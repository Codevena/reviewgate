# Ollama Cloud Reviewer (`ollama` provider) Design

Status: **approved for planning** (brainstorm 2026-07-08). A new HTTP reviewer adapter for Ollama
Cloud's OpenAI-compatible endpoint, so the panel can run models like `glm-5.2:cloud` as a
first-class reviewer / critic. Modeled on the existing OpenRouter adapter
([[2026-05-20-reviewgate-design]]).

## Problem

Reviewgate's heterogeneous panel wants strong, cheap, reliable "extra voices." Two field facts drive
this:

1. **GLM-5.2 via Ollama Cloud is empirically reliable and strong.** Verified 2026-07-08 against
   `glm-5.2:cloud`: 3/3 trials, 1.4–6.5 s, never an empty 200, and it caught both planted CRITICALs
   plus a bonus WARN in the exact FINDINGS/VERDICT format. By contrast, **GLM on OpenRouter was
   flaky** (~3/15 timeouts) — so routing GLM through our existing OpenRouter adapter is not a good
   path. Ollama-direct is.
2. **We have no way to reach Ollama Cloud today.** The panel supports codex / gemini / claude-code /
   opencode (CLIs) and openrouter (HTTP+API-key). Ollama Cloud is a distinct endpoint with its own
   subscription and API key; nothing in the provider layer targets it.

The subscription is flat-rate ($0 within quota), so an Ollama reviewer is a $0-within-plan panel
member — attractive as a primary reviewer, a quota-failover fallback, or a critic.

## Scope & principle

**Approach B (generalized), OpenAI-compat `/v1`.** One new HTTP adapter that clones the OpenRouter
adapter's structure, plus a configurable `baseUrl` so the SAME provider serves Ollama Cloud AND a
self-hosted / local Ollama daemon. It slots into the panel as an ordinary reviewer — aggregator,
consensus, dedup, FP-ledger, reputation, and quota-failover treat it like any other provider, with
**no special-casing beyond the two HTTP-adapter concessions OpenRouter already needs** (sandbox skip,
key-based availability).

House principle: **fail-closed like every other adapter** — a refusal / empty / non-JSON / quota
response never becomes a zero-finding PASS.

Explicitly OUT (YAGNI):

- **`embed()`** — the Brain is default-OFF and OpenRouter already covers embeddings; no Ollama
  embeddings path now.
- **Native `/api/chat` as the default** — OpenAI-compat `/v1` maximizes reuse; native is only a
  documented fallback if the compat structured-output shim proves unreliable (see below).
- **`reasoningEffort` mapping** — not plumbed; GLM thinking control is out of scope.
- **Threading `baseUrl` into `isProviderAvailable`** — availability stays key-based (see Feature 4).

## Motivation is a verifiable wager, not an assumption

The 2026-07-08 reliability data was collected on the **local daemon native path**
(`http://localhost:11434/api/chat`, prompt-instructed FINDINGS format — NOT `response_format`). This
design ships the **cloud-direct `/v1` + API-key path with `response_format: json_schema`**, which
**no one has verified yet**. Per the repo's real-verification rule, implementation MUST include one
real live call against `glm-5.2:cloud` before the feature is called done (see Testing). The unit
tests use stubs; they cannot catch a compat-shim structured-output failure.

## Feature 1 — the `ollama` adapter (`src/providers/ollama.ts`)

A near-clone of `OpenRouterAdapter`. `id = "ollama"`, `auth: "apikey"`.

**Endpoint.** `${baseUrl}/chat/completions` where `baseUrl` comes from config
(`cfg.baseUrl ?? "https://ollama.com/v1"`). Point it at `http://localhost:11434/v1` to hit a local
daemon instead. A single trailing-slash normalization on `baseUrl` (strip one trailing `/`) avoids
`//chat/completions`.

**Auth.** `Authorization: Bearer <key>` is sent **only when a key resolves** (`cfg.apiKeyEnv`,
default `OLLAMA_API_KEY`). When the key is absent AND the baseUrl is a loopback host, the request is
sent unauthenticated (local daemon needs no key). Loopback = `localhost`, any `127.0.0.0/8` address
(not just `127.0.0.1` — e.g. `127.0.1.1`), or `::1`. When the key is absent AND the baseUrl is
remote, `review()` returns `ERROR` ("OLLAMA_API_KEY not set") — same fail-fast as OpenRouter.

**Request body.** Identical shape to OpenRouter minus `provider` routing:

```ts
{
  model: cfg.model,
  messages: [{ role: "user", content: prompt }],
  response_format: {
    type: "json_schema",
    json_schema: { name: "review", strict: true, schema: REVIEW_OUTPUT_SCHEMA },
  },
}
```

`REVIEW_OUTPUT_SCHEMA` is already codex/OpenAI strict-mode valid, so it is a legal
`response_format` payload as-is.

**Response parse — robust against reasoning contamination.** GLM is a reasoning model. Before
`parseReviewOutput(content)`, `stripReasoningBlocks(content)` removes:

- **paired** `<think>…</think>` / `<thinking>…</thinking>` blocks, AND
- an **unclosed** leading `<think>`/`<thinking>` opener up to the first `{` — because a thinking
  model that truncates at its output-token limit (or omits the closing tag) leaves a reasoning
  preamble that may itself contain `{`, which would derail `parseReviewOutput`'s first-`{`…last-`}`
  slice and fail the review closed on the *exact* model this adapter targets (Plan-Gate CONFIRMED
  by both reviewers).

Markdown fences are already handled by `parseReviewOutput`. If the parse still fails (the
pathological unclosed-`<think>`-with-braces case where the stray brace survives the strip),
`lastBalancedJsonObject(content)` recovers the **last** balanced top-level `{…}` object — a
reasoning model emits reasoning first and its answer last, so the review JSON is the final object —
and re-parses that (string-aware brace matching, so braces inside JSON string values don't
miscount; Plan-Gate CRITICAL, Codex). This runs regardless of whether `response_format` was honored
— so a model that ignores strict mode and wraps its JSON still parses. On `!out` → **fail CLOSED**
via `errorResult` (never a zero-finding PASS), identical to OpenRouter's `!out` guard, with the same
`isQuotaExhausted(content)` check to surface a 429 for quota/usage-limit
CONTENT.

**Findings mapping.** `mapReviewOutputToFindings(out, { provider: "ollama", model, persona,
workingDir })`. `Finding.provider` is `z.string()` — **no schema change**.

**Quota / cost.** A 429 (HTTP status OR body) → `status: "quota-exhausted"` so the orchestrator cools
the provider down and fails over, instead of re-hitting it every review — reuse `isQuotaExhausted`
verbatim (Ollama Cloud rate-limits hourly/daily, so this fires in practice). Cost via
`estimateCostUsd(inputTokens, outputTokens, cfg.costPerMTokensUsd)`; default `costPerMTokensUsd: 0`
→ $0 tracked (subscription is flat). Token counts from `usage.prompt_tokens` / `completion_tokens`
when present, else 0.

**Abort wiring.** Like OpenRouter (no subprocess to SIGKILL), wire `input.signal` into the request's
`AbortController` so the gate's self-deadline (`loop.runTimeoutMs`) cuts an in-flight Ollama review
short — otherwise it reintroduces the silent fail-open.

**`complete()`.** Cloned from OpenRouter's `complete()` (free-form, NO review schema — a judge/critic
routed through `review()` would get review-shaped JSON and silently no-op). Same endpoint-from-
baseUrl + conditional-auth + signal-forwarding. It also runs `stripReasoningBlocks` on the returned
content — GLM is a thinking model, so a judge/critic must not receive `<think>`-contaminated text
(Plan-Gate WARN, GLM). This makes `ollama` usable as a critic / curator judge. **No `embed()`.**

**Known limitation — `complete()`-based roles target the cloud endpoint.** `CompleteOptions` gains
an optional `baseUrl`, and `complete()` honors it, but the critic / curator / grounding call sites
that invoke `adapter.complete()` are NOT wired to pass `cfg.providers.ollama.baseUrl` (deferred —
YAGNI). So an Ollama used as a **critic/curator/grounding** judge hits the **cloud** default; a
**localhost-only** Ollama (no cloud key) should be used as a **reviewer** (which honors `baseUrl`),
not as a `complete()`-based judge. The failure mode is fail-safe: a keyless cloud call throws → the
judge falls back to its default verdict (critic is demote-only → no demotion), never a wrong verdict.

## Feature 2 — config surface

`src/config/define-config.ts`:

- `ProviderConfigSchema` gains `baseUrl: z.string().url().optional()`. Generic field, documented as
  "Ollama-only: OpenAI-compat base URL; other providers ignore it" — the same pattern as
  `openrouterProvider` living on the shared schema.
- The `ProviderId` zod enum gains `"ollama"`.
- The `providers` object schema gains `ollama: ProviderConfigSchema.optional()`.

`src/config/defaults.ts`:

- New `ollama` provider default block:
  ```ts
  ollama: {
    enabled: false,
    auth: "apikey" as const,
    apiKeyEnv: "OLLAMA_API_KEY",
    model: "glm-5.2:cloud",
    baseUrl: "https://ollama.com/v1",
    timeoutMs: 300_000,
    costPerMTokensUsd: 0,
  },
  ```
- Every hard-coded provider-union type annotation that currently reads
  `"codex" | "gemini" | "claude-code" | "openrouter" | "opencode"` (the reputation / FP-ledger /
  grounding annotations, ~5 sites) gains `| "ollama"`.

The Brain embeddings `provider: z.literal("openrouter")` is **unchanged** (embeddings stay
OpenRouter-only; see OUT scope). The cache key already hashes the full config, so adding `baseUrl` /
the `ollama` block invalidates stale cache entries automatically.

## Feature 3 — registry + adapter wiring

`src/providers/registry.ts`:

- `ProviderId` union gains `"ollama"`.
- `createAdapter` gains `case "ollama": return new OllamaAdapter();`.

`src/providers/adapter-base.ts`:

- `ProviderAdapter.id` union gains `"ollama"`.
- `ProviderConfig` gains `baseUrl?: string`.

`buildAdapters` needs **no change** — it constructs adapters dynamically from
`consumedProviders(cfg)` via `createAdapter(id)`, so listing `ollama` as a reviewer / fallback /
critic auto-builds it.

## Feature 4 — availability (key-based)

`src/providers/availability.ts`:

- `PROVIDER_BIN` gains `ollama: null` (no binary — an API check, like openrouter).
- `isProviderAvailable` gains an ollama branch keyed on the API key:
  `if (id === "ollama") return Boolean(env[apiKeyEnv ?? "OLLAMA_API_KEY"]);`

**Known limitation (accepted):** `isProviderAvailable(id, apiKeyEnv)` has no `baseUrl` parameter, so
a local-daemon-without-key setup registers as "unavailable." Workaround: local users set
`OLLAMA_API_KEY` to any non-empty placeholder (a placeholder Bearer sent to a local daemon is
harmlessly ignored). Threading `baseUrl` into availability is a larger change and is deferred.
This is documented in the defaults comment and the setup docs.

## Feature 5 — two orchestrator concessions

`src/core/orchestrator.ts`:

1. **Sandbox skip.** `ollama` is an HTTP adapter with no local subprocess, so `sandbox-exec` /
   `bwrap` must be skipped for it — add it alongside `openrouter` in the sandbox-skip condition
   (~line 1369: `sandboxMode === "off" || provider === "openrouter" || provider === "ollama"`).
   See [[2026-05-29-macos-sandbox-filesystem-design]].
2. **Critic policy.** OpenRouter is DELIBERATELY excluded from critic auto-selection (it is a paid,
   low-precision model). Ollama is $0-within-subscription and strong, so it is **NOT** added to that
   exclusion — it may serve as a critic. During implementation, read the exclusion's exact intent
   (orchestrator ~505) and confirm this reading before shipping; if the exclusion guards something
   other than cost/precision, revisit.

Grep for other `provider === "openrouter"` / `"openrouter"`-in-union sites touched by review()'s
schema-forcing comment (~1958) and the fallback comments (~1675) and extend only where an HTTP-
adapter distinction is actually load-bearing (comments may just need the mention).

## Feature 6 — `doctor` check (slim)

`reviewgate doctor` reuses the existing provider-availability checks (which already route `ollama`
through `isProviderAvailable`, so an unavailable ollama critic/curator/grounding is already
reported); the only ollama-specific change is the HINT text, which names `OLLAMA_API_KEY` and points
at `providers.ollama.baseUrl` (cloud vs local daemon) instead of misdirecting to `OPENROUTER_API_KEY`.
Keep it a config/key presence check (no unconditional network call in `doctor`). A separate
"effective baseUrl" report line and an optional reachability ping are explicitly OUT of scope for
this milestone (the hint already surfaces `baseUrl`).

## Data flow

```
panel → adapter.review({ promptFile, signal, cfg, reviewerId })
      → read prompt file
      → POST ${baseUrl}/chat/completions  (Bearer if key; response_format json_schema)
      → stripReasoning(content) → parseReviewOutput
      → mapReviewOutputToFindings({ provider: "ollama", model, persona, workingDir })
      → verdictFromFindings → ReviewResult
      → aggregator (consensus / dedup / FP-ledger / reputation) — unchanged
```

## Error handling (fail-closed)

| Condition | Result |
|---|---|
| No key + remote baseUrl | `ERROR` "OLLAMA_API_KEY not set" |
| HTTP 429 or quota/usage content | `status: "quota-exhausted"` → cooldown + failover |
| Refusal / empty / non-JSON (`!out`) | `errorResult` (fail CLOSED — never zero-finding PASS) |
| `<think>` / fenced JSON | stripped before parse; parses anyway |
| Gate self-deadline fires | `AbortController` aborts the in-flight request |
| Other HTTP error | `errorResult` with status text (sliced) |

## Testing

**Unit (mirror `tests/unit/openrouter*.test.ts`, injected `fetchImpl`):**

- key-missing + remote baseUrl → `ERROR`
- HTTP 429 → `quota-exhausted`; quota-signal content → `quota-exhausted`
- empty / non-JSON / refusal → fail-closed `ERROR` (not PASS)
- `<think>…</think>` + ```json fence stripping → valid findings parsed
- `baseUrl` override: cloud (`https://ollama.com/v1`, Bearer present) vs loopback
  (`http://localhost:11434/v1`, no Bearer)
- trailing-slash normalization on `baseUrl`
- `complete()` free-form path (no schema forced) returns raw content
- abort signal → request aborted

**Config / registry / availability:** `ollama` parses in `ConfigSchema`; defaults present;
`createAdapter("ollama")` returns `OllamaAdapter`; `isProviderAvailable("ollama", …)` keys off
`OLLAMA_API_KEY`.

**Live verification (MANDATORY, gated, NOT in CI):** a scratch script POSTing to
`https://ollama.com/v1/chat/completions` with `model: "glm-5.2:cloud"` + `OLLAMA_API_KEY`, asserting
(a) schema-valid review JSON returns and (b) observing whether `<think>` tokens appear in `content`
(informs the stripping). If `response_format: json_schema` strict is NOT honored reliably, fall back
to native `/api/chat` + `format: <schema>` and re-verify. This step gates "done."

## Touch-points summary

`src/providers/ollama.ts` (new) · `registry.ts` · `adapter-base.ts` · `availability.ts` ·
`config/define-config.ts` · `config/defaults.ts` · `core/orchestrator.ts` (sandbox skip + critic
policy) · `cli/commands/doctor.ts` · tests · docs (defaults comment, setup example with
`glm-5.2:cloud` + cloud/localhost baseUrl, CLAUDE.md Architecture-Map providers line).
