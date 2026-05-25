// src/core/state-store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ZodError } from "zod";
import { type ReviewgateState, ReviewgateStateSchema, initialState } from "../schemas/state.ts";
import { flock } from "../utils/flock.ts";
import { lockPath, reviewgateDir, stateJsonPath } from "../utils/paths.ts";

export class StateStore {
  constructor(private readonly repoRoot: string) {}

  private ensureDir(): void {
    const dir = reviewgateDir(this.repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async initialise(sessionId: string): Promise<ReviewgateState> {
    this.ensureDir();
    const s = initialState(sessionId);
    await this.writeAtomic(s);
    return s;
  }

  async load(): Promise<ReviewgateState> {
    const p = stateJsonPath(this.repoRoot);
    const raw = readFileSync(p, "utf8");
    return ReviewgateStateSchema.parse(JSON.parse(raw));
  }

  async loadOrRecover(sessionId: string): Promise<ReviewgateState> {
    const p = stateJsonPath(this.repoRoot);
    if (!existsSync(p)) return this.initialise(sessionId);
    try {
      return await this.load();
    } catch (err) {
      // Only genuine content corruption is recoverable: malformed JSON
      // (SyntaxError) or a schema mismatch (ZodError). A transient I/O error
      // (EBUSY / AV lock / network FS) must NOT be misread as corruption —
      // wiping the gating history on a momentary read failure is far worse than
      // failing loudly, so rethrow and let the gate surface the error.
      const isCorruption = err instanceof SyntaxError || err instanceof ZodError;
      if (!isCorruption) throw err;
      // Back up the corrupt file with timestamp; re-initialise.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${p}.corrupt.${ts}.json`;
      renameSync(p, backup);
      const fresh = initialState(sessionId);
      fresh.recovered_from = "corruption";
      await this.writeAtomic(fresh);
      return fresh;
    }
  }

  async update<R extends ReviewgateState>(fn: (s: ReviewgateState) => R): Promise<R> {
    this.ensureDir();
    const lock = await flock(lockPath(this.repoRoot));
    try {
      const current = await this.load();
      const next = fn(current);
      ReviewgateStateSchema.parse(next);
      await this.writeAtomic(next);
      return next;
    } finally {
      await lock.release();
    }
  }

  private async writeAtomic(s: ReviewgateState): Promise<void> {
    const p = stateJsonPath(this.repoRoot);
    const tmp = `${p}.tmp`;
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }
}
