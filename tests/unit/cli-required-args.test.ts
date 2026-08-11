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
import { mkdtempSync, writeFileSync } from "node:fs";
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

describe("CLI required-arg declarations (F-079)", () => {
  const cases: Array<{ name: string; argv: string[]; flag: string }> = [
    { name: "audit verify --file", argv: ["audit", "verify"], flag: "file" },
    { name: "brain show --id", argv: ["brain", "show"], flag: "id" },
    { name: "brain revoke --id", argv: ["brain", "revoke"], flag: "id" },
    { name: "fp show --id", argv: ["fp", "show"], flag: "id" },
    { name: "fp unpin --id", argv: ["fp", "unpin"], flag: "id" },
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
