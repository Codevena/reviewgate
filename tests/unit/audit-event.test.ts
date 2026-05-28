// tests/unit/audit-event.test.ts
import { describe, expect, it } from "bun:test";
import { type AuditEvent, AuditEventSchema } from "../../src/schemas/audit-event.ts";

describe("AuditEventSchema", () => {
  it("accepts a reviewer.complete event with full gen_ai block", () => {
    const e: AuditEvent = {
      schema: "reviewgate.audit.v1",
      ts: "2026-05-20T14:32:11.482Z",
      run_id: "01HXQ",
      iter: 1,
      event: "reviewer.complete",
      git: { sha: "abc", branch: "main", dirty_files: ["src/x.ts"], base: "main", ahead_by: 0 },
      trigger: "stop-hook",
      reviewer: { id: "codex", role: "review", iter_attempt: 1 },
      gen_ai: {
        "provider.name": "openai",
        "request.model": "gpt-5.5",
        "response.model": "gpt-5.4-2026-04",
        "operation.name": "review",
        "usage.input_tokens": 1000,
        "usage.output_tokens": 200,
      },
      prompt_sha256: "p",
      response_sha256: "r",
      prompt_ref: "cassettes/p",
      response_ref: "cassettes/r",
      files_read: ["src/x.ts"],
      latency_ms: 1234,
      cost_usd: 0,
      auth_mode: "oauth",
      exit_code: 0,
      finding_count: 0,
      finding_signatures: [],
      verdict_contribution: "PASS",
      prev_event_hash: "h0",
      this_event_hash: "h1",
    };
    expect(() => AuditEventSchema.parse(e)).not.toThrow();
  });

  it("accepts a session.start event with minimal fields", () => {
    const e = {
      schema: "reviewgate.audit.v1" as const,
      ts: "2026-05-20T14:32:00Z",
      run_id: "01HXQ",
      iter: 0,
      event: "session.start" as const,
      trigger: "session-start" as const,
      prev_event_hash: "",
      this_event_hash: "h1",
    };
    expect(() => AuditEventSchema.parse(e)).not.toThrow();
  });

  it("rejects unknown event type", () => {
    expect(() =>
      AuditEventSchema.parse({
        schema: "reviewgate.audit.v1",
        ts: "x",
        run_id: "x",
        iter: 0,
        event: "banana",
        trigger: "stop-hook",
        prev_event_hash: "x",
        this_event_hash: "x",
      }),
    ).toThrow();
  });
});
