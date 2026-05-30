// src/utils/spawn.ts
import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { sandboxExecAvailable } from "../sandbox/availability.ts";
import { SandboxUnavailableError } from "../sandbox/errors.ts";
import type { SandboxProfile } from "../sandbox/profile-builder.ts";
import { buildMacosSbpl, resolveForSandbox } from "../sandbox/sbpl.ts";

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
  // When this fires, the child's whole process group is SIGKILLed at once. Used
  // by the gate's self-deadline to abort in-flight reviewers when a run exceeds
  // loop.runTimeoutMs (so they can't keep running orphaned or write late).
  signal?: AbortSignal;
  sandbox?: { profile: SandboxProfile; mode: "strict" | "permissive" };
}

export interface SpawnResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  killedByWatchdog: boolean;
  killedByTimeout: boolean;
  killedByAbort: boolean;
  sandboxApplied: boolean;
  sandboxFellBack: boolean;
}

export async function spawnSafely(input: SpawnInput): Promise<SpawnResult> {
  let command = input.command;
  let args = input.args;
  let sandboxApplied = false;
  let sandboxFellBack = false;
  let sbDir: string | null = null;
  if (input.sandbox) {
    const available = await sandboxExecAvailable();
    if (available) {
      const home = homedir();
      const prof = input.sandbox.profile;
      const resolved: SandboxProfile = {
        ...prof,
        fs: {
          readAllow: prof.fs.readAllow.map((p) => resolveForSandbox(p, home)),
          readDeny: prof.fs.readDeny.map((p) => resolveForSandbox(p, home)),
          // Globs are NOT realpath'd — they're rendered as anchored SBPL regexes.
          readDenyGlobs: prof.fs.readDenyGlobs,
          writeAllow: prof.fs.writeAllow.map((p) => resolveForSandbox(p, home)),
        },
      };
      const sbpl = buildMacosSbpl(resolved);
      sbDir = mkdtempSync(join(tmpdir(), "rg-sbpl-"));
      const sbplFile = join(sbDir, "profile.sb");
      writeFileSync(sbplFile, sbpl, { mode: 0o600 });
      args = ["-f", sbplFile, command, ...args];
      command = "sandbox-exec";
      sandboxApplied = true;
    } else if (input.sandbox.mode === "strict") {
      throw new SandboxUnavailableError(
        "sandbox.mode='strict' requested but sandbox-exec is unavailable on this host (macOS only). Set mode='permissive' to run unisolated, or 'off' for trusted local dev.",
      );
    } else {
      sandboxFellBack = true;
    }
  }
  // Backstop: a NUL byte can never appear in a real argv (the OS can't represent
  // one) and node:child_process throws synchronously on it ("args[N] must be a
  // string without null bytes"), which would error a reviewer at spawn time. The
  // diff sanitizer strips these at the source; this guards EVERY other argv path
  // (e.g. judge/curator complete() prompts) too. split/join avoids both a regex
  // control-class and a literal NUL byte in this source.
  const NUL = String.fromCharCode(0);
  command = command.split(NUL).join("");
  args = args.map((a) => a.split(NUL).join(""));

  const start = Date.now();
  let killedByWatchdog = false;
  let killedByTimeout = false;
  let killedByAbort = false;

  return new Promise<SpawnResult>((resolve, reject) => {
    const stdinStream = input.stdinFile ? createReadStream(input.stdinFile) : undefined;

    // `detached: true` puts the child in its OWN process group so a timeout/watchdog
    // kill can take down the WHOLE tree (the reviewer CLI + any helper grandchildren
    // it spawned). Killing only the direct child leaves grandchildren that inherited
    // the stdout pipe alive — they hold the pipe open, so neither "close" fires nor
    // the host process can exit (the gate would hang past its own timeout).
    const child = nodeSpawn(command, args, {
      env: input.env,
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    }) as ChildProcessByStdio<Writable, Readable, Readable>;

    // Kill the child's entire process group; fall back to the lone child if the
    // group send fails (e.g. already gone → ESRCH, or no pid).
    const killTree = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already dead
        }
      }
    };

    // Caller-driven abort (gate self-deadline): SIGKILL the whole tree at once.
    // If the signal is already aborted at spawn time, kill immediately. The
    // listener is removed in settle() so an aborted run doesn't leak it.
    const onAbort = () => {
      killedByAbort = true;
      killTree("SIGKILL");
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

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
        killTree("SIGKILL");
      }
    }, 5_000);

    const timeout = setTimeout(() => {
      killedByTimeout = true;
      killTree("SIGKILL");
    }, input.timeoutMs);

    // Settle on "close" (NOT "exit"): "exit" can fire while stdout/stderr "data"
    // events are still in flight, so resolving there lets the caller readFileSync
    // the capture files before all output is written — under load that yields an
    // empty/truncated file (a real bug: a reviewer's output could be lost). "close"
    // fires only after both pipes have drained. Then we wait for the WriteStreams
    // to flush (end callbacks) before resolving so the files are complete on disk.
    //
    // Exception: a SIGKILLed child can leave an orphaned grandchild (e.g. `sleep`)
    // holding the stdout pipe open, so "close" may never fire after a kill — fall
    // back to settling shortly after "exit" in that case (don't hang on the orphan).
    let settled = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      // Release our handles on the child's pipes (and unref the child) so an
      // orphaned grandchild still holding stdout/stderr open cannot keep THIS
      // process alive — without this the promise resolves but the gate can hang at
      // exit until the orphan dies (or forever). On the normal path the streams
      // have already drained (settled from "close"), so destroying is a no-op.
      child.stdout.destroy();
      child.stderr.destroy();
      stdinStream?.destroy();
      child.unref();
      if (sbDir) {
        try {
          rmSync(sbDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      let pending = 2;
      const finishOne = () => {
        pending -= 1;
        if (pending === 0) {
          resolve({
            exitCode: code ?? -1,
            signal,
            durationMs: Date.now() - start,
            killedByWatchdog,
            killedByTimeout,
            killedByAbort,
            sandboxApplied,
            sandboxFellBack,
          });
        }
      };
      out.end(finishOne);
      err.end(finishOne);
    };
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      // The process is gone — cancel the kill timers NOW so a still-armed timeout
      // can't fire after exit and spuriously flag killedByTimeout. Prefer "close"
      // (full pipe drain), but a backgrounded grandchild can hold stdout/stderr
      // open so "close" may never come (whether the child exited normally OR was
      // killed) — settle after a short grace either way to bound the wall time.
      clearInterval(watchdog);
      clearTimeout(timeout);
      setTimeout(() => settle(code, signal), 100);
    });
    child.on("error", reject);
  });
}
