# Agent Lessons — Display Fast-Follows Design

Status: **approved for planning** (brainstorm 2026-07-04). Two display refinements to Agent Lessons
v1 ([[2026-07-03-agent-lessons-design]]): a human-readable `rule_id` in lessons, and a pending.md
recurrence header during active reviews.

## Problem

Agent Lessons v1 shipped, but two display gaps remain:

1. **Token-sorted `rule_id`.** The store keys and displays `rule_id` via `normalizeRuleId`, which
   lowercases, splits on non-alphanumerics, drops noise words, and **sorts tokens alphabetically**
   (`"missing-additionalProperties"` → `"additionalproperties-missing"`). The bucket key must stay
   normalized, but the lesson TEXT the agent reads shows the reordered form — it reads garbled.
2. **Lessons only surface at SessionStart.** They prime a fresh session, but during an *active*
   review — exactly when the agent is fixing a finding of a recurring class — there is no signal
   that "you've made this mistake type N× here before."

## Scope & principle

Two small, deterministic refinements, both under the existing opt-in `phases.agentLessons` (no new
flag). Same house principle as v1: **render-only, NEVER verdict-affecting, fail-safe** — any error
in either path degrades to "no display change," never blocks a review or alters a verdict.

Explicitly OUT (unchanged from v1's deferred list): LLM distillation, the global
`~/.reviewgate/lessons` tier, distinct-session surfacing floor, entry-count cap (the last two remain
"add when the field shows the need").

## Feature 1 — Human-readable `rule_id` in lessons

**Data model:** `LessonEntry` gains `display_rule_id: z.string().optional()` — the RAW `rule_id` as
the reviewer wrote it (e.g. `"missing-additionalProperties"`), most-recent-wins (updated on each
occurrence, exactly like `exemplar_message`). The existing `rule_id` stays the normalized bucket
token (it must match `key = sha256(category + "|" + normalizeRuleId(rule_id))`).

**Collect (`store.recordOccurrence`):** the caller already passes the raw `rule_id` in
`meta.rule_id` (learn.ts passes `f.rule_id`). Set `display_rule_id` to the **defanged** raw rule_id
— `neutralizeInjectionMarkers(meta.rule_id.trim())` with backticks stripped — on create AND on each
non-dup occurrence (most-recent-wins), alongside the existing `rule_id: normalizeRuleId(meta.rule_id)`.
Sanitizing **at write** means every render site (renderLesson, learn-status, recurrence note) uses a
safe value directly, with no per-site sanitizing to forget.

**Render (`distill.renderLesson`, `learn-status`):** use `entry.display_rule_id ?? entry.rule_id`.
Back-compat: entries written before this change have no `display_rule_id` → the `?? entry.rule_id`
fallback shows the normalized form (today's behavior), never crashes.

Deterministic, tiny. No new files.

## Feature 2 — pending.md recurrence header

When a finding in the CURRENT review round matches a *surfaced* lesson (a recurring accepted+fixed
pattern), pending.md gains an advisory header so the agent sees the recurrence while addressing it.

**Match (contextual, not a generic top-K dump):** a current finding matches a surfaced lesson when
`sha256(finding.category + "|" + normalizeRuleId(finding.rule_id))` equals the lesson's `key` AND
the lesson's `count >= minRecurrence`. Only lessons matching this round's findings are shown —
relevant, low-noise.

**New pure function** (`src/core/agent-lessons/recurrence.ts`):
`recurrenceNotesForFindings(repoRoot: string, cfg: AgentLessonsCfg | null | undefined, findings:
Finding[]): Promise<string[]>` — returns one rendered advisory line per matched recurring lesson
(deduped by key; ranked by count desc). Reads the store with `snapshot({ backupCorrupt: false })`
(pure read). **NEVER throws** — wrapped in one try/catch returning `[]`; returns `[]` when
`!cfg?.enabled` or no findings match. Each line is sanitized (`neutralizeInjectionMarkers` +
`neutralizeFences`) since it embeds the reviewer-authored `exemplar_message`. Example line:
`` ⚠️ Recurring mistake: rule `missing-additionalProperties` [correctness] — caught 4× in this repo
before (3 files, 2 sessions). ``

**Wiring:** computed in the orchestrator's `writeReport` (where `findings` + `config` + `repoRoot`
converge), gated on `config.phases.agentLessons?.enabled`, and passed into the `PendingReport` as a
new optional field `agent_lesson_recurrences: string[]` (schema addition, optional/back-compat).
This keeps `report-writer` decoupled from the store — it renders data handed to it, it does not read
the ledger.

**Render (`report-writer.renderMd`):** when `r.agent_lesson_recurrences?.length`, emit a `> ⚠` block
near the top of pending.md, in the same style as the existing `workspace_unsettled` / fragmenting-FP
banners — advisory, above the findings, so the agent reads it before dispositioning. No effect on
gating, counts, or verdict.

**Fail-safe:** `recurrenceNotesForFindings` returning `[]` (disabled / no match / any error) means
no header — pending.md renders exactly as today. The orchestrator computes it in a `.catch(() => [])`
so a failure never blocks report writing.

## Testing (deterministic → unit-testable)

- **F1 store:** `display_rule_id` set to the raw form on create + updated most-recent on a new
  occurrence; a dup does not change it (true no-op); `rule_id` stays normalized.
- **F1 render:** `renderLesson` uses `display_rule_id` when present; falls back to `rule_id` when
  absent (back-compat); `learn-status` surfaced view shows the display form.
- **F2 match:** a finding whose `(category, normalizeRuleId(rule_id))` matches a surfaced lesson
  produces a note; a finding matching a BELOW-threshold entry produces none; a non-matching finding
  produces none; multiple findings of the same key dedupe to one note.
- **F2 fail-safe:** disabled config → `[]`; corrupt store → `[]` (and store not mutated); a
  malicious `exemplar_message` is sanitized in the note.
- **F2 render:** `renderMd` emits the `> ⚠` block when notes are present, and is byte-unchanged when
  absent; the block never affects `blocking`/`advisory` counts or the verdict.

## Deltas / notes

- No new config surface — both features ride `phases.agentLessons.enabled`.
- `display_rule_id` and `agent_lesson_recurrences` are both **optional** schema additions → existing
  persisted stores and pending reports parse unchanged.
- The recurrence note's `(category, count, files, sessions)` are derived (as in v1's `surfacedLessons`);
  the note shows `display_rule_id ?? rule_id` for the same human-readable reason as F1.
