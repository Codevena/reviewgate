// tests/unit/bench-matrix.test.ts — `reviewgate bench matrix` (spec §8 ablation).
// Runs the corpus as a baseline (full suppression) + once per ablated layer, and
// reports the per-layer Δ. Uses the deterministic confidence-floor suppressor (no
// LLM critic needed): a low-confidence FP on the clean case is demoted at the
// baseline floor and survives when the floor is ablated → a real Δ.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import {
  type AuthoritativeTraceInvalidityCode,
  type AuthoritativeTraceRun,
  validateAuthoritativeTracePair,
  validateAuthoritativeTraceProfilePair,
} from "../../src/bench/runner.ts";
import {
  captureThrowableSnapshot,
  replayThrowableSnapshot,
  runBenchMatrix,
  verifyBenchArtifactReference,
} from "../../src/cli/commands/bench.ts";
import { POLICY_CATALOG_VERSION, POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { SandboxUnavailableError } from "../../src/sandbox/errors.ts";
import {
  BenchMatrixSchema,
  BenchPolicyTraceSetSchema,
  BenchResponseManifestSchema,
  BenchResultSchema,
} from "../../src/schemas/bench-result.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { PolicyTrace } from "../../src/schemas/policy-trace.ts";

const DB_DIFF = [
  "diff --git a/src/db.ts b/src/db.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/db.ts",
  "@@ -0,0 +1,5 @@",
  "+export function q(id) {",
  "+  // build query",
  '+  return db.query("SELECT * FROM t WHERE id=" + id);',
  "+}",
  "+export const y = 1;",
  "",
].join("\n");

const UTIL_DIFF = [
  "diff --git a/src/util.ts b/src/util.ts",
  "new file mode 100644",
  "index 0000000..2222222",
  "--- /dev/null",
  "+++ b/src/util.ts",
  "@@ -0,0 +1,3 @@",
  "+export function add(a, b) {",
  "+  return a + b;",
  "+}",
  "",
].join("\n");

const seededJson = {
  schema: "reviewgate.bench.case.v1",
  id: "sql-injection-001",
  kind: "seeded-bug",
  language: "ts",
  expected: [{ tag: "sql injection", file: "src/db.ts", line: 3, min_severity: "CRITICAL" }],
  allowed: [],
  strict_region: true,
  source: "hand-written",
};
const cleanJson = {
  schema: "reviewgate.bench.case.v1",
  id: "clean-add-001",
  kind: "clean",
  language: "ts",
  expected: [],
  allowed: [],
  strict_region: true,
  source: "hand-written",
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
  "ｐａｓｓｗｏｒｄ=hunter2",
  "password：hunter2",
  "ａｐｉ＿ｋｅｙ＝notverysecret",
  'payload ｛"ｐａｓｓｗｏｒｄ"："hunter2"｝',
  "https://example.com/download？ａｐｉ＿ｋｅｙ＝notverysecret",
  "password%EF%BC%9Ahunter2",
  "%EF%BD%90%EF%BD%81%EF%BD%93%EF%BD%93%EF%BD%97%EF%BD%8F%EF%BD%92%EF%BD%84%EF%BC%9Dhunter2",
  "https://example.com/download%EF%BC%9Fapi_key%EF%BC%9Dnotverysecret",
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
  "quota is 50% remaining",
  "100% utilization",
  "see https://example.com/search?q=100%25+coverage",
  "see https://example.com/search?signatureAlgorithm=ed25519",
  "see https://example.com/search?token_count=128",
  "see https://example.com/search?passwordPolicy=strict",
];

function sqlFinding(): Finding {
  return {
    id: "codex-1",
    signature: "sql-inj",
    severity: "CRITICAL",
    category: "security",
    rule_id: "sql-injection",
    file: "src/db.ts",
    line_start: 3,
    line_end: 3,
    message: "SQL injection via string concatenation",
    details: "user id concatenated into the query",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.95,
    consensus: "singleton",
  };
}

// A low-confidence quality nit on the clean case — below the default 0.6 floor.
function lowConfFp(): Finding {
  return {
    id: "codex-fp",
    signature: "nit",
    severity: "WARN",
    category: "quality",
    rule_id: "naming",
    file: "src/util.ts",
    line_start: 2,
    line_end: 2,
    message: "variable name could be clearer",
    details: "consider renaming",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.3,
    consensus: "singleton",
  };
}

function stub(): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "stub-1", authMode: "oauth", error: null };
    },
    async review(inp) {
      const diff = readFileSync(inp.diffPath, "utf8");
      const findings = diff.includes("db.ts") ? [sqlFinding()] : [lowConfFp()];
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 5, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function newCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-bench-matrix-corpus-"));
  for (const [id, cj, diff] of [
    ["sql-injection-001", seededJson, DB_DIFF],
    ["clean-add-001", cleanJson, UTIL_DIFF],
  ] as const) {
    const cd = join(dir, id);
    mkdirSync(cd, { recursive: true });
    writeFileSync(join(cd, "case.json"), JSON.stringify(cj));
    writeFileSync(join(cd, "diff.patch"), diff);
  }
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "bench-test@example.test"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Bench Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function traceArtifactRef(trace: PolicyTrace, traceSha256: string): string {
  return `artifacts/policy-traces/2026/07/01/policy/${sha256(trace.run_id).slice(0, 12)}-i${trace.iter}-${traceSha256.slice(0, 12)}.json`;
}

/** Rebind test-fixture identity after mutating embedded trace bytes. */
function refreshTraceIdentity(run: AuthoritativeTraceRun): void {
  const trace = run.trace;
  if (trace === undefined) return;
  const traceSha256 = sha256(canonicalJson(trace));
  run.traceSha256 = traceSha256;
  run.traceRef = traceArtifactRef(trace, traceSha256);
  run.finalIdentitySha256 = sha256(canonicalJson(trace.final));
}

function emptyTrace(ablated: PolicyTrace["ablated"]): PolicyTrace {
  const passes = POLICY_PASS_IDS.map((passId) =>
    passId === "judgment.confidence" || ablated.includes(passId)
      ? {
          pass_id: passId,
          status: "ran" as const,
          considered: 0,
          opportunities: 0,
          would_apply: 0,
          applied: 0,
          protected: 0,
          blocking_removed: 0,
          blocking_preserved: 0,
          dropped: 0,
        }
      : {
          pass_id: passId,
          status: "not-run" as const,
          reason_code: "configured-off" as const,
        },
  );
  return {
    schema: "reviewgate.policy-trace.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    run_id: "bench-case",
    iter: 1,
    ablated,
    raw_response_sha256: ["a".repeat(64), "b".repeat(64)],
    passes,
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

function traceRun(ablated: PolicyTrace["ablated"]): AuthoritativeTraceRun {
  const trace = emptyTrace(ablated);
  const traceSha256 = sha256(canonicalJson(trace));
  return {
    authoritative: true,
    status: "complete",
    catalogVersion: POLICY_CATALOG_VERSION,
    requestedAblations: ablated,
    trace,
    traceRef: traceArtifactRef(trace, traceSha256),
    traceSha256,
    requestIdentitySha256: "c".repeat(64),
    effectiveConfigSha256: "d".repeat(64),
    finalIdentitySha256: sha256(canonicalJson(trace.final)),
  };
}

describe("runBenchMatrix", () => {
  it("ablates confidence internally while effective config and captured responses remain identical", async () => {
    const corpus = newCorpus();
    const out = join(corpus, "matrix.json");
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["confidence-floor"],
      adapters: { codex: stub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    const m = BenchMatrixSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(m.variants).toHaveLength(2);
    const baseline = m.variants[0];
    const ablated = m.variants.find((v) => v.ablation === "judgment.confidence");
    expect(baseline?.ablation).toBe("");
    expect(baseline?.delta).toBeNull();
    // baseline: floor demotes the low-conf FP → clean-FP 0, precision 1.
    expect(baseline?.clean_fp_rate.value).toBe(0);
    expect(baseline?.precision.value).toBe(1);
    // ablated: floor off → FP survives → clean-FP 1, precision 0.5.
    expect(ablated?.clean_fp_rate.value).toBe(1);
    expect(ablated?.precision.value).toBeCloseTo(0.5, 10);
    // Δ = baseline − ablated.
    expect(ablated?.class).toBe("A");
    expect(ablated?.delta?.precision).toBeCloseTo(0.5, 10);
    expect(ablated?.delta?.clean_fp_rate).toBeCloseTo(-1, 10);
    const baselineResult = BenchResultSchema.parse(
      JSON.parse(readFileSync(join(corpus, m.artifacts?.baseline.path ?? "missing"), "utf8")),
    );
    const ablatedResult = BenchResultSchema.parse(
      JSON.parse(readFileSync(join(corpus, m.artifacts?.variants[0]?.path ?? "missing"), "utf8")),
    );
    expect(baselineResult.provenance.config_hash).toBe(ablatedResult.provenance.config_hash);
    expect(baselineResult.provenance.phases.confidence_floor).toBeGreaterThan(0);
    expect(ablatedResult.provenance.phases.confidence_floor).toBe(
      baselineResult.provenance.phases.confidence_floor,
    );
    expect(baseline?.policy?.raw_response_sha256).toEqual(ablated?.policy?.raw_response_sha256);
    expect(baseline?.policy?.authoritative).toBe(true);
    expect(ablated?.policy?.authoritative).toBe(true);
    expect(ablated?.policy?.ablated_pass_id).toBe("judgment.confidence");
    expect(baselineResult.cases.find((row) => row.kind === "seeded-bug")?.policy_truth).toEqual({
      expected_label_count: 1,
      findings: [
        {
          signature: "8dfccfb7ed70068875825c18167afc1bc34258d715a9ff9007b76ec32b6ea669",
          severity: "CRITICAL",
          outcome: "TP",
          label_index: 0,
          near_miss: false,
        },
      ],
      fn_label_indexes: [],
    });
    const resultRefs = [m.artifacts?.baseline, ...(m.artifacts?.variants ?? [])];
    for (const resultRef of resultRefs) {
      expect(resultRef).toBeDefined();
      if (!resultRef) continue;
      const persisted = BenchResultSchema.parse(
        JSON.parse(readFileSync(join(corpus, resultRef.path), "utf8")),
      );
      for (const row of persisted.cases) {
        expect(row.policy_trace?.trace_ref).toStartWith("artifacts/policy-traces/");
        expect(existsSync(join(corpus, row.policy_trace?.trace_ref ?? "missing"))).toBe(true);
        if (
          row.policy_trace?.trace_ref !== undefined &&
          row.policy_trace.trace_sha256 !== undefined
        ) {
          expect(
            verifyBenchArtifactReference({
              root: corpus,
              ref: row.policy_trace.trace_ref,
              sha256: row.policy_trace.trace_sha256,
              kind: "policy-trace",
            }),
          ).toMatchObject({ ok: true });
          expect(readFileSync(join(corpus, row.policy_trace.trace_ref), "utf8")).toBe(
            canonicalJson(row.policy_trace.trace),
          );
        }
      }
    }
    const traceSetRef = (
      m.artifacts as typeof m.artifacts & {
        policy_trace_set?: { path: string; sha256: string };
      }
    )?.policy_trace_set;
    expect(traceSetRef).toBeDefined();
    expect(existsSync(join(corpus, traceSetRef?.path ?? "missing"))).toBe(true);
    if (traceSetRef) {
      const traceSetBytes = readFileSync(join(corpus, traceSetRef.path), "utf8");
      const traceSet = BenchPolicyTraceSetSchema.parse(JSON.parse(traceSetBytes));
      expect(traceSetBytes).toBe(canonicalJson(traceSet));
      expect(
        verifyBenchArtifactReference({
          root: corpus,
          ref: traceSetRef.path,
          sha256: traceSetRef.sha256,
          kind: "policy-trace-set",
        }),
      ).toMatchObject({ ok: true });
      expect(traceSet.runs.map((run) => run.ablated_pass_id)).toEqual([
        null,
        "judgment.confidence",
      ]);
      expect(traceSet.response_manifest.sha256).toBe(
        m.artifacts?.reviewer_responses.sha256 ?? "missing",
      );
      const tamperedTraceSet = {
        ...traceSet,
        runs: traceSet.runs.map((run, index) =>
          index === 1 ? { ...run, label: `${run.label}-tampered` } : run,
        ),
      };
      writeFileSync(join(corpus, traceSetRef.path), canonicalJson(tamperedTraceSet));
      expect(
        verifyBenchArtifactReference({
          root: corpus,
          ref: traceSetRef.path,
          sha256: traceSetRef.sha256,
          kind: "policy-trace-set",
        }),
      ).toEqual({ ok: false, reason: "hash-mismatch" });
    }
    // The Δ table renders.
    expect(res.stdout).toContain("ablation");
    expect(res.stdout.toLowerCase()).toContain("baseline");
  });

  it("fails closed when a published trace path is replaced by a symlink", async () => {
    const corpus = newCorpus();
    const artifactDir = join(corpus, "symlink-attack");
    const firstOut = join(artifactDir, "first.json");
    const first = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: firstOut,
      ablate: ["confidence-floor"],
      adapters: { codex: stub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(first.exitCode).toBe(0);
    const firstMatrix = BenchMatrixSchema.parse(JSON.parse(readFileSync(firstOut, "utf8")));
    const baselineResult = BenchResultSchema.parse(
      JSON.parse(
        readFileSync(join(artifactDir, firstMatrix.artifacts?.baseline.path ?? "missing"), "utf8"),
      ),
    );
    const traceRef = baselineResult.cases[0]?.policy_trace?.trace_ref;
    expect(traceRef).toBeDefined();
    if (traceRef === undefined) return;
    const tracePath = join(artifactDir, traceRef);
    const outside = join(corpus, "outside-trace.json");
    writeFileSync(outside, readFileSync(tracePath));
    unlinkSync(tracePath);
    symlinkSync(outside, tracePath);

    const attacked = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(artifactDir, "attacked.json"),
      ablate: ["confidence-floor"],
      adapters: { codex: stub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });
    expect(attacked.exitCode).toBe(4);
    expect(attacked.stdout).toBe("");
    expect(attacked.stderr).toContain("policy trace artifact");
    expect(existsSync(join(artifactDir, "attacked.json"))).toBe(false);
  });

  it("rejects missing, tampered, non-canonical, wrong-hash, traversing and symlink artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-bench-artifact-verifier-"));
    const manifest = BenchResponseManifestSchema.parse({
      schema: "reviewgate.bench.provider-response-hashes.v2",
      entries: [],
    });
    const canonical = canonicalJson(manifest);
    const canonicalSha = sha256(canonical);
    const canonicalRef = `artifacts/responses/${canonicalSha}.json`;
    mkdirSync(join(root, "artifacts", "responses"), { recursive: true });
    writeFileSync(join(root, canonicalRef), canonical, { mode: 0o600 });

    expect(
      verifyBenchArtifactReference({
        root,
        ref: canonicalRef,
        sha256: canonicalSha,
        kind: "response-manifest",
      }),
    ).toMatchObject({ ok: true });

    const missingSha = "1".repeat(64);
    expect(
      verifyBenchArtifactReference({
        root,
        ref: `artifacts/responses/${missingSha}.json`,
        sha256: missingSha,
        kind: "response-manifest",
      }),
    ).toEqual({ ok: false, reason: "missing" });

    const tamperedSha = "2".repeat(64);
    const tamperedRef = `artifacts/responses/${tamperedSha}.json`;
    writeFileSync(join(root, tamperedRef), canonical, { mode: 0o600 });
    expect(
      verifyBenchArtifactReference({
        root,
        ref: tamperedRef,
        sha256: tamperedSha,
        kind: "response-manifest",
      }),
    ).toEqual({ ok: false, reason: "hash-mismatch" });

    const pretty = JSON.stringify(manifest, null, 2);
    const prettySha = sha256(pretty);
    const prettyRef = `artifacts/responses/${prettySha}.json`;
    writeFileSync(join(root, prettyRef), pretty, { mode: 0o600 });
    expect(
      verifyBenchArtifactReference({
        root,
        ref: prettyRef,
        sha256: prettySha,
        kind: "response-manifest",
      }),
    ).toEqual({ ok: false, reason: "non-canonical" });

    expect(
      verifyBenchArtifactReference({
        root,
        ref: canonicalRef,
        sha256: "3".repeat(64),
        kind: "response-manifest",
      }),
    ).toEqual({ ok: false, reason: "identity-mismatch" });
    expect(
      verifyBenchArtifactReference({
        root,
        ref: "../outside.json",
        sha256: canonicalSha,
        kind: "response-manifest",
      }),
    ).toEqual({ ok: false, reason: "invalid-reference" });

    const symlinkManifest = BenchResponseManifestSchema.parse({
      schema: "reviewgate.bench.provider-response-hashes.v2",
      entries: [
        {
          provider: "codex",
          kind: "review",
          ordinal: 0,
          request_sha256: "5".repeat(64),
          response_sha256: "6".repeat(64),
          outcome: "return",
        },
      ],
    });
    const symlinkBytes = canonicalJson(symlinkManifest);
    const symlinkSha = sha256(symlinkBytes);
    const symlinkRef = `artifacts/responses/${symlinkSha}.json`;
    const symlinkTarget = join(root, "symlink-target.json");
    writeFileSync(symlinkTarget, symlinkBytes, { mode: 0o600 });
    symlinkSync(symlinkTarget, join(root, symlinkRef));
    expect(
      verifyBenchArtifactReference({
        root,
        ref: symlinkRef,
        sha256: symlinkSha,
        kind: "response-manifest",
      }),
    ).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("rejects a hash-valid Bench artifact unless its mode remains exactly 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-bench-artifact-mode-"));
    const manifest = BenchResponseManifestSchema.parse({
      schema: "reviewgate.bench.provider-response-hashes.v2",
      entries: [],
    });
    const canonical = canonicalJson(manifest);
    const canonicalSha = sha256(canonical);
    const canonicalRef = `artifacts/responses/${canonicalSha}.json`;
    mkdirSync(join(root, "artifacts", "responses"), { recursive: true });
    writeFileSync(join(root, canonicalRef), canonical, { mode: 0o600 });

    for (const unsafeMode of [0o644, 0o4600]) {
      execFileSync("/bin/chmod", [unsafeMode.toString(8), join(root, canonicalRef)]);
      expect(lstatSync(join(root, canonicalRef)).mode & 0o7777).toBe(unsafeMode);
      expect(
        verifyBenchArtifactReference({
          root,
          ref: canonicalRef,
          sha256: canonicalSha,
          kind: "response-manifest",
        }),
      ).toEqual({ ok: false, reason: "not-a-file" });
    }
  });

  it("captures and reconstructs exact immutable throwable snapshots without cross-variant aliasing", () => {
    const sandbox = captureThrowableSnapshot(new SandboxUnavailableError("sandbox unavailable"));
    expect(sandbox.ok).toBe(true);
    if (!sandbox.ok) return;
    const sandboxA = replayThrowableSnapshot(sandbox.snapshot);
    const sandboxB = replayThrowableSnapshot(sandbox.snapshot);
    expect(sandboxA).toBeInstanceOf(SandboxUnavailableError);
    expect(sandboxB).toBeInstanceOf(SandboxUnavailableError);
    expect(sandboxA).not.toBe(sandboxB);
    expect((sandboxA as Error).message).toBe("sandbox unavailable");
    expect(Object.isFrozen(sandbox.snapshot)).toBe(true);

    const cause = new Error("root cause");
    const ordinary = new Error("outer failure", { cause }) as Error & {
      code: string;
      retryable: boolean;
      context: { attempt: number; labels: string[] };
    };
    ordinary.code = "E_RETRY";
    ordinary.retryable = true;
    ordinary.context = { attempt: 2, labels: ["critic", "retry"] };
    const captured = captureThrowableSnapshot(ordinary);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const first = replayThrowableSnapshot(captured.snapshot) as typeof ordinary;
    const second = replayThrowableSnapshot(captured.snapshot) as typeof ordinary;
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBe(second);
    expect(first.cause).toBeInstanceOf(Error);
    expect(first.cause).not.toBe(second.cause);
    expect(first.code).toBe("E_RETRY");
    expect(first.retryable).toBe(true);
    expect(first.context).toEqual({ attempt: 2, labels: ["critic", "retry"] });

    const changedCode = new Error("outer failure") as Error & { code: string };
    changedCode.code = "E_OTHER";
    const changed = captureThrowableSnapshot(changedCode);
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.sha256).not.toBe(captured.sha256);

    for (const primitive of ["plain throw", undefined, null] as const) {
      const primitiveCapture = captureThrowableSnapshot(primitive);
      expect(primitiveCapture.ok).toBe(true);
      if (primitiveCapture.ok) {
        expect(replayThrowableSnapshot(primitiveCapture.snapshot)).toBe(primitive);
      }
    }
  });

  it("fails closed for non-reconstructable or sensitive thrown values", () => {
    class CustomError extends Error {}
    expect(captureThrowableSnapshot(new CustomError("custom"))).toMatchObject({
      ok: false,
      reason: "unsupported-error-type",
    });
    const secret = new Error("failed") as Error & { apiToken: string };
    secret.apiToken = "secret-value";
    expect(captureThrowableSnapshot(secret)).toMatchObject({
      ok: false,
      reason: "sensitive-field",
    });
    expect(
      captureThrowableSnapshot(new Error("failed at /Users/alice/private/file")),
    ).toMatchObject({
      ok: false,
      reason: "unsafe-string",
    });
    const unsupported = new Error("failed") as Error & { debugPayload: { requestId: string } };
    unsupported.debugPayload = { requestId: "request-1" };
    expect(captureThrowableSnapshot(unsupported)).toMatchObject({
      ok: false,
      reason: "unsupported-field",
    });

    const hiddenUnknown = new Error("failed");
    Object.defineProperty(hiddenUnknown, "retryAfterMs", {
      value: 250,
      enumerable: false,
    });
    expect(captureThrowableSnapshot(hiddenUnknown)).toMatchObject({
      ok: false,
      reason: "unsupported-field",
    });

    const symbolUnknown = new Error("failed");
    Object.defineProperty(symbolUnknown, Symbol("debug"), {
      value: "internal",
      enumerable: false,
    });
    expect(captureThrowableSnapshot(symbolUnknown)).toMatchObject({
      ok: false,
      reason: "unsupported-field",
    });
  });

  it("rejects unsafe replay strings at runtime top level", () => {
    for (const value of UNSAFE_REPLAY_STRINGS) {
      expect(captureThrowableSnapshot(new Error(value))).toMatchObject({
        ok: false,
        reason: "unsafe-string",
      });
    }
  });

  it("rejects unsafe replay strings recursively during runtime capture", () => {
    for (const value of UNSAFE_REPLAY_STRINGS) {
      const nested = new Error("provider failed") as Error & {
        context: { attempts: Array<{ detail: string }> };
      };
      nested.context = { attempts: [{ detail: "safe" }, { detail: value }] };
      expect(captureThrowableSnapshot(nested)).toMatchObject({
        ok: false,
        reason: "unsafe-string",
      });
    }
  });

  it("rejects extension fields on nested throwable arrays", () => {
    const hiddenArrayField = ["safe"] as string[] & { debugPayload?: string };
    Object.defineProperty(hiddenArrayField, "debugPayload", {
      value: "internal",
      enumerable: false,
    });
    const nestedArray = new Error("provider failed") as Error & { context: unknown };
    nestedArray.context = hiddenArrayField;
    expect(captureThrowableSnapshot(nestedArray)).toMatchObject({
      ok: false,
      reason: "unsupported-field",
    });
  });

  it("allows safe replay strings at runtime top level", () => {
    for (const value of SAFE_REPLAY_STRINGS) {
      expect(captureThrowableSnapshot(new Error(value))).toMatchObject({ ok: true });
    }
  });

  it("allows safe replay strings recursively during runtime capture", () => {
    for (const value of SAFE_REPLAY_STRINGS) {
      const nested = new Error("provider failed") as Error & {
        context: { attempts: Array<{ detail: string }> };
      };
      nested.context = { attempts: [{ detail: value }] };
      expect(captureThrowableSnapshot(nested)).toMatchObject({ ok: true });
    }
  });

  it("replays typed review and complete throws in full order across multiple variants", async () => {
    const corpus = newCorpus();
    const artifactDir = join(corpus, "typed-throws");
    const out = join(artifactDir, "matrix.json");
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let criticCalls = 0;
    const primary: ProviderAdapter = {
      ...stub(),
      async review() {
        primaryCalls++;
        throw new SandboxUnavailableError("sandbox unavailable");
      },
    };
    const fallbackBase = stub();
    const fallback: ProviderAdapter = {
      ...fallbackBase,
      id: "gemini",
      async review(input) {
        fallbackCalls++;
        return fallbackBase.review(input);
      },
    };
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must use complete");
      },
      async complete() {
        criticCalls++;
        const error = new Error("critic failed", {
          cause: new Error("upstream failed"),
        }) as Error & {
          code: string;
          retryable: boolean;
        };
        error.code = "E_CRITIC";
        error.retryable = true;
        throw error;
      },
    };

    const result = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["confidence-floor", "judgment.hypothetical"],
      criticProvider: "openrouter",
      maxProviderCalls: 10,
      adapters: { codex: primary, gemini: fallback, openrouter: critic },
      providerAvailable: () => true,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(2);
    expect(criticCalls).toBe(2);
    const matrix = BenchMatrixSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(matrix.variants).toHaveLength(3);
    const manifestPath = join(artifactDir, matrix.artifacts?.reviewer_responses.path ?? "missing");
    const manifestBytes = readFileSync(manifestPath, "utf8");
    const manifest = BenchResponseManifestSchema.parse(JSON.parse(manifestBytes));
    expect(manifest.entries.map((entry) => [entry.kind, entry.outcome])).toEqual([
      ["review", "throw"],
      ["review", "return"],
      ["complete", "throw"],
      ["review", "throw"],
      ["review", "return"],
      ["complete", "throw"],
    ]);
    expect(
      manifest.entries
        .filter((entry) => entry.throw_snapshot?.kind === "error")
        .map((entry) =>
          entry.throw_snapshot?.kind === "error" ? entry.throw_snapshot.error_type : null,
        ),
    ).toEqual(["SandboxUnavailableError", "Error", "SandboxUnavailableError", "Error"]);
    expect(manifestBytes).not.toContain("stack");
    expect(manifestBytes).not.toContain("sourceURL");
    expect(manifestBytes).not.toContain("/Users/");
  });

  it("rejects every non-authoritative trace-pair boundary with a precise closed reason", () => {
    const baseline = traceRun([]);
    const counterfactual = traceRun(["judgment.confidence"]);
    expect(validateAuthoritativeTracePair(baseline, counterfactual)).toEqual({ ok: true });

    const cases: Array<{
      name: string;
      mutate: (base: AuthoritativeTraceRun, variant: AuthoritativeTraceRun) => void;
      code: AuthoritativeTraceInvalidityCode;
      refreshTraceIdentity?: "baseline" | "counterfactual";
    }> = [
      {
        name: "missing trace",
        mutate: (_base, variant) => {
          variant.trace = undefined;
        },
        code: "missing-trace",
      },
      {
        name: "missing configured pass row",
        mutate: (_base, variant) => {
          if (variant.trace) variant.trace.passes = variant.trace.passes.slice(1);
        },
        code: "missing-pass-row",
        refreshTraceIdentity: "counterfactual",
      },
      {
        name: "ablated pass not run",
        mutate: (_base, variant) => {
          if (variant.trace) {
            variant.trace.passes = variant.trace.passes.map((row) =>
              row.pass_id === "judgment.confidence"
                ? {
                    pass_id: "judgment.confidence",
                    status: "not-run",
                    reason_code: "configured-off",
                  }
                : row,
            );
          }
        },
        code: "pass-not-run",
        refreshTraceIdentity: "counterfactual",
      },
      {
        name: "trace error",
        mutate: (_base, variant) => {
          variant.status = "error";
        },
        code: "trace-status",
      },
      {
        name: "trace overflow",
        mutate: (_base, variant) => {
          variant.status = "overflow";
        },
        code: "trace-status",
      },
      {
        name: "missing content ref",
        mutate: (_base, variant) => {
          variant.traceRef = undefined;
        },
        code: "trace-reference",
      },
      {
        name: "content hash mismatch",
        mutate: (_base, variant) => {
          variant.traceSha256 = "e".repeat(64);
        },
        code: "trace-hash",
      },
      {
        name: "catalog mismatch",
        mutate: (_base, variant) => {
          variant.catalogVersion = "reviewgate.policy-catalog.v0";
        },
        code: "catalog-mismatch",
      },
      {
        name: "requested pass mismatch",
        mutate: (_base, variant) => {
          variant.requestedAblations = ["judgment.critic"];
        },
        code: "requested-pass-mismatch",
      },
      {
        name: "ordered response mismatch",
        mutate: (_base, variant) => {
          if (variant.trace) variant.trace.raw_response_sha256.reverse();
        },
        code: "response-hash-mismatch",
        refreshTraceIdentity: "counterfactual",
      },
      {
        name: "request mismatch",
        mutate: (_base, variant) => {
          variant.requestIdentitySha256 = "f".repeat(64);
        },
        code: "request-identity-mismatch",
      },
      {
        name: "config mismatch",
        mutate: (_base, variant) => {
          variant.effectiveConfigSha256 = "1".repeat(64);
        },
        code: "config-mismatch",
      },
      {
        name: "final identity mismatch",
        mutate: (_base, variant) => {
          variant.finalIdentitySha256 = "2".repeat(64);
        },
        code: "final-identity-mismatch",
      },
      {
        name: "non-authoritative execution",
        mutate: (_base, variant) => {
          variant.authoritative = false;
        },
        code: "non-authoritative-execution",
      },
      {
        name: "missing counters",
        mutate: (_base, variant) => {
          const row = variant.trace?.passes.find(
            (candidate) => candidate.pass_id === "judgment.confidence",
          );
          if (row?.status === "ran") Reflect.deleteProperty(row, "opportunities");
        },
        code: "missing-counter",
        refreshTraceIdentity: "counterfactual",
      },
    ];

    for (const testCase of cases) {
      const nextBaseline = structuredClone(baseline);
      const nextVariant = structuredClone(counterfactual);
      testCase.mutate(nextBaseline, nextVariant);
      if (testCase.refreshTraceIdentity === "baseline") refreshTraceIdentity(nextBaseline);
      if (testCase.refreshTraceIdentity === "counterfactual") refreshTraceIdentity(nextVariant);
      const result = validateAuthoritativeTracePair(nextBaseline, nextVariant);
      expect(result.ok, testCase.name).toBe(false);
      if (!result.ok) {
        expect(result.code, testCase.name).toBe(testCase.code);
        expect(result.reason.length, testCase.name).toBeGreaterThan(0);
      }
    }
  });

  it("accepts only an exact ordered multi-pass trace profile and keeps the legacy guard", () => {
    const expected = ["scope.diff", "scope.delta", "scope.session"] as const;
    const baseline = traceRun([]);
    const grouped = traceRun([...expected]);

    expect(validateAuthoritativeTraceProfilePair(baseline, grouped, expected)).toEqual({
      ok: true,
    });
    // WITH legacy guard = 1 rejection; WITHOUT it = 0 rejections for the valid group.
    expect(validateAuthoritativeTracePair(baseline, grouped).ok).toBe(false);

    const invalidProfiles: Array<{
      name: string;
      requested: string[];
      mutate?: (trace: NonNullable<AuthoritativeTraceRun["trace"]>) => void;
      code?: AuthoritativeTraceInvalidityCode;
      updateTraceProfile?: boolean;
    }> = [
      {
        name: "missing requested pass",
        requested: ["scope.diff", "scope.delta"],
        code: "requested-pass-mismatch",
        updateTraceProfile: true,
      },
      {
        name: "extra requested pass",
        requested: ["scope.diff", "scope.delta", "scope.session", "judgment.confidence"],
        code: "requested-pass-mismatch",
      },
      {
        name: "reordered requested pass",
        requested: ["scope.delta", "scope.diff", "scope.session"],
        code: "requested-pass-mismatch",
      },
      {
        name: "duplicate requested pass",
        requested: ["scope.diff", "scope.diff", "scope.session"],
        code: "requested-pass-mismatch",
      },
      {
        name: "requested pass did not run",
        requested: [...expected],
        mutate: (trace) => {
          trace.passes = trace.passes.map((row) =>
            row.pass_id === "scope.delta"
              ? { pass_id: "scope.delta", status: "not-run", reason_code: "configured-off" }
              : row,
          );
        },
        code: "pass-not-run",
      },
    ];

    for (const invalid of invalidProfiles) {
      const variant = structuredClone(grouped);
      variant.requestedAblations = invalid.requested as typeof variant.requestedAblations;
      if (variant.trace) {
        if (invalid.updateTraceProfile) {
          variant.trace.ablated = [...invalid.requested] as typeof variant.trace.ablated;
        }
        invalid.mutate?.(variant.trace);
        refreshTraceIdentity(variant);
      }
      const result = validateAuthoritativeTraceProfilePair(baseline, variant, expected);
      expect(result.ok, invalid.name).toBe(false);
      if (!result.ok && invalid.code) expect(result.code, invalid.name).toBe(invalid.code);
    }
  });

  it("exits 2 with no --ablate layers", async () => {
    const corpus = newCorpus();
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "m.json"),
      ablate: [],
      adapters: { codex: stub() },
    });
    expect(res.exitCode).toBe(2);
  });

  it("exits 2 on an unknown ablation layer", async () => {
    const corpus = newCorpus();
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "m.json"),
      ablate: ["bogus-layer"],
      adapters: { codex: stub() },
    });
    expect(res.exitCode).toBe(2);
  });

  it("captures reviewer responses once and replays those exact samples for critic ablation", async () => {
    const corpus = newCorpus();
    const artifactDir = join(corpus, "attempt-01");
    const out = join(artifactDir, "matrix.json");
    let reviewCalls = 0;
    let criticCalls = 0;
    const reviewer = stub();
    const countedReviewer: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        reviewCalls++;
        return reviewer.review(input);
      },
    };
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must use complete()");
      },
      async complete() {
        criticCalls++;
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "likely_fp" },
          ],
        });
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["critic"],
      criticProvider: "openrouter",
      criticModel: "deepseek/deepseek-v4-flash",
      criticOpenrouterProvider: { only: ["alibaba"] },
      maxOutputTokens: 128,
      maxProviderCalls: 10,
      adapters: { codex: countedReviewer, openrouter: critic },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.stderr).toBe("");
    expect(res.exitCode).toBe(0);
    expect(reviewCalls).toBe(2); // baseline only; the variant is deterministic replay
    expect(criticCalls).toBe(2);
    const matrix = BenchMatrixSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(existsSync(join(artifactDir, matrix.artifacts?.baseline.path ?? "missing"))).toBe(true);
    expect(existsSync(join(artifactDir, matrix.artifacts?.variants[0]?.path ?? "missing"))).toBe(
      true,
    );
    const manifest = BenchResponseManifestSchema.parse(
      JSON.parse(
        readFileSync(
          join(artifactDir, matrix.artifacts?.reviewer_responses.path ?? "missing"),
          "utf8",
        ),
      ),
    );
    expect(manifest.entries).toHaveLength(4);
    expect(manifest.entries.every((e) => e.request_sha256.length === 64)).toBe(true);
    expect(manifest.entries.every((e) => e.response_sha256.length === 64)).toBe(true);
    expect(matrix.artifacts?.baseline.path).toMatch(/^artifacts\/results\/[0-9a-f]{64}\.json$/);
    expect(matrix.artifacts?.variants[0]?.path).toMatch(/^artifacts\/results\/[0-9a-f]{64}\.json$/);
    expect(matrix.artifacts?.reviewer_responses.path).toMatch(
      /^artifacts\/responses\/[0-9a-f]{64}\.json$/,
    );
  });

  it("replays reviewer retry attempts in the same order as the captured baseline", async () => {
    const corpus = newCorpus();
    const artifactDir = join(corpus, "attempt-retry");
    const out = join(artifactDir, "matrix.json");
    let reviewCalls = 0;
    const reviewer = stub();
    const flaky: ProviderAdapter = {
      ...reviewer,
      async review(input) {
        reviewCalls++;
        if (reviewCalls === 1) {
          return {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
            durationMs: 1,
            exitCode: 1,
            rawEventsPath: "",
            rawText: "",
            status: "error",
            statusDetail: "transient malformed output",
          } satisfies ReviewResult;
        }
        return reviewer.review(input);
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["confidence-floor"],
      adapters: { codex: flaky },
      maxProviderCalls: 3,
      reviewerMaxAttempts: 2,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(reviewCalls).toBe(3);
    const matrix = BenchMatrixSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    const baseline = BenchResultSchema.parse(
      JSON.parse(
        readFileSync(join(artifactDir, matrix.artifacts?.baseline.path ?? "missing"), "utf8"),
      ),
    );
    const variant = BenchResultSchema.parse(
      JSON.parse(
        readFileSync(join(artifactDir, matrix.artifacts?.variants[0]?.path ?? "missing"), "utf8"),
      ),
    );
    expect(baseline.providers[0]?.coverage.value).toBe(1);
    expect(variant.providers[0]?.coverage.value).toBe(1);
    expect(baseline.provenance.integrity?.provider_calls_used).toBe(3);
    expect(baseline.provenance.integrity?.reviewer_max_attempts).toBe(2);
    const manifest = BenchResponseManifestSchema.parse(
      JSON.parse(
        readFileSync(
          join(artifactDir, matrix.artifacts?.reviewer_responses.path ?? "missing"),
          "utf8",
        ),
      ),
    );
    expect(manifest.entries).toHaveLength(3);
  });

  it("fails closed when a replay variant records a different source commit than the baseline", async () => {
    const corpus = newCorpus();
    initGitRepo(corpus);
    const artifactDir = join(corpus, "provenance-mismatch");
    let criticCalls = 0;
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must use complete()");
      },
      async complete() {
        criticCalls++;
        if (criticCalls === 2) {
          writeFileSync(join(corpus, "after-baseline.txt"), "new committed state\n");
          execFileSync("git", ["add", "after-baseline.txt"], { cwd: corpus, stdio: "ignore" });
          execFileSync("git", ["commit", "-m", "advance during matrix"], {
            cwd: corpus,
            stdio: "ignore",
          });
        }
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "likely_fp" },
          ],
        });
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(artifactDir, "matrix.json"),
      ablate: ["critic"],
      criticProvider: "openrouter",
      criticModel: "deepseek/deepseek-v4-flash",
      maxOutputTokens: 128,
      maxProviderCalls: 10,
      adapters: { codex: stub(), openrouter: critic },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("variant corpus commit differs from baseline");
    expect(res.stderr).toContain("variant source commit differs from baseline");
    expect(existsSync(join(artifactDir, "baseline.result.json"))).toBe(false);
    expect(existsSync(join(artifactDir, "no-judgment.critic.result.json"))).toBe(false);
    expect(existsSync(join(artifactDir, "matrix.json"))).toBe(false);
  });

  it("preserves method binding through budget, capture and replay wrappers", async () => {
    const corpus = newCorpus();
    class StatefulCodex implements ProviderAdapter {
      readonly id = "codex" as const;
      private readonly marker = "bound";
      reviewCalls = 0;
      completeCalls = 0;

      private assertBound(): void {
        if (this.marker !== "bound") throw new Error("adapter method lost its receiver");
      }

      async preflight() {
        this.assertBound();
        return { available: true, version: "stub-1", authMode: "oauth" as const, error: null };
      }

      async review(input: Parameters<ProviderAdapter["review"]>[0]) {
        this.assertBound();
        this.reviewCalls++;
        const diff = readFileSync(input.diffPath, "utf8");
        const findings = diff.includes("db.ts") ? [sqlFinding()] : [lowConfFp()];
        return {
          reviewerId: input.reviewerId,
          verdict: findings.length ? ("FAIL" as const) : ("PASS" as const),
          findings,
          usage: { inputTokens: 5, outputTokens: 5, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          rawText: "",
          status: "ok" as const,
        };
      }

      async complete() {
        this.assertBound();
        this.completeCalls++;
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "keep" },
          ],
        });
      }
    }
    const adapter = new StatefulCodex();
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "bound", "matrix.json"),
      ablate: ["confidence-floor"],
      criticProvider: "codex",
      maxProviderCalls: 10,
      adapters: { codex: adapter },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(adapter.reviewCalls).toBe(2);
    expect(adapter.completeCalls).toBe(2);
  });

  it("never makes live critic completions in a replay variant", async () => {
    const corpus = newCorpus();
    let preflightCalls = 0;
    let reviewCalls = 0;
    let criticCalls = 0;
    const reviewer = stub();
    const countedReviewer: ProviderAdapter = {
      ...reviewer,
      async preflight(config) {
        preflightCalls++;
        return reviewer.preflight(config);
      },
      async review(input) {
        reviewCalls++;
        return reviewer.review(input);
      },
    };
    const critic: ProviderAdapter = {
      id: "openrouter",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "openrouter", error: null };
      },
      async review() {
        throw new Error("critic must use complete()");
      },
      async complete() {
        criticCalls++;
        return JSON.stringify({
          verdicts: [
            { signature: "sql-inj", verdict: "keep" },
            { signature: "nit", verdict: "keep" },
          ],
        });
      },
    };

    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(corpus, "matrix-budget", "matrix.json"),
      ablate: ["confidence-floor"],
      criticProvider: "openrouter",
      criticModel: "deepseek/deepseek-v4-flash",
      criticOpenrouterProvider: { only: ["alibaba"] },
      maxOutputTokens: 128,
      // Exactly the baseline's 2 reviewer + 2 critic calls fit. Any live call in
      // the variant exhausts the ceiling and kills this contract test.
      maxProviderCalls: 4,
      adapters: { codex: countedReviewer, openrouter: critic },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(preflightCalls).toBe(1);
    expect(reviewCalls).toBe(2);
    expect(criticCalls).toBe(2);
  });

  it("captures declared fallback reviewers and replays them without untracked live calls", async () => {
    const corpus = newCorpus();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const successful = stub();
    const quotaPrimary: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "stub-1", authMode: "oauth", error: null };
      },
      async review(input) {
        primaryCalls++;
        return {
          reviewerId: input.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 1,
          rawEventsPath: "",
          rawText: "",
          status: "quota-exhausted",
        };
      },
    };
    const fallback: ProviderAdapter = {
      ...successful,
      id: "gemini",
      async review(input) {
        fallbackCalls++;
        return successful.review(input);
      },
    };

    const artifactDir = join(corpus, "fallback-replay");
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out: join(artifactDir, "matrix.json"),
      ablate: ["confidence-floor"],
      // Omit providers: the default codex slot declares gemini as its first fallback.
      maxProviderCalls: 4,
      adapters: { codex: quotaPrimary, gemini: fallback },
      providerAvailable: () => true,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(0);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(2);
    const matrix = BenchMatrixSchema.parse(
      JSON.parse(readFileSync(join(artifactDir, "matrix.json"), "utf8")),
    );
    const manifest = BenchResponseManifestSchema.parse(
      JSON.parse(
        readFileSync(
          join(artifactDir, matrix.artifacts?.reviewer_responses.path ?? "missing"),
          "utf8",
        ),
      ),
    );
    expect(manifest.entries.filter((entry) => entry.provider === "codex")).toHaveLength(2);
    expect(manifest.entries.filter((entry) => entry.provider === "gemini")).toHaveLength(2);
  });

  it("fails authoritative pairing when the requested scope pass did not run", async () => {
    const corpus = newCorpus();
    const out = join(corpus, "scope-matrix", "matrix.json");
    const res = await runBenchMatrix({
      repoRoot: corpus,
      corpus,
      out,
      ablate: ["scope-to-diff"],
      adapters: { codex: stub() },
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("pass-not-run");
    expect(res.stderr).toContain("scope.diff");
    expect(existsSync(out)).toBe(false);
  });
});
