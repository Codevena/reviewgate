# S4 — User-scoped hooks (`init --user`), Claude Code only (2026-07-29)

Status: DECIDED (Markus, 2026-07-29). Host scope: **Claude Code only**; the Codex-host
analog stays deferred (its user-level hook support is unverified). Expands slice **S4** of
`docs/superpowers/specs/2026-07-17-arming-consent-design.md`, which is three sentences long
and not implementable as written.

## 1. Problem

Reviewgate only fires where `reviewgate init` wrote repo-local hooks. Every fresh clone,
every linked worktree, every repo a user simply starts working in is ungated — and the user
has no reason to expect that, because the tool is installed globally (`npm i -g reviewgate`,
binary on PATH). The gate's coverage is therefore a function of who remembered to run
`init`, which is the weakest possible guarantee for a safety tool.

S1–S3 exist so that fixing this is *safe*:

- **S1** killed first-contact self-blessing: a cloned repo's committed `reviewgate.config.ts`
  can never be self-approved.
- **S2** made an unarmed checkout answer from a pure READ: no `.reviewgate/`, no state, no
  panel, no `checks.commands`.
- **S3** let a linked worktree run under the main checkout's approval.

Until S4 lands, none of those three changes anything a user can observe. S4 is the slice
that makes them matter — and it is only responsible because they exist.

## 2. Verified facts (receipts)

Everything below was checked this session, from the Claude Code hook documentation or by
running the code — not assumed.

| # | Fact | Where |
|---|------|-------|
| G1 | Hook entries **merge** across settings levels; user, project and local settings add their own hooks rather than replacing each other. All matching hooks run **in parallel**. | Claude Code hooks doc, verbatim |
| G2 | Identical handlers are deduplicated automatically — command hooks by **command string + args**. Different paths never dedup. | same |
| G3 | A `Stop` hook has **no "allow"/"approve" decision value**. It can only block (`{"decision":"block"}` / exit 2) or stay silent (exit 0, no JSON = "no decision"). | same |
| G4 | The one cross-cutting override is the universal `continue:false`, which "takes precedence over any event-specific decision fields". | same |
| G5 | Reviewgate has one helper that would emit `continue:false` (`formatAllowStopJson`, `src/hooks/handlers.ts:363`) — it has **zero callers**. Dead code. | `grep` over `src/` + `tests/` |
| G6 | Measured: a hook-invoked gate in an **unarmed** repo writes **nothing to stdout or stderr** and exits 0. In an **armed** repo on PASS, stdout is **empty** and the green message goes to **stderr**. Reviewgate writes to stdout only when it BLOCKS. | ran the compiled path in a temp repo, streams separated |
| G7 | Hook handlers "run in the current directory", and the hook's stdin JSON carries a `cwd` field. `${CLAUDE_PROJECT_DIR}` is documented as "the project root" but its availability in **user** settings is *not* stated either way. | Claude Code hooks doc |
| G8 | `installedGateStopTimeoutS` reads **only the checkout's** `.claude/settings.json` and matches a Stop command containing `.reviewgate/bin/gate`; it returns `null` when absent, and the loop then trusts its configured deadline unclamped. | `src/utils/stop-hook-timeout.ts:18-34` |
| G9 | Repo-local Claude hooks today: PostToolUse `timeout: 5` (async), Stop `timeout: 2400`, SessionStart `timeout: 30`, commands `"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/<shim>"`. | `src/hosts/hooks.ts:59-99` |
| G10 | The repo-local Stop shim fails **CLOSED**: an unresolvable binary prints a `decision:"block"` JSON and exits 0; it also catches exit 126/127 from the child rather than `exec`ing. | `bin-templates/gate.sh` |

**The load-bearing consequence of G3 + G6:** two Stop hooks running in parallel cannot
conflict in the dangerous direction. There is no way for a silent hook to cancel another
hook's block, and Reviewgate is silent on stdout unless it blocks. **Dedup is therefore a
COST problem — duplicate gate-lock contention and duplicate reviewer quota — not a safety
problem.** This is the opposite of what was assumed when S4 was first sketched, and it is
why the dedup rule below is allowed to be a cheap best-effort check rather than a
security boundary.

## 3. Design

### 3.1 `reviewgate init --user`

Writes exactly two things:

1. **User shims** at `~/.reviewgate/bin/{gate,trigger,reset}` — new templates, siblings of
   the existing `bin-templates/`, with the two differences in §3.2. The reviewgate binary
   path is baked in at install time exactly as `init` already does for repo-local shims.
2. **Hook entries** in `~/.claude/settings.json`, mirroring G9's events and timeouts
   (PostToolUse 5s async, Stop **2400s**, SessionStart 30s), with commands pointing at the
   user shims by absolute path.

**Merge, never overwrite.** The file is the user's global configuration for every project;
`init --user` must read it, add only Reviewgate's entries, and write it back preserving
everything else — the same discipline `init` already applies to a repo's
`.claude/settings.json` (an earlier audit found "init wipes settings" as a HIGH finding;
do not reintroduce it at global scope, where the blast radius is every project).

`--user` is orthogonal to the existing per-repo `init`: it does not touch any repo, does
not write `.reviewgate/`, and does not arm anything.

**Refresh path, decided:** `init --user` is idempotent and re-writes the shims from the
current templates with the current binary path, so it doubles as the upgrade repair —
the same role `--hooks-only` plays for repo-local shims. No separate version marker is
introduced; re-running the command is the supported way to refresh stale global shims,
and `doctor` (§3.4) is what tells the user to do it.

### 3.2 User shim semantics

The user shims are the repo-local shims with exactly two deliberate differences.

**Difference 1 — repo resolution without `${CLAUDE_PROJECT_DIR}`.** Per G7 that variable's
user-scope availability is undocumented, so the shim must not depend on it. It resolves the
root the way the Codex shim already does:

```sh
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
```

In a linked worktree this yields the worktree root, which is precisely what S3 wants.

**Difference 2 — dedup, then fail direction.**

```
if [ -x "$ROOT/.reviewgate/bin/gate" ]; then exit 0; fi   # repo-local wins, no stdout
```

Repo-local hooks are already installed there and will fire in the same event (G1), so the
user shim stands down silently. Per G3 an `exit 0` with no stdout is "no decision" and
cannot weaken the repo-local hook's verdict — the check exists to avoid two gates
contending on `gate.lock` and burning double reviewer quota.

Then, unlike the repo-local shim (G10), an unresolvable binary **fails OPEN**:

```
# no binary → warn on STDERR, exit 0. NEVER stdout.
```

Rationale (arming spec §4): a user-scoped hook fires in every repo the user opens. Blocking
every Stop everywhere because a binary is missing would make the feature uninstallable. The
warning goes to stderr precisely because stdout is the decision channel (G6).

**Hard rule for the shims:** never emit `continue:false` (G4/G5). It is the only field that
overrides another hook's decision, and a globally-installed hook must never do that to a
tool it knows nothing about.

### 3.3 Stop-hook timeout clamp (the one real gap)

G8 is a latent fail-open in the user-scoped world: `installedGateStopTimeoutS` looks only at
the checkout's `.claude/settings.json`. In a repo gated *only* by user-scoped hooks that
returns `null`, so the loop keeps its configured deadline (default `runTimeoutMs` 1800s)
while the OS enforces whatever timeout the user's global hook carries. A stale or
hand-edited global timeout below the invariant (120s setup + `runTimeoutMs` + 30s settle)
means the OS kills the hook mid-review — non-blocking, empty stdout, turn ends un-reviewed,
**silently, on every retry**. That is exactly the failure this module was written to prevent.

Fix: `installedGateStopTimeoutS` falls back to `~/.claude/settings.json` when the checkout
has no matching Stop hook. Because the user shim lives at `~/.reviewgate/bin/gate`, the
existing predicate (`command.includes(".reviewgate/bin/gate")`) matches unchanged — only
the set of files consulted grows. `doctor`'s `hookTimeoutCheck` must stay in sync (the
module's own comment already requires this).

### 3.4 `doctor`

Add a user-scope section: are the user hooks installed, does `~/.reviewgate/bin` exist and
resolve, does the baked binary path still run, and does the user-scope Stop timeout satisfy
the panel-budget invariant. Existing repo-local checks are unchanged.

`worktreeGatedCheck` stays as it is: it measures whether hooks are installed *here*. With
user-scoped hooks installed, a worktree IS gated — so the check should recognise that case
and report it honestly rather than keep FAILing. **This is the one place where the S3
decision ("no doctor change") is superseded, and only because S4 makes the underlying claim
true.**

### 3.5 Uninstall

`reviewgate init --user --remove` removes Reviewgate's entries from
`~/.claude/settings.json` and the `~/.reviewgate/bin` shims, leaving every other entry
untouched. Writing to a user's global config without a supported way back is not acceptable.

## 4. Explicitly NOT in scope

- **Codex host.** `.codex` user-level hook support is unverified; verify before promising.
- **S5 plugin packaging.** Separate slice; it reuses these shims.
- **`gateEverywhere`** and any new config field (arming spec §7.2/§8 defer it).
- **Changing `gate.ts`.** S2/S3 already deliver the behaviour the user-scoped case needs;
  the only source change outside `init`/shims/doctor is §3.3's timeout lookup.
- **Removing the dead `formatAllowStopJson`** (G5). Worth doing, but it is unrelated
  cleanup and would ride along untested; track it separately.

## 5. Risks

| Risk | Mitigation |
|------|-----------|
| `~/.claude/settings.json` governs **every** session on the machine, including the one performing the install | Merge-not-overwrite, write atomically, back up the previous file, and dogfood on this machine only after the test suite is green. A broken global Stop hook breaks all of Markus's sessions at once. |
| Duplicate gate runs in repos that have both scopes | §3.2 dedup; failure mode is cost, not safety (G3/G6) |
| A global hook firing in unrelated repos | S2 guarantees silence and zero writes there — measured (G6), not assumed |
| Stale global Stop timeout silently truncating reviews | §3.3 clamp fallback + a `doctor` check |
| Users who want the gate off in one specific repo | Out of scope by construction: an unarmed repo is already a silent no-op, and an armed one was armed deliberately |

## 6. Test strategy

- Unit: shim template rendering; the settings merge (existing entries preserved, idempotent
  re-run, `--remove` restores the original); `installedGateStopTimeoutS` fallback order
  (repo hit wins, repo miss → user file, neither → `null`).
- Shim behaviour: run the generated `gate` shim as a real script in a temp HOME with (a) a
  repo-local `.reviewgate/bin/gate` present → exit 0, empty stdout; (b) an unresolvable
  binary → exit 0, empty stdout, non-empty stderr; (c) a resolvable binary → the gate's
  own stdout/exit code passed through.
- **Never** point tests at the real `~/.claude/settings.json`; every test uses a temp HOME.
- Mutation-check at least: flipping the fail direction to CLOSED, dropping the dedup check,
  and dropping the §3.3 fallback must each turn a specific test red.

## 7. Deliberately left to implementation

Only the exact user-facing wording of the `doctor` checks in §3.4 — including how a
worktree gated solely by user-scoped hooks is described. Everything else above is decided.
