// src/utils/spawn.ts
import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";

export interface SpawnInput {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdinFile?: string;
  stdoutFile: string;
  stderrFile: string;
  timeoutMs: number;
  zeroByteWatchdogMs?: number;
}

export interface SpawnResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  killedByWatchdog: boolean;
  killedByTimeout: boolean;
}

export async function spawnSafely(input: SpawnInput): Promise<SpawnResult> {
  const start = Date.now();
  let killedByWatchdog = false;
  let killedByTimeout = false;

  return new Promise<SpawnResult>((resolve, reject) => {
    const stdinStream = input.stdinFile ? createReadStream(input.stdinFile) : undefined;

    const child = nodeSpawn(input.command, input.args, {
      env: input.env,
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    if (stdinStream && child.stdin) {
      stdinStream.pipe(child.stdin);
    } else if (child.stdin) {
      // No stdin payload: close it so the child receives EOF immediately.
      // `codex exec` (and many CLIs) block on "Reading additional input from
      // stdin..." until EOF even when the prompt is passed as an argument —
      // leaving the pipe open hangs the reviewer until the walltime timeout.
      child.stdin.end();
    }
    const out = createWriteStream(input.stdoutFile);
    const err = createWriteStream(input.stderrFile);
    // Swallow stream errors (e.g. EPIPE when piping stdin to a SIGKILLed child,
    // or a write failure on the capture files). Without these listeners an
    // 'error' event would be unhandled and crash the whole gate process; the
    // child 'exit'/'error' handlers below own the actual result/rejection.
    stdinStream?.on("error", () => {});
    out.on("error", () => {});
    err.on("error", () => {});
    let lastOutputAt = Date.now();
    child.stdout.on("data", (d: Buffer) => {
      lastOutputAt = Date.now();
      out.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      lastOutputAt = Date.now();
      err.write(d);
    });

    const watchdog = setInterval(() => {
      const idle = Date.now() - lastOutputAt;
      if (idle > (input.zeroByteWatchdogMs ?? 60_000)) {
        killedByWatchdog = true;
        clearInterval(watchdog);
        child.kill("SIGKILL");
      }
    }, 5_000);

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      clearInterval(watchdog);
      clearTimeout(timeout);
      out.end();
      err.end();
      resolve({
        exitCode: code ?? -1,
        signal,
        durationMs: Date.now() - start,
        killedByWatchdog,
        killedByTimeout,
      });
    });
    child.on("error", reject);
  });
}
