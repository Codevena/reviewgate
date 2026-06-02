# Design — `reviewgate reset` (user-facing gate re-arm)

**Date:** 2026-06-02
**Status:** Approved (brainstorm) — pending implementation plan
**Scope:** Add a clean top-level CLI command `reviewgate reset` that re-arms the
gate, replacing the awkward `reviewgate gate --hook reset` as the command users
and agents are told to run.

## Problem

The only manual way to re-arm / reset the gate today is
`reviewgate gate --hook reset`. This is poor UX:

- `gate` is explicitly labelled *"internal hook entry point"* in the CLI — it
  does not read as a command a human should type.
- The escalation block (`src/core/loop-driver.ts:1153`) tells users/agents
  verbatim to *"run `reviewgate gate --hook reset` (or restart the session) to
  re-arm"*, and the quota-degraded note (`:1109`) repeats the same string.
- There is a documented foot-gun (`NEXT_SESSION.md:279`, "Reset wrapper trap"):
  an agent ran `bin/gate` instead of `gate --hook reset` and left the gate
  escalated.
- Historically, `gate --hook reset` typed at a TTY hung on stdin read (fixed via
  `readHookStdin`, but the shape still invites the problem).

We want a short, obvious, hook-free command: **`reviewgate reset`**.

## Decisions (from brainstorm)

1. **Scope = 1:1 with SessionStart reset.** `reviewgate reset` does exactly what
   the SessionStart hook (`gate --hook reset`) does — no more, no less. It wipes
   per-session state and re-arms; it does **not** touch learned memory
   (FP-ledger, brain, cross-run candidates — separate files). This matches the
   "or restart the session" semantics in the escalation message and is maximally
   predictable. No `--hard` flag, no surgical "escalation-only" variant (YAGNI).
2. **Behaviour = act immediately + print a one-line summary.** No interactive
   confirmation. Reset is idempotent and cheap; this fits the post-escalation
   recovery flow.
3. **Discoverability = switch messages + docs to `reviewgate reset`, keep the
   alias.** The escalation message, the quota-degraded note, and user-facing docs
   recommend `reviewgate reset`. `gate --hook reset` stays fully functional as
   the internal hook path (the SessionStart `bin/reset` wrapper keeps using it).

## What gets cleared (unchanged from `handleReset`)

`handleReset` (`src/hooks/handlers.ts`) removes, best-effort:

- `dirty.flag`
- `state.json` (this includes per-session reviewer reputation — already
  per-session today, so wiping it here is **not** a regression)
- `decisions/` (directory)
- `pending.md`, `pending.json`
- `research.md`
- `ESCALATION.md`
- all per-run proposal pools (`clearAllProposalPools`)

**Preserved** (separate files, untouched): FP-ledger, brain, cross-run
candidates (`.reviewgate/brain/candidates.jsonl`), quota-cooldown state
(`schemas/quota-cooldown.ts` notes it lives outside `state.json` precisely so a
reset does not wipe it).

## Architecture / Components

### A. `src/hooks/handlers.ts` — `handleReset` returns a summary

Change the signature from `Promise<void>` to `Promise<ResetSummary>` where:

```ts
export interface ResetSummary {
  /** Friendly labels of artifacts that actually existed and were removed. */
  cleared: string[];
}
```

Implementation: before each `rmSync`, check `existsSync`; if present, push a
friendly label (`"session state"`, `"pending findings"`, `"decisions"`,
`"research"`, `"escalation"`, `"proposal pools"`) onto `cleared`. The **removal
behaviour is unchanged** — we only add presence detection so the command can
report what it did. For proposal pools, detect presence via the pool
directory/files before `clearAllProposalPools` (or have that helper report
whether it removed anything); if detection is awkward, label "proposal pools"
based on the pool dir's existence.

This keeps the "what gets cleared" knowledge in **one place** (next to the
removal) — the single-source-of-truth property that makes Approach A preferred
over computing the summary in the command.

### B. `src/cli/commands/reset.ts` — new `runReset`

```ts
export interface ResetInput { repoRoot: string; }
export async function runReset(input: ResetInput): Promise<number>; // exit code
```

- If `.reviewgate/` does not exist → print a gentle hint that this does not look
  like a Reviewgate-initialised repo, still `return 0`.
- Otherwise call `handleReset({ repoRoot })`, then render a one-line-ish summary
  to stdout:
  - cleared something:
    ```
    🔄 Reviewgate reset — gate re-armed.
       Cleared: <comma-joined cleared labels>.
       Preserved: FP-ledger & brain.
    ```
  - nothing present: `🔄 Reviewgate reset — gate re-armed (nothing to clear).`
- **Reads no stdin** — the TTY-hang failure mode cannot occur here by
  construction.
- Always `return 0` (reset is idempotent / best-effort).

### C. `src/cli/index.ts` — register the subcommand

A top-level `reset` `defineCommand` with no `--hook` arg and no stdin read:

```ts
const reset = defineCommand({
  meta: { name: "reset", description: "Re-arm the gate: clear this session's review state (pending findings, decisions, escalation). Learned memory (FP-ledger, brain) is preserved." },
  async run() {
    process.exit(await runReset({ repoRoot: process.cwd() }));
  },
});
```

Add `reset` to `main.subCommands`.

## Data flow

- **Hook path (unchanged):** SessionStart hook → `bin/reset` → `reviewgate gate
  --hook reset` → `gate.ts` calls `handleReset` and **ignores** the return value.
- **User path (new):** `reviewgate reset` → `runReset` → `handleReset` →
  summary → stdout, exit 0.

Both paths share `handleReset` ⇒ guaranteed 1:1 parity (Decision 1).

## Messages & docs to update

- `src/core/loop-driver.ts:1153` (escalation block): `reviewgate gate --hook
  reset` → `reviewgate reset`.
- `src/core/loop-driver.ts:1109` (quota-degraded note): same replacement.
- `README.md`, `docs/architecture.md`, `CLAUDE.md` (project): introduce
  `reviewgate reset` as the user-facing re-arm command; keep `gate --hook reset`
  documented as the internal hook entry point.
- The global `~/.claude/CLAUDE.md` Reviewgate protocol section is the user's
  private file and is **out of scope** for this change.

## Error handling & concurrency

- `handleReset` already swallows per-file `rmSync` errors (best-effort); the new
  presence checks must not change that. `runReset` always exits 0.
- **No flock.** This matches the existing SessionStart reset, which also takes no
  gate lock. A manual `reviewgate reset` issued while a Stop-hook review is
  in-flight is a deliberate human action equivalent to restarting the session;
  racing the in-flight gate's writes is an **accepted edge case** (documented
  here). We deliberately do not add locking to avoid diverging the two reset
  paths' semantics.

## Testing

- `tests/unit/reset-command.test.ts`:
  - Seed a temp `.reviewgate/` with `state.json`, `pending.{md,json}`,
    `decisions/1.jsonl`, `ESCALATION.md`; run `runReset`; assert all removed,
    `cleared` summary lists them, exit 0.
  - Already-clean: run on an empty `.reviewgate/` → exit 0, "nothing to clear".
  - No `.reviewgate/` dir → exit 0, "not a Reviewgate repo" hint.
- `handleReset` return-shape test: present vs. absent artifacts are reflected
  correctly in `cleared`.
- Parity test: `runReset` and the `gate --hook reset` path (i.e. `handleReset`)
  clear the same artifact set on an identical seeded tree.

## Out of scope (YAGNI)

- `--hard` / clearing learned memory (FP-ledger, brain, reputation).
- Interactive confirmation / `--force` / dry-run.
- Re-pointing the `bin/reset` SessionStart wrapper at `reviewgate reset` (would
  touch the hook stdin contract for no user benefit).
- Editing the user's global `~/.claude/CLAUDE.md`.
