// tests/unit/audit-provider-hardening.test.ts
// Regression tests for the provider-layer audit findings:
//   F-1  temp-dir cleanup (no /tmp leak per review)
//   F-2  scrubbed reviewer env (foreign secrets dropped)
//   F-4  review-output crash guards (untrusted shapes)
//   F-5  bounded availability probe
//   F-6  quota signatures (underscore form + injection-resistant banner scan)
//   F-7  tolerant severity coercion
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubReviewerEnv } from "../../src/providers/availability.ts";
import { OpenCodeAdapter } from "../../src/providers/opencode.ts";
import { isQuotaBanner, isQuotaExhausted } from "../../src/providers/quota-signals.ts";
import { mapReviewOutputToFindings, parseReviewOutput } from "../../src/providers/review-output.ts";

// ---------------------------------------------------------------------------
// F-2 — scrubReviewerEnv drops foreign secrets, keeps non-secret config + own key
// ---------------------------------------------------------------------------
describe("scrubReviewerEnv (F-2)", () => {
  it("drops foreign provider API keys / tokens / secrets", () => {
    const env = scrubReviewerEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      SOME_OTHER_API_KEY: "sk-foreign",
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-anthropic",
      GITHUB_TOKEN: "ghp_x",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      DB_PASSWORD: "hunter2",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.SOME_OTHER_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
  });

  it("keeps a provider's OWN auth var when explicitly allowlisted", () => {
    const env = scrubReviewerEnv({ OPENAI_API_KEY: "sk-mine", OTHER_API_KEY: "sk-foreign" }, [
      "OPENAI_API_KEY",
    ]);
    expect(env.OPENAI_API_KEY).toBe("sk-mine");
    expect(env.OTHER_API_KEY).toBeUndefined();
  });

  it("preserves ordinary non-secret config (XDG/NODE/locale/proxies)", () => {
    const env = scrubReviewerEnv({
      XDG_CONFIG_HOME: "/c",
      NODE_OPTIONS: "--max-old-space-size=4096",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy:8080",
    });
    expect(env.XDG_CONFIG_HOME).toBe("/c");
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
  });

  it("ignores undefined values (no `undefined` strings leak through)", () => {
    const env = scrubReviewerEnv({ PATH: "/bin", MISSING: undefined });
    expect(env.PATH).toBe("/bin");
    expect("MISSING" in env).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-6a — canonical underscore quota forms
// ---------------------------------------------------------------------------
describe("quota signatures — canonical underscore forms (F-6a)", () => {
  it("detects rate_limit_exceeded (OpenAI/OpenRouter)", () => {
    expect(isQuotaExhausted('{"error":{"code":"rate_limit_exceeded"}}')).toBe(true);
  });
  it("still detects rate_limit_error (Anthropic)", () => {
    expect(isQuotaExhausted('{"type":"rate_limit_error"}')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-6b — injection-resistant quota banner scan for echo-able channels
// ---------------------------------------------------------------------------
describe("isQuotaBanner — injection resistance (F-6b)", () => {
  it("does NOT classify a diff body that merely contains 'rate limit exceeded'", () => {
    // A reviewer echoing a large diff/reasoning block that quotes the phrase from
    // a planted code comment must not be misread as the reviewer being throttled.
    const echoedDiff = [
      "Looking at the changes, the function in src/api.ts handles requests.",
      "There is a comment in the diff that reads: // TODO handle rate limit exceeded gracefully when the upstream returns 429 — but this is just reviewed code, not the CLI being throttled, and the line is long enough to be agent reasoning rather than a banner.",
      "Overall the change looks fine.",
    ].join("\n");
    expect(isQuotaBanner(echoedDiff)).toBe(false);
  });

  it("DOES classify a short real banner line", () => {
    expect(isQuotaBanner("ERROR: You've hit your usage limit. Try again later.")).toBe(true);
    expect(
      isQuotaBanner("⚠ Individual quota reached. Contact your administrator to enable overages."),
    ).toBe(true);
  });

  it("DOES classify a codex --json item event banner (structured field)", () => {
    const events = [
      '{"type":"item.completed","text":"You have hit your usage limit for this period."}',
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
    ].join("\n");
    expect(isQuotaBanner(events)).toBe(true);
  });

  it("does NOT classify a JSON event whose long text field merely echoes the phrase", () => {
    const longEcho = `{"type":"agent_message","text":"${"x".repeat(700)} rate limit exceeded ${"y".repeat(50)}"}`;
    expect(isQuotaBanner(longEcho)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-4 — review-output crash guards on untrusted shapes
// ---------------------------------------------------------------------------
describe("review-output crash guards (F-4)", () => {
  it("F-4a: normalizeProposals tolerates a non-object memory_proposals element ([null])", () => {
    const raw = JSON.stringify({
      verdict: "PASS",
      findings: [],
      memory_proposals: [
        null,
        42,
        "x",
        {
          type: "convention",
          scope: "s",
          title: "t",
          body: "b",
          confidence: 0.5,
          tags: [],
          evidence: [null, { kind: "k" }],
        },
      ],
    });
    // Must NOT throw; the non-object proposals are dropped, the valid one survives.
    const out = parseReviewOutput(raw);
    expect(out).not.toBeNull();
    expect(out?.memory_proposals?.length).toBe(1);
    expect(out?.memory_proposals?.[0]?.evidence.length).toBe(1); // null evidence dropped
    expect(out?.memory_proposals?.[0]?.evidence[0]?.kind).toBe("k");
  });

  it("F-4b: a non-string `details` does not crash mapping (coerced to message)", () => {
    const ctx = { provider: "codex", model: "m", persona: "security", workingDir: "/repo" };
    const findings = mapReviewOutputToFindings(
      {
        verdict: "FAIL",
        findings: [
          {
            severity: "WARN",
            category: "quality",
            rule_id: "r",
            file: "a.ts",
            line: 5,
            message: "the message",
            // non-string details from a malformed reviewer payload
            details: { nested: true } as never,
            confidence: 0.6,
          },
        ],
      },
      ctx,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.details).toBe("the message");
  });
});

// ---------------------------------------------------------------------------
// F-7 — tolerant severity coercion
// ---------------------------------------------------------------------------
describe("severity coercion (F-7)", () => {
  const ctx = { provider: "codex", model: "m", persona: "security", workingDir: "/repo" };
  const mk = (severity: string) =>
    mapReviewOutputToFindings(
      {
        verdict: "FAIL",
        findings: [
          {
            severity: severity as never,
            category: "quality",
            rule_id: "r",
            file: "a.ts",
            line: 1,
            message: "m",
            details: "d",
            confidence: 0.5,
          },
        ],
      },
      ctx,
    )[0];

  it("coerces 'warning' → WARN (finding NOT dropped)", () => {
    expect(mk("warning")?.severity).toBe("WARN");
  });
  it("coerces 'Critical' → CRITICAL", () => {
    expect(mk("Critical")?.severity).toBe("CRITICAL");
  });
  it("coerces 'high' → CRITICAL and 'note' → INFO", () => {
    expect(mk("high")?.severity).toBe("CRITICAL");
    expect(mk("note")?.severity).toBe("INFO");
  });
  it("still DROPS genuine garbage severity ('BOGUS')", () => {
    expect(mk("BOGUS")).toBeUndefined();
  });
  it("accepts the canonical tokens unchanged", () => {
    expect(mk("INFO")?.severity).toBe("INFO");
    expect(mk("WARN")?.severity).toBe("WARN");
    expect(mk("CRITICAL")?.severity).toBe("CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// F-1 — review() removes its per-run temp dir (no /tmp leak)
// ---------------------------------------------------------------------------
describe("temp-dir cleanup (F-1)", () => {
  it("opencode.review() leaves no rg-oc-run- temp dir behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-test-"));
    // Fake opencode: emits a valid review JSON on stdout, exit 0.
    const bin = join(dir, "fake-opencode.sh");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
set -u
printf '%s' '{"verdict":"PASS","findings":[]}'
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");

    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("rg-oc-run-")));
    const adapter = new OpenCodeAdapter({ binPath: bin });
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "default", timeoutMs: 30_000 },
      reviewerId: "opencode-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "findings.md"),
      persona: "security",
      diffPath: join(dir, "diff.patch"),
    });
    expect(result.status).toBe("ok");
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("rg-oc-run-") && !before.has(n));
    // No NEW rg-oc-run- dir should survive the call.
    expect(after.filter((n) => existsSync(join(tmpdir(), n)))).toEqual([]);
  });
});
