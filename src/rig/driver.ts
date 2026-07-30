// src/rig/driver.ts
// Drives a headless agent through a turn script inside a throwaway, Reviewgate-armed repo,
// snapshotting the gate's artifacts after each turn. The driver only ever READS the repo's
// .reviewgate/ and copies it out — it must never write there, or the rig would be measuring
// its own interference.
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { RigManifest, RigManifestTurn } from "../schemas/rig-manifest.ts";
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

// The manifest shape lives in `src/schemas/rig-manifest.ts` — the harvester parses this file
// back off disk, and a hand-written interface here plus a zod schema there is two definitions
// of one artifact waiting to drift. These aliases keep the driver's public names.
export type DriverTurnRecord = RigManifestTurn;
export type DriverRunManifest = RigManifest;

/**
 * Where this run is recording, from the inherited `REVIEWGATE_CASSETTE=record:<path>`.
 * `null` when not recording (the unit tests, and any replay-mode run).
 */
function recordingCassettePath(): string | null {
  const env = process.env.REVIEWGATE_CASSETTE;
  if (env === undefined || !env.startsWith("record:")) return null;
  const path = env.slice("record:".length);
  return path.length > 0 ? path : null;
}

/** Current cassette size in bytes; 0 before the first entry is written. */
function cassetteSize(path: string | null): number | null {
  if (path === null) return null;
  try {
    return statSync(path).size;
  } catch {
    // Not created yet (turn 1, before any reviewer ran) — that is a zero-length prefix,
    // not an error. A genuinely unreadable path yields the same 0 and the range is then
    // empty, which reads downstream as "no entries", never as a wrong range.
    return 0;
  }
}

const QUIESCE_TIMEOUT_MS = 2_000;
const QUIESCE_POLL_MS = 50;
const COPY_RETRY_DELAY_MS = 100;
const REPORT_POLL_MS = 250;

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

/**
 * Archive every version of `pending.{json,md}` that appears WHILE a turn runs.
 *
 * Without this, recall (M3) is unmeasurable. The gate rewrites `pending.json` each
 * iteration, so after a turn ends green it holds the final PASS report with zero findings —
 * the iteration that actually caught the seeded defect is gone. The audit log does not
 * close the gap: it carries counts, costs and finding SIGNATURES, but a signature is a
 * SHA-256 of `[file, ruleId, category, symbol, offset]`, so neither the rule id nor the
 * finding text can be recovered from it. Matching a seeded defect's tags therefore needs
 * the reports themselves, captured as they appear.
 *
 * Polling rather than fs.watch: the gate writes atomically (temp + rename), so any read
 * returns a complete version, and a missed intermediate is far less bad than a torn one.
 */
function startReportArchiver(repoRoot: string, destDir: string): () => void {
  mkdirSync(destDir, { recursive: true });
  // One counter PER FILE. A shared counter that only advanced on pending.json meant a
  // pending.md version arriving between two json rewrites was written under the previous
  // number and clobbered its predecessor — silently losing exactly the intermediate report
  // this archiver exists to keep (gate finding F-001).
  const seq = new Map<string, number>();
  const seen = new Set<string>();
  const capture = () => {
    for (const name of ["pending.json", "pending.md"]) {
      const src = join(reviewgateDir(repoRoot), name);
      if (!existsSync(src)) continue;
      try {
        const body = readFileSync(src, "utf8");
        const key = `${name}:${createHash("sha256").update(body).digest("hex")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const n = (seq.get(name) ?? 0) + 1;
        seq.set(name, n);
        // Atomic, like every other write in this driver: a process killed mid-write would
        // otherwise leave a torn archived report, and a torn report reads downstream as a
        // MISSED defect rather than as an error.
        writeFileAtomic(join(destDir, `${n}-${name}`), body);
      } catch {
        /* mid-rename read → try again on the next tick */
      }
    }
  };
  const timer = setInterval(capture, REPORT_POLL_MS);
  return () => {
    clearInterval(timer);
    capture(); // final sweep: the last report may have landed after the last tick
  };
}

/**
 * Run one agent turn, sending its output straight to a FILE DESCRIPTOR.
 *
 * Two reasons, and NOT the one you may expect. The gate flagged the previous
 * `stdout: "pipe"` as a pipe-buffer deadlock (F-003, two reviewers, confidence 0.97). That
 * is true of Node's `child_process`, but it is NOT true here: measured directly,
 * `Bun.spawn` pushes 128MB through an undrained pipe in ~1.1s and the child never blocks,
 * because Bun drains into its own buffer. Do not "restore" the pipe on the strength of that
 * finding, and do not re-add a deadlock comment — both were checked.
 *
 * The real reasons are: an fd keeps the per-turn transcript, which the interview stage
 * wants, and it keeps a multi-megabyte agent turn out of the parent's memory, which the
 * pipe version would have accumulated there for the whole run.
 */
async function runAgent(argv: string[], cwd: string, logPath: string): Promise<number> {
  const fd = openSync(logPath, "a");
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      // stdin closed: an agent CLI left with an open stdin waits for input that never comes.
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    return await proc.exited;
  } finally {
    closeSync(fd);
  }
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
    cassettePath: recordingCassettePath(),
    turns: [],
  };
  mkdirSync(opts.outDir, { recursive: true });

  for (const turn of script.turns.slice(0, maxTurns)) {
    const startedAt = Date.now();
    // Sampled BEFORE the agent runs: everything the cassette grows by during this turn is
    // this turn's reviewer traffic, which is what makes the entries addressable per turn.
    const cassetteBefore = cassetteSize(manifest.cassettePath ?? null);
    // The turn directory is created BEFORE the agent runs, because the agent's transcript
    // is written into it live (see runAgent). The .reviewgate/ snapshot still happens after.
    const snapshotDir = join(opts.outDir, "turns", String(turn.index));
    mkdirSync(snapshotDir, { recursive: true });
    // Started BEFORE the agent: the reports it archives only exist during the turn.
    const stopArchiver = startReportArchiver(opts.repoRoot, join(snapshotDir, "reports"));
    let agentExitCode: number;
    try {
      agentExitCode = await runAgent(
        opts.agentCmd(turn.prompt),
        opts.repoRoot,
        join(snapshotDir, "agent.log"),
      );
      await awaitQuiescent(opts.repoRoot, quiesceTimeoutMs);
    } finally {
      // finally, not after: a quiescence failure must not leave an interval running for
      // the rest of the process.
      stopArchiver();
    }

    // Snapshot AFTER the agent exits and the workspace settles. Laid out as a repo root
    // (a directory literally named `.reviewgate`) so `loadAuditWindow(snapshotDir)` reads
    // it unchanged — the audit tree is the load-bearing part, because a clean-PASS re-arm
    // wipes state.json and decisions/ and leaves the audit log as the only surviving
    // per-iteration record.
    const src = reviewgateDir(opts.repoRoot);
    if (existsSync(src)) await copyWithRetry(src, join(snapshotDir, ".reviewgate"), turn.index);

    const cassetteAfter = cassetteSize(manifest.cassettePath ?? null);
    manifest.turns.push({
      index: turn.index,
      snapshotDir,
      agentExitCode,
      wallMs: Date.now() - startedAt,
      cassetteBytes:
        cassetteBefore === null || cassetteAfter === null
          ? null
          : { before: cassetteBefore, after: cassetteAfter },
    });
    // Written after EVERY turn: a run killed at turn 9 of 12 stays harvestable for the
    // turns it did complete, instead of losing the whole (expensive) run.
    writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}
