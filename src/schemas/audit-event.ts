// src/schemas/audit-event.ts
import { z } from "zod";
import { Severity } from "./finding.ts";

export const EventType = z.enum([
  "session.start",
  "session.end",
  "run.start",
  "run.complete",
  "phase.start",
  "phase.complete",
  "reviewer.start",
  "reviewer.complete",
  "reviewer.error",
  "aggregator.complete",
  "verdict.computed",
  "gate.decision",
  "escalation",
  "decision.applied",
  "curator.start",
  "curator.complete",
  "brain.egress",
]);
export type EventType = z.infer<typeof EventType>;

export const Trigger = z.enum(["stop-hook", "post-tool-use", "manual", "session-start"]);
export type Trigger = z.infer<typeof Trigger>;

const Git = z.object({
  sha: z.string(),
  branch: z.string(),
  dirty_files: z.array(z.string()),
  base: z.string().optional(),
  ahead_by: z.number().int().nonnegative().optional(),
});

const Reviewer = z.object({
  id: z.string(),
  role: z.enum(["review", "triage", "critic", "curator"]),
  iter_attempt: z.number().int().positive(),
});

/**
 * Structured payload for `brain.egress` events: the actionable details of a
 * single web-fetch attempt made by the SSRF-resistant fetcher. Optional and
 * backward-compatible — events that do not carry egress data simply omit it.
 */
const Egress = z.object({
  url: z.string(),
  final_url: z.string().optional(),
  resolved_ip: z.string().optional(),
  status: z.number().int().optional(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
});

const GenAi = z.object({
  "provider.name": z.string(),
  "request.model": z.string(),
  "response.model": z.string().optional(),
  "operation.name": z.string(),
  "request.temperature": z.number().optional(),
  "request.seed": z.number().int().optional(),
  "usage.input_tokens": z.number().int().nonnegative(),
  "usage.output_tokens": z.number().int().nonnegative(),
  "usage.cached_input_tokens": z.number().int().nonnegative().optional(),
  "usage.reasoning_tokens": z.number().int().nonnegative().optional(),
  "response.finish_reasons": z.array(z.string()).optional(),
});

const ProviderIdEnum = z.enum(["codex", "gemini", "claude-code", "openrouter", "opencode"]);

export const ProviderStatSchema = z.object({
  provider: ProviderIdEnum,
  personas: z.array(z.string()),
  runs: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  demoted: z.number().int().nonnegative(),
  cost_usd: z.number(),
  duration_ms: z.number().int().nonnegative(),
});

export const RunSummarySchema = z.object({
  verdict: z.enum(["PASS", "SOFT-PASS", "FAIL", "ERROR"]),
  source: z.enum(["panel", "cache", "skipped", "checks"]),
  counts: z.object({
    critical: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  cost_usd: z.number(),
  duration_ms: z.number().int().nonnegative(),
  demoted: z.number().int().nonnegative(),
  signatures: z.array(z.string()),
  providers: z.array(ProviderStatSchema),
  // #6 instrumentation: count of findings this run that asserted a project/house rule WITHOUT
  // a verifiable file:line citation (the F-004 class). Persisted here so the audit trail gives
  // a timestamped before/after signal for the rule-citation directive. Optional/back-compat.
  rule_uncited: z.number().int().nonnegative().optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type ProviderStat = z.infer<typeof ProviderStatSchema>;

export const DecisionOutcomeSchema = z
  .object({
    finding_id: z.string(), // iteration-local, for debugging — NOT a count/dedup key
    severity: Severity, // uppercase CRITICAL | WARN | INFO
    bucket: z.enum(["tp", "fp", "declined"]),
    reviewer_was_wrong: z.boolean().optional(),
    providers: z.array(z.string()), // normalized, de-duped base provider ids
  })
  .strict();
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

export const AuditEventSchema = z.object({
  schema: z.literal("reviewgate.audit.v1"),
  ts: z.string(),
  run_id: z.string(),
  iter: z.number().int().nonnegative(),
  event: EventType,
  git: Git.optional(),
  trigger: Trigger,
  reviewer: Reviewer.optional(),
  gen_ai: GenAi.optional(),
  egress: Egress.optional(),
  run_summary: RunSummarySchema.optional(),
  decision_outcome: DecisionOutcomeSchema.optional(),
  prompt_sha256: z.string().optional(),
  response_sha256: z.string().optional(),
  prompt_ref: z.string().optional(),
  response_ref: z.string().optional(),
  files_read: z.array(z.string()).optional(),
  latency_ms: z.number().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  auth_mode: z.enum(["oauth", "apikey", "openrouter"]).optional(),
  quota_used_pct: z.number().min(0).max(100).nullable().optional(),
  exit_code: z.number().int().optional(),
  finding_count: z.number().int().nonnegative().optional(),
  finding_signatures: z.array(z.string()).optional(),
  verdict_contribution: z.string().optional(),
  prev_event_hash: z.string(),
  this_event_hash: z.string(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
