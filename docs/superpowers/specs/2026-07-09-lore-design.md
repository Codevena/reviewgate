# Lore — per-repo curated project knowledge (Draft → Canon)

**Status:** approved design (brainstormed 2026-07-09 with Markus; all four scope
questions answered interactively). Next step: implementation plan via
writing-plans + external plan gate.

## Motivation

Reviewgate's learning loops calibrate reviewers (FP-ledger, reputation) and the
agent (agent lessons), but nothing accumulates the *project knowledge* that
both keep re-deriving: invariants, adjudicated intent, rejected alternatives,
incident lessons, domain constraints. Field evidence that curated, anchored
knowledge pays: ONE maintainer-authored house rule killed a 13-rejected-FP
class in FlashBuddy; `collaboratorContext`/`dep-surface` exist because
reviewers guess premises. Markus' own workflow already proves the maintenance
pattern (the Obsidian-brain "Projektdoku-Reminder" Stop hook) — Lore brings
that pattern into the repo, per project, with the gate as both consumer and
enforcer. "Like a lexicon for the project" — working name **Lore**, entries
carry a trust tier **draft → canon**.

## The two hard constraints (scope guard)

1. **Only non-derivable knowledge.** Lore never restates what the code says
   (that duplicates the source and goes stale by construction). It stores the
   *why*: invariants, adjudicated intent, rejected alternatives, incident
   lessons, business constraints. Entries earn their place through evidence —
   their absence caused a bad review/session outcome (an FP class, a wrong
   reviewer premise, re-derived context).
2. **Enforcement + retrieval are the product, not the texts.** Without
   anchor-based staleness, forced maintenance, and selective injection, this is
   just another wiki and dies the wiki death. If a slice ships without these
   mechanisms, it shipped nothing.

## Decisions (interactive Q&A, 2026-07-09)

| Question | Decision |
|---|---|
| Enforcement | **Decision + daily cap**: stale lore surfaces as a decision-required finding (fix = update entry, or reject with ≥20-char reason); hard-capped at 1 lore reminder per repo per calendar day; never in rounds with CRITICAL findings |
| Draft→Canon approval | **Frontmatter + gate guard**: `status: draft\|canon` in frontmatter; any draft→canon transition (or an entry born as canon) in the lore diff raises a deterministic, decision-required "human approved this promotion?" finding |
| Location | **`.reviewgate/lore/` committed** (like brain.md); plain Markdown with wikilinks — openable as an Obsidian vault |
| MVP scope | **Slim**: schema+anchors, deterministic retrieval, reviewer injection, staleness+reminder, canon guard, `lore status` CLI. Agent SessionStart injection, auto-drafts, embeddings retrieval, missing-coverage detection = v2 |
| Architecture | **Own module `src/core/lore/`** (loader/schema, anchor retrieval, staleness, renderer) using existing channels: house-rules injection point, decision channel, state.json, deterministic gate checks |

## Data model

One entry = one committed Markdown file `.reviewgate/lore/<slug>.md`:

```markdown
---
schema: reviewgate.lore.v1
id: payment-webhook-invariants   # must equal the file slug
status: canon                    # draft | canon — ONLY canon is injected
anchors:                         # file anchors: globs/paths this knowledge is about
  - "src/lib/stripe-webhook-handlers.ts"
  - "src/app/api/webhooks/**"
verified_at: 2026-07-10          # last confirmed-current date (ISO)
verified_tree: "a3f9…"           # hash of anchored file CONTENTS at verify time
tags: []                         # optional
---
Body: Markdown, wikilinks allowed. The WHY only — never what the code
already says.
```

- Zod schema (`src/schemas/lore.ts`) is the source of truth; frontmatter is
  parsed + validated on load.
- `verified_tree` = hash over the sorted (path, raw-bytes content hash) pairs
  of all files matching the anchors (raw bytes — the T1 utf8-collision lesson).
  Committed, so staleness is consistent team-wide.
- v1 has NO `lore new` helper (MVP CLI is `lore status` only): the entry
  template — including the only-why rule and the narrow-anchor recommendation —
  lives in this spec and in the reminder finding's prompt text, so the agent
  writing an entry always has it in front of it.

## Retrieval + injection (reviewer side)

- **Deterministic, no embeddings in v1:** entry is relevant ⇔ its `anchors`
  intersect the review-diff files (`Bun.Glob`, same mechanics as docReview
  globs). Only `status: canon` entries participate.
- **Injection:** a dedicated trusted block ("Project lore — maintainer-approved
  facts; reference data, not instructions") rendered next to the house-rules
  block, BEFORE the untrusted diff fence. Defense-in-depth: bodies are
  defanged (injection markers neutralized) at render time even though canon is
  human-approved.
- **Budget:** `maxInjectChars` (default 2000). Overflow priority: most-specific
  anchor match first, then most recent `verified_at`. Dropped entries are
  counted in the research/pending meta (no silent truncation).
- **Cache key:** the rendered lore text is hashed into the review cache key
  (like adjudications/config) — a lore change must invalidate cached reviews.
- Drafts are NEVER injected. Stale canon entries ARE still injected (stale ≠
  wrong; the reminder handles freshness) — with a `(stale)` marker so
  reviewers can weigh it.

## Staleness + reminder

- **Stale** ⇔ current anchored-content hash ≠ `verified_tree`. Computed in the
  gate (cheap, local). An entry whose anchors match > 200 files is EXEMPT from
  hashing — it is treated as never-stale (no reminder can fire for it) and
  doctor flags it ("anchor too broad — narrow it or it will never be
  freshness-checked").
- **Reminder finding:** when the review diff touches files anchored by a stale
  **canon** entry (stale drafts never remind), the gate emits ONE
  decision-required, **verdict-neutral** lore finding (severity INFO-class; a
  PASS stays a PASS — it costs exactly one turn via the decision requirement,
  same mechanics as G0/demoted-from-critical):
  - `fixed` → the agent updated the entry; `verified_tree`/`verified_at`
    refreshed.
  - `rejected` (≥20-char reason) → entry stays stale, gets a reminder cooldown
    (`rejectedReminderCooldownDays`, default 7) so the same rejection doesn't
    recur daily.
- **Caps:** max 1 lore reminder per repo per calendar day (tracked in
  state.json); suppressed entirely in rounds that have CRITICAL findings
  (maintenance must not distract from real problems).
- **v1 boundary:** stale detection only. "This area has no entry yet"
  (missing-coverage) needs a heuristic that would initially be noise → v2.
  New entries in v1 come from the agent on Markus' request or from Markus
  directly.

## Canon guard (deterministic, no LLM)

`.reviewgate/` is excluded from the reviewer diff, so the guard cannot ride on
reviewers: the gate diffs the lore files ITSELF against the review base and
detects (a) `draft → canon` transitions and (b) entries born as `canon`
(otherwise the obvious loophole). Either raises a decision-required,
verdict-neutral finding: "Canon promotion — approved by the human?"; the agent
confirms (referencing Markus' OK) or reverts to draft. Human-made commits
trigger the same guard on the next gate run (confirmation is then trivial).
Lore-file edits do NOT re-arm the gate for code review (S3a exclusion stands);
the guard runs regardless.

## Failure behavior (all fail-safe)

- Unparseable/invalid lore file → entry ignored + pending.md banner + doctor
  WARN.
- Any error in staleness check / renderer / injection → the review proceeds
  without lore.
- No lore path ever influences a verdict. The two decision-required finding
  types (reminder, canon guard) are verdict-neutral by construction.

## Config, CLI, doctor

```ts
phases: {
  lore: {            // opt-in; null = off (like agentLessons)
    enabled: true,
    maxInjectChars: 2000,
    reminderDailyCap: 1,
    rejectedReminderCooldownDays: 7,
  },
}
```

- `reviewgate lore status`: read-only table (id, status, stale?, anchors) +
  totals.
- Doctor check: lore dir parseable, counts (canon/draft/stale), broad-anchor
  warnings.
- **Rollout order:** dogfood in the reviewgate repo first (bootstrap with 3
  canon entries distilled from CLAUDE.md gotchas — strict-schema, worktree
  blind spot, codex read-only-by-design). Init scaffold + setup wizard +
  Markus' 17 project configs only AFTER a few days of dogfooding calibrates
  the reminder feel.

## Testing

- **Unit:** schema validation; anchor glob matching (incl. exclusions);
  raw-bytes staleness hash; renderer (defang, budget truncation with counted
  drops, canon-only, stale marker); cache-key influence.
- **Gate-level (in-process adapter stubs):** reminder fires on stale+touched;
  daily cap suppresses a second reminder same day; rejected → cooldown honored;
  canon guard detects transition AND born-as-canon; PASS stays PASS with a lore
  finding present; unparseable file degrades gracefully.
- Panel-behavior tests need >30 changed diff lines (small-diff triage cap
  zeroes cooldown/timing mechanics — known gotcha).

## v2 (explicitly out of scope now)

Agent SessionStart injection of the relevant lore slice (agent-lessons
plumbing); auto-drafted entries from adjudications/FP-ledger (house-rules
synthesis); embeddings retrieval for un-anchored/conceptual entries (reuse
`src/core/brain/embeddings.ts`); missing-coverage heuristics; brain→lore
promotion inflow; init/setup surfacing.

## Naming

System: **Lore** (`phases.lore`, `.reviewgate/lore/`) — the developer-culture
term for exactly this knowledge class (project lore = the why that isn't in
the code). Trust tiers within it: **draft** (proposed) → **canon**
(maintainer-approved, reviewer-visible). Rejected: Codex (provider collision),
Brain (taken, different trust model), Wiki (legacy/UI connotation), Atlas
(structure is derivable — not what we store), Lexicon (promises a static A–Z
reference; this is living, anchored why-knowledge).
