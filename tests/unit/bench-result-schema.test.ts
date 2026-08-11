import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { POLICY_CATALOG_VERSION, POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import {
  BenchMatrixSchema,
  BenchPolicyTraceSetSchema,
  BenchResponseManifestSchema,
  BenchResultSchema,
} from "../../src/schemas/bench-result.ts";

function emptyPolicyTrace(ablated: string[] = []) {
  return {
    schema: "reviewgate.policy-trace.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    run_id: "bench-case",
    iter: 1,
    ablated,
    raw_response_sha256: ["a".repeat(64)],
    passes: POLICY_PASS_IDS.map((passId) => ({
      pass_id: passId,
      status: "ran",
      considered: 0,
      opportunities: 0,
      would_apply: 0,
      applied: 0,
      protected: 0,
      blocking_removed: 0,
      blocking_preserved: 0,
      dropped: 0,
    })),
    evaluations: [],
    stages: [
      {
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "no-blocking-findings",
        input_signatures: [],
        verdict: "PASS",
      },
    ],
    final: {
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 0 },
      finding_signatures: [],
      finding_severities: [],
    },
  };
}

function completePolicyRecord() {
  const trace = emptyPolicyTrace();
  const traceSha256 = createHash("sha256").update(canonicalJson(trace)).digest("hex");
  const finalIdentitySha256 = createHash("sha256").update(canonicalJson(trace.final)).digest("hex");
  return {
    authoritative: true,
    status: "complete",
    catalog_version: POLICY_CATALOG_VERSION,
    requested_ablations: [],
    trace,
    trace_ref: `artifacts/policy-traces/2026/07/01/policy/${createHash("sha256").update(trace.run_id).digest("hex").slice(0, 12)}-i${trace.iter}-${traceSha256.slice(0, 12)}.json`,
    trace_sha256: traceSha256,
    request_identity_sha256: "c".repeat(64),
    effective_config_sha256: "d".repeat(64),
    final_identity_sha256: finalIdentitySha256,
    reason: null,
  };
}

function validPolicyTraceSet() {
  const trace = (caseId: string, traceSha256: string) => ({
    case_id: caseId,
    repeat: 1,
    trace_ref: `artifacts/policy-traces/2026/07/01/policy/${"9".repeat(12)}-i1-${traceSha256.slice(0, 12)}.json`,
    trace_sha256: traceSha256,
    effective_config_sha256: "d".repeat(64),
    request_identity_sha256: "c".repeat(64),
    final_identity_sha256: "e".repeat(64),
    raw_response_sha256: ["a".repeat(64)],
  });
  return {
    schema: "reviewgate.bench.policy-trace-set.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    response_manifest: {
      path: `artifacts/responses/${"b".repeat(64)}.json`,
      sha256: "b".repeat(64),
    },
    runs: [
      {
        label: "baseline",
        ablated_pass_id: null,
        result: {
          path: `artifacts/results/${"1".repeat(64)}.json`,
          sha256: "1".repeat(64),
        },
        traces: [trace("case-1", "2".repeat(64))],
      },
      {
        label: "-judgment.confidence",
        ablated_pass_id: "judgment.confidence",
        result: {
          path: `artifacts/results/${"3".repeat(64)}.json`,
          sha256: "3".repeat(64),
        },
        traces: [trace("case-1", "4".repeat(64))],
      },
    ],
  };
}

const validResult = {
  schema: "reviewgate.bench.result.v1",
  provenance: {
    reviewgate_version: "0.1.0-alpha.4",
    corpus_commit: "abc1234",
    corpus_dirty: false,
    providers: [{ id: "codex", cli_version: "1.2.3", model: "unknown", persona: "security" }],
    config_hash: "deadbeef",
    window: 5,
    repeat: 1,
    include_advisory: false,
    temperature: null,
    stores: "per-case-fresh",
    cache: "cold",
    file_context: "full",
    phases: {
      critic: false,
      reputation: true,
      fp_ledger: false,
      confidence_floor: 0.6,
      scope_to_diff: true,
      ablations: [],
    },
    host_os: "darwin-arm64",
    timestamp: "2026-07-01T00:00:00Z",
    case_count: { seeded: 1, clean: 1 },
  },
  cases: [
    {
      id: "sql-injection-001",
      kind: "seeded-bug",
      status: "scored",
      content_hash: "hash1",
      counts: { tp: 1, fp: 0, fn: 0, neutral: 0 },
      panel_ok: 1,
      panel_configured: 1,
      file_context: "full",
      latency_ms: 1200,
      error: null,
    },
  ],
  providers: [
    {
      provider: "codex",
      coverage: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
      precision: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
      recall: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
      authoritative: true,
    },
  ],
  cost: [
    {
      provider: "codex",
      calls: 2,
      cache_hits: 0,
      tokens_in: 100,
      tokens_out: 50,
      billed_usd: 0,
      oauth_quota_calls: 2,
    },
  ],
  aggregate: {
    precision: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
    recall: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
    clean_fp_rate: { num: 0, den: 1, value: 0, ci_lo: 0, ci_hi: 0.79 },
  },
};

const UNSAFE_REPLAY_STRINGS = [
  ...[
    "/Users",
    "/home",
    "/root",
    "/var",
    "/private",
    "/Volumes",
    "/tmp",
    "/etc",
    "/opt",
    "/mnt",
    "/proc",
    "/sys",
    "/dev",
  ].map((directory) => `open ${directory}/reviewgate/private.json`),
  "open /usr/local/bin/reviewgate",
  "open /Applications/ReviewGate.app/Contents/Info.plist",
  "open /Library/Application Support/ReviewGate/config.json",
  "open /System/Library/CoreServices/SystemVersion.plist",
  "open /workspace/reviewgate/private.json",
  "open //server/share/credentials.json",
  String.raw`open C:\Users\alice\secrets.json`,
  String.raw`open \\server\share\credentials.json`,
  "open file:///etc/passwd",
  "password=hunter2",
  "api_key=notverysecret",
  "Authorization: Basic YTpi",
  "https://user:password@example.com/private",
  "Authorization: Bearer short-but-secret",
  "open %2Fusr%2Flocal%2Fbin%2Freviewgate",
  "open file%3A%2F%2F%2Fetc%2Fpasswd",
  "open file%253A%252F%252F%252Fetc%252Fpasswd",
  "query %2570assword%253Dhunter2",
  'payload {"password":"hunter2"}',
  'payload {"authorization":"Basic YTpi"}',
  "client_secret=notverysecret",
  "ACCESS-TOKEN=notverysecret",
  "https://example.com/download?X-Amz-Signature=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "https://example.com/download?token=notverysecret",
  "https://example.com/download?signature=notverysecret",
  "https://example.com/download?password=hunter2",
  "https://example.com/download?api-key=notverysecret",
  "invalid percent %ZZ",
  "invalid percent %2",
  "open %2525252Fusr%2525252Flocal%2525252Fbin",
  "request used ghp_abcdefghijklmnopqrstuvwxyz123456",
  "request used sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  "request used AKIAIOSFODNN7EXAMPLE",
  "request used xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx",
  "request used AbCd3fGh1jKlMnOpQrSt7vWxYz09+/=AbCd",
];

const SAFE_REPLAY_STRINGS = [
  "request failed in src/core/orchestrator.ts",
  "see https://example.com/root/replay?case=safe-value",
  "see https://docs.example.com/guides/reviewgate/policy-traces",
  "see https://docs.example.com/runs/550e8400-e29b-41d4-a716-446655440000/long-safe-policy-trace-slug",
  "probe http://[::1]:3000/api/health/check",
  "probe https://[2001:db8::1]/reviewgate/status",
  "see https://docs.example.com/search?topic=policy&case=safe-value",
];

function parseThrowableSnapshot(snapshot: unknown) {
  return BenchResponseManifestSchema.safeParse({
    schema: "reviewgate.bench.provider-response-hashes.v2",
    entries: [
      {
        provider: "codex",
        kind: "review",
        ordinal: 0,
        request_sha256: "a".repeat(64),
        response_sha256: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
        outcome: "throw",
        throw_snapshot: snapshot,
      },
    ],
  });
}

describe("BenchResultSchema", () => {
  it("parses a valid result", () => {
    const r = BenchResultSchema.safeParse(validResult);
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("accepts complete embedded policy trace provenance additively", () => {
    const parsed = BenchResultSchema.safeParse({
      ...validResult,
      cases: [{ ...validResult.cases[0], policy_trace: completePolicyRecord() }],
    });
    if (!parsed.success) console.error(parsed.error);
    expect(parsed.success).toBe(true);
  });

  it("keeps legacy BenchResult v1 artifacts explicitly parseable without policy traces", () => {
    expect(BenchResultSchema.safeParse(validResult).success).toBe(true);
  });

  it("rejects complete trace provenance with a missing ref/hash instead of defaulting it", () => {
    const policy = completePolicyRecord();
    const { trace_ref: _missing, ...withoutRef } = policy;
    expect(
      BenchResultSchema.safeParse({
        ...validResult,
        cases: [{ ...validResult.cases[0], policy_trace: withoutRef }],
      }).success,
    ).toBe(false);
  });

  it("rejects a tampered embedded trace whose immutable hash/ref no longer match", () => {
    const policy = completePolicyRecord();
    policy.trace.raw_response_sha256 = ["f".repeat(64)];
    expect(
      BenchResultSchema.safeParse({
        ...validResult,
        cases: [{ ...validResult.cases[0], policy_trace: policy }],
      }).success,
    ).toBe(false);
  });

  it("rejects a missing ran-pass counter rather than coercing it to zero", () => {
    const policy = completePolicyRecord();
    const first = policy.trace.passes[0];
    if (first) Reflect.deleteProperty(first, "opportunities");
    expect(
      BenchResultSchema.safeParse({
        ...validResult,
        cases: [{ ...validResult.cases[0], policy_trace: policy }],
      }).success,
    ).toBe(false);
  });

  it("binds every trace-set artifact path to its declared immutable hash", () => {
    const traceSet = validPolicyTraceSet();
    expect(BenchPolicyTraceSetSchema.safeParse(traceSet).success).toBe(true);

    expect(
      BenchPolicyTraceSetSchema.safeParse({
        ...traceSet,
        response_manifest: { ...traceSet.response_manifest, sha256: "5".repeat(64) },
      }).success,
    ).toBe(false);
    expect(
      BenchPolicyTraceSetSchema.safeParse({
        ...traceSet,
        runs: traceSet.runs.map((run, index) =>
          index === 0 ? { ...run, result: { ...run.result, sha256: "6".repeat(64) } } : run,
        ),
      }).success,
    ).toBe(false);
    expect(
      BenchPolicyTraceSetSchema.safeParse({
        ...traceSet,
        runs: traceSet.runs.map((run, index) =>
          index === 1
            ? {
                ...run,
                traces: run.traces.map((row) => ({
                  ...row,
                  trace_sha256: "7".repeat(64),
                })),
              }
            : run,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe replay strings at the persisted-schema top level", () => {
    expect(
      parseThrowableSnapshot({
        kind: "error",
        error_type: "Error",
        name: "Error",
        message: "failed",
        fields: [{ key: "apiToken", value: "secret", enumerable: true }],
      }).success,
    ).toBe(false);
    expect(
      parseThrowableSnapshot({
        kind: "primitive",
        primitive_type: "string",
        value: "failed at /Users/alice/private/file",
      }).success,
    ).toBe(false);

    for (const value of UNSAFE_REPLAY_STRINGS) {
      expect(
        parseThrowableSnapshot({
          kind: "error",
          error_type: "Error",
          name: "Error",
          message: value,
          fields: [],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unsafe replay strings recursively in the persisted schema", () => {
    for (const value of UNSAFE_REPLAY_STRINGS) {
      expect(
        parseThrowableSnapshot({
          kind: "error",
          error_type: "Error",
          name: "Error",
          message: "provider failed",
          fields: [
            {
              key: "context",
              value: { attempts: [{ detail: "safe" }, { detail: value }] },
              enumerable: true,
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("allows safe replay strings at the persisted-schema top level", () => {
    for (const value of SAFE_REPLAY_STRINGS) {
      expect(
        parseThrowableSnapshot({
          kind: "error",
          error_type: "Error",
          name: "Error",
          message: value,
          fields: [],
        }).success,
      ).toBe(true);
    }
  });

  it("allows safe replay strings recursively in the persisted schema", () => {
    for (const value of SAFE_REPLAY_STRINGS) {
      expect(
        parseThrowableSnapshot({
          kind: "error",
          error_type: "Error",
          name: "Error",
          message: "provider failed",
          fields: [{ key: "context", value: { detail: value }, enumerable: true }],
        }).success,
      ).toBe(true);
    }
  });

  it("strictly validates normalized matrix policy provenance", () => {
    const metric = validResult.aggregate.precision;
    const matrix = {
      schema: "reviewgate.bench.matrix.v1",
      provenance: validResult.provenance,
      variants: [
        {
          label: "-judgment.confidence",
          ablation: "judgment.confidence",
          class: "A",
          precision: metric,
          recall: metric,
          clean_fp_rate: metric,
          delta: { precision: 0, recall: 0, clean_fp_rate: 0 },
          policy: {
            catalog_version: POLICY_CATALOG_VERSION,
            ablated_pass_id: "judgment.confidence",
            trace_status: "complete",
            trace_ref: `artifacts/policy-trace-sets/${"f".repeat(64)}.json`,
            trace_sha256: "f".repeat(64),
            raw_response_sha256: ["a".repeat(64)],
            authoritative: true,
            reason: null,
          },
        },
      ],
    };
    expect(BenchMatrixSchema.safeParse(matrix).success).toBe(true);
    expect(
      BenchMatrixSchema.safeParse({
        ...matrix,
        variants: [
          {
            ...matrix.variants[0],
            policy: { ...matrix.variants[0]?.policy, ablated_pass_id: "confidence-floor" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      BenchMatrixSchema.safeParse({
        ...matrix,
        variants: [
          {
            ...matrix.variants[0],
            policy: {
              ...matrix.variants[0]?.policy,
              catalog_version: "reviewgate.policy-catalog.v0",
            },
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      BenchMatrixSchema.safeParse({
        ...matrix,
        variants: [
          {
            ...matrix.variants[0],
            policy: {
              ...matrix.variants[0]?.policy,
              authoritative: false,
              trace_status: "error",
              trace_sha256: undefined,
              reason: "trace failed",
            },
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      BenchMatrixSchema.safeParse({
        ...matrix,
        artifacts: {
          baseline: { path: `artifacts/results/${"a".repeat(64)}.json`, sha256: "a".repeat(64) },
          variants: [],
          reviewer_responses: {
            path: `artifacts/responses/${"b".repeat(64)}.json`,
            sha256: "b".repeat(64),
          },
          policy_trace_set: {
            path: `artifacts/policy-trace-sets/${"c".repeat(64)}.json`,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts Alpha.12 integrity, critic coverage and honest unknown costs additively", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        case_run_count: { seeded: 3, clean: 3, total: 6 },
        critic: {
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          openrouter_provider: { only: ["alibaba"] },
          max_attempts: 2,
        },
        integrity: {
          source_commit: "a".repeat(40),
          repository_dirty: false,
          runner_sha256: "b".repeat(64),
          runner_kind: "compiled",
          preregistration_sha256: "c".repeat(64),
          authoritative_requested: true,
          max_provider_calls: 100,
          provider_calls_used: 9,
          max_output_tokens: 256,
        },
      },
      cases: [
        {
          ...validResult.cases[0],
          critic: {
            provider: "openrouter",
            eligible: true,
            status: "ran",
            verdicts: 1,
            demoted: 0,
          },
        },
      ],
      critic: {
        provider: "openrouter",
        eligible: 1,
        ran: 1,
        coverage: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
        authoritative: true,
      },
      cost: validResult.cost.map((c) => ({
        ...c,
        tokens_in: null,
        tokens_out: null,
        billed_usd: null,
      })),
    });
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("accepts an optional stamped verdict", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: {
        authoritative: false,
        gate_exit_code: 4,
        reasons: ["reviewer codex coverage 0/1 (100% required)"],
      },
    });
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("rejects a verdict with an unknown key (strict)", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: true, gate_exit_code: 0, reasons: [], extra: 1 },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict whose authoritative flag contradicts gate_exit_code", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: true, gate_exit_code: 4, reasons: ["x"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict with an out-of-domain gate_exit_code", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 2, reasons: ["x"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-authoritative verdict with no stated reasons", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 4, reasons: [] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an authoritative verdict that carries reasons", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: true, gate_exit_code: 0, reasons: ["stray"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict reason containing a C0 ESC (ANSI/VT100) sequence", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 4, reasons: ["\u001b[2Jcleared"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a verdict reason containing an 8-bit C1 CSI (U+009B) sequence", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      verdict: { authoritative: false, gate_exit_code: 4, reasons: ["\u009b2Jcleared"] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown schema tag", () => {
    const r = BenchResultSchema.safeParse({ ...validResult, schema: "reviewgate.bench.result.v2" });
    expect(r.success).toBe(false);
  });

  it("rejects an invalid per-case status", () => {
    const bad = {
      ...validResult,
      cases: [{ ...validResult.cases[0], status: "bogus" }],
    };
    expect(BenchResultSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a metric whose numerator exceeds its denominator", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        precision: { num: 5, den: 1, value: 1, ci_lo: 1, ci_hi: 1 },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a zero-denominator metric with a non-null value", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        recall: { num: 0, den: 0, value: 0, ci_lo: 0, ci_hi: 0 },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a positive-denominator metric with a null value", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        precision: { num: 1, den: 1, value: null, ci_lo: null, ci_hi: null },
      },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a metric whose value disagrees with num/den", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        precision: { num: 1, den: 2, value: 0.9, ci_lo: 0, ci_hi: 1 },
      },
    });
    expect(r.success).toBe(false);
  });

  it("allows a metric with a null value when its denominator is zero", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      aggregate: {
        ...validResult.aggregate,
        recall: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
      },
    });
    expect(r.success).toBe(true);
  });

  it("allows a benchmark-invalid case with a null latency and an error", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      cases: [
        {
          id: "broken",
          kind: "seeded-bug",
          status: "review-error",
          content_hash: "h",
          counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
          panel_ok: 0,
          panel_configured: 1,
          file_context: "full",
          latency_ms: null,
          error: "provider timeout",
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  // --- P1 additive amendments (spec §12) ---

  it("requires provenance.file_context and rejects an unknown value", () => {
    const { file_context: _drop, ...prov } = validResult.provenance;
    expect(BenchResultSchema.safeParse({ ...validResult, provenance: prov }).success).toBe(false);
    expect(
      BenchResultSchema.safeParse({
        ...validResult,
        provenance: { ...validResult.provenance, file_context: "sideways" },
      }).success,
    ).toBe(false);
  });

  it("requires a persona on every provenance roster entry", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        providers: [{ id: "codex", cli_version: "1", model: "unknown" }],
      },
    });
    expect(r.success).toBe(false);
  });

  it("requires the provenance.phases config snapshot", () => {
    const { phases: _drop, ...prov } = validResult.provenance;
    expect(BenchResultSchema.safeParse({ ...validResult, provenance: prov }).success).toBe(false);
  });

  it("allows a null confidence_floor in the phases snapshot (floor disabled)", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        phases: { ...validResult.provenance.phases, confidence_floor: null },
      },
    });
    expect(r.success).toBe(true);
  });

  it("records ablation names in the phases snapshot", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      provenance: {
        ...validResult.provenance,
        phases: { ...validResult.provenance.phases, critic: false, ablations: ["no-critic"] },
      },
    });
    expect(r.success).toBe(true);
  });

  it("requires per-case panel_ok / panel_configured / file_context", () => {
    const bareCase = {
      id: "x",
      kind: "seeded-bug",
      status: "scored",
      content_hash: "h",
      counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
      latency_ms: 1,
      error: null,
    };
    expect(BenchResultSchema.safeParse({ ...validResult, cases: [bareCase] }).success).toBe(false);
  });

  it("requires the top-level per-provider results section", () => {
    const { providers: _drop, ...rest } = validResult;
    expect(BenchResultSchema.safeParse(rest).success).toBe(false);
  });

  it("validates the per-provider metric blocks", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      providers: [
        {
          provider: "codex",
          coverage: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
          // precision value disagrees with num/den → MetricSchema rejects it.
          precision: { num: 1, den: 2, value: 0.9, ci_lo: 0, ci_hi: 1 },
          recall: { num: 1, den: 1, value: 1, ci_lo: 0.21, ci_hi: 1 },
          authoritative: true,
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an authoritative provider with an undefined (den=0) coverage", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      providers: [
        {
          provider: "codex",
          coverage: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          precision: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          recall: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          authoritative: true,
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("allows a non-authoritative provider with undefined coverage", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      providers: [
        {
          provider: "gemini",
          coverage: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          precision: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          recall: { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null },
          authoritative: false,
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("BenchResultSchema — P5 repeat/stability", () => {
  it("accepts a result with a stability block and per-case repeat index", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      cases: [{ ...validResult.cases[0], repeat: 2 }],
      stability: {
        repeats: 3,
        precision: { mean: 0.5, stddev: 0.2, min: 0.3, max: 0.7, samples: 3 },
        recall: { mean: 0.8, stddev: 0.1, min: 0.7, max: 0.9, samples: 3 },
        clean_fp_rate: { mean: 0.25, stddev: 0.35, min: 0, max: 0.75, samples: 3 },
      },
    });
    if (!r.success) console.error(r.error);
    expect(r.success).toBe(true);
  });

  it("accepts an all-null (zero-sample) spread stat", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      stability: {
        repeats: 2,
        precision: { mean: null, stddev: null, min: null, max: null, samples: 0 },
        recall: { mean: null, stddev: null, min: null, max: null, samples: 0 },
        clean_fp_rate: { mean: 0, stddev: 0, min: 0, max: 0, samples: 2 },
      },
    });
    expect(r.success).toBe(true);
  });

  it("still parses a result with no stability (single run)", () => {
    expect(BenchResultSchema.safeParse(validResult).success).toBe(true);
  });

  it("rejects a stability stat with a negative stddev", () => {
    const r = BenchResultSchema.safeParse({
      ...validResult,
      stability: {
        repeats: 2,
        precision: { mean: 0.5, stddev: -0.1, min: 0.4, max: 0.6, samples: 2 },
        recall: { mean: 0.5, stddev: 0, min: 0.5, max: 0.5, samples: 2 },
        clean_fp_rate: { mean: 0, stddev: 0, min: 0, max: 0, samples: 2 },
      },
    });
    expect(r.success).toBe(false);
  });
});
