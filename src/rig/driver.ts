// src/rig/driver.ts
// Drives a headless agent through a turn script inside a throwaway, Reviewgate-armed repo,
// snapshotting the gate's artifacts after each turn. The driver only ever READS the repo's
// .reviewgate/ and copies it out — it must never write there, or the rig would be measuring
// its own interference.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.ts";
import { gateLockPath, reviewgateDir } from "../utils/paths.ts";
import { loadTurnScript } from "./turn-script.ts";

export interface DriverOpts {
  scriptPath: string;
  outDir: string;
  repoRoot: string;
  /** Argv for the agent process, built from the turn's prompt. Injected so tests can
   *  substitute a fake agent instead of spending real `claude -p` quota. */
  agentCmd: (prompt: string) => string[];
  maxTurns?: number;
  /** How long to wait for the workspace to go quiescent after the agent exits. */
  quiesceTimeoutMs?: number;
}

export interface DriverTurnRecord {
  index: number;
  snapshotDir: string;
  agentExitCode: number;
  wallMs: number;
}

export interface DriverRunManifest {
  schema: "reviewgate.rig.manifest.v1";
  runId: string;
  scriptId: string;
  outDir: string;
  turns: DriverTurnRecord[];
}

const QUIESCE_TIMEOUT_MS = 2_000;
const QUIESCE_POLL_MS = 50;
const COPY_RETRY_DELAY_MS = 100;

/**
 * Agent exit is necessary but NOT sufficient. The Stop hook is synchronous, so the gate's
 * own writes are complete and atomic by the time the agent returns — but the PostToolUse
 * hook is installed `async: true` and can outlive the turn. Snapshotting through that
 * window yields a torn artifact whose numbers cannot be traced back to a defect, so this
 * refuses rather than recording a plausible-looking partial.
 */
async function awaitQuiescent(repoRoot: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "unknown";
  for (;;) {
    const reason = notQuiescentReason(repoRoot);
    if (reason === null) return;
    lastReason = reason;
    if (Date.now() >= deadline) {
      throw new Error(
        `rig driver: workspace never became quiescent within ${timeoutMs}ms (${lastReason}). Refusing to snapshot a torn .reviewgate/ — a partial artifact produces numbers nobody can trace back to a defect.`,
      );
    }
    await new Promise((r) => setTimeout(r, QUIESCE_POLL_MS));
  }
}

/** null = quiescent; otherwise a human-readable reason it is not. */
function notQuiescentReason(repoRoot: string): string | null {
  if (existsSync(gateLockPath(repoRoot))) return "gate.lock is held";
  // Parse-checked rather than existence-checked: a half-written JSON file exists too.
  // readFileSync sits INSIDE the try on purpose — a file unlinked between existsSync and
  // the read is "not quiescent", not a crash.
  for (const name of ["state.json", "pending.json"]) {
    const p = join(reviewgateDir(repoRoot), name);
    if (!existsSync(p)) continue;
    try {
      JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return `${name} does not parse yet`;
    }
  }
  // The audit log matters MORE than the two files above, because it is what the harvester
  // actually reads: a clean-PASS re-arm wipes state.json and decisions/, leaving the audit
  // tree as the only per-iteration record. It is append-only JSONL, so the failure mode is
  // a torn LAST line — check exactly that, on every file, rather than trusting that a
  // quiescent state.json implies a quiescent audit log.
  const auditRoot = join(reviewgateDir(repoRoot), "audit");
  if (existsSync(auditRoot)) {
    for (const rel of new Bun.Glob("**/*.jsonl").scanSync({ cwd: auditRoot })) {
      try {
        const lines = readFileSync(join(auditRoot, rel), "utf8").split("\n").filter(Boolean);
        const last = lines.at(-1);
        if (last !== undefined) JSON.parse(last);
      } catch {
        return `audit/${rel} has a torn trailing line`;
      }
    }
  }
  return null;
}

/**
 * Copy the live `.reviewgate/` out. A raw `cpSync` throws if a file is unlinked between the
 * directory walk and its read — a cache entry expiring, a temp file being renamed away. That
 * is transient, so one retry is worth it; but a SECOND failure is not retried into silence,
 * because the alternative to a loud stop is a snapshot that is quietly missing whichever
 * file lost the race, and a missing audit file reads downstream as "this turn had no
 * iterations" rather than as an error.
 */
async function copyWithRetry(src: string, dest: string, turnIndex: number): Promise<void> {
  try {
    cpSync(src, dest, { recursive: true });
    return;
  } catch {
    await new Promise((r) => setTimeout(r, COPY_RETRY_DELAY_MS));
  }
  try {
    cpSync(src, dest, { recursive: true });
  } catch (e) {
    throw new Error(
      `rig driver: could not snapshot .reviewgate/ for turn ${turnIndex} after a retry (${e instanceof Error ? e.message : String(e)}). Refusing to continue with an incomplete snapshot — a missing audit file reads downstream as "no iterations", not as an error.`,
    );
  }
}

async function runAgent(argv: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(argv, {
    cwd,
    // stdin closed: an agent CLI left with an open stdin waits for input that never comes.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

export async function runDriver(opts: DriverOpts): Promise<DriverRunManifest> {
  const script = loadTurnScript(opts.scriptPath);
  const maxTurns = Math.max(1, Math.min(opts.maxTurns ?? script.turns.length, script.turns.length));
  const quiesceTimeoutMs = opts.quiesceTimeoutMs ?? QUIESCE_TIMEOUT_MS;
  const manifestPath = join(opts.outDir, "manifest.json");
  const manifest: DriverRunManifest = {
    schema: "reviewgate.rig.manifest.v1",
    // Not a random id: a run is identified by the script it ran and when it started, so a
    // manifest stays traceable to its turn script without a side lookup.
    runId: `${script.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    scriptId: script.id,
    outDir: opts.outDir,
    turns: [],
  };
  mkdirSync(opts.outDir, { recursive: true });

  for (const turn of script.turns.slice(0, maxTurns)) {
    const startedAt = Date.now();
    const agentExitCode = await runAgent(opts.agentCmd(turn.prompt), opts.repoRoot);
    await awaitQuiescent(opts.repoRoot, quiesceTimeoutMs);

    // Snapshot AFTER the agent exits and the workspace settles. Laid out as a repo root
    // (a directory literally named `.reviewgate`) so `loadAuditWindow(snapshotDir)` reads
    // it unchanged — the audit tree is the load-bearing part, because a clean-PASS re-arm
    // wipes state.json and decisions/ and leaves the audit log as the only surviving
    // per-iteration record.
    const snapshotDir = join(opts.outDir, "turns", String(turn.index));
    mkdirSync(snapshotDir, { recursive: true });
    const src = reviewgateDir(opts.repoRoot);
    if (existsSync(src)) await copyWithRetry(src, join(snapshotDir, ".reviewgate"), turn.index);

    manifest.turns.push({
      index: turn.index,
      snapshotDir,
      agentExitCode,
      wallMs: Date.now() - startedAt,
    });
    // Written after EVERY turn: a run killed at turn 9 of 12 stays harvestable for the
    // turns it did complete, instead of losing the whole (expensive) run.
    writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}
