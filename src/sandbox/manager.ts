import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "./profile-builder.ts";

export interface SandboxRunInput {
  command: string[];
  env: Record<string, string>;
  stdinFile?: string;
  profile: SandboxProfile;
}

export interface SandboxRunResult {
  exitCode: number;
  stdoutFile: string;
  stderrFile: string;
  durationMs: number;
  killedByWatchdog: boolean;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

// M1 caveat: @anthropic-ai/sandbox-runtime v1.x is not on npm yet (spike S5
// was supposed to confirm the API surface). Until it's published, M1 supports
// only sandbox.mode='off' at runtime, where we plain-spawn the command.
// Strict/permissive modes throw SandboxUnavailableError so callers fail loud
// instead of silently running unisolated reviewers.

export class SandboxManager {
  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    if (input.profile.sandboxRequested) {
      if (platform() === "win32") {
        throw new SandboxUnavailableError(
          "Windows is not supported by sandbox-runtime. Use WSL2, or set sandbox.mode='off' explicitly (only for trusted local dev).",
        );
      }
      // Attempt dynamic import; package is not installed in M1.
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — package not installed in M1; dynamic import fails at runtime, caught below
        const mod = (await import("@anthropic-ai/sandbox-runtime")) as {
          runInSandbox: (
            opts: unknown,
          ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
        };
        return await this.runInside(mod.runInSandbox, input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new SandboxUnavailableError(
          `Sandbox isolation unavailable: ${msg}. M1 ships without @anthropic-ai/sandbox-runtime; set sandbox.mode=\'off\' explicitly to run unisolated (only for trusted local dev).`,
        );
      }
    }
    // mode === 'off': plain spawn
    return this.runPlain(input);
  }

  private async runInside(
    runInSandbox: (opts: unknown) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
    input: SandboxRunInput,
  ): Promise<SandboxRunResult> {
    const dir = mkdtempSync(join(tmpdir(), "rg-sb-"));
    const stdoutFile = join(dir, "stdout.log");
    const stderrFile = join(dir, "stderr.log");
    const start = Date.now();
    let killedByWatchdog = false;
    const timer = setTimeout(() => {
      killedByWatchdog = true;
    }, input.profile.budget.walltimeMs);
    try {
      const opts: Record<string, unknown> = {
        command: input.command,
        env: input.env,
        timeoutMs: input.profile.budget.walltimeMs,
        filesystem: {
          readAllowList: input.profile.fs.readAllow,
          readDenyList: input.profile.fs.readDeny,
          writeAllowList: input.profile.fs.writeAllow,
        },
        network: { allowList: input.profile.net.allow },
      };
      if (input.stdinFile) opts.stdinFile = input.stdinFile;
      const res = await runInSandbox(opts);
      writeFileSync(stdoutFile, res.stdout);
      writeFileSync(stderrFile, res.stderr);
      return {
        exitCode: res.exitCode,
        stdoutFile,
        stderrFile,
        durationMs: Date.now() - start,
        killedByWatchdog,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async runPlain(input: SandboxRunInput): Promise<SandboxRunResult> {
    const dir = mkdtempSync(join(tmpdir(), "rg-sb-off-"));
    const stdoutFile = join(dir, "stdout.log");
    const stderrFile = join(dir, "stderr.log");
    const start = Date.now();
    let killedByWatchdog = false;

    return await new Promise<SandboxRunResult>((resolve, reject) => {
      const [cmd, ...args] = input.command;
      if (!cmd) {
        reject(new Error("SandboxManager.run: empty command"));
        return;
      }
      const child = spawn(cmd, args, { env: input.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      const timer = setTimeout(() => {
        killedByWatchdog = true;
        child.kill("SIGKILL");
      }, input.profile.budget.walltimeMs);
      child.on("exit", (code: number | null) => {
        clearTimeout(timer);
        writeFileSync(stdoutFile, stdout);
        writeFileSync(stderrFile, stderr);
        resolve({
          exitCode: code ?? -1,
          stdoutFile,
          stderrFile,
          durationMs: Date.now() - start,
          killedByWatchdog,
        });
      });
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
