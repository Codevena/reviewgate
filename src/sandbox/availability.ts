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
