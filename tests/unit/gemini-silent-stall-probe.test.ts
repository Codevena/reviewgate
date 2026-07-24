// tests/unit/gemini-silent-stall-probe.test.ts
//
// Silent-stall discriminator probe (field incident 2026-07-23): a zero-output
// kill of agy is AMBIGUOUS — a quota'd agy hangs silently (its banner is
// TTY-only), but so does an agentic-crawl hang or a transport flake. Quota
// throttles ALL requests, a prompt-specific hang does not — so after a silent
// stall the adapter asks agy a trivial no-repo question:
//   probe answers  → NOT quota → honest `status:"timeout"` (hung review),
//   probe silent   → consistent with quota → quota-exhausted + quotaInferred,
//   disableRetries → probe forbidden (single-spawn contract) → inferred, 1 spawn,
//   print-timeout sentinel → agy demonstrably ran → no probe, inferred label only.
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAdapter } from "../../src/providers/gemini.ts";

const FAKE_STALL = join(process.cwd(), "tests/fixtures/fake-gemini-stall.sh");

const ENV_KEYS = ["RG_PROBE_COUNT", "RG_ARGS_OUT", "RG_PWD_OUT", "RG_REVIEW_MODE", "RG_PROBE_MODE"];
afterEach(() => {
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
});

function setup(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "rg-gem-stall-"));
  chmodSync(FAKE_STALL, 0o755);
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");
  const countFile = join(dir, "count.txt");
  process.env.RG_PROBE_COUNT = countFile;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return { dir, promptFile, countFile };
}

function reviewInput(dir: string, promptFile: string, extra: Record<string, unknown> = {}) {
  return {
    // Small timeout → the zero-byte watchdog kills the silent review call fast.
    cfg: { enabled: true, auth: "oauth" as const, model: "ignored", timeoutMs: 1200 },
    reviewerId: "gemini-security",
    promptFile,
    workingDir: dir,
    findingsPath: join(dir, "f.md"),
    persona: "security",
    diffPath: join(dir, "d.patch"),
    ...extra,
  };
}

const invocations = (countFile: string): number => Number(readFileSync(countFile, "utf8").trim());

describe("GeminiAdapter silent-stall discriminator probe", () => {
  it("probe answers → the stall was NOT quota: honest status 'timeout', no quotaInferred", async () => {
    const { dir, promptFile, countFile } = setup({ RG_REVIEW_MODE: "silent", RG_PROBE_MODE: "ok" });
    const adapter = new GeminiAdapter({ binPath: FAKE_STALL, probeTimeoutMs: 5000 });
    const res = await adapter.review(reviewInput(dir, promptFile) as never);
    expect(res.status).toBe("timeout");
    expect(res.quotaInferred).toBeUndefined();
    expect(res.statusDetail ?? "").toContain("probe");
    expect(invocations(countFile)).toBe(2);
  }, 20_000);

  it("probe also silent → quota-exhausted + quotaInferred (inference strengthened)", async () => {
    const { dir, promptFile, countFile } = setup({
      RG_REVIEW_MODE: "silent",
      RG_PROBE_MODE: "silent",
    });
    const adapter = new GeminiAdapter({ binPath: FAKE_STALL, probeTimeoutMs: 800 });
    const res = await adapter.review(reviewInput(dir, promptFile) as never);
    expect(res.status).toBe("quota-exhausted");
    expect(res.quotaInferred).toBe(true);
    expect(invocations(countFile)).toBe(2);
  }, 20_000);

  it("probe answers with a quota BANNER → CONFIRMED quota, never 'refuted' (Claude-B WARN)", async () => {
    // A quota'd agy CAN print its usage banner to stdout and still exit 0 (the
    // F-043 class). Such a probe reply must not count as "alive → not quota":
    // it is the OPPOSITE — a banner-CONFIRMED cap. The classification stays
    // quota-exhausted, but no longer as an inference (quotaInferred absent),
    // and the banner text rides statusDetail so a parseable reset can win.
    const { dir, promptFile, countFile } = setup({
      RG_REVIEW_MODE: "silent",
      RG_PROBE_MODE: "banner",
    });
    const adapter = new GeminiAdapter({ binPath: FAKE_STALL, probeTimeoutMs: 5000 });
    const res = await adapter.review(reviewInput(dir, promptFile) as never);
    expect(res.status).toBe("quota-exhausted");
    expect(res.quotaInferred).toBeUndefined(); // confirmed by the banner — not a guess anymore
    expect(res.statusDetail ?? "").toContain("quota reached"); // banner text carried for reset parsing
    expect(invocations(countFile)).toBe(2);
  }, 20_000);

  it("disableRetries → NO probe (single physical spawn), inferred classification stands", async () => {
    const { dir, promptFile, countFile } = setup({ RG_REVIEW_MODE: "silent" });
    const adapter = new GeminiAdapter({ binPath: FAKE_STALL, probeTimeoutMs: 5000 });
    const res = await adapter.review(
      reviewInput(dir, promptFile, { disableRetries: true }) as never,
    );
    expect(res.status).toBe("quota-exhausted");
    expect(res.quotaInferred).toBe(true);
    expect(invocations(countFile)).toBe(1);
  }, 20_000);

  it("print-timeout sentinel → no probe, quota-exhausted + quotaInferred (a guess, labeled as one)", async () => {
    const { dir, promptFile, countFile } = setup({ RG_REVIEW_MODE: "sentinel" });
    const adapter = new GeminiAdapter({ binPath: FAKE_STALL, probeTimeoutMs: 5000 });
    const res = await adapter.review(reviewInput(dir, promptFile) as never);
    expect(res.status).toBe("quota-exhausted");
    expect(res.quotaInferred).toBe(true);
    expect(invocations(countFile)).toBe(1);
  }, 20_000);

  it("probe argv/cwd: -p + skip-permissions + own print-timeout, NO --add-dir, cwd is NOT the repo", async () => {
    const { dir, promptFile } = setup({ RG_REVIEW_MODE: "silent", RG_PROBE_MODE: "ok" });
    const argsOut = join(dir, "argv.txt");
    const pwdOut = join(dir, "pwd.txt");
    process.env.RG_ARGS_OUT = argsOut;
    process.env.RG_PWD_OUT = pwdOut;
    const adapter = new GeminiAdapter({ binPath: FAKE_STALL, probeTimeoutMs: 5000 });
    await adapter.review(reviewInput(dir, promptFile) as never);
    // Invocation index 1 = the probe.
    const probeArgv = readFileSync(`${argsOut}.1`, "utf8").split("\n").filter(Boolean);
    expect(probeArgv).toContain("-p");
    expect(probeArgv).toContain("--dangerously-skip-permissions");
    expect(probeArgv).toContain("--print-timeout");
    expect(probeArgv).toContain("5000ms");
    expect(probeArgv).not.toContain("--add-dir");
    const probeCwd = readFileSync(`${pwdOut}.1`, "utf8").trim();
    expect(probeCwd).not.toBe(dir); // never the repo/workingDir — the probe needs no repo access
  }, 20_000);
});
