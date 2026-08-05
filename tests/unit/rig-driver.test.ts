import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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
//
// The prompt is passed as a POSITIONAL ARGUMENT, never interpolated into the script text.
// JSON.stringify quotes for JSON, not for the shell: `$`, `$(...)` and backticks are not
// JSON-special and survive into a bash double-quoted string, where they still expand. A
// prompt containing `$HOME` would therefore be silently rewritten before printf saw it,
// and the ordering test that compares the snapshot against the prompt would pass while
// comparing the wrong thing (gate findings F-003/F-004).
const appendingAgent = (root: string) => (prompt: string) => [
  "bash",
  "-c",
  'printf "%s\\n" "$1" >> "$2"',
  "fake-agent",
  prompt,
  join(root, ".reviewgate", "agent.log"),
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

  test("captures a high-volume agent turn without buffering it in the parent", async () => {
    // NOT a deadlock regression, and it must not be renamed into one. The gate flagged
    // undrained `stdout: "pipe"` as a pipe-buffer deadlock (F-003, two reviewers, 0.97),
    // but that is Node `child_process` semantics: measured directly, Bun.spawn pushes 128MB
    // through an undrained pipe in 1.1s without blocking. This test was written as a
    // deadlock guard, then mutation-checked — it passed with the "pipe" version restored,
    // i.e. it was vacuous as a deadlock test. What it does guard is real and cheaper to
    // state honestly: a high-volume turn completes, and its output goes to the turn's
    // transcript file rather than into the parent's memory.
    const { root, scriptPath } = sandbox(1);
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: () => ["bash", "-c", "yes 0123456789012345678901234567890123456789 | head -50000"],
      maxTurns: 1,
    });
    expect(manifest.turns[0]?.agentExitCode).toBe(0);
    const log = readFileSync(join(manifest.turns[0]?.snapshotDir ?? "", "agent.log"), "utf8");
    expect(log.length).toBeGreaterThan(1_000_000);
  }, 30_000);

  test("keeps the agent transcript per turn instead of discarding it", async () => {
    const { root, scriptPath } = sandbox(1);
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: () => ["bash", "-c", "echo hello-from-agent; echo oops >&2"],
      maxTurns: 1,
    });
    const log = readFileSync(join(manifest.turns[0]?.snapshotDir ?? "", "agent.log"), "utf8");
    expect(log).toContain("hello-from-agent");
    expect(log).toContain("oops"); // stderr must land in the same transcript
  });

  test("passes a prompt containing shell metacharacters through literally", async () => {
    // Guards the test helper itself. If the prompt were interpolated into the bash script
    // text, `$HOME` and `$(...)` would expand and the ordering assertions elsewhere in this
    // file would compare against a silently rewritten prompt.
    const root = mkdtempSync(join(tmpdir(), "rg-rig-"));
    mkdirSync(join(root, ".reviewgate"), { recursive: true });
    const nasty = "turn $HOME and $(echo pwned) and `echo also`";
    const scriptPath = join(root, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        schema: "reviewgate.rig.turn-script.v1",
        id: "shell-meta",
        turns: [{ index: 1, prompt: nasty, seeded: null }],
      }),
    );
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: appendingAgent(root),
      maxTurns: 1,
    });
    const written = readFileSync(
      join(manifest.turns[0]?.snapshotDir ?? "", ".reviewgate", "agent.log"),
      "utf8",
    );
    expect(written).toContain(nasty);
    expect(written).not.toContain("pwned\n"); // the substitution must not have run
  });

  // Writes the way the real gate does — temp file then mv — and takes every path as a
  // POSITIONAL argument. Both matter: the archiver's contract assumes atomic writes, so a
  // helper using `>` (truncate-then-write) could be caught mid-write and archive an empty
  // report; and interpolating a path into a bash string via JSON.stringify is the exact
  // anti-pattern this file documents two helpers above (gate findings F-003/F-004).
  const gateLikeWriter = (steps: Array<{ file: string; body: string }>) => () => {
    const script = steps
      .map(
        (_, i) =>
          `printf '%s' "$${i * 2 + 2}" > "$${i * 2 + 1}.tmp"; mv "$${i * 2 + 1}.tmp" "$${i * 2 + 1}"; sleep 0.4`,
      )
      .join("; ");
    return ["bash", "-c", script, "fake-agent", ...steps.flatMap((s2) => [s2.file, s2.body])];
  };

  test("archives an intermediate pending.json that the turn later overwrites", async () => {
    // The whole point of the archiver. The gate rewrites pending.json every iteration, so
    // after a turn ends green it holds a PASS report with zero findings — and the iteration
    // that actually caught the seeded defect is gone. Recall would then read as "missed"
    // for a defect the gate did catch. The audit log cannot substitute: its signatures are
    // SHA-256 of [file, ruleId, ...], so no rule id or finding text survives in them.
    const { root, scriptPath } = sandbox(1);
    const pending = join(root, ".reviewgate", "pending.json");
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: gateLikeWriter([
        { file: pending, body: '{"verdict":"FAIL","findings":[{"rule_id":"path-traversal"}]}' },
        { file: pending, body: '{"verdict":"PASS","findings":[]}' },
      ]),
      maxTurns: 1,
    });
    const reportsDir = join(manifest.turns[0]?.snapshotDir ?? "", "reports");
    const archived = readdirSync(reportsDir)
      .filter((f) => f.endsWith("pending.json"))
      .map((f) => readFileSync(join(reportsDir, f), "utf8"));
    // The FAIL report must be recoverable even though the live file now says PASS.
    expect(archived.some((c) => c.includes("path-traversal"))).toBe(true);
    expect(readFileSync(pending, "utf8")).toContain("PASS");
    // And nothing torn or empty may have been archived along the way.
    expect(archived.every((c) => c.trim().length > 0)).toBe(true);
  }, 20_000);

  test("keeps every pending.md version, even when pending.json does not change", async () => {
    // Guards the clobber: with a single shared counter that only advanced on pending.json,
    // a second pending.md landing between two json rewrites was written under the previous
    // number and silently replaced its predecessor (gate finding F-001).
    const { root, scriptPath } = sandbox(1);
    const md = join(root, ".reviewgate", "pending.md");
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: gateLikeWriter([
        { file: md, body: "# iteration 1 report" },
        { file: md, body: "# iteration 2 report" },
      ]),
      maxTurns: 1,
    });
    const reportsDir = join(manifest.turns[0]?.snapshotDir ?? "", "reports");
    const mds = readdirSync(reportsDir)
      .filter((f) => f.endsWith("pending.md"))
      .map((f) => readFileSync(join(reportsDir, f), "utf8"));
    expect(mds.some((c) => c.includes("iteration 1"))).toBe(true);
    expect(mds.some((c) => c.includes("iteration 2"))).toBe(true);
  }, 20_000);

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

describe("rig run repo guards", () => {
  function gitRepo(dirty: boolean): string {
    const repo = mkdtempSync(join(tmpdir(), "rg-rig-git-"));
    Bun.spawnSync(["git", "init", "-q", "."], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
    Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });
    if (dirty) writeFileSync(join(repo, "a.txt"), "two\n");
    return repo;
  }
  const cassette = () => `record:${join(mkdtempSync(join(tmpdir(), "rg-cass-")), "c.jsonl")}`;
  const script = join(import.meta.dir, "..", "..", "rig", "scripts", "pilot-01.json");

  test("refuses a relative cassette path, which would land in the AGENT's cwd", async () => {
    await expect(
      runRigRun({
        scriptPath: script,
        outDir: mkdtempSync(join(tmpdir(), "rg-out-")),
        repoRoot: gitRepo(false),
        cassetteEnv: "record:cassette.jsonl",
      }),
    ).rejects.toThrow(/ABSOLUTE path/);
  });

  test("refuses a cassette outside the repo under review (the recorder does, mid-gate)", async () => {
    // The failure this prevents is silent and expensive: the recorder's refusal happens inside
    // the GATE's setup phase, so every turn completes with the agent's edits made and no review
    // at all. Three pilot attempts were lost to it before the pre-flight check learned the rule.
    const repo = gitRepo(false);
    await expect(
      runRigRun({
        scriptPath: script,
        outDir: mkdtempSync(join(tmpdir(), "rg-out-")),
        repoRoot: repo,
        cassetteEnv: `record:${join(mkdtempSync(join(tmpdir(), "rg-elsewhere-")), "c.jsonl")}`,
      }),
    ).rejects.toThrow(/INSIDE the repo under review/);
  });

  test("refuses to point an acceptEdits agent at a repo with uncommitted work", async () => {
    // The pilot script deliberately contains prompts like "put the API token directly in
    // the source". Harmless in a throwaway repo; not harmless in one somebody is using.
    // The cassette is deliberately VALID (inside the repo) so this exercises the dirty-repo
    // guard rather than tripping the containment guard first.
    const repo = gitRepo(true);
    await expect(
      runRigRun({
        scriptPath: script,
        outDir: mkdtempSync(join(tmpdir(), "rg-out-")),
        repoRoot: repo,
        cassetteEnv: `record:${join(repo, "cassette.jsonl")}`,
      }),
    ).rejects.toThrow(/uncommitted change/);
  });
});

describe("rig driver — unreviewed-turn guard", () => {
  // Reproduces pilot-01 turn 1 (2026-07-30): the agent edits, PostToolUse leaves dirty.flag
  // set, and the session ends WITHOUT its Stop hook firing, so no audit event is ever written.
  // Exit code 0 throughout. Before this guard the driver recorded a healthy-looking turn and
  // kept going; 11 more turns would have spent real quota producing zero measurements.
  const editingAgentThatNeverTriggersTheGate = (root: string) => (prompt: string) => [
    "bash",
    "-c",
    'printf "%s\\n" "$1" >> "$2/edit.txt"; printf "{}" > "$2/.reviewgate/dirty.flag"',
    "fake-agent",
    prompt,
    root,
  ];

  test("flags a turn the gate never reviewed instead of recording it as healthy", async () => {
    const { root, scriptPath } = sandbox(1);
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: editingAgentThatNeverTriggersTheGate(root),
    });
    expect(manifest.turns[0]?.agentExitCode).toBe(0); // exit 0 proves nothing
    expect(manifest.turns[0]?.gateReviewed).toBe(false);
  });

  test("aborts the run after two consecutive unreviewed turns, keeping the partial manifest", async () => {
    const { root, scriptPath } = sandbox(4);
    await expect(
      runDriver({
        scriptPath,
        outDir: join(root, "out"),
        repoRoot: root,
        agentCmd: editingAgentThatNeverTriggersTheGate(root),
      }),
    ).rejects.toThrow(/ABORTING after 2 consecutive turns/);
    // The completed turns stay harvestable rather than the whole run being lost.
    const written = JSON.parse(readFileSync(join(root, "out", "manifest.json"), "utf8"));
    expect(written.turns).toHaveLength(2);
  });

  test("records the code the agent actually wrote, so seed landing stays checkable", async () => {
    // pilot-01's turn 9 is the reason: the script directed a hardcoded token, the agent wrote
    // the env-var version instead, and NOTHING in the recorded artifacts could show that the
    // seeded defect never landed — so the miss was charged to the reviewer. The source has to
    // be recorded for a later `seed_landed` check to be possible at all.
    const { root, scriptPath } = sandbox(1);
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    execFileSync("git", ["config", "user.email", "rig@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "rig"], { cwd: root });
    writeFileSync(join(root, "seed.ts"), "export const x = 1\n");
    execFileSync("git", ["add", "seed.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: root });

    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      // Stands in for the agent writing source: the defect (or its refusal) lives HERE, in
      // the code, not in anything .reviewgate/ records.
      agentCmd: () => [
        "bash",
        "-c",
        `printf 'const API_TOKEN = process.env.REPORT_API_TOKEN\\n' > ${JSON.stringify(join(root, "notify.ts"))}`,
      ],
    });

    const patchPath = join(manifest.turns[0]?.snapshotDir ?? "", "diff.patch");
    expect(existsSync(patchPath)).toBe(true);
    const patch = readFileSync(patchPath, "utf8");
    expect(patch).toContain("notify.ts");
    expect(patch).toContain("process.env.REPORT_API_TOKEN");
    expect(manifest.turns[0]?.diffBytes).toBe(Buffer.byteLength(patch, "utf8"));
  });

  test("a turn that leaves NO dirty flag is not counted as unreviewed (a legitimate skip)", async () => {
    const { root, scriptPath } = sandbox(3);
    // Edits nothing and clears no flag: the gate had nothing to review, which is not a failure.
    const manifest = await runDriver({
      scriptPath,
      outDir: join(root, "out"),
      repoRoot: root,
      agentCmd: () => ["bash", "-c", "true"],
    });
    expect(manifest.turns).toHaveLength(3);
    expect(manifest.turns.every((t) => t.gateReviewed === true)).toBe(true);
  });
});
