// src/utils/spawn-capture.ts
// A lightweight async replacement for `spawnSync` on the Stop-hook HOT PATH
// (git, ripgrep). spawnSync blocks the event loop, so while a `git diff` hangs
// (index.lock, huge repo, network FS) the gate's self-deadline timer can never
// fire. This captures stdout/stderr into memory (no temp files — unlike the
// heavier file-based spawnSafely) with a per-command SIGKILL timeout and a hard
// stdout cap, and never blocks the loop.
import { type ChildProcess, spawn } from "node:child_process";

export interface CaptureResult {
  // Exit code, or null when the child never produced one (spawn error, or
  // killed by a signal — e.g. the timeout). Mirrors spawnSync's `status`.
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean; // killed by the per-command timeout
  truncated: boolean; // stdout hit maxBytes and was cut
  aborted: boolean; // killed by (or skipped due to) the caller's AbortSignal
  spawnError: Error | null; // ENOENT etc. (mirrors spawnSync's `error`)
}

export interface CaptureOptions {
  cwd?: string;
  timeoutMs?: number; // default 30s — bounds a hung subprocess
  maxBytes?: number; // stdout cap, default 16 MiB — bounds memory on a huge diff
  encoding?: BufferEncoding; // default utf8
  // When this fires (e.g. the gate self-deadline), the child is SIGKILLed at once
  // so a hung git/rg can't delay the fail-closed path. An already-aborted signal
  // skips the spawn entirely.
  signal?: AbortSignal | undefined;
}

export function spawnCapture(
  command: string,
  args: string[],
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const encoding = opts.encoding ?? "utf8";

  return new Promise<CaptureResult>((resolve) => {
    // Already aborted → don't even spawn.
    if (opts.signal?.aborted) {
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        aborted: true,
        spawnError: null,
      });
      return;
    }

    let child: ChildProcess;
    try {
      // detached: own process group so the timeout kill takes down git/rg AND any
      // helper grandchildren (a pager, etc.) that inherited the stdout pipe — else
      // an orphan holding the pipe open can keep this process alive.
      child = spawn(command, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"], // stdin closed → git/rg never block on it
        detached: true,
      });
    } catch (err) {
      // A synchronous spawn throw (e.g. invalid args) — surface like ENOENT.
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        aborted: false,
        spawnError: err as Error,
      });
      return;
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let truncated = false;
    let aborted = false;
    let settled = false;

    const killTree = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGKILL");
    }, timeoutMs);
    // Post-exit fallback timer (set in the 'exit' handler) — tracked so settle()
    // can clear it, avoiding residual timer churn when 'close' settles first.
    let exitFallback: ReturnType<typeof setTimeout> | undefined;

    // Caller-driven abort (gate self-deadline): SIGKILL the whole tree at once.
    const onAbort = () => {
      aborted = true;
      killTree("SIGKILL");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (status: number | null, spawnError: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitFallback) clearTimeout(exitFallback);
      opts.signal?.removeEventListener("abort", onAbort);
      // Release pipe handles + unref so an orphaned grandchild holding stdout
      // open can't keep this process alive past resolve.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        status,
        stdout: Buffer.concat(outChunks).toString(encoding),
        stderr: Buffer.concat(errChunks).toString(encoding),
        timedOut,
        truncated,
        aborted,
        spawnError,
      });
    };

    // Swallow stream errors (EPIPE on a SIGKILLed child) — the exit/close/error
    // handlers own the result; an unhandled 'error' would crash the gate.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    child.stdout?.on("data", (d: Buffer) => {
      if (outLen >= maxBytes) {
        truncated = true;
        return;
      }
      if (outLen + d.length > maxBytes) {
        outChunks.push(d.subarray(0, maxBytes - outLen));
        outLen = maxBytes;
        truncated = true;
      } else {
        outChunks.push(d);
        outLen += d.length;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      // Bound stderr the same way as stdout so a subprocess spewing diagnostics
      // can't grow memory without limit (stderr isn't reported as truncated — it's
      // only diagnostic — but it must still be capped).
      if (errLen >= maxBytes) return;
      if (errLen + d.length > maxBytes) {
        errChunks.push(d.subarray(0, maxBytes - errLen));
        errLen = maxBytes;
      } else {
        errChunks.push(d);
        errLen += d.length;
      }
    });

    // ENOENT (and other spawn failures) emit 'error' — possibly WITHOUT 'close'.
    child.on("error", (err) => settle(null, err));
    // Normal completion: 'close' fires after both pipes drain → buffers complete.
    child.on("close", (code) => settle(code, null));
    // Fallback: after a SIGKILL an orphaned grandchild can hold a pipe open so
    // 'close' may never come. Settle shortly after 'exit' either way. Skip if
    // already settled (the normal 'close'-first path), and unref the timer so the
    // fallback alone never keeps the process alive.
    child.on("exit", (code) => {
      if (settled) return;
      exitFallback = setTimeout(() => settle(code, null), 100);
      exitFallback.unref?.();
    });
  });
}
