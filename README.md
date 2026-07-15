# Reviewgate

**Reviewgate intercepts your Claude Code or Codex agent's turn-end, runs an independent LLM
review over the actual change, and requires an explicit outcome for every blocking
finding.** It is the *checker* half of the agent loop, packaged so the writer can't
grade its own homework. A clean PASS releases the turn; WARN-only policy,
infrastructure deferral and bounded human escalation remain visibly distinct from PASS.

- 🐛 **Catches real bugs before the agent says "done"** — a heterogeneous panel
  (Codex · Gemini · Claude · OpenCode · OpenRouter · Ollama) reviews the actual diff,
  in-loop, every turn.
- 🚦 **Never turns failure into green** — a crash, timeout or quota outage is never
  reported as PASS. Reviewgate blocks, explicitly defers for a bounded window, or
  escalates to a human according to the configured policy.
- 📋 **Leaves an audit trail** — every finding and every fix/reject decision is
  written to files (`.reviewgate/pending.md`) a human (or CI) can inspect later — no
  chat-stream parsing, no flaky stdout scraping.

Reviewers run the official provider CLIs, so users on Claude Pro/Max, ChatGPT
Plus/Pro and Gemini Advanced pay **$0 per review** within their subscription
quotas (OAuth-first). OpenRouter reviewers use an API key and can target any
hosted model by name.

> [!WARNING]
> **Alpha.** Reviewgate runs provider CLIs on your working-tree diff. Reviewer
> **filesystem write isolation plus secret-path masking ships** (macOS Seatbelt,
> Linux bubblewrap) but is **opt-in** (`sandbox.mode`, default `off`). It is a
> denylist model, not a read allowlist: other host files may remain readable, and
> **network egress is not isolated**. Prefer your own code / trusted repos. See
> [Security](#security).

<p align="center">
  <img src="docs/assets/demo.gif" alt="Reviewgate Alpha.11 replay: a real gate blocks a CRITICAL SQL-injection finding, consumes an accepted/fixed decision, then passes the parameterized fix." width="820">
</p>

> **Demo disclosure:** this is a deterministic replay of two provider responses
> recorded during a real `reviewgate@0.1.0-alpha.11` OpenRouter run. The production
> init, control-plane, trigger, Stop-hook, decision, re-review and audit-verifier
> paths execute live. The script checksum-verifies the cassette and aborts on
> prompt drift. [Run it and inspect the provenance](assets/demo/README.md).

## 60-second quickstart

```bash
npm i -g reviewgate     # your platform's prebuilt binary
cd your-repo
reviewgate init         # configure policy + hosts, install hooks, record LKG, run doctor
```

No reviewer CLI available? Use the tested
[OpenRouter-only setup](docs/openrouter-quickstart.md). For claims, raw caveats and
historical catches, see [Evidence](docs/evidence.md).

Claude Code is armed as soon as init completes. For Codex, init installs the hook
definitions, but Codex intentionally keeps new project commands disabled until you
approve their exact hash once through `/hooks`. After activation, either host runs
Reviewgate when it tries to finish a changed turn.

`init` recommends both hosts and can also target one explicitly:

```bash
reviewgate init --host both          # Claude Code + Codex
reviewgate init --host codex         # Codex only
reviewgate init --quick --host both  # scripted recommended preset
```

Host selection installs or refreshes the selected host definitions; it never
silently removes an already-installed other host or any foreign hook.

Host hooks and shims are installed per checkout. Do not copy the generated Codex
hook between clones or worktrees; run `reviewgate init` in each checkout so its
fallback root and hash trust match that checkout.

Codex project hooks are hash-trusted by Codex itself. After installation, start or
restart Codex inside the trusted project, open `/hooks`, inspect the three
Reviewgate responsibilities (`SessionStart` reset, `PostToolUse` trigger and
`Stop` gate), then trust their exact current definitions. This is normally a
one-time action and repeats only when those definitions change.
If the project already defines inline hooks in `.codex/config.toml`, init preserves
them and warns that Codex will merge both sources; it never rewrites TOML hooks.

> [!IMPORTANT]
> **Installed does not yet mean active in Codex.** `reviewgate doctor` can verify
> the generated file, shims, timeouts and binary, but Codex does not expose its
> per-hash trust decision to Reviewgate. That is why Doctor shows a manual warning
> even when installation is healthy. Reviewgate will not use Codex's dangerous
> trust-bypass option: allowing the installer or coding agent to approve its own
> shell commands would defeat the checkpoint. See the dedicated
> [Codex host and hook-trust guide](docs/codex-host.md).

> **Want the _why_?** How this fits "write loops, not code", the failure modes it
> survives, the security model → [Why](#why-reviewgate-is-the-verification-loop) ·
> [Failure modes](#failure-modes-it-survives) · [Security](#security).

<details><summary><b>Full feature list</b> (<code>0.1.0-alpha</code>)</summary>

Multi-reviewer panel (Codex · Gemini · Claude · OpenCode · OpenRouter · Ollama) · parallel execution ·
adversarial critic · adaptive triage · tree-sitter symbol graph · research context ·
review cache · quota auto-failover · per-repo learning brain + curator ·
false-positive ledger · stats & weekly reports · complete interactive `init` wizard ·
opt-in reviewer filesystem isolation (macOS Seatbelt / Linux bubblewrap). Remaining
caveat: network egress is not isolated. See [Scope & limitations](#scope--limitations).
</details>

---

## How it works

```
┌──────────────────── Claude Code or Codex (host) ──────────────────────────┐
│  Edit / Write / apply_patch / Bash                                          │
│        │                                                                    │
│        ▼  PostToolUse hook                                                  │
│  .reviewgate/bin/trigger  ──►  marks .reviewgate/dirty.flag                 │
│                                                                             │
│  …agent finishes its turn…                                                  │
│        │                                                                    │
│        ▼  Stop hook                                                         │
│  .reviewgate/bin/gate  ──►  reviewgate gate --hook stop                     │
│        │                                                                    │
│        ├─ no changes since last pass ───────────────────────► allow stop   │
│        │                                                                    │
│        ▼  run configured panel on diff since the captured review base       │
│  aggregate findings → verdict                                               │
│        │                                                                    │
│        ├─ PASS / policy-allowed SOFT-PASS ──────────────────► allow stop   │
│        ├─ FAIL / blocking SOFT-PASS ──► pending.md/json, BLOCK turn         │
│        │           Agent reads pending.md, fixes or rejects each finding,   │
│        │           appends decisions/<iter>.jsonl, stops again → re-review  │
│        └─ max iterations / stuck / cost cap ──► ESCALATION.md, allow stop   │
│                                                                             │
│  reviewgate.config.ts changed?                                               │
│        └─ separate policy fingerprint → review under last-known-good policy │
│           → weakening/non-monotonic change requires human TTY approval      │
└─────────────────────────────────────────────────────────────────────────────┘
```

\* Reviewer **filesystem isolation ships** via OS sandboxing — macOS Seatbelt
(`sandbox-exec`) and Linux bubblewrap (`bwrap`) — enabled with `sandbox.mode:
"strict"` (fails closed if the OS sandbox is unavailable) or `"permissive"` (runs
unisolated with a warning). The default is `"off"`. Network egress is **not**
isolated on either platform. See [Security](#security).

> 📐 For the full control flow, module map and pipeline stages, see
> [`docs/architecture.md`](docs/architecture.md).

---

## Why: Reviewgate is the verification loop

The current meta in agentic coding is **"write loops, not code"** ([Boris
Cherny](https://medium.com/@fahey_james/i-dont-prompt-claude-anymore-i-write-loops-that-prompt-claude-57e48a4f28d7),
[Simon Willison](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/),
[Addy Osmani](https://addyosmani.com/blog/loop-engineering/)). The unit of work
moved from the keystroke → to the prompt → to the **loop**: you stop writing
lines and start designing the system that prompts the agent and lets it iterate
until a goal is met.

Every agentic loop has two halves — a **generator** that produces code and a
**checker** that verifies it and decides when to stop. The loop-engineering
crowd is near-unanimous on the part that actually makes a loop trustworthy:
*split the one who writes from the one who checks*, and give the loop a
**testable termination condition** so it can't grade its own homework or run
forever.

**Reviewgate is that checker, packaged as reusable infrastructure.** It is not a
code-generating orchestrator (that's the host — Claude Code's `Workflow`,
parallel agents, cron). It is the verification loop you drop *into* such a loop
so it can't merge unreviewed work "while you sleep":

| Loop-engineering principle | Reviewgate |
| --- | --- |
| Writer ≠ checker (no self-grading) | A **heterogeneous reviewer panel** (Codex · Gemini · Claude · OpenCode · OpenRouter · Ollama) — independent models inspect the diff |
| "Are you done?" check each turn | A **`Stop` hook** blocks on unresolved blocking findings; explicit SOFT-PASS/defer/escalation outcomes are never mislabeled PASS |
| Testable termination condition | `decisions/<iter>.jsonl` must address every finding id in `pending.json` before the gate allows the stop |
| Adversarial verification | A demote-only **critic** + severity-weighted veto + cross-reviewer consensus |
| Explicit failure exits (no infinite loop) | `LoopDriver` caps iterations and emits `ESCALATION.md` on max-iter / stuck-signatures / cost-cap / high-reject-rate |
| Feedback as an observable signal | Findings are written to **files** the agent reads with its normal Read tool — no chat-stream scraping |

In a full "write loops, not code" setup, Reviewgate is the `/goal`-style
verifier that runs at the end of each turn.

**And there is inspectable evidence—not just a product claim.** In one published
single-pass smoke on an 18-case labelled corpus, the panel caught 8/8 seeded bugs,
while the demote-only critic reduced clean-case false positives from 9/10 to 4/10
at zero recall loss in that run. This is small-N, hand-authored and not a stable
leaderboard. Numbers, Wilson intervals, limitations and a copy-paste reproduction
path: **[`bench/`](bench/README.md)**. Real gate-run provenance and dogfood cases:
**[`docs/evidence.md`](docs/evidence.md)**.

---

## Failure modes it survives

A code-review gate has exactly one job: **don't let a real bug ship.** The easy
part is reviewing a diff — any wrapper around an LLM does that in an afternoon.
The hard part is **never silently failing _open_**: a gate that quietly says
"green" when it didn't actually check is worse than no gate at all, because you
*trust* it.

Almost everything below was learned the hard way, in production, dogfooding
Reviewgate on its own changes. Each one is a way a naïve gate fails open — and
what this one does instead. The fix is the product.

> **Design rule:** when in doubt, **fail closed** — block, over-review, or
> escalate to a human. Never fail open: pass, hide, or demote. Every guard below
> is a consequence of that rule.

**"No findings" must never mean "PASS."** *Naïve:* every reviewer is
quota-exhausted or times out → the panel returns nothing → "0 findings" →
**PASS**. *Reality:* your code was never reviewed; the gate just waved it through.
*Reviewgate:* zero successful reviews is an **ERROR that blocks**, distinct from a
real clean pass.

**A demote is not harmless.** *Naïve:* an "uncertain" CRITICAL is quietly
downgraded to WARN so the turn can proceed. *Reality:* under the default policy a
WARN-only result *soft-passes* — so a real, possibly-correct CRITICAL **vanishes
with no decision required**. *Reviewgate:* a finding demoted *from* CRITICAL is
flagged and still requires an explicit decision before the turn can end — it can
never silently soft-pass.

**Reviewers hallucinate — including in code they never saw.** *Naïve:* trust the
panel. *Reality:* a lone reviewer emits a 0.97-confidence CRITICAL citing
`file:line` in a file with *fewer lines than that* — a fabrication that, at panel
size 1, hard-FAILs the gate with full authority. *Reviewgate:* a deterministic,
no-LLM fact-check demotes a finding whose cited line provably doesn't exist;
diff-scoping makes findings on *unchanged* code advisory; a demote-only critic and
cross-reviewer consensus down-weight the rest.

**A blocked turn must not become an infinite loop.** *Naïve:* "block until every
finding is resolved." *Reality:* the agent writes its decision file → that write
re-arms the dirty flag → the gate re-blocks → forever. *Reviewgate:* the loop is
bounded — it caps iterations and emits an `ESCALATION.md` (releasing the turn to a
human) on max-iterations, stuck-signatures, cost-cap or a high reject-rate.

**Multi-agent shared checkouts break "review the repo's HEAD."** *Naïve:* review
whatever is in the working tree. *Reality:* in a shared checkout, session A's gate
blocks on session B's parallel work — code A never wrote. And the obvious fix
("attribute *committed* work to a session") is *itself* a fail-open: a file
authored via a shell command and then committed is invisible to every attribution
signal, so an agent could "disown" its own CRITICAL. *Reviewgate:* per-session
**baseline-delta ownership** scopes uncommitted work soundly; committed foreign
work is *never* silently demoted — it routes to an honest, human-surfaced
**escalation**. (That unsound auto-attribution was caught by an adversarial
pre-implementation review *before* a line of it shipped.)

**The bug a green test suite can't see.** *Naïve:* the schema looks right and the
stub tests pass — ship it. *Reality:* one property missing from a strict
JSON-schema's `required` list makes *every real* provider review return HTTP 400;
the stub-based tests never hit the real endpoint, so they stay green. *Reviewgate:*
a structural test replicates the provider's strict-mode rules so the trap can't be
reintroduced — and provider changes are verified against a *real* CLI/API call, not
just stubs.

### How these get found

None of this comes from foresight — it comes from process:

- **It dogfoods itself.** Reviewgate runs its own gate on every change to
  Reviewgate; most of the incidents above were surfaced by the tool reviewing its
  own diff.
- **Adversarial verification, before *and* after.** Plans are reviewed by an
  independent model panel *before* implementation (a pre-implementation gate that
  has killed real fail-opens on paper) and again after — reviewers prompted to
  *refute*, not rubber-stamp.
- **Real calls, not just mocks.** Provider behaviour is verified end-to-end against
  the actual CLIs/APIs, because stubs have hidden whole classes of bug.

If a guard ever looks paranoid, assume it's load-bearing — it's almost certainly a
scar from one of the failures above.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (Node 20+ works for the compiled binary)
- **At least one reviewer CLI**, installed and logged in:
  - [Codex CLI](https://github.com/openai/codex) ≥ 0.130 (`codex login`) — recommended default
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (OAuth)
  - [Claude Code](https://claude.com/claude-code) (OAuth)
  - [OpenCode](https://opencode.ai) (OAuth/provider credentials)
  - …or an [OpenRouter](https://openrouter.ai) API key for any hosted model
  - …or an [Ollama](https://ollama.com) API key (Ollama Cloud, or point `baseUrl`
    at a local `ollama serve`)
- macOS or Linux (Windows: use WSL2)
- git

Using Codex as the **authoring host** (not merely as a reviewer) requires a Codex
release with project lifecycle hooks; the implementation is verified against
Codex CLI `0.144.1`. Codex must trust the generated project hook hash through
`/hooks` before those hooks execute. See [Codex host setup](docs/codex-host.md)
for the exact installed → trusted → active states.

You don't need all of them — one is enough to start. Check exactly which
reviewers are ready on your machine at any time:

```bash
reviewgate doctor
```

---

## Install

### Option A — one-liner install (fastest)

Detects your platform, downloads the matching prebuilt binary from
[Releases](https://github.com/Codevena/reviewgate/releases), **verifies its
SHA-256**, and symlinks it onto your `PATH` (into `~/.local/bin`). No sudo, no
build step, no Bun required:

```bash
curl -sSL https://raw.githubusercontent.com/Codevena/reviewgate/master/install.sh | sh
reviewgate --version
```

Pin a version with `REVIEWGATE_VERSION=v0.1.0-alpha.12`, or change where it lands
with `REVIEWGATE_INSTALL_DIR` / `REVIEWGATE_BIN_DIR`. macOS + Linux (arm64/x64).

<details><summary>…or download the tarball manually</summary>

Grab the asset for your os-arch from the Releases page and keep the extracted
folder intact — the binary loads its sibling `grammars/` (tree-sitter `.wasm`) at
runtime. Each release ships a `SHA256SUMS.txt` to verify against:

```bash
tar xzf reviewgate-v0.1.0-alpha.12-darwin-arm64.tar.gz
ln -sf "$PWD/reviewgate-v0.1.0-alpha.12-darwin-arm64/reviewgate" /usr/local/bin/reviewgate
reviewgate --version
```

</details>

### Option B — build from source (contributors / latest `master`)

```bash
git clone https://github.com/Codevena/reviewgate.git
cd reviewgate
bun install
bun run build          # produces ./dist/reviewgate (+ sibling grammars/)
```

Then, in the repo you want reviewed:

```bash
reviewgate init        # complete guided first-run setup:
                       # policy + Claude/Codex hosts + hooks + LKG + doctor,
                       # copies .reviewgate/bin/{trigger,gate,reset},
                       # writes config + approved policy fingerprint
```

`init` is idempotent and merges into existing `.claude/settings.json` and/or
`.codex/hooks.json` without clobbering foreign hooks or other settings. Use
`reviewgate init --hooks-only --host both` to repair/re-bake hooks without
changing an existing configuration.

`reviewgate setup` remains an alias for the same guided project wizard; its
`--global` mode remains config-only.

```bash
reviewgate setup       # compatibility alias for the init wizard
```

### Option C — npm (`npm i -g reviewgate`)

```bash
npm i -g reviewgate     # installs only your platform's prebuilt binary
reviewgate init         # configure + arm Claude Code/Codex + health-check
reviewgate doctor       # repeat the health-check whenever needed
```

A global install is recommended for the persistent Stop gate, because `reviewgate init`
bakes the binary's absolute path into the hook. `npx reviewgate init` works for a quick
try, but the binary lives in an ephemeral npx cache that may be garbage-collected — `init`
warns when it detects this. Supported: macOS and Linux (glibc) on arm64/x64; on other
platforms use Option A or B.

---

## First run — guided walkthrough

Zero to your first blocked review in ~5 minutes.

1. **Run `reviewgate init`.** In one guided flow it asks which coding-agent hosts
   to protect, chooses quick/custom policy setup, configures reviewers/models,
   critic and memory features, then asks the first-run safety/completion choices:
   sandbox mode, SOFT-PASS policy, clean-pass acknowledgement, desktop
   notifications and the warn-only pre-push reminder. It then installs the native
   hooks, records the validated initial LKG and runs `doctor`.
2. **Get one reviewer working.** You need exactly one to start:
   - **Lowest friction (no CLI):** set `OPENROUTER_API_KEY` and add an
     `openrouter` reviewer to `phases.review.reviewers` (paid per call).
   - **$0 within your subscription:** install + log in to one OAuth CLI — `codex
     login`, Claude Code, or the Gemini CLI — they're already in the starter config.
   - **Ollama Cloud (also no CLI, $0 within your Ollama subscription quota):** set
     `OLLAMA_API_KEY` and add an `ollama` reviewer — see
     [Choosing the Ollama model](#choosing-the-ollama-model) below.

   Then confirm what's actually ready: **`reviewgate doctor`** tells you exactly
   which reviewers it can reach and what to fix.

   During custom OpenRouter setup, Reviewgate discloses and offers one bounded paid
   capability check per distinct paid request tuple (purpose, model, auth, route and probe bounds), enabled by default. Reviewer and fallback
   choices use the same strict structured `review()` request as production;
   critic/curator choices use their real free-form completion shape. The check is
   capped at 15 seconds and 256 output tokens and sends a constant repository-free
   prompt. Success confirms that exact request completed and parsed at setup time;
   it is not a permanent guarantee about a third-party route.
3. **If Codex is selected, activate the installed project hooks.** Start or
   restart Codex in the trusted repository, run `/hooks`, inspect the exact
   `.codex/hooks.json` commands and trust their current hash. Codex skips new or
   changed hooks until this happens. Reviewgate cannot perform or verify that
   user-owned action and never bypasses it. Full explanation:
   [Codex host setup and hook trust](docs/codex-host.md).
4. **See it work (60-second smoke test) — *before* you trust it in a loop.** Make
   a deliberately broken change and run the gate by hand:

   ```bash
   echo 'export const refund = (amt, by) => amt / by;  // div-by-zero, no guard' >> smoke.ts
   git add smoke.ts
   reviewgate gate            # reviews the current Reviewgate change scope
   cat .reviewgate/pending.md # the findings the panel raised
   git rm -f smoke.ts
   ```
5. **Use Claude Code or Codex as normal.** After it edits files and tries to finish a turn,
   the `Stop` hook runs the review. If a reviewer raises a blocking finding, the agent
   is told to read `.reviewgate/pending.md` and address each one. The current turn
   stays blocked while those findings remain unresolved; bounded non-convergence
   instead produces an explicit human escalation rather than an endless loop.
6. **You review the final diff and commit manually.** Reviewgate never commits or
   edits code itself; it only reports.

Useful commands outside the loop:

```bash
reviewgate doctor                    # which reviewers are ready + what to fix
reviewgate init                      # complete interactive first-run/reconfigure flow
reviewgate init --hooks-only --host both # repair hooks, preserve config
reviewgate setup                     # compatibility alias (`--global` is config-only)
reviewgate config status             # approved/pending policy fingerprints
reviewgate config approve            # TTY-only human approval after an LKG pass
reviewgate gate                      # review the current change scope on demand
reviewgate reset                     # re-arm the gate (clear this session's review state)
reviewgate audit verify --file <jsonl>   # verify an audit-log hash chain
```

---

## Configuration — `reviewgate.config.ts`

`reviewgate.config.ts` is a **data-only default-export object**. Reviewgate parses
objects, arrays, strings, finite numbers, booleans, null and comments; it does not
execute the file. Imports, function calls, spreads, template expressions and
environment lookups are rejected. A present invalid config blocks instead of
falling back to a weaker default policy.

The effective config has a separate control-plane fingerprint. A changed candidate
is first evaluated while code review continues under the last-known-good policy.
Provable monotonic strengthenings are adopted only after that pass. Any weakening
or non-monotonic change needs `reviewgate config approve` from an interactive TTY;
there is deliberately no `--yes` bypass. Details are written to
`.reviewgate/POLICY_CHANGE.md`, never injected into the normal reviewer diff.

Minimal single-reviewer setup (Codex only, OAuth, $0):

```ts
export default {
  providers: {
    codex: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 300_000 },
  },
  loop: {
    maxIterations: 3,        // escalate to the human after N failed review rounds
    costCapUsd: 1.5,         // only enforced in apikey/openrouter mode (OAuth = $0)
    softPassPolicy: "allow", // allow | block | ask-once for WARN-only verdicts
  },
  sandbox: {
    mode: "off",
  },
};
```

Multi-reviewer panel with an OpenRouter critic:

```ts
export default {
  providers: {
    codex: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 300_000 },
    gemini: { enabled: true, auth: "oauth", model: "gemini-3.5-flash", timeoutMs: 300_000 },
    "claude-code": { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 300_000 },
    openrouter: {
      enabled: true,
      auth: "openrouter",
      model: "deepseek/deepseek-v4-pro",   // ← any OpenRouter model slug (see below)
      apiKeyEnv: "OPENROUTER_API_KEY",
      costPerMTokensUsd: 0.075,            // optional; fed into loop costCapUsd tracking
      timeoutMs: 120_000,
    },
  },
  phases: {
    review: {
      reviewers: [
        { provider: "codex",       persona: "security" },
        { provider: "gemini",      persona: "security" },
        { provider: "claude-code", persona: "adversarial" },
        { provider: "openrouter",  persona: "security" },
      ],
    },
    critic: { provider: "openrouter", persona: "critic" },
  },
  loop: {
    maxIterations: 3,
    costCapUsd: 2.0,
    softPassPolicy: "allow",
  },
};
```

Codex with an Ollama Cloud fallback (also $0 within your Ollama subscription
quota — no CLI, just an API key):

```ts
export default {
  providers: {
    codex: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 300_000 },
    ollama: {
      enabled: true,
      auth: "apikey",
      apiKeyEnv: "OLLAMA_API_KEY",
      model: "glm-5.2:cloud",              // ← any model ollama.com serves
      baseUrl: "https://ollama.com/v1",    // self-hosted: "http://localhost:11434/v1"
      timeoutMs: 300_000,
    },
  },
  phases: {
    review: {
      reviewers: [{ provider: "codex", persona: "security", fallback: ["ollama"] }],
    },
  },
};
```

Anything you omit falls back to the defaults. The config is zod-validated.

### Deterministic checker tier (`phases.checks`)

Before the LLM panel runs, Reviewgate can execute a set of **deterministic
commands** (typecheck, build, test suite, linter) that are fast, free, and
perfectly reproducible. If any command exits non-zero the gate **fails closed**
immediately — without spending a single token on reviewer inference — and
surfaces the exact output as a `CRITICAL` finding. Commands run in order,
fail-fast (the first failure stops the rest).

```ts
// reviewgate.config.ts — run tsc + tests before the LLM panel; a failure blocks
// the turn (with the output) and skips the panel. Order cheap → expensive.
phases: {
  checks: {
    commands: [
      { name: "typecheck", run: "bun run typecheck", timeoutMs: 120_000 },
      { name: "test",      run: "bun test",          timeoutMs: 300_000 },
    ],
  },
}
```

Key properties:

- Commands run **unsandboxed** — they are your own trusted config (same trust
  level as `reviewgate.config.ts` itself), not untrusted reviewer subprocesses.
- A check failure is **not rejectable** by the agent; it must be fixed (or the
  check removed from the config) before the panel runs. This prevents the
  agent from shipping code that doesn't compile or breaks tests.
- Each command has an optional `timeoutMs` (default 300 s). A timeout is also
  treated as a failure (fail-closed, never a silent skip).
- Combine with `sandbox.mode` to isolate only the LLM reviewers — the checks
  tier always runs unsandboxed regardless of the sandbox setting.

### Project knowledge — "Lore" (`phases.lore`)

Reviewers keep re-deriving the same project facts — invariants, past decisions,
gotchas — and sometimes get them wrong (a hallucinated "bug" that's actually a
deliberate design choice). **Lore** lets you write those facts down once, as
committed Markdown, and have the gate inject the relevant ones into each review
as **trusted context**. One maintainer-authored note can end a whole class of
repeated false positives.

Turn it on in the custom `reviewgate init` flow (it asks and explains — **off by default**), or
by hand:

```ts
phases: {
  lore: { enabled: true },
}
```

Then write one file per fact under `.reviewgate/lore/<slug>.md`:

```markdown
---
schema: reviewgate.lore.v1
id: payment-webhook-invariants        # must equal the file name
status: draft                          # draft | canon — only canon is injected
anchors:                               # which files this fact is about (globs ok)
  - "src/lib/stripe-webhook-handlers.ts"
  - "src/app/api/webhooks/**"
verified_at: 2026-07-10
verified_tree: "…"                     # hash of the anchored files at verify time
---
Every subscription write is a compare-and-set on (status, lastStripeEventAt).
Why: Stripe delivers webhooks out of order, so a naive "last write wins" corrupts state.
Write the WHY — never restate what the code already says.
```

How it behaves (all fail-safe — a broken lore file never blocks a review):

- **Draft → canon, with approval.** New notes start as `status: draft`
  (never injected). A maintainer promotes one to `status: canon`; the gate then
  raises a one-time, **verdict-neutral** "did a human approve this promotion?"
  finding. Approving it records a line in the committed
  `.reviewgate/lore/approvals.jsonl` — and **only an approved canon note is ever
  injected**. This keeps a compromised or careless commit from silently feeding
  the reviewer instructions.
- **Relevant-only injection.** A note is injected only when its `anchors`
  overlap the files in the current diff — so reviews stay focused and cheap.
- **Freshness, enforced.** When the anchored files change, the note goes *stale*
  (a content hash no longer matches). The gate then raises a **verdict-neutral,
  once-per-day** reminder to update or re-confirm it — so your knowledge base
  can't quietly rot. Rejecting a reminder (with a reason) snoozes it.
- **Never changes a verdict.** Both lore findings are advisory INFO — a PASS
  stays a PASS. They just cost one turn via the decision requirement.
- **`reviewgate lore status`** lists every note with its status and freshness;
  **`reviewgate lore verify <slug>`** (or `--all`) recomputes `verified_tree`/
  `verified_at` for the named entries and writes them back, so you never have to
  hand-compute the hash; **`reviewgate doctor`** flags broken, un-anchored, or
  too-broad notes.

### Completion signal

A passing review used to be silent (the Stop hook just exits 0). Now the gate
always writes a one-line summary to **stderr** on completion — e.g.
`🟢 Reviewgate · GATE OPEN — PASS (iteration 1)` or
`🔴 Reviewgate · GATE CLOSED — …` — so "green" is distinguishable from "the gate
didn't run". Set `notify.desktop: true`
to also fire a macOS/Linux desktop notification when a review finishes:

```ts
export default {
  // ...providers, phases...
  notify: { desktop: true },   // osascript (macOS) / notify-send (Linux)
};
```

Note: by hook architecture, an AI agent can only be *interrupted* on a blocking
(FAIL) verdict — on PASS its turn simply ends. The stderr line and desktop
notification are the human-facing signal; an agent confirms a pass by reading
`.reviewgate/state.json` / `pending.md`.

If you want the **agent** to be told about a pass too, set
`loop: { acknowledgePass: true }`. Then a passing review blocks ONCE with a
`✅ Reviewgate PASS …` message so the agent can confirm the result to you, and
ends cleanly on the next stop (one extra turn per pass; default off).

### Choosing the OpenRouter model

The OpenRouter reviewer can target **any model OpenRouter hosts** — just set the
`model` field to its slug. Examples that work today:

```
deepseek/deepseek-v4-pro        deepseek/deepseek-v4-flash:free
google/gemini-2.0-flash-001     openai/gpt-4o-mini
anthropic/claude-sonnet-4.5     meta-llama/llama-3.3-70b-instruct
```

Browse and copy exact slugs from <https://openrouter.ai/models>. An invalid slug
returns a 404 (`ModelNotFoundError`) and the reviewer reports `status: error`
(fail-closed — never a silent pass). Set your key once in the shell:

```bash
export OPENROUTER_API_KEY=sk-or-...   # e.g. in ~/.zshrc
```

Reviewgate sends a strict JSON schema via OpenRouter's `response_format`; models
that ignore it are still recovered by the tolerant parser.

### Choosing the Ollama model

The `ollama` reviewer is an OpenAI-compat HTTP adapter (no CLI, no subprocess —
same shape as `openrouter`), pointed at Ollama Cloud by default:

```bash
export OLLAMA_API_KEY=...   # ollama.com → Account → API Keys, e.g. in ~/.zshrc
```

```ts
ollama: {
  enabled: true,
  auth: "apikey",
  apiKeyEnv: "OLLAMA_API_KEY",
  model: "glm-5.2:cloud",             // any model ollama.com serves; verified with glm-5.2:cloud
  baseUrl: "https://ollama.com/v1",
  timeoutMs: 300_000,
},
```

**Self-hosted instead of the cloud:** point `baseUrl` at a local `ollama serve`
daemon:

```ts
ollama: { enabled: true, auth: "apikey", apiKeyEnv: "OLLAMA_API_KEY", model: "glm-5.2:cloud", baseUrl: "http://localhost:11434/v1", timeoutMs: 300_000 },
```

Run `ollama serve` (and `ollama signin` first if you want to pull Ollama's
`:cloud` models through your local daemon). **Availability is key-based, not
URL-based** — `reviewgate doctor` and reviewer selection check for a non-empty
`OLLAMA_API_KEY` env var regardless of `baseUrl`, so even a pure-localhost setup
is treated as unavailable with no key at all. Set `OLLAMA_API_KEY` to *any*
non-empty placeholder in that case: a local daemon ignores a bogus Bearer
token, but the loopback request itself doesn't require a real key.

Note: unlike OpenRouter, Ollama's `/v1` endpoint accepts a `response_format`
JSON schema in the request but does **not enforce** it server-side — schema
conformance is prompt-driven, the same way it is for the `claude` and `gemini`
adapters. The tolerant parser (plus a reasoning-block stripper for `<think>`
output) recovers the JSON regardless; verified working end-to-end with
`glm-5.2:cloud`.

---

## Verdicts

| Verdict       | Meaning                                              | Effect            |
|---------------|------------------------------------------------------|-------------------|
| **PASS**      | No findings, or INFO only                            | allow stop        |
| **SOFT-PASS** | Only WARN findings, singleton/minority, no CRITICAL  | allow stop (default policy) |
| **FAIL**      | A CRITICAL (security/correctness), or majority WARN  | **block** until addressed |
| **ESCALATE**  | Max iterations, stuck findings, or cost cap hit      | writes `ESCALATION.md`, allow stop |
| **ERROR**     | Reviewer could not run (crash/timeout/sandbox)       | **block** (fail closed), eventually escalates |

Reviewgate **fails closed**: a reviewer that crashes or times out is never
treated as a pass.

---

## Adaptive pipeline

Four stages run before the reviewer panel, making the gate faster and more
precise without changing any external protocols:

### Triage

Before spawning any reviewer, Reviewgate classifies the diff:

- **Doc-only diffs** (changes confined to Markdown, comments, or other
  non-executable files) are **skipped at $0** — they get an automatic PASS
  verdict without touching the reviewer panel.
- **Sensitive-path diffs** (auth, crypto, payment, admin) receive an expanded
  review budget (more iterations, higher cost cap).

### Research context

For every non-trivial diff Reviewgate builds a `research.md` context file and
injects it into each reviewer's prompt. The context includes:

- A summary of which files changed and why.
- **Symbol graph** callers/callees (see below).
- Any relevant entries from the per-repo learning brain (when enabled).

Every reviewer reads this context, so findings reference stable symbol names
rather than raw line numbers.

### Tree-sitter symbol graph

Reviewgate uses `web-tree-sitter` + grammar WASM files to extract the call
graph around the changed symbols. Supported languages: TypeScript, TSX,
JavaScript, JSX, Python.

The symbol graph needs [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)
to find callers efficiently. If `rg` is absent, the symbol graph degrades
gracefully (callers list is empty; reviews still run). If no grammar WASM can
be found the symbol graph is disabled entirely but reviews are unaffected.

Grammar WASM files are bundled into `dist/grammars/` by `bun run build` so the
compiled binary works without `node_modules`. Run `reviewgate doctor` to confirm
both `rg` and the grammars are available.

### Review cache

When the diff is byte-for-byte identical to a previous run (same content hash),
Reviewgate returns the cached verdict without spawning any reviewer. This makes
repeated stop-hooks instantaneous after a trivially clean re-run.

---

## Security

- **Author session ≠ reviewer process.** The host Claude Code or Codex session
  never reviews inline; reviewers are fresh isolated subprocesses. When Claude
  is the authoring host, any Claude reviewer is additionally downgraded to a
  smaller tier. A Codex host does not incorrectly trigger that Claude-only rule.
- **Diff sanitisation.** Diffs are run through a 6-layer pipeline (Unicode NFKC
  normalise → injection-marker neutralise → fenced wrap → high-entropy secret
  redaction → persona reaffirmation) before reaching the reviewer, to blunt
  prompt-injection planted in code.
- **Tamper-evident audit log.** Every run appends a sha256 hash-chained JSONL
  event log; `reviewgate audit verify` detects any modification.
- **Sandbox (denylist filesystem model; opt-in).** With `sandbox.mode: "strict"`
  or `"permissive"`, macOS Seatbelt denies writes except the exact findings/run-temp/
  own-credential targets; Linux bubblewrap exposes `/` read-only and binds only those
  targets writable. Known secret paths are denied/masked, but this is **not a read
  allowlist**: other host files may remain readable. `"strict"` fails closed if the
  OS sandbox is unavailable; default is `"off"`. Network egress is not isolated,
  and Linux cannot enforce glob denies such as `*.pem` or `.env*`.
- **Provider risk is not uniform.** Codex is invoked read-only and Claude's reviewer
  tools are restricted. Gemini/agy and OpenCode are coding-agent CLIs invoked with
  their non-interactive permission-bypass flag and may explore/run tools; use
  `sandbox.mode: "strict"`. OpenRouter/Ollama are HTTP adapters: they do not run local
  tools, but the prompt/diff is sent over the network.
- **Config control plane.** Config is data-parsed, invalid candidates block, and
  policy changes are reviewed under a last-known-good snapshot before adoption.

See [`SECURITY.md`](SECURITY.md) for the full threat model and how to report a
vulnerability.

---

## What gets written to `.reviewgate/`

| Path                         | Committed? | Purpose                                  |
|------------------------------|-----------|-------------------------------------------|
| `bin/{trigger,gate,reset}`   | yes        | tiny hook shims that call the binary      |
| `personas/security.md`       | yes        | the reviewer's persona prompt             |
| `pending.md` / `pending.json`| no         | current iteration's findings (human + machine) |
| `decisions/<iter>.jsonl`     | no         | Coding agent's accept/reject ledger        |
| `state.json`                 | no         | loop FSM state                            |
| `control-plane.json`         | no         | approved policy snapshot + pending candidate |
| `POLICY_CHANGE.md`           | no         | human-readable policy checkpoint          |
| `audit/…`                    | no         | hash-chained event log                    |
| `ESCALATION.md`              | no         | written when a run escalates to the human |

---

## For AI agents

If you are an AI coding agent operating in a Reviewgate-enabled repo, read
[`docs/AGENTS.md`](docs/AGENTS.md) — it specifies exactly how to respond when
Reviewgate blocks your turn (read `pending.md`, fix or reject each finding, write
`decisions/<iter>.jsonl`).

---

## Scope & limitations

**Reviewing**

- Multi-reviewer panel — Codex + Gemini + Claude + OpenRouter (any model by slug),
  run in parallel, with an adversarial critic phase and `confirmed_by` cross-reviewer
  consensus tracking.
- Severity-weighted veto verdict · `pending.md`/`pending.json` + decisions protocol ·
  single loop with escalation (max-iterations / stuck-signatures / cost-cap).
- Quota auto-failover — if a reviewer hits its usage cap, the gate fails over to a
  configured fallback provider, remembers when the limit resets, and resumes the
  primary automatically (no config edit).

**Speed & precision**

- Adaptive triage — doc-only diffs skip review at $0; sensitive paths (auth, crypto,
  payment) get an expanded budget.
- `research.md` context injected into every reviewer prompt — a tree-sitter symbol
  graph (TS/JS/TSX/Python; ripgrep used for callers if present, degrades gracefully)
  and, when enabled, Context7 library docs.
- Review cache — an identical diff returns a cached verdict with no reviewer spawn.

**Learning**

- Per-repo learning brain & Curator (see [Brain & Curator](#brain--curator)) — committed
  memory; `reviewgate brain list|show|revoke`.
- False-positive ledger — FPs you reject are demoted on future runs;
  `reviewgate fp list|show|pin|unpin|audit`.

**Tooling**

- Commands: `init` · `gate` · `doctor` · `config status|approve` · `audit verify` ·
  `stats` · `report` · `review-plan <file>` · `setup` · `brain` · `lore` · `fp` ·
  `learn status` · `bench`.
- Cost model: subscription/OAuth paths for Codex, Gemini, Claude and OpenCode;
  OpenRouter/Ollama use the configured HTTP endpoint/key and are tracked against
  `costCapUsd` where pricing is configured.
- Hash-chained audit log · cassette record/replay for deterministic provider testing.

**Caveats:** reviewer filesystem isolation ships (macOS Seatbelt / Linux bubblewrap)
but is opt-in (`sandbox.mode`, default `off`); **network egress is not isolated** on
either platform, and Linux does not enforce glob secret-denies. See [Security](#security).

---

## Brain & Curator

The brain is a **committed per-repo memory** (`reviewgate.brain.json`,
`brain.md`, `sources.jsonl`, `archive.md` under `.reviewgate/brain/`). Every
reviewer reads the brain entries most relevant to the current diff and may
propose new facts. The **Curator** is a non-blocking background validator that
applies 7 acceptance rules (uniqueness, source authority, cross-provider
quorum, embedding dedup against existing entries, etc.) before anything enters
the brain; proposals that fail are discarded or archived, never silently
committed.

**Committed vs. gitignored:**

| Path | Committed? |
|---|---|
| `.reviewgate/brain/brain.json` | yes |
| `.reviewgate/brain/brain.md` | yes |
| `.reviewgate/brain/sources.jsonl` | yes |
| `.reviewgate/brain/archive.md` | yes |
| `.reviewgate/brain/proposals/` | no (gitignored) |
| `.reviewgate/brain/snapshots/` | no (gitignored) |

**Enable in `reviewgate.config.ts`:**

```ts
export default {
  // ...providers, phases...
  phases: {
    brain: {
      enabled: true,
      embeddings: {
        model: "baai/bge-base-en-v1.5",   // default; any sentence-transformers slug works
      },
      // optional: which provider runs Curator validation
      curator: { provider: "codex" },
      // optional: domains the brain may fetch sources from
      egressAllowlist: ["github.com", "docs.example.com"],
    },
  },
};
```

**CLI:**

```bash
reviewgate brain list          # list all committed brain entries
reviewgate brain show --id <id>     # show a single entry with metadata
reviewgate brain revoke --id <id>   # archive + revoke an entry immediately
```

---

## Development

```bash
bun test            # unit + integration (fake Codex stub)
bun run typecheck   # tsc --noEmit
bun run lint        # biome
bun run build       # compile single binary

REVIEWGATE_E2E=1 bun test tests/e2e   # real Codex end-to-end (uses your quota)
```

The design spec lives in `docs/superpowers/specs/`, the implementation plans in
`docs/superpowers/plans/`, and spike findings in `docs/superpowers/spikes/`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR.

---

## Contributing

Bug reports, feedback, and small focused PRs are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). For security issues, follow
[`SECURITY.md`](SECURITY.md) (do not file them publicly).

## License

[MIT](LICENSE) © Markus Wiesecke
