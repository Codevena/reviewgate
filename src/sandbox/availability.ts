import { spawn } from "node:child_process";
import { platform } from "node:os";

let cached: boolean | null = null;

export function sandboxExecAvailable(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (platform() !== "darwin") {
    cached = false;
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", (code) => {
      cached = code === 0;
      resolve(cached);
    });
    child.on("error", () => {
      cached = false;
      resolve(false);
    });
  });
}

export function __resetSandboxExecCache(): void {
  cached = null;
}

let bwrapCached: boolean | null = null;

// True when `bwrap` can actually build a namespace with the SAME flags production
// uses (so a probe-pass / production-fail mismatch can't happen). Linux only;
// memoized. Deliberately NO `--uid 0` (production runs as the mapped real user).
// A locked-down host (Ubuntu 24.04 unprivileged-userns AppArmor restriction) makes
// the --unshare-* trip and this returns false -> strict fails closed.
export function bwrapAvailable(): Promise<boolean> {
  if (bwrapCached !== null) return Promise.resolve(bwrapCached);
  if (platform() !== "linux") {
    bwrapCached = false;
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      "bwrap",
      [
        "--unshare-user",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--",
        "true",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("exit", (code) => {
      bwrapCached = code === 0;
      resolve(bwrapCached);
    });
    child.on("error", () => {
      bwrapCached = false;
      resolve(false);
    });
  });
}

// The single availability entry point used by spawnSafely AND doctor, so they agree.
export function sandboxRuntimeAvailable(): Promise<boolean> {
  const plat = platform();
  if (plat === "darwin") return sandboxExecAvailable();
  if (plat === "linux") return bwrapAvailable();
  return Promise.resolve(false);
}

// Test-only: reset the bwrap memo so a test can re-probe.
export function __resetBwrapCache(): void {
  bwrapCached = null;
}
