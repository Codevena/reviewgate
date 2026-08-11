import { createHash } from "node:crypto";
import { URL } from "node:url";
import { z } from "zod";
import { canonicalJson } from "../audit/canonical.ts";
import { POLICY_CATALOG_VERSION, POLICY_PASS_IDS } from "../core/policy/catalog.ts";
import { redactHighEntropy } from "../diff/sanitizer.ts";
import { PolicyTraceSchema } from "./policy-trace.ts";

// reviewgate bench — result schema (spec §5, §7.2). What `bench run` writes and
// `bench report` reads. Every rate carries its raw numerator/denominator + a Wilson
// CI (§5.2), and the provenance block pins the run so results are comparable (§7.2).

/** A rate reported with its raw counts and a Wilson 95% CI; value/CI are null when den=0. */
export const MetricSchema = z
  .object({
    num: z.number().int().nonnegative(),
    den: z.number().int().nonnegative(),
    value: z.number().min(0).max(1).nullable(),
    ci_lo: z.number().min(0).max(1).nullable(),
    ci_hi: z.number().min(0).max(1).nullable(),
  })
  .strict()
  // Reject internally inconsistent rates so an invalid headline number can never
  // pass validation: num≤den; den=0 ⇒ value/CI all null; den>0 ⇒ value/CI all
  // present, value=num/den, and ci_lo≤value≤ci_hi.
  .superRefine((m, ctx) => {
    if (m.num > m.den) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "num must be <= den", path: ["num"] });
    }
    if (m.den === 0) {
      if (m.value !== null || m.ci_lo !== null || m.ci_hi !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "den=0 requires null value/ci_lo/ci_hi",
          path: ["value"],
        });
      }
      return;
    }
    if (m.value === null || m.ci_lo === null || m.ci_hi === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "den>0 requires non-null value/ci_lo/ci_hi",
        path: ["value"],
      });
      return;
    }
    if (Math.abs(m.value - m.num / m.den) > 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value must equal num/den",
        path: ["value"],
      });
    }
    if (m.ci_lo > m.value || m.ci_hi < m.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ci_lo <= value <= ci_hi required",
        path: ["ci_lo"],
      });
    }
  });

// The result-affecting slice of the effective config, snapshotted into provenance
// (spec §12) so a published number carries the exact suppression posture it was
// measured under. `ablations` names the class-A/B toggles applied for THIS run
// (empty for a plain `bench run`); the individual booleans are the resolved state
// of each layer the metrics depend on.
export const PhasesSnapshotSchema = z
  .object({
    critic: z.boolean(),
    reputation: z.boolean(),
    fp_ledger: z.boolean(),
    confidence_floor: z.number().min(0).max(1).nullable(),
    scope_to_diff: z.boolean(),
    ablations: z.array(z.string()),
  })
  .strict();

const OpenRouterRoutingSnapshotSchema = z
  .object({
    only: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
    allowFallbacks: z.boolean().optional(),
  })
  .strict();

const CriticProvenanceSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    openrouter_provider: OpenRouterRoutingSnapshotSchema.nullable(),
    // Additive for Alpha.12 Attempt 02; optional keeps older published artifacts valid.
    max_attempts: z.number().int().positive().optional(),
  })
  .strict();

const IntegrityProvenanceSchema = z
  .object({
    source_commit: z.string(),
    repository_dirty: z.boolean(),
    runner_sha256: z.string(),
    runner_kind: z.enum(["compiled", "source-runtime", "test"]),
    preregistration_sha256: z.string().nullable(),
    authoritative_requested: z.boolean(),
    max_provider_calls: z.number().int().positive().nullable(),
    provider_calls_used: z.number().int().nonnegative(),
    max_output_tokens: z.number().int().positive().nullable(),
    // Optional for backwards compatibility with older Alpha.12 artifacts; absent
    // means the historical single physical reviewer invocation per case.
    reviewer_max_attempts: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.max_provider_calls !== null && value.provider_calls_used > value.max_provider_calls) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider_calls_used must not exceed max_provider_calls",
        path: ["provider_calls_used"],
      });
    }
  });

export const ProvenanceSchema = z
  .object({
    reviewgate_version: z.string(),
    corpus_commit: z.string(),
    corpus_dirty: z.boolean(),
    // The resolved reviewer roster: provider + upstream model + CLI version + the
    // persona each slot ran under (persona changes what the reviewer looks for, so
    // a number is only comparable against a run with the same roster+persona).
    providers: z.array(
      z
        .object({
          id: z.string(),
          cli_version: z.string(),
          model: z.string(),
          persona: z.string(),
        })
        .strict(),
    ),
    config_hash: z.string(),
    window: z.number().int().nonnegative(),
    repeat: z.number().int().positive(),
    include_advisory: z.boolean(),
    temperature: z.number().nullable(),
    stores: z.enum(["per-case-fresh", "accumulated"]),
    cache: z.enum(["cold", "warm"]),
    // Whether reviewers saw the full hydrated changed-file content ("full") or only
    // the diff ("diff-only"). Guards against silently pooling numbers from a future
    // diff-only fallback with hydrated ones (they are not comparable).
    file_context: z.enum(["full", "diff-only"]),
    phases: PhasesSnapshotSchema,
    host_os: z.string(),
    timestamp: z.string(),
    case_count: z
      .object({ seeded: z.number().int().nonnegative(), clean: z.number().int().nonnegative() })
      .strict(),
    // Alpha.12 additive provenance. Optional so published v1 artifacts from older
    // releases continue to parse byte-for-byte.
    case_run_count: z
      .object({
        seeded: z.number().int().nonnegative(),
        clean: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    critic: CriticProvenanceSchema.nullable().optional(),
    integrity: IntegrityProvenanceSchema.optional(),
  })
  .strict();

export const CaseCriticSchema = z
  .object({
    provider: z.string(),
    eligible: z.boolean(),
    status: z.enum(["not-eligible", "ran", "error", "empty", "misconfigured", "skipped-budget"]),
    verdicts: z.number().int().nonnegative(),
    demoted: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.eligible !== (value.status !== "not-eligible")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eligible must agree with critic status",
        path: ["eligible"],
      });
    }
  });

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const PolicyPassIdSchema = z.enum(POLICY_PASS_IDS);
const PolicyTraceArtifactRefSchema = z
  .string()
  .regex(
    /^artifacts\/policy-traces\/\d{4}\/\d{2}\/\d{2}\/policy\/[0-9a-f]{12}-i(?:0|[1-9]\d*)-[0-9a-f]{12}\.json$/,
  );
const PolicyTraceSetArtifactRefSchema = z
  .string()
  .regex(/^artifacts\/policy-trace-sets\/[0-9a-f]{64}\.json$/);
const ResultArtifactRefSchema = z.string().regex(/^artifacts\/results\/[0-9a-f]{64}\.json$/);
const ResponseManifestArtifactRefSchema = z
  .string()
  .regex(/^artifacts\/responses\/[0-9a-f]{64}\.json$/);

export type ThrowableSafeValue =
  | null
  | string
  | number
  | boolean
  | ThrowableSafeValue[]
  | { [key: string]: ThrowableSafeValue };

const MAX_PERCENT_DECODE_PASSES = 3;
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "credential",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "signature",
] as const;

function isSensitiveThrowableKey(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

const SensitiveThrowableFieldSchema = z
  .string()
  .min(1)
  .refine((value) => !isSensitiveThrowableKey(value), "throwable field contains sensitive key");
const ABSOLUTE_POSIX_PATH = /(?:^|[\s"\x27\x60([{=,:;])\/(?!\/)(?=[^\s/])/;
const FORWARD_UNC_PATH = /(?:^|[\s"\x27\x60([{=,:;])\/\/[^/\s\\]+\/[^/\s\\]+/;
const WINDOWS_DRIVE_PATH = /(?:^|[\s"\x27\x60([{=,:;])[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /(?:^|[\s"\x27\x60([{=,:;])\\\\[^\\\s]+\\[^\\\s]+/;
const URL_SEGMENT = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`)}]+/gi;
const KEY_VALUE_PAIR =
  /(?:"([^"\r\n]{1,128})"|'([^'\r\n]{1,128})'|([A-Za-z][A-Za-z0-9_.-]{0,127}))\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/g;
const CREDENTIAL_VALUE =
  /(?:\bBearer\s+\S+|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b)/i;

function decodePercentToFixedPoint(value: string): string | null {
  let decoded = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    if (!decoded.includes("%")) return decoded;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  return decoded.includes("%") ? null : decoded;
}

function hasSensitiveKeyValuePair(value: string): boolean {
  for (const match of value.matchAll(KEY_VALUE_PAIR)) {
    const key = match[1] ?? match[2] ?? match[3];
    if (key !== undefined && isSensitiveThrowableKey(key)) return true;
  }
  return false;
}

function maskSafeHttpUrls(value: string): string | null {
  let invalidUrl = false;
  const nonUrlText = value.replace(URL_SEGMENT, (rawUrl) => {
    try {
      const parsed = new URL(rawUrl);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username !== "" ||
        parsed.password !== ""
      ) {
        invalidUrl = true;
        return rawUrl;
      }
      if (
        hasSensitiveKeyValuePair(`${parsed.pathname} ${parsed.hash}`) ||
        Array.from(parsed.searchParams).some(
          ([key, partValue]) =>
            isSensitiveThrowableKey(key) ||
            hasSensitiveKeyValuePair(partValue) ||
            CREDENTIAL_VALUE.test(partValue),
        )
      ) {
        invalidUrl = true;
        return rawUrl;
      }
      return " ".repeat(rawUrl.length);
    } catch {
      invalidUrl = true;
      return rawUrl;
    }
  });
  return invalidUrl ? null : nonUrlText;
}

/** Shared at-rest boundary for every string in a captured provider throw. */
export function isAuthoritativeThrowableString(value: string): boolean {
  const decodedValue = decodePercentToFixedPoint(value);
  if (decodedValue === null) return false;
  const hasUnsafeControlCharacter = Array.from(decodedValue).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    );
  });
  const nonUrlText = maskSafeHttpUrls(decodedValue);
  return (
    !hasUnsafeControlCharacter &&
    nonUrlText !== null &&
    !ABSOLUTE_POSIX_PATH.test(nonUrlText) &&
    !FORWARD_UNC_PATH.test(nonUrlText) &&
    !WINDOWS_DRIVE_PATH.test(nonUrlText) &&
    !WINDOWS_UNC_PATH.test(nonUrlText) &&
    !hasSensitiveKeyValuePair(nonUrlText) &&
    !CREDENTIAL_VALUE.test(decodedValue) &&
    redactHighEntropy(nonUrlText).count === 0
  );
}
const SafeThrowableStringSchema = z
  .string()
  .refine(isAuthoritativeThrowableString, "throwable string contains unsafe data");
const SafeThrowableNameSchema = z
  .string()
  .min(1)
  .refine(isAuthoritativeThrowableString, "throwable string contains unsafe data");

export const ThrowableSafeValueSchema: z.ZodType<ThrowableSafeValue> = z.lazy(() =>
  z.union([
    z.null(),
    SafeThrowableStringSchema,
    z.number().finite(),
    z.boolean(),
    z.array(ThrowableSafeValueSchema),
    z.record(SensitiveThrowableFieldSchema, ThrowableSafeValueSchema),
  ]),
);

export type CapturedThrowableSnapshot =
  | { kind: "primitive"; primitive_type: "string"; value: string }
  | { kind: "primitive"; primitive_type: "undefined" | "null" }
  | {
      kind: "error";
      error_type: "Error" | "SandboxUnavailableError";
      name: string;
      message: string;
      cause?: CapturedThrowableSnapshot | undefined;
      fields: Array<{ key: string; value: ThrowableSafeValue; enumerable: boolean }>;
    };

export const CAPTURED_THROWABLE_FIELD_KEYS = [
  "code",
  "context",
  "errno",
  "exitCode",
  "killed",
  "retryable",
  "signal",
  "status",
  "statusCode",
  "syscall",
  "timedOut",
] as const;
const CapturedThrowableFieldKeySchema = z.enum(CAPTURED_THROWABLE_FIELD_KEYS);

export const CapturedThrowableSnapshotSchema: z.ZodType<CapturedThrowableSnapshot> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal("primitive"),
        primitive_type: z.literal("string"),
        value: SafeThrowableStringSchema,
      })
      .strict(),
    z.object({ kind: z.literal("primitive"), primitive_type: z.literal("undefined") }).strict(),
    z.object({ kind: z.literal("primitive"), primitive_type: z.literal("null") }).strict(),
    z
      .object({
        kind: z.literal("error"),
        error_type: z.enum(["Error", "SandboxUnavailableError"]),
        name: SafeThrowableNameSchema,
        message: SafeThrowableStringSchema,
        cause: CapturedThrowableSnapshotSchema.optional(),
        fields: z.array(
          z
            .object({
              key: CapturedThrowableFieldKeySchema,
              value: ThrowableSafeValueSchema,
              enumerable: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict()
      .superRefine((value, ctx) => {
        const keys = value.fields.map((field) => field.key);
        if (
          keys.some((key, index) => index > 0 && (keys[index - 1] ?? "").localeCompare(key) >= 0)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["fields"],
            message: "throwable fields must be uniquely sorted",
          });
        }
      }),
  ]),
);

export const BenchResponseManifestSchema = z
  .object({
    schema: z.literal("reviewgate.bench.provider-response-hashes.v2"),
    entries: z.array(
      z
        .object({
          provider: z.string().min(1),
          kind: z.enum(["review", "complete"]),
          ordinal: z.number().int().nonnegative(),
          request_sha256: Sha256Schema,
          response_sha256: Sha256Schema,
          outcome: z.enum(["return", "throw"]),
          throw_snapshot: CapturedThrowableSnapshotSchema.optional(),
        })
        .strict()
        .superRefine((value, ctx) => {
          if ((value.outcome === "throw") !== (value.throw_snapshot !== undefined)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["throw_snapshot"],
              message: "throw outcomes require exactly one typed snapshot",
            });
          }
          if (value.throw_snapshot !== undefined) {
            const actual = createHash("sha256")
              .update(Buffer.from(canonicalJson(value.throw_snapshot), "utf8"))
              .digest("hex");
            if (actual !== value.response_sha256) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["response_sha256"],
                message: "throw snapshot hash mismatch",
              });
            }
          }
        }),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.entries.some((entry, index) => entry.ordinal !== index)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "response ordinals must be globally contiguous",
      });
    }
  });

export const BenchPolicyTraceRunSchema = z
  .object({
    authoritative: z.boolean(),
    status: z.enum(["complete", "not-run", "error", "overflow"]),
    catalog_version: z.string().min(1),
    requested_ablations: z.array(PolicyPassIdSchema),
    trace: PolicyTraceSchema.optional(),
    trace_ref: PolicyTraceArtifactRefSchema.optional(),
    trace_sha256: Sha256Schema.optional(),
    request_identity_sha256: Sha256Schema,
    effective_config_sha256: Sha256Schema,
    final_identity_sha256: Sha256Schema,
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const completeFields = [value.trace, value.trace_ref, value.trace_sha256];
    if (value.status === "complete") {
      if (completeFields.some((field) => field === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trace"],
          message: "complete policy trace requires trace/ref/hash",
        });
      }
      if (value.trace !== undefined && value.trace_sha256 !== undefined) {
        const actualSha256 = createHash("sha256")
          .update(Buffer.from(canonicalJson(value.trace), "utf8"))
          .digest("hex");
        if (value.trace_sha256 !== actualSha256) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["trace_sha256"],
            message: "embedded policy trace hash mismatch",
          });
        }
        const traceRefMatch = value.trace_ref?.match(
          /^artifacts\/policy-traces\/\d{4}\/\d{2}\/\d{2}\/policy\/([0-9a-f]{12})-i(0|[1-9]\d*)-([0-9a-f]{12})\.json$/,
        );
        const runSha12 = createHash("sha256").update(value.trace.run_id).digest("hex").slice(0, 12);
        if (
          traceRefMatch === null ||
          traceRefMatch === undefined ||
          traceRefMatch[1] !== runSha12 ||
          Number(traceRefMatch[2]) !== value.trace.iter ||
          traceRefMatch[3] !== actualSha256.slice(0, 12)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["trace_ref"],
            message: "persisted policy trace reference mismatch",
          });
        }
        const finalSha256 = createHash("sha256")
          .update(Buffer.from(canonicalJson(value.trace.final), "utf8"))
          .digest("hex");
        if (value.final_identity_sha256 !== finalSha256) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["final_identity_sha256"],
            message: "embedded policy final identity mismatch",
          });
        }
        if (
          value.requested_ablations.length !== value.trace.ablated.length ||
          value.requested_ablations.some((passId, index) => passId !== value.trace?.ablated[index])
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["requested_ablations"],
            message: "requested ablations must equal the embedded trace profile",
          });
        }
      }
    } else if (completeFields.some((field) => field !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trace"],
        message: `${value.status} policy trace forbids trace/ref/hash`,
      });
    }
    if (value.authoritative !== (value.status === "complete" && value.reason === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authoritative"],
        message: "authoritative requires complete trace and no invalidity reason",
      });
    }
    if (
      value.authoritative &&
      (value.catalog_version !== POLICY_CATALOG_VERSION ||
        value.trace?.catalog_version !== POLICY_CATALOG_VERSION)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalog_version"],
        message: "authoritative trace requires the current policy catalog",
      });
    }
  });

export const CaseResultSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["seeded-bug", "clean"]),
    // scored = counted; review-error = a provider failed on this case; invalid = malformed case.json
    status: z.enum(["scored", "review-error", "invalid"]),
    content_hash: z.string(),
    counts: z
      .object({
        tp: z.number().int().nonnegative(),
        fp: z.number().int().nonnegative(),
        fn: z.number().int().nonnegative(),
        neutral: z.number().int().nonnegative(),
      })
      .strict(),
    // Per-case aggregate-panel coverage: how many configured reviewers actually
    // returned an OK result vs. how many were configured. A case scored on a
    // degraded panel (panel_ok < panel_configured) is recorded so the run-level
    // quality gate can flag it rather than silently averaging it in.
    panel_ok: z.number().int().nonnegative(),
    panel_configured: z.number().int().nonnegative(),
    file_context: z.enum(["full", "diff-only"]),
    // Which repeat (1..K) this case-run belongs to under `--repeat K`. Absent ⇒ 1.
    repeat: z.number().int().positive().optional(),
    latency_ms: z.number().nonnegative().nullable(),
    error: z.string().nullable(),
    critic: CaseCriticSchema.optional(),
    // Additive: legacy BenchResult v1 rows without traces remain parseable, but
    // exact policy matrix runs require this block before they can be scored.
    policy_trace: BenchPolicyTraceRunSchema.optional(),
  })
  .strict();

// One metric's spread across the K repeats (spec §10#3). `stddev` is the population
// standard deviation; stats are null when no repeat had a defined value (den=0).
export const SpreadStatSchema = z
  .object({
    mean: z.number().nullable(),
    stddev: z.number().min(0).nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    samples: z.number().int().nonnegative(),
  })
  .strict();

// Run-to-run stability under `--repeat K` — the mean ± spread of each headline
// metric across the K repeats, so a lucky/unlucky single run isn't mistaken for
// signal. Null on a single run (repeat=1).
export const StabilitySchema = z
  .object({
    repeats: z.number().int().positive(),
    precision: SpreadStatSchema,
    recall: SpreadStatSchema,
    clean_fp_rate: SpreadStatSchema,
  })
  .strict();

// Per-provider RAW-layer results (spec §5.1/§12): each reviewer scored on its own
// pre-aggregation findings, distinct from the aggregated panel. `coverage` is the
// fraction of scored cases the provider returned an OK result on; `authoritative`
// is false when coverage is too low to trust the number — and a provider can never
// be authoritative on an undefined (den=0) coverage.
export const ProviderResultSchema = z
  .object({
    provider: z.string(),
    coverage: MetricSchema,
    precision: MetricSchema,
    recall: MetricSchema,
    authoritative: z.boolean(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.authoritative && p.coverage.value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authoritative requires a defined (den>0) coverage",
        path: ["authoritative"],
      });
    }
  });

export const CostSchema = z
  .object({
    provider: z.string(),
    calls: z.number().int().nonnegative(),
    cache_hits: z.number().int().nonnegative(),
    // null means the provider/CLI did not expose trustworthy accounting. Never
    // coerce unknown usage or billing to a misleading numeric zero.
    tokens_in: z.number().int().nonnegative().nullable(),
    tokens_out: z.number().int().nonnegative().nullable(),
    billed_usd: z.number().nonnegative().nullable(),
    oauth_quota_calls: z.number().int().nonnegative(),
  })
  .strict();

export const CriticResultSchema = z
  .object({
    provider: z.string(),
    eligible: z.number().int().nonnegative(),
    ran: z.number().int().nonnegative(),
    coverage: MetricSchema,
    authoritative: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.ran > value.eligible ||
      value.coverage.num !== value.ran ||
      value.coverage.den !== value.eligible
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "critic coverage must equal ran/eligible",
        path: ["coverage"],
      });
    }
  });

// The run's own quality-gate outcome, stamped into the artifact so a saved
// result is SELF-DESCRIBING. Trustworthiness was previously knowable only from
// the process exit code (ephemeral) or by digging into per-provider coverage;
// a consumer collecting baselines could mistake a quota-degraded run (a
// reviewer at 0% coverage → de-facto single-provider panel) for an authoritative
// one. `authoritative` mirrors the runner's exit-0 decision; `gate_exit_code`
// is 0 (clean) | 3 (provider outage) | 4 (benchmark-invalid); `reasons` lists
// the blocking gate reasons. Optional for backward-compat with result files
// written before this field — `isAuthoritative()` re-derives when it is absent.
// Reason strings are rendered VERBATIM into terminal reports (`reviewgate bench
// report <path>` accepts an arbitrary file). Reject ASCII control/escape bytes at
// the parse boundary so a crafted artifact cannot smuggle ANSI/VT100 sequences
// (cursor moves, screen clears) that rewrite surrounding output. Runner-produced
// reasons are plain sentences. (No control-char regex literal — biome flags those.)
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // C0 (<0x20) + DEL (0x7f) + C1 (0x80–0x9f). C1 matters because U+009B is the
    // 8-bit CSI — terminals in 8-bit mode treat it as ESC+"[", so it can drive
    // the same VT100 sequences as an ESC.
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

export const BenchVerdictSchema = z
  .object({
    authoritative: z.boolean(),
    // 0 (clean) | 3 (provider outage) | 4 (benchmark-invalid) — the only exit
    // codes under which a result file is written.
    gate_exit_code: z.union([z.literal(0), z.literal(3), z.literal(4)]),
    reasons: z.array(
      z.string().refine((s) => !hasControlChar(s), "reasons must not contain control characters"),
    ),
  })
  .strict()
  // Invariants the runner always upholds; enforced at the schema boundary so a
  // crafted/buggy artifact carrying a contradictory verdict fails validation
  // instead of silently passing.
  .refine((v) => v.authoritative === (v.gate_exit_code === 0), {
    message: "authoritative must equal (gate_exit_code === 0)",
    path: ["authoritative"],
  })
  // A non-authoritative verdict must state WHY (else the report shows a bare
  // "NON-AUTHORITATIVE" banner with no cause — a misleading audit trail); an
  // authoritative one carries no reasons. `authoritative ⟺ reasons empty`.
  .refine((v) => v.authoritative === (v.reasons.length === 0), {
    message: "a non-authoritative verdict must state reasons; an authoritative one must have none",
    path: ["reasons"],
  });

export const BenchResultSchema = z
  .object({
    schema: z.literal("reviewgate.bench.result.v1"),
    provenance: ProvenanceSchema,
    cases: z.array(CaseResultSchema),
    // Per-provider RAW-layer metrics (see ProviderResultSchema). Distinct from
    // `aggregate`, which is the post-suppression panel.
    providers: z.array(ProviderResultSchema),
    cost: z.array(CostSchema),
    critic: CriticResultSchema.nullable().optional(),
    aggregate: z
      .object({
        precision: MetricSchema,
        recall: MetricSchema,
        clean_fp_rate: MetricSchema,
      })
      .strict(),
    // Present (object) only under `--repeat K` (K>1); null/absent for a single run.
    stability: StabilitySchema.nullable().optional(),
    verdict: BenchVerdictSchema.optional(),
  })
  .strict();

const BenchPolicyTraceSetRunSchema = z
  .object({
    label: z.string().min(1),
    ablated_pass_id: PolicyPassIdSchema.nullable(),
    result: z.object({ path: ResultArtifactRefSchema, sha256: Sha256Schema }).strict(),
    traces: z.array(
      z
        .object({
          case_id: z.string().min(1),
          repeat: z.number().int().positive(),
          trace_ref: PolicyTraceArtifactRefSchema,
          trace_sha256: Sha256Schema,
          effective_config_sha256: Sha256Schema,
          request_identity_sha256: Sha256Schema,
          final_identity_sha256: Sha256Schema,
          raw_response_sha256: z.array(Sha256Schema),
        })
        .strict(),
    ),
  })
  .strict();

export const BenchPolicyTraceSetSchema = z
  .object({
    schema: z.literal("reviewgate.bench.policy-trace-set.v1"),
    catalog_version: z.literal(POLICY_CATALOG_VERSION),
    response_manifest: z
      .object({ path: ResponseManifestArtifactRefSchema, sha256: Sha256Schema })
      .strict(),
    runs: z.array(BenchPolicyTraceSetRunSchema).min(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.response_manifest.path !== `artifacts/responses/${value.response_manifest.sha256}.json`
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response_manifest", "path"],
        message: "response manifest path/hash identity mismatch",
      });
    }
    const baseline = value.runs[0];
    if (baseline?.label !== "baseline" || baseline.ablated_pass_id !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runs", 0],
        message: "trace set must start with the unabated baseline",
      });
      return;
    }
    const labels = new Set<string>();
    const passIds = new Set<string>();
    for (const [runIndex, run] of value.runs.entries()) {
      if (run.result.path !== `artifacts/results/${run.result.sha256}.json`) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runs", runIndex, "result", "path"],
          message: "result path/hash identity mismatch",
        });
      }
      if (labels.has(run.label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runs", runIndex, "label"],
          message: "trace-set run labels must be unique",
        });
      }
      labels.add(run.label);
      if (runIndex > 0) {
        if (run.ablated_pass_id === null || passIds.has(run.ablated_pass_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["runs", runIndex, "ablated_pass_id"],
            message: "counterfactual trace sets require one unique pass ID",
          });
        } else {
          passIds.add(run.ablated_pass_id);
        }
      }
      if (baseline === undefined || run.traces.length !== baseline.traces.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runs", runIndex, "traces"],
          message: "trace-set runs must have identical case cardinality",
        });
        continue;
      }
      for (const [traceIndex, trace] of run.traces.entries()) {
        if (!trace.trace_ref.endsWith(`-${trace.trace_sha256.slice(0, 12)}.json`)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["runs", runIndex, "traces", traceIndex, "trace_ref"],
            message: "policy trace path/hash identity mismatch",
          });
        }
        const base = baseline.traces[traceIndex];
        if (
          base === undefined ||
          trace.case_id !== base.case_id ||
          trace.repeat !== base.repeat ||
          trace.effective_config_sha256 !== base.effective_config_sha256 ||
          trace.request_identity_sha256 !== base.request_identity_sha256 ||
          trace.raw_response_sha256.length !== base.raw_response_sha256.length ||
          trace.raw_response_sha256.some(
            (hash, hashIndex) => hash !== base.raw_response_sha256[hashIndex],
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["runs", runIndex, "traces", traceIndex],
            message: "trace-set pair identity mismatch",
          });
        }
      }
    }
  });

// reviewgate bench matrix (spec §8) — the ablation Δ table. One variant per row:
// the baseline (full suppression) plus one row per ablated layer, each carrying
// its point metrics and the signed delta vs. baseline.
export const MatrixVariantSchema = z
  .object({
    label: z.string(),
    /** the ablated layer ("" for the baseline row). */
    ablation: z.string(),
    /** A = post-review suppressor (aggregated layer only); B = input/prompt-stage. */
    class: z.enum(["A", "B", "baseline"]),
    precision: MetricSchema,
    recall: MetricSchema,
    clean_fp_rate: MetricSchema,
    /** baseline − variant per metric (null on the baseline row). */
    delta: z
      .object({
        precision: z.number(),
        recall: z.number(),
        clean_fp_rate: z.number(),
      })
      .strict()
      .nullable(),
    authoritative: z.boolean().optional(),
    result_ref: z.string().optional(),
    result_sha256: z.string().optional(),
    policy: z
      .object({
        catalog_version: z.string().min(1),
        ablated_pass_id: PolicyPassIdSchema.nullable(),
        trace_status: z.enum(["complete", "not-run", "error", "overflow"]),
        trace_ref: PolicyTraceSetArtifactRefSchema.optional(),
        trace_sha256: Sha256Schema.optional(),
        raw_response_sha256: z.array(Sha256Schema),
        authoritative: z.boolean(),
        reason: z.string().min(1).nullable(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.authoritative && value.catalog_version !== POLICY_CATALOG_VERSION) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["catalog_version"],
            message: "authoritative matrix policy requires the current catalog",
          });
        }
        const hasIdentity = value.trace_ref !== undefined && value.trace_sha256 !== undefined;
        const hasAnyIdentity = value.trace_ref !== undefined || value.trace_sha256 !== undefined;
        if (value.trace_status === "complete" && !hasIdentity) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["trace_ref"],
            message: "complete matrix policy requires trace ref/hash",
          });
        }
        if (value.trace_status !== "complete" && hasAnyIdentity) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["trace_ref"],
            message: `${value.trace_status} matrix policy forbids trace ref/hash`,
          });
        }
        if (value.authoritative !== (value.trace_status === "complete" && value.reason === null)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["authoritative"],
            message: "authoritative matrix policy requires complete trace and no reason",
          });
        }
      })
      .optional(),
  })
  .strict();

const MatrixArtifactRefSchema = z.object({ path: z.string(), sha256: z.string() }).strict();

export const BenchMatrixSchema = z
  .object({
    schema: z.literal("reviewgate.bench.matrix.v1"),
    provenance: ProvenanceSchema,
    variants: z.array(MatrixVariantSchema),
    authoritative: z.boolean().optional(),
    artifacts: z
      .object({
        baseline: MatrixArtifactRefSchema,
        variants: z.array(MatrixArtifactRefSchema),
        reviewer_responses: MatrixArtifactRefSchema,
        policy_trace_set: MatrixArtifactRefSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Metric = z.infer<typeof MetricSchema>;
export type MatrixVariant = z.infer<typeof MatrixVariantSchema>;
export type BenchMatrix = z.infer<typeof BenchMatrixSchema>;
export type PhasesSnapshot = z.infer<typeof PhasesSnapshotSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type BenchPolicyTraceRun = z.infer<typeof BenchPolicyTraceRunSchema>;
export type BenchResponseManifest = z.infer<typeof BenchResponseManifestSchema>;
export type BenchPolicyTraceSet = z.infer<typeof BenchPolicyTraceSetSchema>;
export type SpreadStat = z.infer<typeof SpreadStatSchema>;
export type Stability = z.infer<typeof StabilitySchema>;
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type BenchVerdict = z.infer<typeof BenchVerdictSchema>;
export type BenchResult = z.infer<typeof BenchResultSchema>;
