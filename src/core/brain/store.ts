// src/core/brain/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type BrainEntry, BrainEntrySchema } from "../../schemas/brain.ts";
import { flock } from "../../utils/flock.ts";
import { brainDir, brainJsonPath, brainLockPath, brainMdPath } from "../../utils/paths.ts";

const BrainIndexSchema = z.object({
  schema: z.literal("reviewgate.brain.v1"),
  entries: z.array(BrainEntrySchema),
});
export type BrainSnapshot = z.infer<typeof BrainIndexSchema>;

// Best-effort: preserve a corrupt file for forensics before recovering empty
// (mirrors StateStore.loadOrRecover). Rename failures (e.g. a concurrent reader
// already moved it) are swallowed — recovery must never fail on the backup.
function backupCorrupt(p: string): void {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(p, `${p}.corrupt.${ts}`);
  } catch {
    // best-effort only
  }
}

function renderMd(snap: BrainSnapshot): string {
  const lines = ["# Reviewgate Brain", ""];
  for (const e of snap.entries) {
    lines.push(`### ${e.id} · ${e.type} · ${e.status} (${e.scope})`);
    lines.push(`**${e.title}** — refs ${e.referenced_count}`);
    lines.push(e.body, "");
  }
  return lines.join("\n");
}

export class BrainStore {
  constructor(private readonly repoRoot: string) {}

  private writeAtomic(path: string, body: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  }

  // Reads a fresh, immutable copy of the index. Callers pin this once per run.
  async snapshot(): Promise<BrainSnapshot> {
    const p = brainJsonPath(this.repoRoot);
    if (!existsSync(p)) return { schema: "reviewgate.brain.v1", entries: [] };
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (err) {
      // existsSync→read TOCTOU: deleted in between is a genuine "no file".
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return { schema: "reviewgate.brain.v1", entries: [] };
      // F-22: a transient I/O error (EACCES / EBUSY / AV lock / EIO / network FS)
      // on an EXISTING brain.json must NOT be misread as "empty" — inside
      // mutate() that empty snapshot would be atomically persisted, silently
      // wiping every promoted brain entry. Rethrow so the mutate fails loudly
      // (the curator path is best-effort and never blocks the verdict).
      // Mirrors StateStore.loadOrRecover.
      throw err;
    }
    try {
      return BrainIndexSchema.parse(JSON.parse(raw));
    } catch {
      // Genuine content corruption only (SyntaxError / ZodError). Preserve the
      // corrupt file for forensics (best-effort), then recover empty.
      backupCorrupt(p);
      return { schema: "reviewgate.brain.v1", entries: [] };
    }
  }

  private persist(snap: BrainSnapshot): void {
    this.writeAtomic(brainJsonPath(this.repoRoot), JSON.stringify(snap, null, 2));
    this.writeAtomic(brainMdPath(this.repoRoot), renderMd(snap));
  }

  // Single guarded mutation: lock → read → mutate → atomic write → unlock.
  async mutate<T>(fn: (snap: BrainSnapshot) => { next: BrainSnapshot; result: T }): Promise<T> {
    if (!existsSync(brainDir(this.repoRoot)))
      mkdirSync(brainDir(this.repoRoot), { recursive: true });
    const lock = await flock(brainLockPath(this.repoRoot));
    try {
      const cur = await this.snapshot();
      const { next, result } = fn(structuredClone(cur));
      BrainIndexSchema.parse(next);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  async add(e: BrainEntry): Promise<void> {
    await this.mutate((snap) => {
      snap.entries.push(BrainEntrySchema.parse(e));
      return { next: snap, result: undefined };
    });
  }

  // Compute the next free `B-00N` id *inside* the same write lock that appends
  // the entry, eliminating the nextId()/add() TOCTOU race where two concurrent
  // curators could both read max=N and mint the same B-00(N+1). `build` receives
  // the freshly-allocated id and returns the entry to persist; the id is also
  // returned so the caller can log the promotion.
  async addAllocatingId(build: (id: string) => BrainEntry): Promise<string> {
    return this.mutate((snap) => {
      const max = snap.entries
        .map((e) => Number.parseInt(e.id.replace(/^B-/, ""), 10))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => Math.max(a, b), 0);
      const id = `B-${String(max + 1).padStart(3, "0")}`;
      snap.entries.push(BrainEntrySchema.parse(build(id)));
      return { next: snap, result: id };
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.mutate((snap) => {
      const before = snap.entries.length;
      snap.entries = snap.entries.filter((x) => x.id !== id);
      return { next: snap, result: snap.entries.length < before };
    });
  }

  async nextId(): Promise<string> {
    const snap = await this.snapshot();
    const max = snap.entries
      .map((e) => Number.parseInt(e.id.replace(/^B-/, ""), 10))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);
    return `B-${String(max + 1).padStart(3, "0")}`;
  }
}
