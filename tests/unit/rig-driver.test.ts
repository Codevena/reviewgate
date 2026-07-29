import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRigRun } from "../../src/cli/commands/rig.ts";
import { runDriver } from "../../src/rig/driver.ts";

// The driver spawns a real agent process per turn. Every test here injects a FAKE agent
// instead — a shell one-liner that writes a marker. A test that spent `claude -p` quota
// would be unrunnable in CI and too slow to iterate on, and none of the driver's own
// behaviour (ordering, snapshotting, manifest durability, quiescence) needs a real model.
function sandbox(turns: number): { root: string; scriptPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rg-rig-"));
  mkdirSync(join(root, ".reviewgate"), { recursive: true });
  const scriptPath = join(root, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      schema: "reviewgate.rig.turn-script.v1",
      id: "t",
      turns: Array.from({ length: turns }, (_, i) => ({
        index: i + 1,
        prompt: `turn ${i + 1}`,
        seeded: null,
      })),
    }),
  );
  return { root, scriptPath };
}

// Fake agent: append the prompt to a file INSIDE .reviewgate/, so a snapshot taken before
// the agent ran is distinguishable from one taken after.
const appendingAgent = (root: string) => (prompt: string) => [
  "bash",
  "-c",
  `printf '%s\\n' ${JSON.stringify(prompt)} >> ${JSON.stringify(join(root, ".reviewgate", "agent.log"))}`,
];

describe("rig driver", () => {
  test("runs one snapshot per turn and honours maxTurns", async () => {
    const { root, scriptPath } = sandbox(3);
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: appendingAgent(root),
      maxTurns: 2,
    });
    expect(manifest.turns).toHaveLength(2);
    expect(existsSync(manifest.turns[0]?.snapshotDir ?? "")).toBe(true);
    expect(existsSync(manifest.turns[1]?.snapshotDir ?? "")).toBe(true);
  });

  test("snapshots AFTER the agent ran, so the turn's own effect is captured", async () => {
    // The load-bearing ordering guarantee. A snapshot taken before the agent (or before its
    // Stop hook finished) captures the PREVIOUS turn's state, which would silently attribute
    // every turn's findings to its predecessor.
    const { root, scriptPath } = sandbox(1);
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: appendingAgent(root),
      maxTurns: 1,
    });
    const snapshotted = join(manifest.turns[0]?.snapshotDir ?? "", ".reviewgate", "agent.log");
    expect(existsSync(snapshotted)).toBe(true);
    expect(readFileSync(snapshotted, "utf8")).toContain("turn 1");
  });

  test("lays the snapshot out as a repo root, so loadAuditWindow can read it unchanged", async () => {
    // loadAuditWindow resolves auditDir(repoRoot); the snapshot must therefore contain a
    // directory literally named `.reviewgate`, not `reviewgate`.
    const { root, scriptPath } = sandbox(1);
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: appendingAgent(root),
      maxTurns: 1,
    });
    expect(existsSync(join(manifest.turns[0]?.snapshotDir ?? "", ".reviewgate"))).toBe(true);
  });

  test("writes the manifest after every turn, so a killed run stays harvestable", async () => {
    const { root, scriptPath } = sandbox(2);
    const outDir = join(root, "out");
    await runDriver({
      scriptPath,
      outDir,
      repoRoot: root,
      agentCmd: appendingAgent(root),
      maxTurns: 2,
    });
    const onDisk = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(onDisk.turns).toHaveLength(2);
  });

  test("fails the turn LOUDLY when the workspace never goes quiescent", async () => {
    // A held gate.lock means a gate process is still writing. Harvesting then yields a torn
    // snapshot whose numbers nobody can trace back to a defect, so the driver must refuse
    // rather than record a plausible-looking partial.
    const { root, scriptPath } = sandbox(1);
    writeFileSync(join(root, ".reviewgate", "gate.lock"), "held");
    await expect(
      runDriver({
        scriptPath,
        outDir: join(root, "out"),
        repoRoot: root,
        agentCmd: appendingAgent(root),
        maxTurns: 1,
        quiesceTimeoutMs: 150,
      }),
    ).rejects.toThrow(/quiescent|gate\.lock/i);
  });

  test("refuses to snapshot while an audit file has a torn trailing line", async () => {
    // The audit log matters more than state.json here: a clean-PASS re-arm wipes state.json
    // and decisions/, so the audit tree is the only surviving per-iteration record and the
    // only thing the harvester reads. A torn trailing JSONL line must therefore block the
    // snapshot, not ride along and read downstream as "this turn had no iterations".
    const { root, scriptPath } = sandbox(1);
    const auditDay = join(root, ".reviewgate", "audit", "2026", "07", "30");
    mkdirSync(auditDay, { recursive: true });
    writeFileSync(
      join(auditDay, "run.jsonl"),
      `${JSON.stringify({ event: "run.complete", iter: 1 })}\n{"event":"gate.dec`,
    );
    await expect(
      runDriver({
        scriptPath,
        outDir: join(root, "out"),
        repoRoot: root,
        agentCmd: appendingAgent(root),
        maxTurns: 1,
        quiesceTimeoutMs: 150,
      }),
    ).rejects.toThrow(/torn trailing line/i);
  });

  test("a complete audit file does NOT block the snapshot", async () => {
    // Guards the obvious over-correction: if the torn-line check rejected well-formed logs
    // too, every real run would fail and the guard above would look like it works.
    const { root, scriptPath } = sandbox(1);
    const auditDay = join(root, ".reviewgate", "audit", "2026", "07", "30");
    mkdirSync(auditDay, { recursive: true });
    writeFileSync(
      join(auditDay, "run.jsonl"),
      `${JSON.stringify({ event: "run.complete", iter: 1 })}\n`,
    );
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: appendingAgent(root),
      maxTurns: 1,
      quiesceTimeoutMs: 150,
    });
    expect(manifest.turns).toHaveLength(1);
  });

  test("records the agent's exit code instead of swallowing a failed turn", async () => {
    const { root, scriptPath } = sandbox(1);
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: () => ["bash", "-c", "exit 3"],
      maxTurns: 1,
    });
    expect(manifest.turns[0]?.agentExitCode).toBe(3);
  });
});

// Only the REJECTION path is testable here: the accepting path spawns a real `claude -p`
// and would spend quota from a unit test. That asymmetry is the point of the guard —
// starting the expensive thing is exactly what must not happen by accident.
describe("rig run cassette guard", () => {
  const input = (cassetteEnv?: string) => ({
    scriptPath: join(import.meta.dir, "..", "..", "rig", "scripts", "pilot-01.json"),
    outDir: mkdtempSync(join(tmpdir(), "rg-rig-out-")),
    repoRoot: mkdtempSync(join(tmpdir(), "rg-rig-repo-")),
    cassetteEnv,
  });

  test("refuses to start an unrecorded run", async () => {
    await expect(runRigRun(input(undefined))).rejects.toThrow(/REVIEWGATE_CASSETTE/);
  });

  test("refuses replay mode: `rig run` is the recording driver", async () => {
    await expect(runRigRun(input("replay:/tmp/x.jsonl"))).rejects.toThrow(/record:/);
  });
});

describe("rig run cassette destination", () => {
  const base = (cassetteEnv: string) => ({
    scriptPath: join(import.meta.dir, "..", "..", "rig", "scripts", "pilot-01.json"),
    outDir: mkdtempSync(join(tmpdir(), "rg-rig-out-")),
    repoRoot: mkdtempSync(join(tmpdir(), "rg-rig-repo-")),
    cassetteEnv,
  });

  test("refuses a record path whose directory does not exist", async () => {
    // `record:` prefix alone is not proof of a recording: this would spend a whole
    // multi-turn run's quota and write the cassette nowhere.
    await expect(runRigRun(base("record:/nonexistent-dir-xyz/c.jsonl"))).rejects.toThrow(
      /does not exist/,
    );
  });
});
