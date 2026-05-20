// src/cli/commands/doctor.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkSandboxHealth } from "../../sandbox/doctor-check.ts";
import { detectHostModel } from "../../utils/host-model.ts";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
}

function checkBinary(bin: string, name: string): Check {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status === 0)
    return { name, status: "ok", detail: (r.stdout ?? "").trim().split("\n")[0] ?? "" };
  return {
    name,
    status: "fail",
    detail: `${bin} --version exit=${r.status ?? "spawn error"}`,
    ...(r.error?.message ? { hint: r.error.message } : {}),
  };
}

export interface DoctorInput {
  repoRoot: string;
  capture?: boolean;
}

export async function runDoctor(input: DoctorInput): Promise<number> {
  const checks: Check[] = [];

  checks.push(checkBinary("codex", "codex CLI"));
  checks.push(checkBinary("git", "git"));

  const sb = await checkSandboxHealth();
  checks.push({
    name: `sandbox (${sb.platform})`,
    status: sb.available ? "ok" : "fail",
    detail: sb.detail,
    ...(sb.remediation ? { hint: sb.remediation } : {}),
  });

  const host = detectHostModel({ env: process.env as Record<string, string>, hookStdin: null });
  checks.push({
    name: "host-model detection",
    status: host.source === "fallback:assume-opus" ? "warn" : "ok",
    detail: `tier=${host.tier} source=${host.source}${host.modelId ? ` model=${host.modelId}` : ""}`,
    ...(host.source === "fallback:assume-opus"
      ? {
          hint: "Set REVIEWGATE_HOST_MODEL or CLAUDE_MODEL to your active Claude model for accurate downgrade.",
        }
      : {}),
  });

  const cfgExists = existsSync(join(input.repoRoot, "reviewgate.config.ts"));
  checks.push({
    name: "reviewgate.config.ts",
    status: cfgExists ? "ok" : "warn",
    detail: cfgExists ? "present" : "missing (defaults will apply)",
  });

  // Optional reviewer CLIs (M2). These are only needed if enabled in config;
  // report as warn (not fail) when absent so codex-only setups stay green.
  for (const [bin, name] of [
    ["gemini", "gemini CLI (optional)"],
    ["claude", "claude CLI (optional)"],
  ] as const) {
    const c = checkBinary(bin, name);
    checks.push({ ...c, status: c.status === "fail" ? "warn" : c.status });
  }
  checks.push({
    name: "OPENROUTER_API_KEY",
    status: process.env.OPENROUTER_API_KEY ? "ok" : "warn",
    detail: process.env.OPENROUTER_API_KEY ? "set" : "unset (only needed for openrouter reviewers)",
  });

  if (!input.capture) {
    for (const c of checks) {
      const sym = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
      process.stdout.write(`${sym}  ${c.name}: ${c.detail}\n`);
      if (c.hint) process.stdout.write(`    hint: ${c.hint}\n`);
    }
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (fails > 0) return 2;
  if (warns > 0) return 1;
  return 0;
}
