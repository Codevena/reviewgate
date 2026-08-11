import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { aggregate } from "../../src/core/aggregator.ts";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { groundFindings } from "../../src/core/grounding.ts";
import { demoteHypotheticalCriticals } from "../../src/core/hypothetical-demote.ts";
import { ImplicitOutcomeStore } from "../../src/core/learnings/implicit-outcomes.ts";
import { POLICY_CATALOG_VERSION } from "../../src/core/policy/catalog.ts";
import { capturePolicyReplayEnvelope } from "../../src/core/policy/replay-capture.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import { StateStore } from "../../src/core/state-store.ts";
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
  replayPolicyAblations,
  replayPolicyEnvelopePair,
  replayPolicyEnvelopeSequence,
  runWithReplayProviderCeiling,
} from "../../src/rig/replay.ts";
import {
  type PolicyReplayEnvelopeInput,
  PolicyReplayEnvelopeSchema,
  policyReplayCallId,
} from "../../src/schemas/policy-replay.ts";
import type { RigManifest } from "../../src/schemas/rig-manifest.ts";
import { initialState } from "../../src/schemas/state.ts";

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

function responseEntry(input: {
  provider?: "claude-code" | "codex" | "gemini" | "openrouter" | "opencode" | "ollama";
  method: "review" | "complete";
  key: string;
  promptSha256: string;
  rawText: string;
  call?: ReturnType<typeof responseCall>;
  runId?: string;
  iter?: number;
}): string {
  const provider = input.provider ?? "openrouter";
  return JSON.stringify({
    schema: "reviewgate.cassette.entry.v1",
    provider,
    method: input.method,
    key: input.key,
    promptSha256: input.promptSha256,
    ...(input.call === undefined
      ? {}
      : {
          policyReplayCall: {
            callId: input.call.call_id,
            runId: input.runId ?? "exact-run",
            iter: input.iter ?? 1,
            kind: input.call.kind,
            ordinal: input.call.ordinal,
            slot: input.call.slot,
            attempt: input.call.attempt,
            occurrence: input.call.occurrence,
          },
        }),
    result:
      input.method === "complete"
        ? { text: input.rawText }
        : {
            reviewerId: input.key,
            verdict: "PASS",
            findings: [],
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
            durationMs: 1,
            exitCode: 0,
            rawEventsPath: "",
            status: "ok",
            rawText: input.rawText,
          },
  });
}

function responseCall(input: {
  runId?: string;
  iter?: number;
  kind: "reviewer" | "grounding" | "critic";
  provider?: "claude-code" | "codex" | "gemini" | "openrouter" | "opencode" | "ollama";
  method: "review" | "complete";
  key: string;
  promptSha256: string;
  ordinal?: number;
  slot: number;
  attempt?: number;
  occurrence?: number;
  rawText: string;
}) {
  const identity = {
    runId: input.runId ?? "exact-run",
    iter: input.iter ?? 1,
    kind: input.kind,
    provider: input.provider ?? "openrouter",
    method: input.method,
    key: input.key,
    promptSha256: input.promptSha256,
    ordinal: input.ordinal ?? input.slot,
    slot: input.slot,
    attempt: input.attempt ?? 1,
    occurrence: input.occurrence ?? 0,
  };
  return {
    call_id: policyReplayCallId(identity),
    kind: identity.kind,
    provider: identity.provider,
    method: identity.method,
    key: identity.key,
    prompt_sha256: identity.promptSha256,
    ordinal: identity.ordinal,
    slot: identity.slot,
    attempt: identity.attempt,
    occurrence: identity.occurrence,
    response_sha256: sha256(input.rawText),
  };
}

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
    fpActive: new Map([["seeded-fp", { id: "FP-001" }]]),
    fpActiveClusters: new Map(),
    repUnreliable: new Set(["codex:quality"]),
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
  writeFileSync(
    join(sourceRepoRoot, ".reviewgate", "state.json"),
    JSON.stringify(initialState("exact-session")),
    { mode: 0o600 },
  );
  mkdirSync(join(sourceRepoRoot, ".reviewgate", "learnings"));
  const observedAt = "2026-08-11T12:00:00.000Z";
  writeFileSync(
    join(sourceRepoRoot, ".reviewgate", "learnings", "known_fp.jsonl"),
    JSON.stringify({
      schema: "reviewgate.fpledger.v1",
      seq: 1,
      entries: [
        {
          id: "FP-001",
          signature: "seeded-fp",
          rule_id: "seeded-rule",
          category: "quality",
          file: "src/x.ts",
          symbol: "",
          stage: "active",
          rejects: [
            {
              run_id: "seed-1",
              provider: "codex",
              ts: "2026-08-01T12:00:00.000Z",
              reason: "confirmed false positive one",
            },
            {
              run_id: "seed-2",
              provider: "openrouter",
              ts: "2026-08-02T12:00:00.000Z",
              reason: "confirmed false positive two",
            },
            {
              run_id: "seed-3",
              provider: "codex",
              ts: "2026-08-03T12:00:00.000Z",
              reason: "confirmed false positive three",
            },
          ],
          distinct_providers: ["codex", "openrouter"],
          first_seen_at: "2026-08-01T12:00:00.000Z",
          last_seen_at: "2026-08-03T12:00:00.000Z",
          created_at: "2026-08-01T12:00:00.000Z",
        },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(sourceRepoRoot, ".reviewgate", "reputation.json"),
    JSON.stringify({
      schema: "reviewgate.reputation.v1",
      reviewers: {
        "codex:quality": {
          correct: [],
          wrong: Array.from({ length: 8 }, (_, index) => ({
            ts: `2026-08-0${index + 1}T12:00:00.000Z`,
            eid: `seed-reputation-${index + 1}`,
          })),
        },
      },
    }),
    { mode: 0o600 },
  );
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
      fp_active: [{ signature: "seeded-fp", id: "FP-001" }],
      fp_active_clusters: [],
      rep_unreliable: ["codex:quality"],
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
    response_calls: [
      {
        call_id: policyReplayCallId({
          runId: "exact-run",
          iter: 1,
          kind: "reviewer",
          provider: "openrouter",
          method: "review",
          key: "openrouter-security",
          promptSha256: "a".repeat(64),
          ordinal: 0,
          slot: 0,
          attempt: 1,
          occurrence: 0,
        }),
        kind: "reviewer",
        provider: "openrouter",
        method: "review",
        key: "openrouter-security",
        prompt_sha256: "a".repeat(64),
        ordinal: 0,
        slot: 0,
        attempt: 1,
        occurrence: 0,
        response_sha256: rawHash,
      },
    ],
    history: {
      fp_ledger: { enabled: true, active_at: observedAt, clusters_at: observedAt },
      reputation: {
        enabled: true,
        observed_at: observedAt,
        min_samples: 6,
        trust_floor: 0.45,
        half_life_days: 45,
      },
      cycle_state: { source: "state.json", region_rejected_enabled: false },
      implicit_outcomes: { enabled: false },
    },
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
  const recordedCall = envelope.response_calls[0];
  if (recordedCall === undefined) throw new Error("response call fixture failed");
  const cassettePath = join(root, "cassette.jsonl");
  writeFileSync(
    cassettePath,
    `${responseEntry({
      method: "review",
      key: "openrouter-security",
      promptSha256: "a".repeat(64),
      rawText,
      call: recordedCall,
    })}\n`,
    { mode: 0o600 },
  );
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

function replaceRawTrace(
  fixture: ReturnType<typeof exactRun>,
  envelope: Record<string, unknown>,
): void {
  const bytes = canonicalJson(envelope);
  const hash = sha256(bytes);
  const runId = typeof envelope.run_id === "string" ? envelope.run_id : "exact-run";
  const iter = typeof envelope.iter === "number" ? envelope.iter : 1;
  const ref = `${sha256(runId).slice(0, 12)}-i${iter}-${hash.slice(0, 12)}.json`;
  writeFileSync(join(fixture.sinkDir, ref), bytes, { mode: 0o600 });
  const turn = fixture.manifest.turns[0];
  if (turn === undefined) throw new Error("turn fixture missing");
  turn.policyReplay = { status: "complete", traces: [{ ref, sha256: hash }] };
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
    reviewer: { provider: "codex", model: "gpt-5", persona: "correctness" },
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
    fpActive: new Map([["seeded-fp", { id: "FP-001" }]]),
    fpActiveClusters: new Map(),
    repUnreliable: new Set(["codex:quality"]),
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
      fp_active: [{ signature: "seeded-fp", id: "FP-001" }],
      fp_active_clusters: [],
      rep_unreliable: ["codex:quality"],
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
  test("rejects captured history inputs that disagree with branch-local production stores", async () => {
    const cases: Array<{
      name: string;
      mutate: (envelope: PolicyReplayEnvelopeInput) => PolicyReplayEnvelopeInput;
    }> = [
      {
        name: "fp ledger",
        mutate: (envelope) => ({
          ...envelope,
          aggregate: {
            ...envelope.aggregate,
            fp_active: [{ signature: "missing-from-store", id: "FP-999" }],
          },
        }),
      },
      {
        name: "reputation",
        mutate: (envelope) => ({
          ...envelope,
          aggregate: { ...envelope.aggregate, rep_unreliable: ["gemini:security"] },
        }),
      },
      {
        name: "cycle state",
        mutate: (envelope) => ({
          ...envelope,
          aggregate: { ...envelope.aggregate, cycle_rejected: ["not-in-state"] },
        }),
      },
    ];
    for (const row of cases) {
      const fixture = exactRun();
      const candidate = PolicyReplayEnvelopeSchema.parse(row.mutate(fixture.envelope));
      let caught: unknown;
      try {
        await replayPolicyEnvelopePair({
          sourceRepoRoot: fixture.sourceRepoRoot,
          envelope: candidate,
          stateSnapshotRoot: fixture.stateRoot,
          passId: "judgment.confidence",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught, row.name).toBeInstanceOf(RigAuthorityError);
      expect((caught as RigAuthorityError | undefined)?.code, row.name).toBe(
        "state-digest-mismatch",
      );
    }
  });

  test("uses the real branch-local fp, reputation, and cycle Store APIs", async () => {
    const fixture = exactRun();
    const fpRead = spyOn(FpLedgerStore.prototype, "snapshot");
    const reputationRead = spyOn(ReputationStore.prototype, "snapshot");
    const cycleRead = spyOn(StateStore.prototype, "load");
    try {
      await replayPolicyEnvelopePair({
        sourceRepoRoot: fixture.sourceRepoRoot,
        envelope: PolicyReplayEnvelopeSchema.parse(fixture.envelope),
        stateSnapshotRoot: fixture.stateRoot,
        passId: "judgment.confidence",
      });
      expect(fpRead).toHaveBeenCalled();
      expect(reputationRead).toHaveBeenCalled();
      expect(cycleRead).toHaveBeenCalled();
    } finally {
      fpRead.mockRestore();
      reputationRead.mockRestore();
      cycleRead.mockRestore();
    }
  });

  test("matches logical response calls by identity when physical completion order reverses", () => {
    const fixture = exactRun();
    const first = "safe slow logical response";
    const second = "safe fast logical response";
    const firstPrompt = "b".repeat(64);
    const secondPrompt = "c".repeat(64);
    const slowCall = responseCall({
      kind: "reviewer",
      method: "review",
      key: "openrouter-slow",
      promptSha256: firstPrompt,
      slot: 0,
      rawText: first,
    });
    const fastCall = responseCall({
      kind: "reviewer",
      method: "review",
      key: "openrouter-fast",
      promptSha256: secondPrompt,
      slot: 1,
      rawText: second,
    });
    const calls = [slowCall, fastCall];
    const hashes = calls.map((call) => call.response_sha256);
    replaceTrace(fixture, {
      ...fixture.envelope,
      raw_response_sha256: hashes,
      response_calls: calls,
      policy_trace: emptyPolicyTrace(hashes),
    });
    const extraPrompt = "d".repeat(64);
    const physical = [
      responseEntry({
        method: "review",
        key: "openrouter-fast",
        promptSha256: secondPrompt,
        rawText: second,
        call: fastCall,
      }),
      responseEntry({
        method: "complete",
        key: `openrouter:complete:${extraPrompt}`,
        promptSha256: extraPrompt,
        rawText: "safe unrelated curator completion",
      }),
      responseEntry({
        method: "review",
        key: "openrouter-slow",
        promptSha256: firstPrompt,
        rawText: first,
        call: slowCall,
      }),
    ].join("\n");
    const cassetteBytes = `${physical}\n`;
    writeFileSync(join(fixture.root, "cassette.jsonl"), cassetteBytes, { mode: 0o600 });
    if (fixture.manifest.policyReplay) {
      fixture.manifest.policyReplay.cassetteSha256 = sha256(cassetteBytes);
    }

    expect(() =>
      validateRigPolicyReplayArtifacts({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
      }),
    ).not.toThrow();
  });

  test("matches identical concurrent calls by call id when their completions reverse", () => {
    const fixture = exactRun();
    const promptSha256 = "b".repeat(64);
    const slow = responseCall({
      kind: "reviewer",
      method: "review",
      key: "openrouter-security",
      promptSha256,
      slot: 0,
      occurrence: 0,
      rawText: "safe slow duplicate response",
    });
    const fast = responseCall({
      kind: "reviewer",
      method: "review",
      key: "openrouter-security",
      promptSha256,
      slot: 1,
      occurrence: 1,
      rawText: "safe fast duplicate response",
    });
    const calls = [slow, fast];
    const hashes = calls.map((call) => call.response_sha256);
    replaceTrace(fixture, {
      ...fixture.envelope,
      raw_response_sha256: hashes,
      response_calls: calls,
      policy_trace: emptyPolicyTrace(hashes),
    });
    const physical = `${responseEntry({ method: "review", key: fast.key, promptSha256, rawText: "safe fast duplicate response", call: fast })}\n${responseEntry({ method: "review", key: slow.key, promptSha256, rawText: "safe slow duplicate response", call: slow })}\n`;
    writeFileSync(join(fixture.root, "cassette.jsonl"), physical, { mode: 0o600 });
    if (fixture.manifest.policyReplay)
      fixture.manifest.policyReplay.cassetteSha256 = sha256(physical);

    expect(() =>
      validateRigPolicyReplayArtifacts({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
      }),
    ).not.toThrow();
  });

  test("rejects authoritative cassette responses whose call metadata is missing", () => {
    const fixture = exactRun();
    const cassettePath = join(fixture.root, "cassette.jsonl");
    const rawText = "safe recorded review response";
    const legacy = `${entry("openrouter-security", { rawText })}\n`;
    writeFileSync(cassettePath, legacy, { mode: 0o600 });
    if (fixture.manifest.policyReplay)
      fixture.manifest.policyReplay.cassetteSha256 = sha256(legacy);
    expect(() =>
      validateRigPolicyReplayArtifacts({
        manifest: fixture.manifest,
        manifestPath: fixture.manifestPath,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "response-hash-mismatch",
        exitCode: 4,
      }),
    );
  });

  test("filters authoritative ablation to one exact closed-catalog selector", async () => {
    const fixture = exactRun();
    const selectedReplay = replayPolicyAblations as unknown as (input: {
      manifestPath: string;
      sourceRepoRoot: string;
      passId: string;
    }) => Promise<Array<{ passId: string }>>;
    const rows = await selectedReplay({
      manifestPath: fixture.manifestPath,
      sourceRepoRoot: fixture.sourceRepoRoot,
      passId: "judgment.confidence",
    });
    expect(rows.map((row) => row.passId)).toEqual(["judgment.confidence"]);
  });

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

  test("replays production policy in isolated branches without a live provider capability", async () => {
    const fixture = exactRun();
    const validated = validateRigPolicyReplayArtifacts({
      manifest: fixture.manifest,
      manifestPath: fixture.manifestPath,
    });
    expect(validated).not.toBeNull();
    const item = validated?.turns.get(1)?.[0];
    if (item === undefined) throw new Error("validated trace missing");
    const pair = await replayPolicyEnvelopePair({
      sourceRepoRoot: fixture.sourceRepoRoot,
      envelope: item.envelope,
      stateSnapshotRoot: item.stateRoot,
      passId: "judgment.confidence",
    });
    expect(pair.baseline.raw_response_sha256).toEqual(pair.counterfactual.raw_response_sha256);
    expect(pair.counterfactual.ablated).toEqual(["judgment.confidence"]);
  });

  test("allows the ablated production pass to change output after reproducing the baseline", async () => {
    const fixture = exactRun();
    const candidate = PolicyReplayEnvelopeSchema.parse(confidenceEnvelope(fixture));
    const pair = await replayPolicyEnvelopePair({
      sourceRepoRoot: fixture.sourceRepoRoot,
      envelope: candidate,
      stateSnapshotRoot: fixture.stateRoot,
      passId: "judgment.confidence",
    });
    expect(pair.baseline.final.counts.info).toBe(1);
    expect(pair.counterfactual.final.counts.warn).toBe(1);
  });

  test("persists real branch-local policy outcomes across a multi-envelope sequence", async () => {
    const fixture = exactRun();
    const sourceStateBefore = digestPolicyState(join(fixture.sourceRepoRoot, ".reviewgate"));
    const sourceFileBefore = readFileSync(join(fixture.sourceRepoRoot, "src", "x.ts"), "utf8");
    const firstEnvelope = PolicyReplayEnvelopeSchema.parse({
      ...confidenceEnvelope(fixture),
      history: {
        ...fixture.envelope.history,
        implicit_outcomes: {
          enabled: true,
          cap: 100,
          created_at: "2026-08-11T12:00:00.000Z",
        },
      },
    });
    const secondTrace = emptyPolicyTrace([...fixture.envelope.raw_response_sha256], {
      runId: "exact-run",
      iter: 2,
    });
    const secondCalls = fixture.envelope.response_calls.map((call) => ({
      ...call,
      call_id: policyReplayCallId({
        runId: "exact-run",
        iter: 2,
        kind: call.kind,
        provider: call.provider,
        method: call.method,
        key: call.key,
        promptSha256: call.prompt_sha256,
        ordinal: call.ordinal,
        slot: call.slot,
        attempt: call.attempt,
        occurrence: call.occurrence,
      }),
    }));
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
      response_calls: secondCalls,
      history: {
        ...fixture.envelope.history,
        implicit_outcomes: {
          enabled: true,
          cap: 100,
          created_at: "2026-08-11T12:00:01.000Z",
        },
      },
      policy_trace: secondTrace,
    });
    const implicitAppend = spyOn(ImplicitOutcomeStore.prototype, "append");
    const pairs = await replayPolicyEnvelopeSequence({
      sourceRepoRoot: fixture.sourceRepoRoot,
      passId: "judgment.confidence",
      items: [
        {
          envelope: firstEnvelope,
          stateSnapshotRoot: fixture.stateRoot,
        },
        {
          envelope: secondEnvelope,
          stateSnapshotRoot: fixture.stateRoot,
        },
      ],
    });
    const stateful = pairs as unknown as Array<{
      state: {
        baseline: { digest: string; implicit_outcomes: number; history_reads: number };
        counterfactual: { digest: string; implicit_outcomes: number; history_reads: number };
      };
    }>;
    expect(implicitAppend).toHaveBeenCalled();
    expect(stateful[0]?.state.baseline.implicit_outcomes).toBe(1);
    expect(stateful[0]?.state.counterfactual.implicit_outcomes).toBe(0);
    expect(stateful[1]?.state.baseline.implicit_outcomes).toBe(1);
    expect(stateful[1]?.state.counterfactual.implicit_outcomes).toBe(0);
    expect(stateful[1]?.state.baseline.digest).not.toBe(stateful[1]?.state.counterfactual.digest);
    expect(stateful[1]?.state.baseline.history_reads).toBeGreaterThan(0);
    expect(stateful[1]?.state.counterfactual.history_reads).toBeGreaterThan(0);
    implicitAppend.mockRestore();
    expect(digestPolicyState(join(fixture.sourceRepoRoot, ".reviewgate"))).toBe(sourceStateBefore);
    expect(readFileSync(join(fixture.sourceRepoRoot, "src", "x.ts"), "utf8")).toBe(
      sourceFileBefore,
    );
  });

  test("re-applies only captured human decisions through production learning stores", async () => {
    const fixture = exactRun();
    const observedAt = "2026-08-11T12:00:01.000Z";
    const expectedRepo = mkdtempSync(join(tmpdir(), "rg-policy-human-learning-"));
    cpSync(fixture.stateRoot, join(expectedRepo, ".reviewgate"), { recursive: true });
    const statePath = join(expectedRepo, ".reviewgate", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { iteration: number };
    state.iteration = 1;
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    const learningFinding = {
      id: "F-001",
      signature: "captured-human-decision",
      severity: "WARN",
      category: "quality",
      rule_id: "captured-decision-rule",
      file: "src/x.ts",
      line_start: 1,
      line_end: 1,
      message: "Captured human decision finding",
      details: "The captured operator accepted this finding.",
      reviewer: { provider: "codex", model: "test", persona: "correctness" },
      confidence: 0.9,
      consensus: "singleton",
    };
    writeFileSync(
      join(expectedRepo, ".reviewgate", "pending.json"),
      JSON.stringify({ findings: [learningFinding] }),
      { mode: 0o600 },
    );
    mkdirSync(join(expectedRepo, ".reviewgate", "decisions"));
    writeFileSync(
      join(expectedRepo, ".reviewgate", "decisions", "1.jsonl"),
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "fixed",
      })}\n`,
      { mode: 0o600 },
    );
    await new ReputationStore(expectedRepo).record(
      [
        {
          reviewerKey: "codex:correctness",
          outcome: "correct",
          eid: "exact-session:0:1:F-001:codex:correctness",
          ts: observedAt,
        },
      ],
      { now: new Date(observedAt), halfLifeDays: 45 },
    );
    await new FpLedgerStore(expectedRepo).decayPass(observedAt);
    const expectedOutput = mkdtempSync(join(tmpdir(), "rg-policy-human-output-"));
    const nextState = createPolicyStateSnapshot({
      sourceRepoRoot: expectedRepo,
      outputRoot: expectedOutput,
    });
    const secondTrace = emptyPolicyTrace([...fixture.envelope.raw_response_sha256], {
      runId: "exact-run",
      iter: 2,
    });
    const secondCalls = fixture.envelope.response_calls.map((call) => ({
      ...call,
      call_id: policyReplayCallId({
        runId: "exact-run",
        iter: 2,
        kind: call.kind,
        provider: call.provider,
        method: call.method,
        key: call.key,
        promptSha256: call.prompt_sha256,
        ordinal: call.ordinal,
        slot: call.slot,
        attempt: call.attempt,
        occurrence: call.occurrence,
      }),
    }));
    const secondEnvelope = PolicyReplayEnvelopeSchema.parse({
      ...fixture.envelope,
      iter: 2,
      state_sha256: nextState.stateSha256,
      response_calls: secondCalls,
      history: {
        ...fixture.envelope.history,
        fp_ledger: {
          enabled: true,
          active_at: observedAt,
          clusters_at: observedAt,
        },
        reputation: {
          ...fixture.envelope.history.reputation,
          observed_at: observedAt,
        },
      },
      policy_trace: secondTrace,
    });
    const fpWrite = spyOn(FpLedgerStore.prototype, "decayPass");
    const reputationWrite = spyOn(ReputationStore.prototype, "record");
    try {
      await replayPolicyEnvelopePair({
        sourceRepoRoot: fixture.sourceRepoRoot,
        envelope: secondEnvelope,
        stateSnapshotRoot: join(expectedOutput, nextState.stateRef),
        passId: "judgment.confidence",
      });
      expect(fpWrite).not.toHaveBeenCalled();
      expect(reputationWrite).not.toHaveBeenCalled();

      const pairs = await replayPolicyEnvelopeSequence({
        sourceRepoRoot: fixture.sourceRepoRoot,
        passId: "judgment.confidence",
        items: [
          {
            envelope: PolicyReplayEnvelopeSchema.parse(fixture.envelope),
            stateSnapshotRoot: fixture.stateRoot,
          },
          {
            envelope: secondEnvelope,
            stateSnapshotRoot: join(expectedOutput, nextState.stateRef),
          },
        ],
      });
      expect(fpWrite).toHaveBeenCalled();
      expect(reputationWrite).toHaveBeenCalled();
      expect(pairs[1]?.state.baseline.history_writes).toBeGreaterThanOrEqual(2);
      expect(pairs[1]?.state.counterfactual.history_writes).toBeGreaterThanOrEqual(2);
    } finally {
      fpWrite.mockRestore();
      reputationWrite.mockRestore();
    }
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
            response_calls: fixture.envelope.response_calls.map((call) => ({
              ...call,
              response_sha256: unknown,
            })),
            policy_trace: policyTrace,
          });
        },
      },
      {
        name: "response call attempt",
        code: "invalid-trace",
        mutate: (fixture) => {
          const first = fixture.envelope.response_calls[0];
          if (first === undefined) throw new Error("response call fixture missing");
          replaceRawTrace(fixture, {
            ...fixture.envelope,
            response_calls: [
              {
                ...first,
                attempt: first.attempt + 1,
                // Deliberately retain call_id: attempt is part of stable identity.
              },
            ],
          });
        },
      },
      {
        name: "recomputed response call attempt",
        code: "response-hash-mismatch",
        mutate: (fixture) => {
          const first = fixture.envelope.response_calls[0];
          if (first === undefined) throw new Error("response call fixture missing");
          const attempt = first.attempt + 1;
          replaceTrace(fixture, {
            ...fixture.envelope,
            response_calls: [
              {
                ...first,
                attempt,
                call_id: policyReplayCallId({
                  runId: fixture.envelope.run_id,
                  iter: fixture.envelope.iter,
                  kind: first.kind,
                  provider: first.provider,
                  method: first.method,
                  key: first.key,
                  promptSha256: first.prompt_sha256,
                  ordinal: first.ordinal,
                  slot: first.slot,
                  attempt,
                  occurrence: first.occurrence,
                }),
              },
            ],
          });
        },
      },
      {
        name: "response call identity",
        code: "response-hash-mismatch",
        mutate: (fixture) => {
          const first = "safe first recorded response";
          const second = "safe second recorded response";
          const hashes = [sha256(first), sha256(second)];
          const firstPrompt = "b".repeat(64);
          const secondPrompt = "c".repeat(64);
          replaceTrace(fixture, {
            ...fixture.envelope,
            raw_response_sha256: hashes,
            response_calls: [
              responseCall({
                kind: "reviewer",
                method: "review",
                key: "openrouter-first",
                promptSha256: firstPrompt,
                slot: 0,
                rawText: first,
              }),
              responseCall({
                kind: "reviewer",
                method: "review",
                key: "openrouter-second",
                promptSha256: secondPrompt,
                slot: 1,
                rawText: second,
              }),
            ],
            policy_trace: emptyPolicyTrace(hashes),
          });
          const reversed = `${responseEntry({ method: "review", key: "openrouter-first", promptSha256: firstPrompt, rawText: second })}\n${responseEntry({ method: "review", key: "openrouter-second", promptSha256: secondPrompt, rawText: first })}\n`;
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
