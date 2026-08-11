import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../../src/core/aggregator.ts";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import { groundFindings } from "../../src/core/grounding.ts";
import { demoteHypotheticalCriticals } from "../../src/core/hypothetical-demote.ts";
import { POLICY_CATALOG_VERSION } from "../../src/core/policy/catalog.ts";
import { capturePolicyReplayEnvelope } from "../../src/core/policy/replay-capture.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import {
  RigAuthorityError,
  createPolicyStateSnapshot,
  digestPolicyState,
  validateRigPolicyReplayArtifacts,
} from "../../src/rig/policy-replay-state.ts";
import {
  checkCassette,
  checkDeterminism,
  replay,
  replayPolicyEnvelopePair,
  replayPolicyEnvelopeSequence,
  runWithReplayProviderCeiling,
} from "../../src/rig/replay.ts";
import {
  type PolicyReplayEnvelopeInput,
  PolicyReplayEnvelopeSchema,
} from "../../src/schemas/policy-replay.ts";
import type { RigManifest } from "../../src/schemas/rig-manifest.ts";

/** Smallest run that harvests: one turn, one snapshot laid out as a repo root. */
function miniRun(): { manifestPath: string; scriptPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "rg-replay-"));
  const snapshotDir = join(root, "turns", "1");
  mkdirSync(join(snapshotDir, ".reviewgate", "audit", "2026", "08", "05"), { recursive: true });
  writeFileSync(
    join(snapshotDir, ".reviewgate", "audit", "2026", "08", "05", "gate.jsonl"),
    `${JSON.stringify({
      schema: "reviewgate.audit.v1",
      ts: "2026-08-05T09:00:00.000Z",
      run_id: "r1",
      iter: 1,
      event: "run.complete",
      trigger: "stop-hook",
      prev_event_hash: "",
      this_event_hash: "h1",
      run_summary: {
        verdict: "PASS",
        source: "panel",
        counts: { critical: 0, warn: 0, info: 0 },
        cost_usd: 0.01,
        duration_ms: 1000,
        demoted: 0,
        signatures: [],
        providers: [],
      },
    })}\n`,
  );
  const scriptPath = join(root, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      schema: "reviewgate.rig.turn-script.v1",
      id: "mini",
      turns: [{ index: 1, prompt: "t1", seeded: null }],
    }),
  );
  const manifestPath = join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: "reviewgate.rig.manifest.v1",
      runId: "mini-1",
      scriptId: "mini",
      outDir: root,
      turns: [{ index: 1, snapshotDir, agentExitCode: 0, wallMs: 1000, gateReviewed: true }],
    }),
  );
  return { manifestPath, scriptPath, root };
}

function cassette(root: string, lines: string[]): string {
  const p = join(root, "cassette.jsonl");
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}

/** A schema-valid recorded review call. `findings` is the only part these tests vary. */
const entry = (key: string, result: Record<string, unknown> | "empty") =>
  JSON.stringify({
    schema: "reviewgate.cassette.entry.v1",
    provider: "openrouter",
    method: "review",
    key,
    promptSha256: "a".repeat(64),
    result:
      result === "empty"
        ? {}
        : {
            reviewerId: key,
            verdict: "PASS",
            findings: [],
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, quotaUsedPct: null },
            durationMs: 100,
            exitCode: 0,
            rawEventsPath: "",
            status: "ok",
            ...result,
          },
  });

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyPolicyTrace(
  rawResponseSha256: string[],
  identity: { runId: string; iter: number } = { runId: "exact-run", iter: 1 },
) {
  const runtime = PolicyTraceRecorder.start({
    runId: identity.runId,
    iter: identity.iter,
    ablated: new Set(),
  });
  const result = aggregate({
    findings: [],
    reviewersTotal: 1,
    changedRanges: new Map(),
    scopeToDiff: true,
    outOfDiffBlocking: [],
    confidenceFloor: 0,
    demoteCorrectness: true,
    corroborateCritical: true,
    demoteTestSecurity: true,
    capDocsSeverity: true,
    critic: new Map(),
    fpActive: new Map(),
    fpActiveClusters: new Map(),
    repUnreliable: new Set(),
    protectedReviewers: new Set(),
    foreignFiles: new Set(),
    cycleRejected: new Set(),
    claimedFixed: new Map(),
    deltaScope: new Set(),
    rejectedRegions: [],
    policyRuntime: runtime,
    policyInactive: {},
  });
  const trace = runtime.finalize({
    rawResponseSha256,
    verdict: result.verdict,
    finalFindings: result.dedupedFindings,
  });
  if (trace === null) throw new Error("trace fixture failed");
  return trace;
}

function exactRun(): {
  sourceRepoRoot: string;
  root: string;
  manifestPath: string;
  manifest: RigManifest;
  envelope: PolicyReplayEnvelopeInput;
  stateRoot: string;
  sinkDir: string;
} {
  const sourceRepoRoot = mkdtempSync(join(tmpdir(), "rg-policy-replay-source-"));
  execFileSync("git", ["init", "-q", "."], { cwd: sourceRepoRoot });
  execFileSync("git", ["config", "user.email", "rig@example.invalid"], {
    cwd: sourceRepoRoot,
  });
  execFileSync("git", ["config", "user.name", "rig"], { cwd: sourceRepoRoot });
  mkdirSync(join(sourceRepoRoot, "src"));
  writeFileSync(join(sourceRepoRoot, "src", "x.ts"), "export const x = 1;\n");
  mkdirSync(join(sourceRepoRoot, ".reviewgate"));
  writeFileSync(join(sourceRepoRoot, ".reviewgate", "fp-ledger.jsonl"), "");
  execFileSync("git", ["add", "src/x.ts"], { cwd: sourceRepoRoot });
  execFileSync("git", ["commit", "-qm", "source"], { cwd: sourceRepoRoot });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRepoRoot,
    encoding: "utf8",
  }).trim();

  const root = mkdtempSync(join(tmpdir(), "rg-policy-replay-run-"));
  const state = createPolicyStateSnapshot({ sourceRepoRoot, outputRoot: root });
  const rawText = "safe recorded review response";
  const rawHash = sha256(rawText);
  const policyTrace = emptyPolicyTrace([rawHash]);
  const envelope: PolicyReplayEnvelopeInput = {
    schema: "reviewgate.policy-replay-envelope.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    run_id: "exact-run",
    iter: 1,
    source_commit: sourceCommit,
    exact_diff: "",
    pre_policy_findings: [],
    grounding: { corpus: "", verdicts: [], llm_status: "not-run" },
    aggregate: {
      findings: [],
      reviewers_total: 1,
      changed_ranges: [],
      scope_to_diff: true,
      out_of_diff_blocking: [],
      confidence_floor: 0,
      demote_correctness: true,
      corroborate_critical: true,
      demote_test_security: true,
      cap_docs_severity: true,
      critic: [],
      fp_active: [],
      fp_active_clusters: [],
      rep_unreliable: [],
      protected_reviewers: [],
      foreign_files: [],
      cycle_rejected: [],
      claimed_fixed: [],
      delta_scope: [],
      rejected_regions: [],
      policy_inactive: [],
    },
    policy_final_findings: [],
    pre_policy: { self_refutation_enabled: true, hypothetical_enabled: true },
    state_sha256: state.stateSha256,
    raw_response_sha256: [rawHash],
    policy_trace: policyTrace,
    lossless: true,
  };
  const sinkDir = join(root, "policy-replay");
  mkdirSync(sinkDir, { mode: 0o700 });
  const stored = capturePolicyReplayEnvelope({
    sinkDir,
    measuredRepoRoot: sourceRepoRoot,
    envelope,
  });
  if (stored.status !== "complete") throw new Error("capture fixture failed");
  const cassettePath = join(root, "cassette.jsonl");
  writeFileSync(cassettePath, `${entry("openrouter-security", { rawText })}\n`, { mode: 0o600 });
  const manifestPath = join(root, "manifest.json");
  const manifest: RigManifest = {
    schema: "reviewgate.rig.manifest.v1",
    runId: "exact-rig",
    scriptId: "exact-script",
    outDir: root,
    turns: [
      {
        index: 1,
        snapshotDir: join(root, "turns", "1"),
        agentExitCode: 0,
        wallMs: 1,
        policyReplay: { status: "complete", traces: [{ ref: stored.ref, sha256: stored.sha256 }] },
      },
    ],
    policyReplay: {
      catalogVersion: POLICY_CATALOG_VERSION,
      sourceCommit,
      initialStateRef: state.ref,
      initialStateSha256: state.sha256,
      initialStateDigest: state.stateSha256,
      cassetteSha256: sha256(readFileSync(cassettePath)),
      cassetteRef: "cassette.jsonl",
      captureDir: "policy-replay",
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    sourceRepoRoot,
    root,
    manifestPath,
    manifest,
    envelope,
    stateRoot: join(root, state.stateRef),
    sinkDir,
  };
}

function replaceTrace(
  fixture: ReturnType<typeof exactRun>,
  envelope: PolicyReplayEnvelopeInput,
): void {
  const stored = capturePolicyReplayEnvelope({
    sinkDir: fixture.sinkDir,
    measuredRepoRoot: fixture.sourceRepoRoot,
    envelope,
  });
  if (stored.status !== "complete") throw new Error("replacement capture failed");
  const turn = fixture.manifest.turns[0];
  if (turn === undefined) throw new Error("turn fixture missing");
  turn.policyReplay = { status: "complete", traces: [{ ref: stored.ref, sha256: stored.sha256 }] };
}

function confidenceEnvelope(fixture: ReturnType<typeof exactRun>): PolicyReplayEnvelopeInput {
  const finding = {
    id: "confidence-1",
    signature: "confidence-sig",
    severity: "WARN" as const,
    category: "quality" as const,
    rule_id: "confidence-rule",
    file: "src/x.ts",
    line_start: 1,
    line_end: 1,
    message: "Low-confidence warning",
    details: "The reviewer explicitly reports uncertainty.",
    reviewer: { provider: "codex", model: "gpt-5", persona: "quality" },
    confidence: 0.2,
    consensus: "singleton" as const,
  };
  const runtime = PolicyTraceRecorder.start({
    runId: "exact-run",
    iter: 1,
    ablated: new Set(),
  });
  const factChecked = validateFindingFacts([finding], fixture.sourceRepoRoot, new Set(), runtime);
  const selfScreened = demoteSelfRefuting(factChecked, true, runtime);
  const hypothetical = demoteHypotheticalCriticals(selfScreened, true, runtime);
  const grounded = groundFindings(hypothetical, "", runtime);
  runtime.markInactive("judgment.grounding-llm", "configured-off");
  const policyInactive = {
    "judgment.critic": "configured-off" as const,
    "scope.diff": "configured-off" as const,
    "scope.delta": "stage-precondition-miss" as const,
    "scope.session": "stage-precondition-miss" as const,
  };
  const result = aggregate({
    findings: grounded,
    reviewersTotal: 1,
    changedRanges: new Map(),
    scopeToDiff: false,
    outOfDiffBlocking: [],
    confidenceFloor: 0.8,
    demoteCorrectness: true,
    corroborateCritical: true,
    demoteTestSecurity: true,
    capDocsSeverity: true,
    critic: new Map(),
    fpActive: new Map(),
    fpActiveClusters: new Map(),
    repUnreliable: new Set(),
    protectedReviewers: new Set(),
    foreignFiles: new Set(),
    cycleRejected: new Set(),
    claimedFixed: new Map(),
    deltaScope: new Set(),
    rejectedRegions: [],
    policyRuntime: runtime,
    policyInactive,
  });
  const policyTrace = runtime.finalize({
    rawResponseSha256: [...fixture.envelope.raw_response_sha256],
    verdict: result.verdict,
    finalFindings: result.dedupedFindings,
  });
  if (policyTrace === null) throw new Error("confidence trace fixture failed");
  return {
    ...fixture.envelope,
    pre_policy_findings: [finding],
    grounding: { corpus: "", verdicts: [], llm_status: "not-run" },
    aggregate: {
      findings: grounded,
      reviewers_total: 1,
      changed_ranges: [],
      scope_to_diff: false,
      out_of_diff_blocking: [],
      confidence_floor: 0.8,
      demote_correctness: true,
      corroborate_critical: true,
      demote_test_security: true,
      cap_docs_severity: true,
      critic: [],
      fp_active: [],
      fp_active_clusters: [],
      rep_unreliable: [],
      protected_reviewers: [],
      foreign_files: [],
      cycle_rejected: [],
      claimed_fixed: [],
      delta_scope: [],
      rejected_regions: [],
      policy_inactive: Object.entries(policyInactive)
        .map(([pass_id, reason_code]) => ({
          pass_id: pass_id as keyof typeof policyInactive,
          reason_code,
        }))
        .sort((left, right) => left.pass_id.localeCompare(right.pass_id)),
    },
    policy_final_findings: result.dedupedFindings,
    policy_trace: policyTrace,
  };
}

describe("rig replay — determinism self-check", () => {
  test("a run whose metrics re-derive identically is DETERMINISTIC", () => {
    const { manifestPath, scriptPath } = miniRun();
    const r = checkDeterminism(manifestPath, scriptPath);
    expect(r.deterministic).toBe(true);
    expect(r.differences).toEqual([]);
    expect(r.turns).toBe(1);
  });

  // NOTE on the negative case. There is deliberately no unit test that forces
  // `deterministic: false`, because faking it would mean stubbing `harvest`/`ablate` and the
  // test would then prove only that the stub differs from itself. The check's ability to FAIL
  // is not assumed, though — it was observed: on first contact with the real pilot it
  // reported NON-DETERMINISTIC for all four layers, because the ablation embeds two full
  // RigResults and inherited their `harvested_at`. That bug is why `stripAblationVolatile`
  // exists, and it is the evidence that the comparison is sensitive rather than vacuous.
});

describe("rig replay — cassette integrity", () => {
  test("counts recorded calls per reviewer key", () => {
    // The per-key counts are what make the recording addressable: a replay serves each key's
    // queue FIFO, so an uneven or short queue is how a replay silently misaligns.
    const { root } = miniRun();
    const p = cassette(root, [
      entry("openrouter-security", { findings: [] }),
      entry("openrouter-security", { findings: [] }),
      entry("ollama-correctness", { findings: [] }),
    ]);
    const c = checkCassette(p);
    expect(c.entries).toBe(3);
    expect(c.byKey).toEqual({ "openrouter-security": 2, "ollama-correctness": 1 });
    expect(c.malformedLines).toBe(0);
    // These three recorded clean reviews, so the counter must NOT over-report.
    expect(c.reviewsWithFindings).toBe(0);
  });

  test("a malformed line is COUNTED, never silently dropped", () => {
    // A recording that lost lines replays as a shorter FIFO: reviewers start being served
    // the next turn's answers. Skipping quietly (as loadCassette does, by design, so a live
    // replay degrades rather than dies) is wrong for an integrity CHECK.
    const { root } = miniRun();
    const p = cassette(root, [entry("openrouter-security", { findings: [] }), "{not json", "  "]);
    const c = checkCassette(p);
    expect(c.entries).toBe(1);
    expect(c.malformedLines).toBe(1); // the blank line is not an error
  });

  test("an entry whose result body is empty is MALFORMED, not a review that found nothing", () => {
    // The schema's result union has no member accepting `{}`. Worth pinning: an earlier
    // version of this check carried a `withResult` counter for exactly that case — a metric
    // the schema makes unreachable, so it always equalled `entries` and always read as a
    // passed check.
    const { root } = miniRun();
    const p = cassette(root, [
      entry("openrouter-security", { findings: [] }),
      entry("openrouter-security", "empty"),
    ]);
    const c = checkCassette(p);
    expect(c.entries).toBe(1);
    expect(c.malformedLines).toBe(1);
  });

  test("a --cassette path that does not exist fails loudly", async () => {
    const { manifestPath, scriptPath, root } = miniRun();
    await expect(
      replay({ manifestPath, scriptPath, cassettePath: join(root, "nope.jsonl") }),
    ).rejects.toThrow(/no cassette at/);
  });
});

describe("rig replay — exact policy authority", () => {
  test("turns any attempted network or provider subprocess call into authority exit 4", () => {
    const attempts: Array<() => unknown> = [
      () => fetch("https://example.invalid"),
      () => Bun.spawn(["true"]),
    ];
    for (const attempt of attempts) {
      try {
        runWithReplayProviderCeiling(attempt);
        throw new Error("live provider attempt unexpectedly escaped the ceiling");
      } catch (error) {
        expect(error).toBeInstanceOf(RigAuthorityError);
        expect((error as RigAuthorityError).code).toBe("live-provider-call");
        expect((error as RigAuthorityError).exitCode).toBe(4);
      }
    }
  });

  test("replays production policy in isolated branches without a live provider capability", () => {
    const fixture = exactRun();
    const validated = validateRigPolicyReplayArtifacts({
      manifest: fixture.manifest,
      manifestPath: fixture.manifestPath,
    });
    expect(validated).not.toBeNull();
    const item = validated?.turns.get(1)?.[0];
    if (item === undefined) throw new Error("validated trace missing");
    const pair = replayPolicyEnvelopePair({
      sourceRepoRoot: fixture.sourceRepoRoot,
      envelope: item.envelope,
      stateSnapshotRoot: item.stateRoot,
      passId: "judgment.confidence",
    });
    expect(pair.baseline.raw_response_sha256).toEqual(pair.counterfactual.raw_response_sha256);
    expect(pair.counterfactual.ablated).toEqual(["judgment.confidence"]);
  });

  test("allows the ablated production pass to change output after reproducing the baseline", () => {
    const fixture = exactRun();
    const candidate = PolicyReplayEnvelopeSchema.parse(confidenceEnvelope(fixture));
    const pair = replayPolicyEnvelopePair({
      sourceRepoRoot: fixture.sourceRepoRoot,
      envelope: candidate,
      stateSnapshotRoot: fixture.stateRoot,
      passId: "judgment.confidence",
    });
    expect(pair.baseline.final.counts.info).toBe(1);
    expect(pair.counterfactual.final.counts.warn).toBe(1);
  });

  test("keeps one branch pair and branch-local Store writes across a multi-envelope sequence", async () => {
    const fixture = exactRun();
    const sourceStateBefore = digestPolicyState(join(fixture.sourceRepoRoot, ".reviewgate"));
    const sourceFileBefore = readFileSync(join(fixture.sourceRepoRoot, "src", "x.ts"), "utf8");
    const expectedRepo = mkdtempSync(join(tmpdir(), "rg-policy-sequence-expected-"));
    cpSync(fixture.stateRoot, join(expectedRepo, ".reviewgate"), { recursive: true });
    const event = {
      reviewerKey: "codex:quality",
      eid: "exact-run:1:confidence-sig:codex:quality",
      ts: "2026-08-11T12:00:00.000Z",
    };
    await new ReputationStore(expectedRepo).record([{ ...event, outcome: "correct" }], {
      now: new Date(event.ts),
    });
    const expectedOutput = mkdtempSync(join(tmpdir(), "rg-policy-sequence-state-"));
    const secondState = createPolicyStateSnapshot({
      sourceRepoRoot: expectedRepo,
      outputRoot: expectedOutput,
    });
    const secondTrace = emptyPolicyTrace([...fixture.envelope.raw_response_sha256], {
      runId: "exact-run",
      iter: 2,
    });
    const secondEnvelope = PolicyReplayEnvelopeSchema.parse({
      ...fixture.envelope,
      iter: 2,
      exact_diff: [
        "diff --git a/src/x.ts b/src/x.ts",
        "--- a/src/x.ts",
        "+++ b/src/x.ts",
        "@@ -1 +1 @@",
        "-export const x = 1;",
        "+export const x = 2;",
        "",
      ].join("\n"),
      state_sha256: secondState.stateSha256,
      policy_trace: secondTrace,
    });
    const branchRoots: Array<{ baseline: string; counterfactual: string }> = [];

    await replayPolicyEnvelopeSequence({
      sourceRepoRoot: fixture.sourceRepoRoot,
      passId: "judgment.confidence",
      items: [
        {
          envelope: PolicyReplayEnvelopeSchema.parse(fixture.envelope),
          stateSnapshotRoot: fixture.stateRoot,
        },
        {
          envelope: secondEnvelope,
          stateSnapshotRoot: join(expectedOutput, secondState.stateRef),
        },
      ],
      afterEnvelope: async ({ index, branches }) => {
        branchRoots.push({
          baseline: branches.baseline.checkoutRoot,
          counterfactual: branches.counterfactual.checkoutRoot,
        });
        if (index === 0) {
          await new ReputationStore(branches.baseline.checkoutRoot).record(
            [{ ...event, outcome: "correct" }],
            { now: new Date(event.ts) },
          );
          await new ReputationStore(branches.counterfactual.checkoutRoot).record(
            [{ ...event, outcome: "wrong" }],
            { now: new Date(event.ts) },
          );
          return;
        }
        expect(readFileSync(join(branches.baseline.checkoutRoot, "src", "x.ts"), "utf8")).toBe(
          "export const x = 2;\n",
        );
        const baselineRep = await new ReputationStore(branches.baseline.checkoutRoot).snapshot();
        const counterfactualRep = await new ReputationStore(
          branches.counterfactual.checkoutRoot,
        ).snapshot();
        expect(baselineRep.reviewers["codex:quality"]?.correct).toHaveLength(1);
        expect(counterfactualRep.reviewers["codex:quality"]?.wrong).toHaveLength(1);
        expect(digestPolicyState(join(branches.baseline.checkoutRoot, ".reviewgate"))).not.toBe(
          digestPolicyState(join(branches.counterfactual.checkoutRoot, ".reviewgate")),
        );
      },
    });

    expect(branchRoots).toHaveLength(2);
    expect(branchRoots[1]).toEqual(branchRoots[0]);
    expect(digestPolicyState(join(fixture.sourceRepoRoot, ".reviewgate"))).toBe(sourceStateBefore);
    expect(readFileSync(join(fixture.sourceRepoRoot, "src", "x.ts"), "utf8")).toBe(
      sourceFileBefore,
    );
  });

  test("rejects the authoritative invalidity matrix before metrics", () => {
    const cases: Array<{
      name: string;
      code: RigAuthorityError["code"];
      mutate: (fixture: ReturnType<typeof exactRun>) => void;
    }> = [
      {
        name: "missing",
        code: "missing-trace",
        mutate: (fixture) => {
          const turn = fixture.manifest.turns[0];
          if (turn) turn.policyReplay = { status: "missing", traces: [] };
        },
      },
      {
        name: "cross catalog",
        code: "catalog-mismatch",
        mutate: (fixture) => {
          if (fixture.manifest.policyReplay)
            fixture.manifest.policyReplay.catalogVersion = "future";
        },
      },
      {
        name: "tampered",
        code: "invalid-trace",
        mutate: (fixture) => {
          const ref = fixture.manifest.turns[0]?.policyReplay?.traces[0]?.ref;
          if (ref) writeFileSync(join(fixture.sinkDir, ref), "{}", { mode: 0o600 });
        },
      },
      {
        name: "lossy",
        code: "lossy-trace",
        mutate: (fixture) => replaceTrace(fixture, { ...fixture.envelope, lossless: false }),
      },
      {
        name: "state digest",
        code: "state-digest-mismatch",
        mutate: (fixture) =>
          replaceTrace(fixture, { ...fixture.envelope, state_sha256: "f".repeat(64) }),
      },
      {
        name: "source commit",
        code: "source-commit-mismatch",
        mutate: (fixture) => {
          if (fixture.manifest.policyReplay) {
            fixture.manifest.policyReplay.sourceCommit = "e".repeat(40);
          }
        },
      },
      {
        name: "response hash",
        code: "response-hash-mismatch",
        mutate: (fixture) => {
          const unknown = "e".repeat(64);
          const policyTrace = emptyPolicyTrace([unknown]);
          replaceTrace(fixture, {
            ...fixture.envelope,
            raw_response_sha256: [unknown],
            policy_trace: policyTrace,
          });
        },
      },
      {
        name: "response order",
        code: "response-hash-mismatch",
        mutate: (fixture) => {
          const first = "safe first recorded response";
          const second = "safe second recorded response";
          const hashes = [sha256(first), sha256(second)];
          replaceTrace(fixture, {
            ...fixture.envelope,
            raw_response_sha256: hashes,
            policy_trace: emptyPolicyTrace(hashes),
          });
          const reversed = `${entry("openrouter-second", { rawText: second })}\n${entry("openrouter-first", { rawText: first })}\n`;
          const cassettePath = join(fixture.root, "cassette.jsonl");
          writeFileSync(cassettePath, reversed, { mode: 0o600 });
          if (fixture.manifest.policyReplay) {
            fixture.manifest.policyReplay.cassetteSha256 = sha256(reversed);
          }
        },
      },
      {
        name: "overflow",
        code: "trace-overflow",
        mutate: (fixture) => {
          const bytes = "x".repeat(1_048_577);
          const hash = sha256(bytes);
          const run = sha256("exact-run").slice(0, 12);
          const ref = `${run}-i1-${hash.slice(0, 12)}.json`;
          writeFileSync(join(fixture.sinkDir, ref), bytes, { mode: 0o600 });
          const turn = fixture.manifest.turns[0];
          if (turn) turn.policyReplay = { status: "complete", traces: [{ ref, sha256: hash }] };
        },
      },
      {
        name: "non-canonical",
        code: "non-canonical-trace",
        mutate: (fixture) => {
          const bytes = JSON.stringify(fixture.envelope, null, 2);
          const hash = sha256(bytes);
          const run = sha256("exact-run").slice(0, 12);
          const ref = `${run}-i1-${hash.slice(0, 12)}.json`;
          writeFileSync(join(fixture.sinkDir, ref), bytes, { mode: 0o600 });
          const turn = fixture.manifest.turns[0];
          if (turn) turn.policyReplay = { status: "complete", traces: [{ ref, sha256: hash }] };
        },
      },
    ];

    for (const row of cases) {
      const fixture = exactRun();
      row.mutate(fixture);
      try {
        validateRigPolicyReplayArtifacts({
          manifest: fixture.manifest,
          manifestPath: fixture.manifestPath,
        });
        throw new Error(`${row.name} unexpectedly passed`);
      } catch (error) {
        expect(error, row.name).toBeInstanceOf(RigAuthorityError);
        expect((error as RigAuthorityError).code, row.name).toBe(row.code);
      }
    }
  });
});
