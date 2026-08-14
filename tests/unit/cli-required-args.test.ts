// tests/unit/cli-required-args.test.ts
// F-079: mandatory flags must be declared `required: true` in the citty arg
// schema (not validated ad-hoc inside the run-function). When declared, citty
// enforces them at the parser layer — emitting `Missing required argument:
// --<flag>` and exiting 1 BEFORE the run-function is reached — and `--help`
// renders a "(required)" marker. We assert the parser-level enforcement, which
// is what `required: true` switches on (the same flag also drives the help
// marker). The pre-fix manual checks instead printed "... is required" and
// exited 2, so the citty message + exit-1 distinguishes fixed from unfixed.
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function runSync(args: string[]): { code: number; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "rg-cli-help-"));
  const outputPath = join(root, "output.txt");
  const output = openSync(outputPath, "w");
  try {
    const proc = spawnSync("bun", [CLI, ...args], {
      stdio: ["ignore", output, output],
      env: { ...process.env, NODE_ENV: "production" },
    });
    closeSync(output);
    return { code: proc.status ?? -1, stdout: readFileSync(outputPath, "utf8"), stderr: "" };
  } finally {
    try {
      closeSync(output);
    } catch {
      // The successful path closes before reading; only the exceptional path reaches this close.
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe("CLI required-arg declarations (F-079)", () => {
  const cases: Array<{ name: string; argv: string[]; flag: string }> = [
    { name: "audit verify --file", argv: ["audit", "verify"], flag: "file" },
    { name: "brain show --id", argv: ["brain", "show"], flag: "id" },
    { name: "brain revoke --id", argv: ["brain", "revoke"], flag: "id" },
    { name: "fp show --id", argv: ["fp", "show"], flag: "id" },
    { name: "fp unpin --id", argv: ["fp", "unpin"], flag: "id" },
    { name: "bench policy --preregistration", argv: ["bench", "policy"], flag: "preregistration" },
    {
      name: "stats policy attest-dogfood --input-manifest",
      argv: ["stats", "policy", "attest-dogfood"],
      flag: "input-manifest",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: citty enforces the flag at the parser layer`, async () => {
      const { code, stderr } = await run(c.argv);
      // citty's parser-level enforcement (proves `required: true` is declared
      // in the arg schema, not just a manual check inside run()).
      expect(stderr).toContain(`Missing required argument: --${c.flag}`);
      expect(code).toBe(1);
    });
  }
});

describe("Rig authority exit code", () => {
  it("maps a typed cross-catalog harvest invalidity to exact exit 4", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-rig-authority-cli-"));
    const scriptPath = join(root, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        schema: "reviewgate.rig.turn-script.v1",
        id: "authority",
        turns: [{ index: 1, prompt: "turn", seeded: null }],
      }),
    );
    const manifestPath = join(root, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: "reviewgate.rig.manifest.v1",
        runId: "authority-run",
        scriptId: "authority",
        outDir: root,
        turns: [],
        policyReplay: {
          catalogVersion: "reviewgate.policy-catalog.future",
          sourceCommit: "a".repeat(40),
          initialStateRef: `policy-state/${"b".repeat(64)}.json`,
          initialStateSha256: "b".repeat(64),
          initialStateDigest: "c".repeat(64),
          cassetteSha256: "d".repeat(64),
          cassetteRef: "cassette.jsonl",
          captureDir: "policy-replay",
        },
      }),
    );

    const { code, stderr } = await run([
      "rig",
      "harvest",
      "--manifest",
      manifestPath,
      "--script",
      scriptPath,
    ]);
    expect(code).toBe(4);
    expect(stderr).toContain("catalog-mismatch");
  });
});

describe("policy replay CLI help contracts", () => {
  it("keeps bare stats on its existing report path rather than routing it into policy analysis", () => {
    const bare = runSync(["stats", "--json"]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain('"window"');
    expect(`${bare.stdout}${bare.stderr}`).not.toContain("policy measurement:");
  });

  it("requires the four direct policy-analysis inputs without imposing them on attestation", async () => {
    const direct = await run(["stats", "policy"]);
    expect(direct.code).toBe(2);
    expect(direct.stderr).toContain("Missing required argument: --preregistration");

    const attestationRoot = join(mkdtempSync(join(tmpdir(), "rg-policy-attest-nontty-")), "out");
    const child = await run([
      "stats",
      "policy",
      "attest-dogfood",
      "--input-manifest",
      "artifacts/policy-dogfood-input/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
      "--adjudication",
      "draft.json",
      "--actor",
      "human",
      "--out",
      attestationRoot,
    ]);
    expect(child.code).toBe(1);
    expect(child.stderr).toContain("requires a real interactive terminal");
    expect(child.stderr).not.toContain("--preregistration");
    expect(existsSync(attestationRoot)).toBe(false);
  });

  it("exposes no-provider policy capture and analysis commands", () => {
    for (const argv of [
      ["bench", "policy", "--help"],
      ["stats", "policy", "--help"],
      ["stats", "policy", "attest-dogfood", "--help"],
    ]) {
      const { code, stdout, stderr } = runSync(argv);
      expect(code).toBe(0);
      expect(`${stdout}${stderr}`).toContain("policy");
    }
    const { stdout, stderr } = runSync(["stats", "policy", "--help"]);
    const help = `${stdout}${stderr}`;
    for (const flag of ["preregistration", "bench", "rig", "out"]) {
      expect(help).toContain(`--${flag}`);
      expect(help).toContain("required for direct policy analysis");
    }
  });

  it("describes Bench Matrix as exact internal closed-catalog ablation", () => {
    const { code, stdout, stderr } = runSync(["bench", "matrix", "--help"]);
    const help = `${stdout}${stderr}`;

    expect(code).toBe(0);
    expect(help).toContain("exact internal policy ablations");
    expect(help).toContain("evidence.fact-location");
    expect(help).toContain("legacy aliases accepted for compatibility");
    expect(help).toContain("critic,confidence-floor,reputation,scope-to-diff");
    expect(help).not.toContain("suppression layers toggled");
    expect(help).not.toContain("critic-only authoritative protocol");
  });

  it("describes Rig Cassette verification by stable logical identity and hashes", () => {
    const { code, stdout, stderr } = runSync(["rig", "replay", "--help"]);
    const help = `${stdout}${stderr}`;

    expect(code).toBe(0);
    expect(help).toContain("stable logical call identity");
    expect(help).toContain("ordered response hashes");
    expect(help).not.toContain("FIFO");
  });

  it("keeps Audit help as the unchanged control", () => {
    const { code, stdout, stderr } = runSync(["audit", "--help"]);
    const help = `${stdout}${stderr}`;

    expect(code).toBe(0);
    expect(help).toContain("Audit utilities");
    expect(help).toContain("verify");
  });
});
