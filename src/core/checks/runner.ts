// src/core/checks/runner.ts
//
// Deterministic checker tier: run configured commands (typecheck/build/test) as a
// fail-fast, $0 gate BEFORE the LLM panel. The FIRST command that exits non-zero
// (or times out / errors / is aborted) becomes a single blocking finding and the
// rest are NOT run. A failure is fail-CLOSED: a command that cannot run is a FAIL,
// never a silent skip. The finding is deterministic (reject-forbidden, stable
// signature) so it rides the existing decisions / fix-verification loop.
import type { Finding } from "../../schemas/finding.ts";
import { spawnCapture } from "../../utils/spawn-capture.ts";

export interface CheckCommand {
  name: string;
  run: string;
  timeoutMs?: number;
}

export interface RunChecksOptions {
  repoRoot: string;
  commands: CheckCommand[];
  /** fallback per-command timeout; default 300_000ms */
  defaultTimeoutMs?: number;
  /** captured-output cap (bytes); default 16_384 */
  outputCapBytes?: number;
  /** the iteration's abort signal (gate self-deadline) */
  signal?: AbortSignal | undefined;
}

export type CheckResult = { ok: true } | { ok: false; finding: Finding };

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_CAP = 16_384;

function checkFinding(name: string, run: string, status: string, output: string): Finding {
  const body = output.trim().length > 0 ? output : "(no output)";
  return {
    id: `check-${name}`,
    signature: `check:${name}`,
    severity: "CRITICAL",
    category: "correctness",
    rule_id: `deterministic-check/${name}`,
    file: `(deterministic check: ${name})`,
    line_start: 1,
    line_end: 1,
    message: `Deterministic check "${name}" failed: ${status}`.slice(0, 200),
    details: `Command: ${run}\nStatus: ${status}\n\n${body}`.slice(0, 2000),
    reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
    confidence: 1,
    consensus: "singleton",
    deterministic: true,
  };
}

export async function runChecks(opts: RunChecksOptions): Promise<CheckResult> {
  const defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  for (const cmd of opts.commands) {
    const timeoutMs = cmd.timeoutMs ?? defaultTimeout;
    const res = await spawnCapture("/bin/sh", ["-c", cmd.run], {
      cwd: opts.repoRoot,
      timeoutMs,
      maxBytes: cap,
      signal: opts.signal,
    });
    const failed = res.status !== 0 || res.timedOut || res.aborted || res.spawnError !== null;
    if (failed) {
      const status = res.spawnError
        ? `could not run (${res.spawnError.message})`
        : res.timedOut
          ? `timed out after ${timeoutMs}ms`
          : res.aborted
            ? "aborted (gate deadline)"
            : `exited ${res.status}`;
      const parts = [res.stdout, res.stderr].filter((s) => s.trim().length > 0);
      const combined = parts.join("\n--- stderr ---\n");
      const output = res.truncated ? `${combined}\n…(output truncated)` : combined;
      return { ok: false, finding: checkFinding(cmd.name, cmd.run, status, output) };
    }
  }
  return { ok: true };
}
