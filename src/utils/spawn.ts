// src/utils/spawn.ts
import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { sandboxRuntimeAvailable } from "../sandbox/availability.ts";
import { assertNoSandboxOverlap, buildBwrapArgs } from "../sandbox/bwrap.ts";
import { SandboxUnavailableError } from "../sandbox/errors.ts";
import type { SandboxProfile, WriteTarget } from "../sandbox/profile-builder.ts";
import { buildMacosSbpl, resolveForSandbox } from "../sandbox/sbpl.ts";

// Default stdout capture cap (32 MiB). Far larger than any real reviewer JSON, so
// normal output is never clipped, but bounded enough that a runaway dump can't OOM
// the gate when the adapter readFileSyncs the capture file.
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

// Bring each write target into existence with the right kind BEFORE bwrap builds its
// read-only-root namespace (the reviewer can't create them inside). Never touches an
// existing path (so an existing file passed as a dir target won't crash mkdir, and
// binds per its real kind); never fabricates a createIfMissing:false own-cred dir.
export function ensureWriteTargets(targets: WriteTarget[]): void {
  for (const t of targets) {
    if (existsSync(t.path)) continue;
    if (!t.createIfMissing) continue;
    if (t.kind === "file") {
      mkdirSync(dirname(t.path), { recursive: true });
      writeFileSync(t.path, "");
    } else {
      mkdirSync(t.path, { recursive: true });
    }
  }
}

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
  // Hard cap on the bytes captured to `stdoutFile`. A pathological reviewer (or a
  // runaway CLI dumping its whole context) can emit gigabytes; the adapter then
  // `readFileSync`s the capture file and can OOM the gate. Once the cap is hit we
  // stop writing stdout (so the file stays bounded) and SIGKILL the tree (the
  // useful prefix — a reviewer's JSON is at the start — is already captured).
  // `result.outputTruncated` reports whether the cap fired. Default: 32 MiB.
  maxOutputBytes?: number;
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
  // True when stdout exceeded `maxOutputBytes` and the capture file was truncated
  // (the child was SIGKILLed). The captured prefix is still readable.
  outputTruncated: boolean;
}

export async function spawnSafely(input: SpawnInput): Promise<SpawnResult> {
  let command = input.command;
  let args = input.args;
  let sandboxApplied = false;
  let sandboxFellBack = false;
  let sbDir: string | null = null;
  if (input.sandbox) {
    const available = await sandboxRuntimeAvailable();
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
          writeTargets: (prof.fs.writeTargets ?? []).map((t) => ({
            ...t,
            path: resolveForSandbox(t.path, home),
          })),
        },
      };
      if (platform() === "darwin") {
        const sbpl = buildMacosSbpl(resolved);
        sbDir = mkdtempSync(join(tmpdir(), "rg-sbpl-"));
        const sbplFile = join(sbDir, "profile.sb");
        writeFileSync(sbplFile, sbpl, { mode: 0o600 });
        args = ["-f", sbplFile, command, ...args];
        command = "sandbox-exec";
      } else {
        // Validate the profile BEFORE creating any write target on the host — a
        // writeAllow nested under a readDeny secret must be rejected before we mkdir/
        // touch it (the guard inside buildBwrapArgs runs too late, after creation).
        assertNoSandboxOverlap(resolved.fs.writeAllow, resolved.fs.readDeny);
        ensureWriteTargets(resolved.fs.writeTargets ?? []);
        args = [...buildBwrapArgs(resolved), command, ...args];
        command = "bwrap";
      }
      sandboxApplied = true;
    } else if (input.sandbox.mode === "strict") {
      throw new SandboxUnavailableError(
        `sandbox.mode='strict' requested but no OS sandbox is available on this host (${platform()}). On macOS use sandbox-exec; on Linux install bubblewrap (bwrap) and enable unprivileged user namespaces. Set mode='permissive' to run unisolated, or 'off' for trusted local dev.`,
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
  let outputTruncated = false;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

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

    // Swallow stream errors (a read failure on the stdin payload, a write failure
    // on the capture files). Without these listeners an 'error' event would be
    // unhandled and crash the whole gate process; the child 'exit'/'error'
    // handlers below own the actual result/rejection. EPIPE from a child that
    // exits before draining a large piped prompt (quota banner + exit, auth
    // error, watchdog SIGKILL) surfaces on the DESTINATION stream — child.stdin,
    // NOT stdinStream — so it needs its own swallow or the Stop hook dies
    // mid-review and the turn ends un-reviewed (fail-open). Attached BEFORE
    // pipe()/end() so the destination is covered for the whole write lifecycle.
    stdinStream?.on("error", () => {});
    child.stdin.on("error", () => {});

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
    out.on("error", () => {});
    err.on("error", () => {});
    let lastOutputAt = Date.now();
    let stdoutBytes = 0;
    child.stdout.on("data", (d: Buffer) => {
      lastOutputAt = Date.now();
      if (outputTruncated) return; // cap already hit — drop the rest
      const remaining = maxOutputBytes - stdoutBytes;
      if (d.length <= remaining) {
        stdoutBytes += d.length;
        out.write(d);
        return;
      }
      // Write the final allowed slice, then stop capturing and kill the tree so a
      // runaway producer can't keep the gate alive or fill the disk. The captured
      // prefix (containing the reviewer's JSON, which comes first) is preserved.
      if (remaining > 0) {
        out.write(d.subarray(0, remaining));
        stdoutBytes += remaining;
      }
      outputTruncated = true;
      killTree("SIGKILL");
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
            outputTruncated,
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
