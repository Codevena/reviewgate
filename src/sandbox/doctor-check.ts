import { platform } from 'node:os';
import { spawn } from 'node:child_process';

export interface SandboxHealthReport {
  platform: NodeJS.Platform;
  available: boolean;
  detail: string;
  remediation?: string;
}

function bwrapTest(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn('bwrap', ['--ro-bind', '/', '/', '--unshare-user', '--uid', '0', '--', 'true'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('exit', (code: number | null) => {
      resolve({ ok: code === 0, detail: code === 0 ? 'bwrap functional' : `bwrap exit=${code}: ${stderr.slice(0, 200)}` });
    });
    child.on('error', (err: Error) => resolve({ ok: false, detail: `bwrap not invokable: ${err.message}` }));
  });
}

function sandboxExecTest(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const profile = '(version 1)(allow default)';
    const child = spawn('sandbox-exec', ['-p', profile, '/usr/bin/true'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('exit', (code: number | null) => {
      resolve({ ok: code === 0, detail: code === 0 ? 'sandbox-exec functional' : `sandbox-exec exit=${code}: ${stderr.slice(0, 200)}` });
    });
    child.on('error', (err: Error) => resolve({ ok: false, detail: `sandbox-exec not invokable: ${err.message}` }));
  });
}

export async function checkSandboxHealth(): Promise<SandboxHealthReport> {
  const plat = platform();
  if (plat === 'darwin') {
    const r = await sandboxExecTest();
    return { platform: plat, available: r.ok, detail: r.detail };
  }
  if (plat === 'linux') {
    const r = await bwrapTest();
    return {
      platform: plat,
      available: r.ok,
      detail: r.detail,
      ...(r.ok
        ? {}
        : { remediation: 'On Ubuntu 24.04+, run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (or install an AppArmor profile for bwrap).' }),
    };
  }
  return {
    platform: plat,
    available: false,
    detail: `Platform ${plat} not supported by sandbox-runtime in M1.`,
    remediation: 'Use WSL2 on Windows, or set sandbox.mode="off" explicitly.',
  };
}
