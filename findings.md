# Reviewgate — Audit-Findings (Workflow-Run wf_bb90e785-ceb, 2026-06-10)

Quelle: Multi-Agent-Audit (6 Bug-Finder, je Finding ein adversarialer Verifier).
31 Roh-Findings → **24 bestätigt**, 7 widerlegt. Duplikate sind markiert (gleicher Bug, von zwei Findern unabhängig gefunden).

## Fix-Status (2026-06-10)

Alle 22 uniquen Findings wurden von 6 parallelen Fix-Agenten (Cluster A–F, strikt disjunkte
Datei-Ownership, test-first) behoben. Verifikation: voller `bun test` **1581 pass / 0 fail**
(256 Dateien), `bunx tsc --noEmit` sauber, `bun run lint` sauber, dist-Binary neu gebaut.

- **Cluster A** (F-06, F-07, F-08): Verdict-Leiter `warn>0 || critical>0 → SOFT-PASS`; rule_id
  einmal normalisiert ("unspecified") für Signatur UND persistiertes Feld; Masking-Warnung
  überlebt die 2000-Zeichen-Truncation.
- **Cluster B** (F-09, F-10, F-11): codex-Prompt via `codex exec -` über stdin (review() inkl.
  Retry + complete()); opencode-Prompt via piped stdin (Upstream-Verhalten verifiziert);
  Exit-0-Quota-Banner-Check nach claude.ts-Muster. **Live verifiziert:** `codex exec -` mit
  100-KB-Prompt → PONG; `opencode run` piped → PONG; Unit-Tests reproduzierten den echten
  E2BIG vor dem Fix (5 rot → grün).
- **Cluster C** (F-12, F-01, F-13, F-14, F-17, F-18): Diff-Fehler ⇒ incomplete ⇒ ERROR statt
  PASS im Skip-Branch (über bounded infra-defer, kein Block-Loop; Unborn-HEAD bleibt benign);
  Cooldown-Timestamps frisch beim Anwenden (pro Effekt); `--no-index` mit `--` + Exit≥2 ⇒
  incomplete; @@-State-Tracking statt Präfix-Heuristik; `lockfileOnly`-Flag + Konsum in
  triage/matrix.ts (Minimal-Tier, Review läuft weiter — Hauptagent); tracked names mit `-z`.
- **Cluster D** (F-04, F-02, F-05/F-16, F-15, F-06-Sekundärfix): absorbPriorDecisions vor die
  Eskalations-Preconditions gehoben (Sensitivität via git stash verifiziert); incomplete_runs:0
  in beiden Defer-Pfaden; Compare-and-Delete fürs dirty.flag (ts+diff_hash-Match, Mikrosekunden-
  Rest-TOCTOU dokumentiert); BASE_TS_NO_SCOPING_SENTINEL (Epoch-0) für synthetisierte Flags,
  handleTrigger paart nie alte base_sha mit frischer base_ts; SOFT-PASS-Meldung zeigt
  CRITICAL-Count.
- **Cluster E** (F-19, F-20, F-03/F-21, F-22, F-23): neuer shared Fold `decision-fold.ts`
  (last-wins per finding_id, Muster aus loop-driver) in learn.ts/reputation/reject-rate;
  Stores rethrowen rohe fs-Fehler (nur SyntaxError/ZodError ⇒ empty, mit `.corrupt.<ts>`-Backup
  wie StateStore); toter 180d-Guard entfernt (Begründung: Recompute-Demotion am 60d-Fenster ist
  die operative, test-gepinnte Semantik). Hinweis: transiente Read-I/O-Fehler in Read-only-Pfaden
  (orchestrator fp/brain) sind jetzt laute Gate-ERRORs (fail-closed) statt stiller Leer-Runden.
- **Cluster F** (F-24): Status-Clamp (out-of-range/fehlend ⇒ 502) vor dem Response-Konstruktor;
  echter Upstream-Status nicht-spoofbar via `x-reviewgate-raw-status` für ehrliche Deny-Messages;
  alle Event-Handler-Callbacks rejecten statt uncaughtException. Live-Repro (HTTP 700) vor dem
  Fix gecrasht, danach sauber 502/raw-700.

Bekannte akzeptierte Rest-Punkte: Mikrosekunden-TOCTOU beim dirty.flag-Unlink (dokumentiert);
Cross-Stop-Supersede bräuchte eine Retraction-API am Store (out of scope, in F-19/F-20 notiert);
opencodes Exit-0-Quota-Banner-Wortlaut ist nicht feld-verifiziert (rides on quota-signals.ts).

## Übersicht

| ID | Sev | Cluster | Titel | Ort | Status |
|----|-----|---------|-------|-----|--------|
| F-06 | HIGH | A | Non-failing CRITICAL finding yields verdict PASS (severity inversion, bypasses softPass… | `src/core/aggregator.ts:629` | GEFIXT |
| F-09 | HIGH | B | codex adapter passes the full review prompt as a single argv element — E2BIG on large d… | `src/providers/codex.ts:115` | GEFIXT |
| F-12 | HIGH | C | Diff-collection failure yields empty diff → triage-skip PASS → change ships unreviewed … | `src/core/orchestrator.ts:500` | GEFIXT |
| F-24 | HIGH | F | pinnedFetch crashes the process (uncaughtException) on any HTTP status outside 101/[200… | `src/core/brain/fetcher.ts:336` | GEFIXT |
| F-01 | MEDIUM | C | Cooldown backoff/reset windows are anchored at panel-START time, so a timed-out reviewe… | `src/core/orchestrator.ts:938` | GEFIXT |
| F-04 | MEDIUM | D | absorbPriorDecisions runs AFTER the cost-cap / max-iterations / stuck-signatures precon… | `src/core/loop-driver.ts:806` | GEFIXT |
| F-07 | MEDIUM | A | Severity leaks into the finding signature when rule_id is missing, breaking cross-itera… | `src/providers/review-output.ts:243` | GEFIXT |
| F-10 | MEDIUM | B | opencode adapter passes the full review prompt as a single argv element — E2BIG on larg… | `src/providers/opencode.ts:86` | GEFIXT |
| F-13 | MEDIUM | C | Untracked-file `git diff --no-index` failures silently drop files from the review (no `… | `src/utils/git.ts:249` | GEFIXT |
| F-14 | MEDIUM | C | Hunk-line counter excludes content lines starting with '++'/'--' — real changes can par… | `src/research/diff-facts.ts:65` | GEFIXT |
| F-15 | MEDIUM | D | Synthesized dirty.flag lacks base_ts; the next trigger back-dates it only 30s, scoping … | `src/hooks/handlers.ts:64` | GEFIXT |
| F-16 | MEDIUM | D | Unconditional dirty.flag unlink on PASS races a concurrent PostToolUse trigger — cross-… | `src/core/loop-driver.ts:1141` | Duplikat von F-05 (gefixt) |
| F-19 | MEDIUM | E | FP-ledger learns from superseded (retracted) rejections — all lines processed instead o… | `src/core/fp-ledger/learn.ts:48` | GEFIXT |
| F-20 | MEDIUM | E | Reputation books BOTH 'wrong' and 'correct' events for a superseded decision (eid inclu… | `src/core/reputation/learn.ts:71` | GEFIXT |
| F-22 | MEDIUM | E | FpLedger/Brain/Reputation stores treat a transient read I/O error as 'empty' inside a l… | `src/core/fp-ledger/store.ts:67` | GEFIXT |
| F-02 | LOW | D | Defer paths do not reset incomplete_runs, so the "consecutive" review-timeout escalatio… | `src/core/loop-driver.ts:1276` | GEFIXT |
| F-03 | LOW | E | computeRejectRate counts the FIRST decision per finding_id while the decisions-file con… | `src/core/fp-ledger/reject-rate.ts:58` | GEFIXT |
| F-05 | LOW | D | Unconditional dirty.flag unlink on PASS/escalation races a concurrent async trigger rew… | `src/core/loop-driver.ts:1141` | GEFIXT |
| F-08 | LOW | A | Multi-category masking warning is appended before truncation, so it is silently lost ex… | `src/core/aggregator.ts:334` | GEFIXT |
| F-11 | LOW | B | opencode exit-0-unparseable path skips the quota-banner check that codex/claude/gemini … | `src/providers/opencode.ts:127` | GEFIXT |
| F-17 | LOW | C | FileKind "lockfile" is classified but never consumed — dead triage guard, lockfile-only… | `src/research/diff-facts.ts:30` | GEFIXT |
| F-18 | LOW | C | collectChangedFileContents parses tracked names without -z — non-ASCII paths are C-quot… | `src/utils/git.ts:276` | GEFIXT |
| F-21 | LOW | E | computeRejectRate counts the FIRST decision line per finding, not the last — a retracte… | `src/core/fp-ledger/reject-rate.ts:55` | Duplikat von F-03 (gefixt) |
| F-23 | LOW | E | Dead guard: fp-ledger decayPass's 'active -> candidate after 180d' demotion is unreachable | `src/core/fp-ledger/store.ts:208` | GEFIXT |

## Fix-Cluster (Datei-Ownership für parallele Agenten)

- **Cluster A** — Aggregation & Signaturen (src/core/aggregator.ts, src/providers/review-output.ts): F-06, F-07, F-08
- **Cluster B** — Provider-Adapter (src/providers/codex.ts, src/providers/opencode.ts): F-09, F-10, F-11
- **Cluster C** — Diff/Git/Orchestrator (src/utils/git.ts, src/research/diff-facts.ts, src/core/orchestrator.ts): F-01, F-12, F-13, F-14, F-17, F-18
- **Cluster D** — LoopDriver & Hooks (src/core/loop-driver.ts, src/hooks/handlers.ts, src/cli/commands/gate.ts): F-02, F-04, F-05, F-15
- **Cluster E** — Lern-Subsystem (src/core/fp-ledger/**, src/core/reputation/**, src/core/brain/store.ts): F-03, F-19, F-20, F-22, F-23
- **Cluster F** — Brain-Fetcher (src/core/brain/fetcher.ts): F-24

---

## Bestätigte Findings (Details)

### F-06 [HIGH] Non-failing CRITICAL finding yields verdict PASS (severity inversion, bypasses softPassPolicy)

- **Ort:** `src/core/aggregator.ts:629`
- **Cluster:** A (aggregation)

**Beschreibung:**

In the verdict computation (lines 584-630), a CRITICAL finding that does not trip any `fail` branch (non-security/correctness category like architecture/performance/quality, consensus singleton/minority, reviewersTotal >= 2, not claimed-fixed-recurred) only increments `counts.critical` and never feeds the SOFT-PASS tier: the final ladder is `fail||warnFail ? FAIL : warn > 0 ? SOFT-PASS : PASS`. So a lone CRITICAL on a multi-reviewer panel produces verdict "PASS" with counts {critical:1, warn:0} — strictly weaker than a lone WARN, which produces SOFT-PASS. Downstream this matters: LoopDriver (loop-driver.ts:1074-1080) applies `softPassPolicy` ("block"/"ask-once") only to SOFT-PASS and re-arms unconditionally on PASS, so the CRITICAL is never surfaced, never requires a decision, and the gate opens silently even under softPassPolicy:"block". It also makes pending.md internally inconsistent: report-writer renders the finding under "## CRITICAL" with the text "Reviewgate refuses to unblock until every CRITICAL/WARN finding ID has a decision", which is false on a PASS verdict. The existing test (tests/unit/aggregator.test.ts:63-71) only asserts `not.toBe("FAIL")`, so PASS vs SOFT-PASS is unpinned.

**Fix-Vorschlag:**

Make the verdict ladder monotone in severity: a CRITICAL that does not hard-FAIL should at least produce SOFT-PASS, e.g. change line 629 to `else if (warn > 0 || critical > 0) verdict = "SOFT-PASS";` (and include the critical count in the loop-driver SOFT-PASS notification at loop-driver.ts:1184, which currently reports warnCount only). Add a test pinning singleton non-security CRITICAL @ reviewersTotal>=2 to SOFT-PASS.

**Verifikation (adversarialer Check):**

Reproduced live with `bun -e` against src/core/aggregator.ts: a singleton CRITICAL architecture finding with reviewersTotal=3 returns verdict "PASS" with counts {critical:1, warn:0}, while the identical finding at WARN severity returns "SOFT-PASS". Code trace confirms: the verdict loop (aggregator.ts:589-625) only sets `fail` for CRITICAL when security/correctness, majority/unanimous consensus, reviewersTotal<=1, or claimed_fixed_recurred — otherwise it merely increments counts.critical, and the final ladder (627-630) checks only `fail||warnFail` then `warn > 0`, never `critical`. No upstream pass demotes the lone CRITICAL by default (reputation demote requires the reviewer to be in repUnreliable; scope/FP/confidence demotes need their own triggers), and no downstream guard checks counts.critical: loop-driver.ts:1078-1080 computes softPassBlocks only for SOFT-PASS and treats PASS as unconditional gate-open/re-arm, so softPassPolicy "block"/"ask-once" are bypassed and the CRITICAL is never surfaced or decision-gated. The finding stays severity CRITICAL in dedupedFindings, so report-writer.ts:170 renders it under "## CRITICAL ●" with the "refuses to unblock until every CRITICAL/WARN finding ID has a decision" text (line 138) on a PASS report — internally inconsistent. Deliberateness check: the test (tests/unit/aggregator.test.ts:63-71) and the code comment (aggregator.ts:603-605) only pin "must NOT hard-FAIL" (anti-FP); neither pins PASS vs SOFT-PASS. The severity inversion is clearly unintended: the reputation pass demotes the same lone CRITICAL from an UNRELIABLE reviewer to WARN → SOFT-PASS (expected explicitly in docs/superpowers/specs/2026-05-25-reviewer-reputation-design.md:146), meaning a trusted reviewer's lone CRITICAL is treated strictly weaker than both a lone WARN and an unreliable reviewer's identical CRITICAL. Real bug; fix would be feeding non-failing CRITICALs into the SOFT-PASS tier (e.g. `else if (critical + warn > 0) verdict = "SOFT-PASS"`).

### F-09 [HIGH] codex adapter passes the full review prompt as a single argv element — E2BIG on large diffs (same bug class fixed for claude/gemini)

- **Ort:** `src/providers/codex.ts:115`
- **Cluster:** B (providers-spawn)

**Beschreibung:**

CodexAdapter.review() builds `args = ["exec", ..., promptText]` where promptText is the entire prompt file (research.md + house rules + full review-base diff + 32KB file-context + collaborator/referenced sources — multiple MB on a real batch). The claude and gemini adapters were explicitly converted to stdin delivery after the 2026-06-02 shoal 'E2BIG: argument list too long' gate-closed incident (see the comment in claude.ts:102-107 and tests/unit/large-prompt-stdin.test.ts, which covers ONLY claude+gemini), but codex — the DEFAULT PRIMARY reviewer — and opencode were left on argv. On Linux a single argv element is capped at MAX_ARG_STRLEN (128 KiB), and on macOS total argv+env is capped at ~1 MiB, so any moderately large diff makes posix_spawn fail with E2BIG before codex even starts. The failure surfaces as a thrown spawn error → runProvider converts it to a fast status:"error" run → the slot silently fails over to gemini/claude every iteration. Net effect: the strongest reviewer is permanently and silently dropped from the panel on exactly the large/high-risk diffs where it matters most, and the failover masks it (no cooldown is recorded for a fast error, so the futile E2BIG spawn is also re-attempted every turn). codex.complete() at line 294 has the same pattern for judge/critic prompts.

**Fix-Vorschlag:**

Deliver the prompt over stdin like the other adapters: write promptText to a file (review() already has input.promptFile) and pass it via spawnSafely's stdinFile, invoking `codex exec -` (codex reads the prompt from stdin when the positional prompt is `-`). spawnSafely already pipes stdinFile and sends EOF. Apply the same fix to complete(). Verify with a real `codex exec - </tmp/bigprompt` call (per the repo's real-verification rule) and extend tests/unit/large-prompt-stdin.test.ts to cover codex.

**Verifikation (adversarialer Check):**

CONFIRMED real by tracing the full path. (1) codex.ts:241 reads the entire prompt file and codex.ts:115 places it as a single argv element in `args = ["exec", ..., promptText]`; complete() repeats the pattern at codex.ts:294 (opencode.ts:85 likewise). (2) The prompt is the SAME promptFile delivered to claude/gemini, and the project's own E2BIG fix comment (claude.ts:102-107) plus fix commit 1630c1c state it "can be multiple MB" (diff collection is capped only at 16 MiB, spawn-capture.ts:39) — exceeding macOS ARG_MAX (~1 MiB total argv+env) and Linux MAX_ARG_STRLEN (128 KiB per argv element). No upstream size guard exists; the only argv backstop in spawn.ts:116-125 strips NUL bytes. (3) Not a deliberate exclusion: commit 1630c1c (PR #59, the shoal 2026-06-02 gate-closed incident fix) converted ONLY claude.ts and gemini.ts to stdinFile delivery; codex.ts is untouched with no comment/spec/plan rationale, and tests/unit/large-prompt-stdin.test.ts covers only claude+gemini. Codex likely escaped observation in the incident because it was quota-locked at the time. (4) Downstream effect is exactly as claimed: an E2BIG spawn failure rejects spawnSafely (spawn.ts:279 child.on("error", reject)), review() throws, the orchestrator catch (orchestrator.ts ~903-925) yields a fast status:"error" run, and the failover chain silently substitutes gemini/claude every iteration; effectFor treats generic "error" as cooldown-clear so no cooldown suppresses the futile re-spawn. Minor tempering only: the gate does not fail open (failover still produces a review), so impact is the default primary reviewer being silently, systematically dropped from the panel on exactly the large diffs where it matters — consistent with severity "high".

### F-12 [HIGH] Diff-collection failure yields empty diff → triage-skip PASS → change ships unreviewed (fail-open)

- **Ort:** `src/core/orchestrator.ts:500`
- **Cluster:** C (diff-triage)

**Beschreibung:**

When `git diff <base>` times out, spawn-capture returns status:null with (typically) empty stdout, so collectDiff sets out="" (git.ts:198 only keeps stdout when status===0) and appends DIFF_INCOMPLETE_MARKER. computeDiffFacts on a marker-only (or fully empty) diff parses zero files, triageFromFacts returns runReview:false (matrix.ts:52), and orchestrator.runIteration takes the skip branch at orchestrator.ts:500 — returning verdict PASS without ever consulting this.input.diffIncomplete (which is only used inside the reviewer-prompt path at line 1008, never reached here). LoopDriver then treats PASS as a clean cycle: it unlinks dirty.flag (loop-driver.ts:1141) and advances last_reviewed_head_sha, so the change is never re-reviewed. The same happens with NO marker at all for a plain non-timeout git failure (status 128 — corrupt index/object, diff failing on both base and HEAD): out="" and incomplete stays false. Net effect: a hung or failing `git diff` converts directly into a silent unreviewed PASS — the exact fail-open class the incomplete-marker machinery was built to prevent.

**Fix-Vorschlag:**

In the runReview:false skip branch (orchestrator.ts:500), check this.input.diffIncomplete first and return ERROR/fail-closed (or defer like the infra-outage path) instead of PASS when the diff is marked incomplete. Additionally, in collectDiff (git.ts:198) set incomplete=true whenever the tracked diff (and its HEAD fallback) exits non-zero for reasons other than 'no HEAD yet', so a plain git error is not indistinguishable from a genuinely empty diff.

**Verifikation (adversarialer Check):**

Verified every link of the chain in the actual code. (1) git.ts:198 discards stdout on non-zero/null status; a timeout sets incomplete (git.ts:188) and appends the marker (git.ts:257), yielding a marker-only diff; a plain status-128 failure yields a fully empty diff with NO marker. (2) The setup budget (120s, budgets.ts:15) does not intercept: GIT_TIMEOUT_MS=30s per call, worst case ~90s, so collectDiff returns the empty diff inside the budget and the fail-closed setup block (gate.ts:486-489) never fires. (3) matrix.ts:52 returns runReview:false for zero parsed files; the marker contains no 'diff --git' line so computeDiffFacts parses zero files. (4) orchestrator.ts:500-519 returns verdict PASS (source 'skipped') without consulting this.input.diffIncomplete — grep confirms diffIncomplete is only read at orchestrator.ts:1008 (reviewer-prompt path), unreachable from the skip branch; gate.ts:508 does set it correctly for marker-only diffs, so the signal exists but is dropped. (5) loop-driver.ts:1080/1129/1141 treat the PASS as a clean cycle: last_reviewed_head_sha advanced, dirty.flag unlinked, decisions cleared; no special handling of source==='skipped'. (6) Not deliberate: git.ts:182-187 explicitly says a clean verdict on a partial diff is a false reassurance and the marker exists to prevent exactly this; tests only cover prompt injection and marker detection, not the empty-but-incomplete skip. Mitigating notes (don't change the verdict): untracked-file synthesis can partially fill the diff, and a later in-session edit/commit can re-capture the changes — but the failing turn itself ends with GATE OPEN/PASS, unreviewed: a genuine fail-open.

### F-24 [HIGH] pinnedFetch crashes the process (uncaughtException) on any HTTP status outside 101/[200,599] or a missing statusCode

- **Ort:** `src/core/brain/fetcher.ts:336`
- **Cluster:** F (config-schemas-research)

**Beschreibung:**

In pinnedFetch the response is built with `new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers })`. The Web `Response` constructor throws `RangeError: The status provided must be 101 or in the range of [200, 599]` for any other value. Two concrete triggers: (1) an allowlisted upstream returning a non-standard status code (e.g. 999 used by some real CDNs/sites, or a malformed/custom status line — I reproduced the crash live with a server returning `700`), and (2) `res.statusCode` being undefined, where the `?? 0` fallback feeds status 0, which is also out of range. The throw happens inside the `res.on("data")`/`res.on("end")` event-handler callbacks (which call `finish()`), i.e. on a later event-loop tick rather than synchronously inside the awaited promise body. Therefore it surfaces as an `uncaughtException` and escapes BOTH safeFetch's own try/catch (violating its documented 'NEVER throws / always returns a SafeFetchResult' contract) AND the per-lib `try/catch` in context7.ts (fetchLibraryDocs) and enrichProposal. Impact: for the Stop hook the `uncaughtException` backstop in cli/index.ts converts it to a fail-closed block, but it aborts the ENTIRE review over a single weird upstream response; for the `reviewgate doctor` and `review-plan` entry points there is no backstop, so the CLI process crashes. safeApiFetch (research/safe-api-fetch.ts) reuses the same pinnedFetch and is affected identically (Context7 docs fetch).

**Fix-Vorschlag:**

Clamp/validate the status before constructing the Response: capture `const status = res.statusCode; const safe = (typeof status === "number" && (status === 101 || (status >= 200 && status <= 599))) ? status : 502;` and pass `safe`, while preserving the real status for the downstream `!resp.ok`/`http <status>` deny path (e.g. carry the raw code via a header or a separate field). Equivalently, wrap the `new Response(...)` in a try/catch inside `finish()` and `fail(...)` a real Error so safeFetch's contract holds. Add a unit test that drives a raw socket returning status 700 and status 0 and asserts safeFetch resolves `{ ok:false }` instead of throwing.

**Verifikation (adversarialer Check):**

CONFIRMED by live reproduction, not just code reading. (1) Code matches the claim: src/core/brain/fetcher.ts:336 builds `new Response(..., { status: res.statusCode ?? 0, headers })` inside finish(), called from res.on("data")/res.on("end") handlers (lines 347/350) — i.e. on a later event-loop tick outside the promise executor. (2) Reproduced under Bun 1.3.14 (the repo's runtime): a raw TCP server returning `HTTP/1.1 700` + a call to the repo's actual pinnedFetch yields `UNCAUGHT-EXCEPTION: The status provided (700) must be 101 or in the range of [200, 599]`; the try/catch around the awaited pinnedFetch caught nothing and the promise never settled — confirming the throw escapes safeFetch's catch (fetcher.ts:437-453) and violates its documented NEVER-throws contract (fetcher.ts:10). `new Response("x",{status:0})` (the `?? 0` fallback) throws identically. (3) The downstream `!resp.ok → deny` guard at line 481 is unreachable for out-of-range statuses since the Response cannot be constructed. (4) Impact claims verified: the only uncaughtException backstop is in the `gate --hook stop` path (src/cli/index.ts:54-65) → fail-closed block but aborts the entire review; `doctor`/`review-plan` have no backstop → process crash. safeApiFetch (src/research/safe-api-fetch.ts:26/83/102) reuses the same pinnedFetch, so the Context7 path is equally affected. Only mitigation: the trigger needs an allowlisted host (post DNS/IP gates) to emit a non-standard status (e.g. CDN 999), so likelihood is low — but that reduces severity, not realness; no guard or deliberate-design note covers this case.

### F-01 [MEDIUM] Cooldown backoff/reset windows are anchored at panel-START time, so a timed-out reviewer's first backoff window is already expired when recorded

- **Ort:** `src/core/orchestrator.ts:938`
- **Cluster:** C (core-gate)

**Beschreibung:**

`const now = this.input.now?.() ?? new Date()` is captured BEFORE the reviewer panel runs, and that same pre-panel timestamp is passed to `applyCooldownEffects(...)` at line 1212 after the panel settles (potentially many minutes later, up to loop.runTimeoutMs=12min). `QuotaCooldownStore.recordBackoff(provider, now)` computes `reset_at = now + cooldownMs` and `recorded_at = now`. With the default claude-code reviewer timeout of 300s and the first-strike backoff of 5min (BACKOFF_SCHEDULE_MS[0] = 5*60_000), a reviewer that burns its full 300s timeout gets a cooldown whose reset_at ≈ the moment the panel actually finished — i.e. it is already expired (or expires within seconds) when written, so `skipUntil` returns null on the very next turn and the provider re-burns the full wall-clock again. This is exactly the field-reported loop the P4+ escalating backoff was built to stop; the escalation only becomes effective from strike 2 onward, and even then every window is silently shortened by the panel duration (a 720s run cuts the 20min strike-2 window to ~8min). The same skew applies to parsed relative resets: `parseQuotaResetAt(res.statusDetail, now)` anchors "retry after N seconds" at panel start instead of at the time the provider actually emitted the banner, under-cooling by the run duration.

**Fix-Vorschlag:**

Capture a fresh timestamp when applying effects: call `applyCooldownEffects(cooldownStore, effects, this.input.now?.() ?? new Date(), aborted)` (or compute per-effect observation time as panel-start + res.durationMs and thread it through CooldownEffect). Keep the pre-panel `now` only for the skipUntil/quarantine decisions made before spawning.

**Verifikation (adversarialer Check):**

Verified by reading the code. orchestrator.ts:938 captures `now` before the reviewer panel tasks are built (line 965); the panel settles at line 1202 and the same stale `now` is passed to applyCooldownEffects at 1212-1216. quota-cooldown.ts recordBackoff (lines 247-252) computes reset_at = now + cooldownMs and recorded_at = now from that pre-panel timestamp; skipUntil (line 200) compares reset_at against the next turn's fresh clock with no compensation. Defaults confirm the worst case: every reviewer timeoutMs is 300_000 (defaults.ts:10,20,26,37,53) and BACKOFF_SCHEDULE_MS[0] is also 5min, so a full-timeout reviewer (the panel's longest task) gets a strike-1 cooldown that expires at approximately the moment the panel settles — or strictly in the past when the slot then runs its fallback chain sequentially (lines 1145/1185). Strike 1 is therefore inert in the default config, reproducing the field-reported re-burn loop the feature targets, and all later windows (incl. parsed 'retry after N seconds' resets, anchored at panel start via cooldownEffectFor at line 1069) are silently shortened by the run duration. Not deliberate: comments at 935-937 and 296-304 only justify deferred single-writer application and per-apply timestamp sharing, both satisfiable with a fresh clock read at apply time. Minor nit: the claim's 720s strike-2 example would typically be suppressed by the self-deadline abort guard (aborted=true skips recordBackoff, line 335), but non-aborted >300s panels are routine, so the core skew stands.

### F-04 [MEDIUM] absorbPriorDecisions runs AFTER the cost-cap / max-iterations / stuck-signatures preconditions, so the final iteration's FP-ledger + reputation learn signal is permanently lost on those escalations

- **Ort:** `src/core/loop-driver.ts:806`
- **Cluster:** D (core-gate)

**Beschreibung:**

The hoisted `absorbPriorDecisions(state)` call (line 806) lives inside the `if (state.iteration > 0)` block (line 796) and its comment claims it runs "before ANY early-return in this block". But three escalation preconditions early-return BEFORE that block ever starts: cost-cap (line 656), max-iterations / hard-cap (lines 748-763), and stuck-signatures (line 786). When any of them fires, the decisions the agent wrote for the just-completed iteration (decisions/<iter>.jsonl, including reviewer_was_wrong rejections — exactly the cross-cycle FP-ledger/reputation signal absorbPriorDecisions exists to preserve per its own doc comment at lines 1219-1235) are never consumed. The loss is permanent: after the escalation is announced, the next dirty turn hits the post-escalation re-arm (line 625) which resets iteration to 0 and calls clearDecisions(), wiping the file before any later absorb could read it (same for commit-recovery at line 611). The stuck-signatures case is the most likely real occurrence: identical finding sets two iterations in a row typically coincide with the agent having just written rejections for the final round.

**Fix-Vorschlag:**

Hoist the absorbPriorDecisions(state) call above the cost-cap/max-iter/stuck preconditions (right after the dirty-flag/escalation re-arm handling, guarded by state.iteration >= 1) — it is documented idempotent, so calling it earlier is safe.

**Verifikation (adversarialer Check):**

CONFIRMED by direct code trace of /Users/markus/Developer/reviewgate/src/core/loop-driver.ts. (1) absorbPriorDecisions (def 1236, doc 1219-1235) is the ONLY production path into learnFromDecisions/learnReputationFromDecisions (grep-verified), and its sole call site is line 806 inside the `if (state.iteration > 0)` block at line 796. (2) Three escalation preconditions return via escalateAndDecide BEFORE that block: cost-cap (656), max-iterations hard-cap/non-progressing (749/758), stuck-signatures (786). escalateAndDecide/escalate do not learn — escalate's lastDecisionsById read (1490) is report-annotation only (N4). (3) The unfolded decisions provably exist at escalation time: the max-iterations branch itself reads them via computeRejectRate (688-692) with the comment "the fold runs after this check" — then escalates without ever running the fold. (4) The stuck-signatures scenario is realistic: identical signature sets in iters N-1 and N mean the gate blocked after iter N demanding decisions/N.jsonl; the agent writes them (incl. reviewer_was_wrong) and ends turn; the next stop hits the stuck check (777-791) before line 796 and escalates. (5) Loss is permanent: escalateAndDecide unlinks dirty.flag (1442); the next dirty turn triggers the post-escalation re-arm (625-648) which resets iteration to 0 and calls clearDecisions() (645) before any absorb — and absorbPriorDecisions no-ops at iteration<1 anyway (1237); commit-while-escalated (611) also clears. (6) Not deliberate: the doc comment explicitly states the function exists so the signal "survives even when this gate run escalates before reaching a new iteration" (shoal 2026-05-29 = "the worst-case miss"); the hoist comment "before ANY early-return in this block" shows the fix's scope ended at the block boundary, missing the three preconditions outside it. Severity medium is apt — it loses cross-cycle FP-ledger/reputation learn signal, not gate safety.

### F-07 [MEDIUM] Severity leaks into the finding signature when rule_id is missing, breaking cross-iteration signature stability

- **Ort:** `src/providers/review-output.ts:243`
- **Cluster:** A (aggregation)

**Beschreibung:**

`computeSignature({ ruleId: cf.rule_id ?? cf.severity, ... })` uses the finding's SEVERITY as the rule-id ingredient when the reviewer omits rule_id (null), and uses the raw empty string when rule_id is "" (`??` does not catch ""), while the persisted `rule_id` field is normalized to "unspecified" (line 250). Consequences: (1) severity becomes an identity ingredient — when a reviewer re-reports the same issue at a different severity across iterations (a common flip-flop), the signature changes, so cycleRejected suppression, the §4.3 claimedFixed pin, FP-ledger rematching, and stuck-signature detection all miss, re-enabling exactly the recurring-FP re-block loop those mechanisms exist to stop; (2) the signature disagrees with the finding's own rule_id: orchestrator.applySymbolSignatures (orchestrator.ts:1630-1638) recomputes from `f.rule_id` = "unspecified", so the same finding hashes differently depending on whether tree-sitter resolves an enclosing symbol (e.g. unsupported language, top-level code, or the known wasm-missing-in-dist case).

**Fix-Vorschlag:**

Normalize rule_id ONCE before computing the signature and use the same value for both the signature ingredient and the persisted field: `const ruleId = cf.rule_id && cf.rule_id.length > 0 ? cf.rule_id : "unspecified";` then pass `ruleId` to computeSignature and store it as `rule_id`. Never derive the signature from severity.

**Verifikation (adversarialer Check):**

Confirmed by reading the code. review-output.ts:243 uses `cf.rule_id ?? cf.severity` as the signature's ruleId ingredient while line 250 persists `rule_id` as "unspecified" (and `??` indeed misses the empty-string case). The input is reachable: parseReviewOutput casts findings unvalidated and the mapper guard (lines 218-226) never checks rule_id, so claude/agy stdout JSON with absent/empty rule_id flows through (only codex/OpenRouter enforce the strict schema). signature.ts deliberately excludes severity from signature parts and its normalizeRuleId comment documents cross-run signature stability as the design goal (drift previously broke stuck-detection and FP-ledger rematching) — so severity leaking in as identity is contrary to design, and a severity flip on a rule_id-less finding changes the signature, defeating cycleRejected/claimedFixed/FP-ledger/stuck-signature matching, all of which key on exact signature equality. One partial mitigation: applySymbolSignatures (orchestrator.ts:1620-1642) rewrites signatures from f.rule_id="unspecified" when a tree-sitter symbol resolves, removing the severity taint — but only TS/Python grammars exist, top-level code has no enclosing symbol, and enclosingSymbol failures fall back to the tainted mapper signature, so the bug stands for a large class of findings; the mapper-vs-recompute ruleId disagreement (severity or "" vs "unspecified") is also literally true. git log -L shows both lines originate in the same commit with no justifying comment, and no test covers the fallback — not deliberate. Real bug, medium severity is fair: requires reviewer-omitted rule_id plus a severity flip (or symbol-resolution flicker) to manifest, but it silently re-enables exactly the recurring-FP re-block loops those suppression mechanisms exist to stop.

### F-10 [MEDIUM] opencode adapter passes the full review prompt as a single argv element — E2BIG on large diffs

- **Ort:** `src/providers/opencode.ts:86`
- **Cluster:** B (providers-spawn)

**Beschreibung:**

OpenCodeAdapter.review() reads the whole prompt file into memory and does `args.push(promptText)` (line 85-86), passing the multi-MB prompt as the trailing positional argv. Identical E2BIG failure mode to the codex finding: on Linux any prompt over 128 KiB (MAX_ARG_STRLEN), or ~1 MiB total on macOS, makes the spawn fail before opencode starts. Since opencode is typically a fallback/heavy-review provider for exactly the long/large reviews (see the comment at line 96-97), it will fail precisely when it is needed. complete() at line 174 (`args.push(prompt)`) has the same issue for curator/judge prompts.

**Fix-Vorschlag:**

Pass the prompt via spawnSafely's stdinFile if `opencode run` reads its message from stdin when no positional message is given (verify with the real CLI); otherwise chunk via a temp-file flag if the CLI supports one. Mirror the claude/gemini stdin pattern and add opencode to tests/unit/large-prompt-stdin.test.ts.

**Verifikation (adversarialer Check):**

VERIFIED REAL. opencode.ts:85-86 does `readFileSync(input.promptFile)` then `args.push(promptText)`, passing the full review prompt as one argv element; complete() repeats this at line 174. No upstream guard exists: the orchestrator-assembled prompt includes the diff, which is capped only at 16 MiB (spawn-capture.ts:25/39), far above Linux MAX_ARG_STRLEN (128 KiB per arg) and macOS ARG_MAX (~1 MiB total), and spawnSafely passes args verbatim to nodeSpawn (only NUL-stripping). The identical failure was a real production incident for the claude/gemini adapters (E2BIG on multi-MB prompts), fixed in PR #59 by switching them to stdinFile (claude.ts:131, gemini.ts:154) — the same spawnSafely stdinFile mechanism is available but unused in opencode, so this is an omission, not a design decision (no comment/spec documents an argv-size assumption). Since the same per-reviewer promptFile is handed to all panel adapters, opencode receives exactly the prompt sizes that broke claude/gemini, and the in-file comment (lines 96-97: 'heavy fallback for long codex reviews') confirms it is targeted at the large-review case where the spawn will E2BIG before the CLI starts, yielding reviewer ERROR → failover/fail-closed precisely when the fallback is needed. Severity 'medium' is appropriate (degrades to existing error/failover handling rather than fail-open). Note: codex.ts:115 shares the same argv pattern, consistent with the hunter's referenced codex finding.

### F-13 [MEDIUM] Untracked-file `git diff --no-index` failures silently drop files from the review (no `--` separator, exit status ignored)

- **Ort:** `src/utils/git.ts:249`
- **Cluster:** C (diff-triage)

**Beschreibung:**

collectDiff invokes `git diff --no-color --no-index /dev/null <file>` without a `--` separator before the paths. An untracked file whose name begins with `-` (e.g. `-foo.ts`, `--output=x` — perfectly listable by `ls-files --others`) is parsed by git as an option, the command errors with status ≥2 and empty stdout, and the file is silently omitted from the reviewed diff. The code at line 252-253 only inspects d.timedOut/d.truncated/d.stdout; it never distinguishes the expected exit 1 ('differences found') from an exit ≥2 error, so any failing --no-index call (option mis-parse, EACCES on the file, etc.) drops the file without setting `incomplete` — an unmarked under-review. The comment at line 244 ('exits 1 when differences exist — that is expected') shows exit status was considered but error statuses were then ignored entirely.

**Fix-Vorschlag:**

Add `--` before the two paths (`git diff --no-color --no-index -- /dev/null <file>`), and treat d.status other than 0/1 (with no stdout) as incomplete=true so a dropped untracked file is at least surfaced via DIFF_INCOMPLETE_MARKER instead of vanishing silently.

**Verifikation (adversarialer Check):**

VERIFIED REAL by reading the code and reproducing both failure modes with real git.

Code facts (/Users/markus/Developer/reviewgate/src/utils/git.ts):
- Line 247-251: `git(repoRoot, ["diff", "--no-color", "--no-index", "/dev/null", file], ...)` — no `--` separator before the paths. Args go straight to argv via spawnCapture (no shell), so git itself parses a dash-prefixed filename as an option.
- Lines 252-253: only `d.timedOut || d.truncated` set `incomplete`, and stdout is appended if non-empty. `d.status` is never inspected — confirmed by reading the `git()` helper (lines 18-28), which DOES return `status`; this caller just ignores it.
- The only upstream filter (line 217-219) is `s.length > 0 && !isExcludedFromReview(s)` — no guard against leading `-`, no later coverage check elsewhere.

Empirical reproduction:
1. Dash-prefixed file: `git ls-files -z --others --exclude-standard` happily lists `-foo.ts` (verified via xxd). `git diff --no-color --no-index /dev/null -foo.ts` fails with "unknown switch `f'" + usage, exit 129, and the usage text goes to STDERR — captured stdout length is 0. So lines 252-253 see a non-timed-out, non-truncated result with empty stdout: the file is silently omitted from the reviewed diff and `incomplete`/DIFF_INCOMPLETE_MARKER are never set. An unmarked under-review, exactly as claimed.
2. EACCES file: `chmod 000 locked.txt; git diff --no-index /dev/null locked.txt` → "cannot hash locked.txt", exit 128, empty stdout — same silent drop.
3. The fix is trivially available: `git diff --no-color --no-index -- /dev/null -foo.ts` produces the correct new-file diff (the `--` separator IS supported by --no-index).

Refutation attempts that failed: no lock/guard elsewhere handles this; the line number is exact; the comment at line 244 only excuses exit 1 ("differences exist"), it does not justify ignoring exit >=2; nothing downstream cross-checks the diff against the ls-files listing. Severity "medium" is fair: the inputs are edge-case (dash-prefixed or unreadable untracked files) but the consequence is the gate's core invariant violated — a file known to be in scope is dropped from review with no incompleteness marker, the very failure mode the surrounding code (lines 182-188, 205-206, 238-242) goes to great lengths to prevent for timeouts/truncation.

### F-14 [MEDIUM] Hunk-line counter excludes content lines starting with '++'/'--' — real changes can parse as zero-line files and skip review

- **Ort:** `src/research/diff-facts.ts:65`
- **Cluster:** C (diff-triage)

**Beschreibung:**

computeDiffFacts counts added lines with `line.startsWith("+") && !line.startsWith("+++")` (and the mirror for removed). The `+++`/`---` exclusion is meant for the file headers `+++ b/path` / `--- a/path`, but it also matches CONTENT lines: an added source line beginning with `++` (e.g. `++i;`) renders in the diff as `+++i;` and is never counted; a removed line beginning with `--` (SQL/Lua comments `-- foo`, YAML `---` separators) renders as `--- foo` and is never counted. A diff whose every changed line is of this shape (e.g. deleting a commented-out SQL block) produces added=0/removed=0, the file is filtered at line 74, and if it was the only changed file, facts.files is empty → triageFromFacts returns runReview:false → the change passes the gate unreviewed. Less drastically, the undercount skews totalAdded/totalRemoved and thus the N1 small-diff iteration cap in matrix.ts.

**Fix-Vorschlag:**

Exclude only true headers: use `!line.startsWith("+++ ")` / `!line.startsWith("--- ")` (headers always have a space or tab after the marker), or better, only treat `+++`/`---` lines as headers when not inside a hunk (track @@ state).

**Verifikation (adversarialer Check):**

Empirically reproduced, not just code-read. (1) The cited lines are exact: src/research/diff-facts.ts:65-66 counts added lines via startsWith("+") && !startsWith("+++") and the mirror for removed; this excludes CONTENT lines beginning with ++/-- (a removed `-- sql comment` renders as `--- sql comment`, an added `++i;` as `+++i;`). Confirmed with a real `git diff` of a .sql file deleting comment lines, then running the actual computeDiffFacts on that diff: files:[], totalAdded:0, totalRemoved:0. (2) The fail-open chain holds with no intervening guard: diff-facts.ts:74 drops the zero-count file; matrix.ts:52-64 returns runReview:false for empty files (verified by executing triageFromFacts on the repro facts → riskClass "trivial", runReview false); orchestrator.ts:470 calls refineTriage with llm:null which "can only narrow" (cannot re-enable review); orchestrator.ts:500-518 returns an immediate PASS with zero reviewers, so LoopDriver allows the stop and the change passes the gate unreviewed. (3) Aggravating: sensitivityTags are computed after the filter (diff-facts.ts:75-76), so even the .sql "sensitive" tag is lost in the repro. (4) The filter's own comment (lines 68-73) assumes dropped entries are renames/binary/mode-only with "zero reviewable lines" — the miscount violates that premise, so this is not deliberate behavior. The secondary claim (skewed N1 small-diff cap via totalAdded/totalRemoved vs SMALL_DIFF_LINES=30 in matrix.ts) is also correct. Trigger inputs (SQL/Lua comment blocks, YAML --- separators, C/C++ ++i;/--i; lines) are realistic; the total-bypass requires all changed lines in all changed files to have this shape, consistent with medium severity.

### F-15 [MEDIUM] Synthesized dirty.flag lacks base_ts; the next trigger back-dates it only 30s, scoping batch-created untracked files out of the re-review

- **Ort:** `src/hooks/handlers.ts:64`
- **Cluster:** D (diff-triage)

**Beschreibung:**

handleTrigger preserves base_sha and base_ts from an existing dirty.flag, but when base_ts is absent it stamps `now − 30s` as if this were the batch's first edit. The two flag-synthesis paths — consumeDeferredFlag (gate.ts:275-283) and the HEAD-advanced path (gate.ts:418-426) — both write a dirty.flag containing base_sha but NO base_ts. Sequence: flag is synthesized (review base = last reviewed sha, possibly hours old), the gate blocks on findings, the agent makes a fix edit → handleTrigger preserves the old base_sha but stamps base_ts = fix-time − 30s. The re-review's collectDiff mtime/ctime gate (git.ts:229-235) then excludes every untracked file created during the batch more than 30s before that fix edit — files that WERE in the first review's scope (the first run used reviewBaseTs=null) and may carry the very findings being 're-verified'. The committed side of the diff keeps the old base while the untracked side silently narrows: inconsistent scope and a silent under-review.

**Fix-Vorschlag:**

Make the synthesized flags carry an explicit base_ts (e.g. the last-review timestamp, or an epoch-0 sentinel meaning 'no untracked scoping'), or in handleTrigger only stamp a fresh base_ts when base_sha was ALSO freshly captured — never pair an old base_sha with a new base_ts.

**Verifikation (adversarialer Check):**

Verified by reading all three cited locations. (1) Both dirty.flag synthesis paths — consumeDeferredFlag (gate.ts:275-283) and the HEAD-advanced path (gate.ts:418-425) — write base_sha but no base_ts; a grep confirms no other writer exists (LoopDriver only unlinks the flag). (2) The first review after synthesis therefore runs with reviewBaseTs=null (gate.ts:387-389), deliberately including ALL untracked files (comment at gate.ts:379-380 says this is correct). (3) When that review blocks and the agent makes any fix edit (or even the decision-JSONL Write, which also fires PostToolUse), handleTrigger (handlers.ts:50-64) preserves the old base_sha but finds base_ts absent and stamps now−30s — code whose design comments (lines 24-33, 45-48) state base_ts must be the batch's clean→dirty transition, which this trigger is not (the flag already existed). (4) The re-review's collectDiff (git.ts:229-232) then skips every untracked file with max(mtime,ctime) < fix-time−30s, deliberately WITHOUT setting the incomplete marker, so untracked files created during the batch (in iteration 1's scope, possibly carrying the findings under re-verification — e.g. a rejected finding's file that the fix never touched) silently vanish from the re-review while the committed-side diff keeps the old base. No guard elsewhere corrects or re-nulls base_ts (resolveReviewBase only fixes the sha side). The scenario is concretely reachable via the HEAD-advanced path (Bash-only work creating untracked files + commits, review FAILs, fix edit >30s after file creation). Real bug: inconsistent review scope and silent under-review on re-review iterations after flag synthesis. Severity medium is appropriate.

### F-16 [MEDIUM] Unconditional dirty.flag unlink on PASS races a concurrent PostToolUse trigger — cross-session edits flagged mid-review are silently dropped

- **Ort:** `src/core/loop-driver.ts:1141`
- **Cluster:** D (diff-triage)
- **Duplikat von:** F-05 (unabhängig gefunden — Beschreibung kann zusätzliche Details enthalten)

**Beschreibung:**

On PASS the LoopDriver unconditionally unlinks dirty.flag. handleTrigger (hooks/handlers.ts) deliberately takes no gate lock (PostToolUse must be fast), so in the supported multi-session-on-one-checkout setup (M-A1 comments) session B can edit and atomically rewrite dirty.flag AFTER session A's gate collected its diff but BEFORE A's PASS unlinks the flag. The unlink destroys B's fresh flag even though B's edit was never part of A's reviewed diff. If B then stops without further edits, stopHasNothingToReview sees no dirty.flag and an unchanged HEAD (B's change is uncommitted working-tree; A's PASS set last_reviewed_head_sha to the same HEAD) → allow_stop → B's change is never reviewed. The deferred.flag mechanism does not engage because B's stop encounters no lock contention. Note the unlink compares nothing: the flag's `ts`/`diff_hash` (written precisely to identify the batch) are ignored at deletion time.

**Fix-Vorschlag:**

Before unlinking on PASS, re-read the flag and only delete it if its `ts` predates the moment the reviewed diff was collected (or its diff_hash matches the one captured at gate start); if it was rewritten mid-review, keep it so the next stop re-reviews the newer edits.

**Verifikation (adversarialer Check):**

Refutation attempt failed; the bug is real. (1) handleTrigger is lock-free by design: runGate returns for hook==="trigger" at gate.ts:203-206 before the flock at :236, so a parallel session B can atomically rewrite dirty.flag at any time during session A's review. (2) A's diff is frozen at setup (gatherReviewContext, gate.ts:479) before the multi-minute reviewer panel runs, so B's mid-panel edit is not in A's reviewed diff. (3) On PASS, loop-driver.ts:1141 unconditionally unlinkSync's dirty.flag — the flag read at line 553 is never re-read, and its ts/diff_hash are never compared before deletion (diff_hash is written in handlers.ts:66 and compared nowhere in src), so B's fresh flag is destroyed. (4) No guard rescues B: deferred.flag only gets written on FlockTimeoutError at a contended stop (gate.ts:123-146), but B stops after A released the lock; stopHasNothingToReview (gate.ts:157-173) then sees no deferred.flag, no dirty.flag, and last_reviewed_head_sha == HEAD (set by A's PASS at loop-driver.ts:1129; B's edit is uncommitted so HEAD is unchanged) → allow_stop, and the HEAD-advance synthesis path (gate.ts:404-414) never fires. B's change ships unreviewed. (5) Not deliberate: multi-session-on-one-checkout is explicitly supported (gate.ts:148-156 M-A1 comments), and the M-A2 comment at gate.ts:256-259 ("never delete it with no dirty.flag left, or the deferred review is permanently lost") shows the codebase explicitly treats silently dropping a flagged change as a CRITICAL bug class — this unlink path violates that same eventual-review guarantee. Scope caveats match the medium severity: edits before diff collection are over-reviewed (safe), later edits re-create the flag, and commits are caught by HEAD-advance; but the unguarded window spans the entire multi-minute panel run, so the loss is realistic. A correct fix would be compare-and-delete (only unlink if the flag's ts/content still match what the gate read at run start).

### F-19 [MEDIUM] FP-ledger learns from superseded (retracted) rejections — all lines processed instead of last-wins

- **Ort:** `src/core/fp-ledger/learn.ts:48`
- **Cluster:** E (state-concurrency)

**Beschreibung:**

learnFromDecisions iterates EVERY valid line of decisions/<iter>.jsonl and records an FP reject for each rejected+reviewer_was_wrong line. But the decisions file is append-only and supersession is an explicitly supported protocol: loop-driver.ts's priorIterationDecisionSignatures (line 128-134) and the claimed-fixed reconcile (line 821-830) both implement LAST-wins because 'the append-only decisions file may carry a superseding disposition for a finding within an iteration; the fold reflects the agent's MOST RECENT intent'. Both 'rejected' and 'accepted' lines for the same finding_id are individually schema-valid (DecisionEntrySchema is a discriminated union). So when the agent first rejects a finding and later (same iteration, e.g. after a re-block) supersedes it with accepted/fixed, learn.ts still books a permanent FP reject into known_fp.jsonl for a rejection the agent retracted. Over recurring cycles this marches the signature toward stage active/sticky (>=3 rejects, >=2 providers), at which point the FP-ledger DEMOTES future occurrences of a finding the agent actually accepted as real — suppressing a genuine finding.

**Fix-Vorschlag:**

Fold the decisions file to last-wins per finding_id first (reuse the lastDecisionsById/Map pattern from loop-driver.ts) and only record a reject when the FINAL disposition for that finding is rejected+reviewer_was_wrong.

**Verifikation (adversarialer Check):**

CONFIRMED. learn.ts:37-48 processes EVERY valid rejected+reviewer_was_wrong line of decisions/<iter>.jsonl with no per-finding_id last-wins fold; FpLedgerStore.recordReject (store.ts:95-159) is append-only with only (run_id,provider) idempotency and no retraction API. Supersession within one iteration file is an explicitly supported reality, not hypothetical: loop-driver.ts:130-132 documents that "the append-only decisions file may carry a superseding disposition for a finding within an iteration; the fold reflects the agent's MOST RECENT intent", and the decisions-gate re-blocks across multiple stops of ONE iteration (loop-driver.ts:821-827), so rejected-then-accepted pairs for the same finding_id (both individually schema-valid under the discriminated union) do occur. Every sibling consumer of the same file implements last-wins: priorIterationDecisionSignatures (loop-driver.ts:183-195), foldDecisions (~312, "last line for an id wins"), and the §4.3 claimed-fixed reconcile (821-835) — the latter two pinned by tests (loop-driver.test.ts:2203, 2263). Notably priorIterationRejectedSignatures (line 813) correctly EXCLUDES a superseded rejection from cycle suppression via last-wins, while learnFromDecisions — fed the identical file at loop-driver.ts:806 — books it permanently into known_fp.jsonl. No test in tests/unit/fp-ledger-learn.test.ts covers superseded rejections and no comment/spec justifies all-lines processing, so the behavior is not deliberate. Impact path verified: run_id is unique per (session,cycle,iter), so recurring retracted rejections accumulate toward the ≥3-reject/≥2-provider active stage (a consensus-clustered finding with members from 2 providers meets the provider quorum from one retracted rejection), after which the ledger demotes future occurrences of a finding whose final disposition was accepted. Caveat (doesn't refute): for multi-stop supersedes an early absorb may book the reject before the superseding line is written, so a last-wins fold in learn.ts fixes the within-turn case but the cross-stop case would need retraction; also src/core/reputation/learn.ts:30-55 shares the same all-lines flaw (books both "wrong" and "correct" for a superseded pair), corroborating a shared oversight. Medium severity is fair — requires repeated reject-then-retract on the same signature to cause real suppression, but each occurrence records an objectively wrong permanent learning signal.

### F-20 [MEDIUM] Reputation books BOTH 'wrong' and 'correct' events for a superseded decision (eid includes verdict)

- **Ort:** `src/core/reputation/learn.ts:71`
- **Cluster:** E (state-concurrency)

**Beschreibung:**

learnReputationFromDecisions also iterates all valid lines (no last-wins fold). A finding first rejected (reviewer_was_wrong) and later superseded to accepted produces two events for the same reviewerKey: one outcome:'wrong' and one outcome:'correct'. The idempotency eid is `${sessionId}:${cycleSeq}:${iter}:${d.finding_id}:${d.verdict}:${reviewerKey}` — it deliberately includes the verdict, so the eid dedup in ReputationStore.record does NOT collapse the contradictory pair; both events persist permanently in the correct[] and wrong[] buckets of reputation.json. The agent's retracted rejection therefore permanently debits the reviewer's trust score even though the agent's final disposition validated the finding (and simultaneously credits it, diluting the signal both ways). This contradicts the last-wins supersession semantics implemented in loop-driver.ts lines 128-203.

**Fix-Vorschlag:**

Compute the last-wins DecisionEntry per finding_id before deriving events, so exactly one outcome per (finding, reviewerKey, iter) is recorded — matching the agent's final intent. The eid can then drop the verdict component (or keep it; with last-wins only one verdict per finding per iter is ever emitted).

**Verifikation (adversarialer Check):**

Verified, not refuted. (1) src/core/reputation/learn.ts:30-75 iterates every valid line of decisions/<iter>.jsonl with no per-finding_id last-wins fold; a rejected(reviewer_was_wrong)-then-accepted pair for the same finding emits both outcome:'wrong' and outcome:'correct' events. (2) The eid at learn.ts:71 includes d.verdict, and ReputationStore.record (store.ts:66-74) dedups by eid within each bucket only, so both events persist into wrong[] and correct[] of reputation.json (pruned only after ~6 half-lives ≈ 270 days). (3) The superseding input is real and explicitly supported: loop-driver.ts:128-134/172-173/291 implement LAST-wins per finding_id precisely because "the append-only decisions file may carry a superseding disposition for a finding within an iteration; the fold reflects the agent's MOST RECENT intent", and the fix-verification spec (docs/superpowers/specs/2026-06-02-fix-verification-design.md:52-70) plus loop-driver.ts:823-827 even purge superseded fixed-claims from persisted state — proving stale pre-supersession bookings in persistent state are treated as bugs elsewhere in this codebase. (4) No normalizer rewrites the decisions file before absorbPriorDecisions (loop-driver.ts:1236-1266) invokes the learner. Refutation attempts failed: the "one JSON line per finding" protocol does not preclude supersession (the gate's own code anticipates it, e.g. the within-iteration decision-gate retry path), and nothing in learn.ts or the reputation design spec marks the all-lines iteration as deliberate — the spec's verdict-in-eid exists for re-stop idempotency, not contradictory-verdict collapsing. Net effect as claimed: a retracted rejection permanently debits (and the supersede simultaneously credits) the reviewer's trust, diluting the reputation signal contrary to last-wins semantics. Medium severity is apt: corrupts the demote/quarantine learning signal but does not change gate verdicts directly.

### F-22 [MEDIUM] FpLedger/Brain/Reputation stores treat a transient read I/O error as 'empty' inside a locked mutate, then atomically persist the wipe

- **Ort:** `src/core/fp-ledger/store.ts:67`
- **Cluster:** E (state-concurrency)

**Beschreibung:**

FpLedgerStore.snapshot() catches ANY error (not just SyntaxError/ZodError) and returns EMPTY: a transient readFileSync failure (EBUSY, EACCES, AV lock, network FS) on an existing known_fp.jsonl is indistinguishable from corruption. mutate() (line 80-93) then runs fn(EMPTY) and persist()s the result, atomically replacing the entire ledger with a near-empty file — all accumulated FP rejects/stages are destroyed by one momentary read failure that happens to coincide with a write. The exact same pattern exists in BrainStore.snapshot (src/core/brain/store.ts:42-44, consumed by mutate at :58) wiping brain.json, and ReputationStore.snapshot (src/core/reputation/store.ts:54-56, consumed by record at :65) wiping reputation.json. This is precisely the failure mode StateStore.loadOrRecover (src/core/state-store.ts:35-42) deliberately guards against, with the comment 'a transient I/O error must NOT be misread as corruption — wiping the gating history on a momentary read failure is far worse than failing loudly' — but the three learning stores never received that fix.

**Fix-Vorschlag:**

In each store's snapshot()/read path, only fall back to EMPTY on SyntaxError/ZodError (genuine content corruption, ideally with a .corrupt backup like StateStore); rethrow raw fs errors so mutate()/record() fails loudly instead of persisting an empty index. Callers already .catch() learn-path failures, so a throw degrades to 'no learning this round' rather than data loss.

**Verifikation (adversarialer Check):**

Verified by reading all four files. FpLedgerStore.snapshot (src/core/fp-ledger/store.ts:65-69), BrainStore.snapshot (src/core/brain/store.ts:40-44), and ReputationStore.snapshot (src/core/reputation/store.ts:52-56) each wrap readFileSync+parse in a bare `catch` that returns an empty index, so a transient I/O error (EACCES, EMFILE under heavy subprocess spawn, EIO, EBUSY/AV, network FS) on an existing file is indistinguishable from corruption. Each store's locked mutator (fp-ledger mutate :80-93, brain mutate :53-66, reputation record :59-90) then runs the mutation on the empty snapshot and atomically rename-persists the result, permanently replacing the accumulated ledger/brain/reputation with a near-empty file — no retry, no backup, no error surfaced. The flock only serializes writers; it cannot prevent the read fault, and the fault needs no concurrent writer. The behavior is not deliberate: state-store.ts loadOrRecover (:35-42) was explicitly fixed to recover ONLY on SyntaxError/ZodError and rethrow I/O errors, with a comment naming this exact failure mode ('a transient I/O error must NOT be misread as corruption'); the three learning stores never received that fix. Medium severity is fair: low trigger probability but silent, unrecoverable loss of self-learning state that weakens subsequent gate runs.

### F-02 [LOW] Defer paths do not reset incomplete_runs, so the "consecutive" review-timeout escalation can fire across non-consecutive runs

- **Ort:** `src/core/loop-driver.ts:1276`
- **Cluster:** D (core-gate)

**Beschreibung:**

The state schema documents `incomplete_runs` as "Reset to 0 whenever a review actually completes (any verdict)", and the normal state update (line 1123) does reset it. But `handleAllQuotaLocked` (line 1276) and `handleInfraUnavailable` (lines 1335-1341) return early and update state WITHOUT resetting `incomplete_runs`, even though in both cases runIteration genuinely completed (verdict ERROR). Sequence: turn 1 self-deadline timeout → incomplete_runs=1, block; turn 2 completes but all reviewers quota-capped → defer, incomplete_runs stays 1; turn 3 timeout → incomplete_runs=2 ≥ MAX_CONSECUTIVE_INCOMPLETE_RUNS → escalates "review-timeout … for 2 consecutive runs" although the timeouts were not consecutive (a completed run sat between them). The escalation fires earlier than designed and its message is factually wrong.

**Fix-Vorschlag:**

Add `incomplete_runs: 0` to the state.update in both handleAllQuotaLocked and handleInfraUnavailable (the run completed; only a genuinely incomplete run should extend the streak).

**Verifikation (adversarialer Check):**

Confirmed by reading the code. The schema (src/schemas/state.ts:102-106) explicitly documents incomplete_runs as "Reset to 0 whenever a review actually completes (any verdict)", and the normal state update (loop-driver.ts:1121-1123) honors this. But both defer paths return early BEFORE that update: handleAllQuotaLocked (line 1276-1278) writes only last_stop_ts, and handleInfraUnavailable's bounded-defer (lines 1335-1341) writes only consecutive_infra_defers + last_stop_ts — in both cases runIteration genuinely completed (verdict ERROR), yet incomplete_runs is preserved via ...cur. With MAX_CONSECUTIVE_INCOMPLETE_RUNS=2 (line 40), the sequence timeout (incomplete_runs=1, dirty flag kept) → quota-locked defer (counter preserved, dirty flag deliberately kept) → timeout (1+1=2) escalates "review-timeout … for 2 consecutive runs" (line 1381) despite a completed run between the timeouts. Reachable in practice: a timed-out provider enters escalating-backoff cooldown, so the next turn can be all-quota/cooldown-capped. Refutation angles checked: the only other resets (lines 592, 637) are escalation-recovery paths that don't apply; no comment marks the preservation as deliberate; and a misconfig ERROR with zero reviews DOES reset the counter while a quota ERROR with zero reviews doesn't — an inconsistency incompatible with design intent. Severity low is fair: impact is a premature escalation with a factually wrong message, not a fail-open.

### F-03 [LOW] computeRejectRate counts the FIRST decision per finding_id while the decisions-file contract everywhere else is LAST-wins — a superseded rejection permanently inflates the FP-streak and reject-rate escalations

- **Ort:** `src/core/fp-ledger/reject-rate.ts:58`
- **Cluster:** E (core-gate)

**Beschreibung:**

`if (!allowed.has(id) || seen.has(id)) continue;` makes the first valid line per finding_id win. But the decisions file is append-only with a documented supersede semantics: loop-driver.ts:128-134 / 172-176 (priorIterationDecisionSignatures, priorAdjudications, lastDecisionsById) all deliberately implement LAST-wins because "the append-only decisions file may carry a superseding disposition for a finding within an iteration". If the agent first appends `{F-001 rejected, reviewer_was_wrong:true}` and later supersedes with `{F-001 accepted, action:"fixed"}` (the documented pattern across re-blocks of one iteration), computeRejectRate still counts F-001 as a wrongReject. That inflates rr.rate for the reject-rate-high escalation (loop-driver.ts:900), inflates `cumulative_fp_rejects` for the reviewer-fp-streak escalation (loop-driver.ts:922) — which is an ALLOW-stop escalation, i.e. it un-arms the gate — and skews the FP-discounted convergence override `latestWrong` (loop-driver.ts:689). Meanwhile the per-cycle suppression set correctly does NOT suppress the signature (last-wins says it wasn't rejected), so the two views of the same file disagree.

**Fix-Vorschlag:**

Fold to last-valid-decision-per-id first (same lastById map as the sibling readers in loop-driver.ts), then count totals/wrongRejects over that map instead of first-wins line iteration.

**Verifikation (adversarialer Check):**

Verified at the cited locations. reject-rate.ts:55-58 implements first-valid-line-wins per finding_id (`seen.has(id)` skip), so the first line's verdict is what gets classified as wrongReject. The decisions file's supersede contract is last-wins, explicitly documented and implemented three times in loop-driver.ts: priorIterationDecisionSignatures (lines 128-134/172-176, comment: "LAST-wins because the append-only decisions file may carry a superseding disposition for a finding within an iteration... reflects the agent's MOST RECENT intent"), priorAdjudications (line 271), and lastDecisionsById (lines 286-312). So the superseded-rejection input (rejected w/ reviewer_was_wrong, later superseded by accepted/fixed in the same iteration file) is a pattern the codebase itself anticipates. Under first-wins it is still counted as a confirmed reviewer FP, inflating rr.rate for the reject-rate-high escalation (loop-driver.ts:895-909), cumulative_fp_rejects/fp_rejects_history for the reviewer-fp-streak escalation (lines 922-945), and latestWrong in the convergence override (line 690) — while the last-wins suppression reader correctly does NOT suppress that signature, so two readers of the same file disagree. I checked for a deliberate-design defense: the comments in reject-rate.ts justify only the per-id dedup (anti-padding) and single-iteration scope; first-wins provides no security benefit over last-wins (same author, same once-per-real-id cap), so the ordering is incidental, not deliberate. No guard elsewhere reconciles the verdict. Severity low is accurate: narrow trigger (intra-iteration disposition flip) and bounded impact (counter inflation → possible premature escalation, including the allow-stop fp-streak path, plus convergence skew).

### F-05 [LOW] Unconditional dirty.flag unlink on PASS/escalation races a concurrent async trigger rewrite — a flag re-written mid-review is deleted unreviewed

- **Ort:** `src/core/loop-driver.ts:1141`
- **Cluster:** D (core-gate)

**Beschreibung:**

The flag is read once at run start (line 553) but `unlinkSync(dirtyFlagPath(...))` on PASS (line 1141) and in escalateAndDecide (line 1442) deletes whatever is on disk at that moment without comparing it to the flag content the review was based on. The PostToolUse trigger is registered `async: true` and is NOT serialized by the gate lock, so during a multi-minute panel a parallel session's Edit (or a laggard async trigger) can atomically replace dirty.flag with a NEW batch (new base_sha/base_ts) whose diff this review never saw; the PASS then unlinks it, and the other session's next Stop takes the stopHasNothingToReview fast path (gate.ts:157, no flag + HEAD unchanged) and ends its turn unreviewed. The damage mostly self-heals later (uncommitted edits are re-covered by the next trigger's working-tree diff; committed work by the HEAD-advanced synthesis at gate.ts:394), but the per-turn review guarantee is broken for that turn, and the escalation-path unlink loses the new batch's captured base_sha/base_ts (a later trigger re-captures base as the CURRENT HEAD, which may already contain unreviewed mid-batch commits).

**Fix-Vorschlag:**

Re-read the flag before unlinking and only delete it if its `ts`/`diff_hash` still match the flag captured at run start (the atomic-rename writer makes this a cheap compare-and-delete); leave a newer flag in place so the next stop reviews it.

**Verifikation (adversarialer Check):**

Verified by tracing the code. (1) The PostToolUse trigger is registered async:true (src/cli/commands/init.ts:23) and gate.ts:203-204 runs handleTrigger without ever taking the gate lock — only the stop path locks (gate.ts:236). (2) LoopDriver reads dirty.flag once at run start (loop-driver.ts:553) and the diff is collected once per gate invocation; on PASS loop-driver.ts:1141 (and escalateAndDecide loop-driver.ts:1442) unconditionally unlinkSync's the flag with no diff_hash/ts comparison — grep confirms no code validates flag freshness before deletion. (3) A parallel session's edit during the multi-minute panel rewrites the flag (handlers.ts:74-78 atomic rename); the PASS unlink deletes it; that session's next Stop hits stopHasNothingToReview (gate.ts:157-171: no flag + HEAD unchanged → allow_stop) and ends unreviewed. (4) The only cross-session guard, consumeDeferredFlag (gate.ts:260-298), covers only the lock-contention-Stop ordering (deferred marker), not the edit-mid-review/stop-after-PASS ordering — and its comments show the eventual-review guarantee is intended, with no comment at 1141 accepting this TOCTOU. One detail in the claim is wrong but non-fatal: a mid-review trigger PRESERVES base_sha/base_ts when the flag exists (handlers.ts:50-64), so the deleted flag has the same base, not a new one; a new-base flag only appears from a laggard trigger after the unlink, and that one survives to be reviewed. The core bug — unconditional unlink races a concurrent async trigger and breaks the per-turn review guarantee for the other session's turn, with the escalation-path unlink additionally losing the captured base for mid-batch commits (partially recovered by the HEAD-advanced synthesis at gate.ts:394+) — is real. Severity low is appropriate (requires shared-checkout multi-session; self-heals on next trigger).

### F-08 [LOW] Multi-category masking warning is appended before truncation, so it is silently lost exactly when details are long

- **Ort:** `src/core/aggregator.ts:334`
- **Cluster:** A (aggregation)

**Beschreibung:**

When a cluster merges multiple categories, the "⚠ This finding merges concerns categorized as: ..." warning (line 330) and the "Also reported by other reviewers" wordings (line 324) are appended to `sample.details` and the combined string is then truncated with `details.slice(0, 2000)` (line 334). A representative whose details are already at/near the 2000-char schema cap truncates the appended material first — i.e. the masking guard (whose purpose is to stop one decision silently disposing several concerns) disappears precisely on long-detail findings. Every other note-appending site in this file deliberately truncates the ORIGINAL and preserves the note (scopeFindings demote() line 206-209, confidence demote line 517-524, reputation demote lines 562-579), so this site contradicts the established invariant.

**Fix-Vorschlag:**

Mirror the demote() pattern: build the appended suffix first, then `details = sample.details.slice(0, 2000 - suffix.length) + suffix` so the masking warning (and at least a truncated other-reviewer list) always survives the cap.

**Verifikation (adversarialer Check):**

Confirmed by reading the code. aggregator.ts:322-331 appends the "Also reported by other reviewers" wordings and the multi-category masking warning AFTER sample.details, then line 334 truncates the combined string from the end with details.slice(0, 2000). FindingSchema (src/schemas/finding.ts:31) permits details up to exactly 2000 chars, so a representative at/near the cap loses the appended warning entirely while keeping its original details — the masking guard disappears exactly on long-detail findings. The file's own established invariant is the opposite: line 203's comment says "truncate the original" and lines 208, 524, 568, 579 all use f.details.slice(0, 2000 - note.length) + note to preserve the note. No redundancy exists: report-writer.ts never renders members, so pending.md's details field is the only agent-visible channel for the merged-categories warning. Surrounding comments (lines 320, 326-328) state the intent is that nothing be lost on merge, so the asymmetry is not deliberate. Low severity is accurate (degraded warning, not verdict/state corruption), but the bug is real.

### F-11 [LOW] opencode exit-0-unparseable path skips the quota-banner check that codex/claude/gemini all have (F-043 gap) — capped provider is re-burned every iteration

- **Ort:** `src/providers/opencode.ts:127`
- **Cluster:** B (providers-spawn)

**Beschreibung:**

When opencode exits 0 but stdout is not parseable review JSON, review() returns status:"error" unconditionally. The codex (codex.ts:183), claude (claude.ts:178) and gemini (gemini.ts:210) adapters all check isQuotaExhausted() on this same path (the F-043 fix) because several CLIs print their quota/usage-limit banner and still exit 0. For opencode, a quota banner on an exit-0 run is therefore classified as a generic fast error: cooldownEffectFor() returns null for a fast "error" (inconclusive), so no cooldown is recorded and the capped provider is re-attempted — burning its full attempt — on every subsequent review instead of being cooled down and skipped, and the orchestrator's allReviewersQuotaLocked infra-defer classification (orchestrator.ts:1289-1290) is also defeated when opencode is the last provider standing (a quota outage reads as a misconfig hard-block instead of a bounded defer).

**Fix-Vorschlag:**

Mirror the other three adapters: in the `!out` branch compute `const quota = isQuotaExhausted(stdout + errText)` and return status "quota-exhausted" with a matching statusDetail when it is true (keep the generic "error" otherwise).

**Verifikation (adversarialer Check):**

Verified by reading the code. opencode.ts review(): the exit-0-but-unparseable branch (lines 127-141) returns status:"error" unconditionally (line 139); the adapter's only isQuotaExhausted check (line 107) is gated on baseStatus==="error" i.e. exit!=0, so it cannot fire on the exit-0 path. The three sibling adapters all check quota on exactly this path, each with explicit F-043 comments: codex.ts:178-201 ("usage-limit banner lands on exit 0 here, not the exit!=0 path above"), claude.ts:171-191, gemini.ts:202-223 — and tests/unit/gemini-adapter.test.ts:183 tests this F-043 path, while the opencode test file has no such test. Downstream consequences confirmed: (1) orchestrator.ts cooldownEffectFor (lines 277-293) returns null for a fast "error" (deliberately inconclusive) — so no cooldown is recorded and the capped opencode is re-attempted at full cost every iteration; even a slow error only gets a generic default backoff, never the parsed reset time a quota-exhausted status carries. (2) orchestrator.ts:1289-1290 allReviewersQuotaLocked requires settled.every(status === "quota-exhausted"); an opencode "error" defeats it, turning a pure quota outage into a misconfig hard-block instead of the bounded infra-defer. No compensating guard exists — the orchestrator keys exclusively off the adapter-set status and never re-scans statusDetail/output for quota signals. Nothing marks the omission deliberate (this codebase comments deliberate divergences heavily, e.g. opencode's -m sentinel comment; claude.ts even says "matching codex/opencode's fail-closed behavior" while adding the quota refinement opencode lacks). The claimed input (quota banner on an exit-0 run) is the exact pattern F-043 fixed on three other agentic CLIs of the same class, and opencode's own exit!=0 quota check shows the author treats it as quota-banner-capable. Severity "low" is fair: opencode is usually a fallback and the exit-0 banner behavior for opencode specifically isn't field-proven, but the logic gap and its consequences are concretely reproducible from the code.

### F-17 [LOW] FileKind "lockfile" is classified but never consumed — dead triage guard, lockfile-only diffs run the full default panel

- **Ort:** `src/research/diff-facts.ts:30`
- **Cluster:** C (diff-triage)

**Beschreibung:**

classify() detects package-lock.json/pnpm-lock.yaml/bun.lock(b)/yarn.lock and returns kind "lockfile", but no code anywhere consumes that kind: triageFromFacts (matrix.ts) only branches on files.length, docOnly, sensitivityTags, and testsOnly. A regenerated-lockfile-only diff (thousands of machine-generated lines) is therefore neither doc-skipped nor tier-reduced — it triages as riskClass "default" with the standard budget, and its line count also defeats the small-diff cap. The classification is a dead guard whose evident intent (special-casing lockfile churn) never took effect.

**Fix-Vorschlag:**

Either consume the kind in triageFromFacts (e.g. lockfile-only → minimal tier or skip, mixed → exclude lockfile lines from the small-diff line count), or delete the dead "lockfile" branch so the classifier doesn't imply behavior that doesn't exist.

**Verifikation (adversarialer Check):**

Verified by tracing the code. (1) classify() at src/research/diff-facts.ts:29-31 does return kind "lockfile" for the four lockfile names. (2) Repo-wide grep confirms the ONLY consumer of DiffFile.kind outside diff-facts.ts is research-writer.ts:125, a display-only interpolation into research.md — triageFromFacts (src/triage/matrix.ts:46-130) branches solely on files.length, docOnly, sensitivityTags, and testsOnly, never on kind "lockfile". (3) A lockfile-only diff therefore has docOnly=false, no sensitivity tags, testsOnly=false → falls through to riskClass "default", budgetTier "standard", loopCap 3, runReview true; and a regenerated lockfile's thousands of changed lines exceed SMALL_DIFF_LINES=30 (matrix.ts:50-51), so the small-diff iteration cap is indeed defeated. (4) No guard elsewhere mitigates: isExcludedFromReview (src/utils/git.ts:72-79) covers only reviewgate.config.ts/.reviewgate/Antigravity artifacts; the .reviewgateignore/.gitattributes generated-file exclusion in the design spec (2026-05-20-reviewgate-design.md:1172) was never implemented; lockfiles are tracked and appear in the diff. (5) Not deliberate: no comment claims kind is display-only, and the project's own field-report remediation doc (docs/dev/2026-06-05-field-report-remediation.md:407) acknowledges config/lockfile files wrongly forcing tiers as an open gap. Minor caveat: the implementation matches the original M3 plan verbatim (the plan's matrix also never consumed "lockfile"), so this is an unwired-since-day-one classification rather than a regression, and the dead branch itself is consequence-free (those files would otherwise classify as "config", treated identically) — but the claim's behavioral assertion (lockfile-only diffs run the full default panel at standard budget with the small-diff cap defeated, and the classification is consumed nowhere in triage) is accurate. Low severity is appropriate.

### F-18 [LOW] collectChangedFileContents parses tracked names without -z — non-ASCII paths are C-quoted and silently dropped from full-file context

- **Ort:** `src/utils/git.ts:276`
- **Cluster:** C (diff-triage)

**Beschreibung:**

The untracked listing in this same function was explicitly fixed to use `ls-files -z` because core.quotePath C-quotes non-ASCII paths and the quoted token then fails to resolve (comment at lines 288-289). But the tracked side still uses plain `git diff --name-only` split on \n (lines 276-287): a modified file with a non-ASCII name comes back as `"\351\233\242.ts"` (quotes and octal escapes included), lstat on that literal string throws, and the file is silently skipped. The full-file context exists precisely to suppress false-positive 'symbol undefined' findings — so for non-ASCII-named files the FP-suppression input is quietly missing while the diff itself (collected with proper exclusions) still shows the change, recreating the exact failure mode the -z fix addressed for untracked files.

**Fix-Vorschlag:**

Use `git diff --name-only -z <ref> -- . <excludes>` and split on \0, matching the untracked path.

**Verifikation (adversarialer Check):**

Confirmed by code reading and live reproduction. git.ts:276 builds tracked-name args without -z (["diff","--name-only",ref,...]) and splits stdout on \n (lines 282-287). With core.quotePath=true (git's default, acknowledged in this file's own comment at line 201), a tracked non-ASCII file is emitted as the literal C-quoted token `"\351\233\242.ts"` — reproduced live: `git diff --name-only HEAD` outputs the quoted form, while `-z` outputs the real path. The quoted token is added verbatim to `names`; lstatSync(join(repoRoot, token)) at line 318 throws ENOENT and the bare catch at line 327 (`continue; // deleted or binary`) silently skips the file. grep shows no core.quotePath override or unquoting logic anywhere in src/; the git() helper passes args through unchanged. The untracked side of the SAME function uses `ls-files -z` with a comment (lines 288-289) naming exactly this failure mode, and collectDiff (lines 200-204) got the same -z fix — the tracked side was missed. Net effect as claimed: non-ASCII tracked files appear in the reviewed diff but are silently absent from the full-file context used for undefined-symbol FP suppression. Severity low is appropriate (needs a non-ASCII filename; degrades reviewer context, not the verdict path).

### F-21 [LOW] computeRejectRate counts the FIRST decision line per finding, not the last — a retracted rejection still drives reject-rate/fp-streak escalation

- **Ort:** `src/core/fp-ledger/reject-rate.ts:55`
- **Cluster:** E (state-concurrency)
- **Duplikat von:** F-03 (unabhängig gefunden — Beschreibung kann zusätzliche Details enthalten)

**Beschreibung:**

The per-finding dedup `if (!allowed.has(id) || seen.has(id)) continue` keeps the FIRST valid line's verdict and ignores all later lines. Every other consumer of decisions/<iter>.jsonl that handles multiple lines per finding (priorIterationDecisionSignatures, lastDecisionsById in loop-driver.ts) is last-wins by design. Consequence: an agent that writes 'rejected' and then supersedes the same finding with 'accepted/fixed' still has it counted as a confirmed reviewer false positive in wrongRejects, which feeds the reject-rate-high escalation (loop-driver.ts line 900) and the cumulative_fp_rejects fp-streak escalation (line 921-945) — escalations triggered by FPs the agent retracted. Conversely an accepted-then-rejected supersede is invisible to the breaker.

**Fix-Vorschlag:**

Fold to the last valid DecisionEntry per finding_id (same Map pattern as lastDecisionsById) before counting total/wrongRejects.

**Verifikation (adversarialer Check):**

VERIFIED. (1) reject-rate.ts:55 is genuinely first-wins per finding_id: `if (!allowed.has(id) || seen.has(id)) continue` keeps the first valid line's verdict and skips all later lines. (2) The superseding-decision input is explicitly supported, not hypothetical: loop-driver.ts:128-134 documents LAST-wins as design ("the append-only decisions file may carry a superseding disposition for a finding within an iteration; the fold reflects the agent's MOST RECENT intent"), and priorIterationDecisionSignatures (line 194), priorAdjudications (line 271), and lastDecisionsById (line 312) all fold last-wins; evaluateDecisions (lines 380-481) accepts any valid line per id and does not block conflicting duplicates, so a rejected-then-fixed file passes the gate. (3) Consequence confirmed: a retracted rejection (rejected line then accepted/fixed line) still counts in wrongRejects, feeding reject-rate-high (loop-driver.ts:900-910) and cumulative_fp_rejects/reviewer-fp-streak (lines 922-945) plus fp_rejects_history — while the same file's last-wins readers simultaneously treat the finding as fixed (it even receives the §4.3 claimed-fixed pin). The cumulative fp-streak path has no per-iteration sample floor, so retracted rejections genuinely accumulate toward fpStreakThreshold. The inverse order (accepted-then-rejected) is invisible to the breaker, as claimed. (4) Refutation attempts failed: the anti-padding rationale in reject-rate.ts lines 13-31 is fully satisfied by last-wins-per-id too (still one count per real id; an adversarial agent authoring the whole file gains nothing from either order policy), and the only dedup test (fp-reject-rate.test.ts:60) pins identical-duplicate padding, never a verdict flip — so first-wins is unpinned/undocumented for the supersede case, contradicting the codebase's own stated last-wins semantics. Severity low is appropriate: protocol says one line per finding so flips are rare, and the rate path has a min-sample guard; but the inconsistency and escalation-counter impact are real. (Corroborating: fp-ledger/learn.ts and reputation/learn.ts also lack a last-wins fold, booking FP-ledger rejects / reputation "wrong" events for retracted rejections.)

### F-23 [LOW] Dead guard: fp-ledger decayPass's 'active -> candidate after 180d' demotion is unreachable

- **Ort:** `src/core/fp-ledger/store.ts:208`
- **Cluster:** E (state-concurrency)

**Beschreibung:**

decayPass first recompute()s every sticky/active entry (line 198-200). recompute keeps stage 'active' only when win60.length >= ACTIVE_REJECTS, i.e. at least one reject ts is within 60 days of now. last_seen_at is set to nowIso on every recordReject (including dup hits, line 135), so last_seen_at >= the latest reject ts, meaning any post-recompute 'active' entry has last_seen_at at most 60 days old. The subsequent loop `if (e.stage === "active" && age(last_seen_at) > 180d) stage = "candidate"` can therefore never fire — recompute has already demoted any entry that could satisfy it (and did so at ~60d, much earlier than the documented 'active->candidate after 180d' lifecycle in the comment at line 183). Behavior is safe (demotion happens sooner via recompute), but the 180d rule the comment documents does not exist in practice and the guard is dead code that will mislead future changes.

**Fix-Vorschlag:**

Delete the unreachable 180d demotion loop and fix the lifecycle comment (line 183) to state that active entries decay to candidate via the read-time/decay-time recompute once their qualifying rejects age out of the 60d window — or, if 180d grace was the intended behavior, demote based on persisted stage BEFORE recomputing.

**Verifikation (adversarialer Check):**

Verified by tracing src/core/fp-ledger/store.ts. last_seen_at is written ONLY in recordReject (lines 120/135/139), always to the same nowIso that stamps any pushed reject's ts, so last_seen_at >= max(reject.ts) is an invariant (pin/unpin/recompute never lower it). decayPass (line 198-200) recomputes every sticky/active entry first; recompute keeps stage 'active' only when >=3 rejects (>=2 distinct providers) fall within the 60-day window of nowMs, so any post-recompute 'active' entry necessarily has last_seen_at <= 60 days old. The subsequent guard at line 208 demands stage==='active' AND last_seen_at age > 180d — a direct contradiction, hence unreachable. Candidates skip recompute but the guard matches only 'active'; pinned entries recompute to 'sticky'. Only a >120-day backwards clock jump or a hand-edited ledger could reach it — not code paths. The bug is aggravated by the comment at lines 148-150 claiming demotion is 'owned SOLELY by decayPass's 180d-since-last_seen rule' (the F-020 promote-only floor was designed around that rule), while actual demotion occurs at ~60d via the recompute; no test exercises the line-208 branch (tests/unit/fp-ledger-store.test.ts:242 F-018 demotion goes through recompute). Dead/unreachable guard with a misleading documented lifecycle — real, low severity, behavior currently safe (demotes earlier than documented).

---

## Widerlegte Findings (keine Aktion nötig)

- **All-quota outage defers UNBOUNDEDLY — handleAllQuotaLocked bypasses the infraDeferMaxConsecutive cap and never escalates to the human**
  - Widerlegung: The code reading is accurate (loop-driver.ts:1055 routes all-quota to handleAllQuotaLocked at :1275, which allow-stops with no counter, no audit event, no escalation, before the bounded infra-defer at :1065), but this is an explicitly documented design decision, not a bug. The P3 spec (docs/dev/2026-06-05-field-report-remediation.md) states twice that the all-quota path is deliberately uncapped: Step 8 — "quota has its own uncapped path … leaving untouched is correct"; design-notes line 418 — "the common transient outage is already covered (all-quota defers uncapped; per-reviewer timeout cools down + fails over). This setting only governs the rarer MIXED total outage" — written after a codex review round that explicitly debated defer fail-open posture. Rationale holds: quota outages carry a known reset time; the cooldown-skip synthesis (orchestrator.ts:1071-1090) is NOT self-perpetuating as claimed — it only synthesizes quota-exhausted for the primary while within the recorded reset/re-probe window AND a fallback exists (the fallback IS spawned), and past the window the primary is re-attempted, so the state is re-probed with real spawns. The defer is also not silent: every turn emits the visible 🟠 GATE DEFERRED message with per-provider reset times (quotaDegradationNote), and the dirty flag is kept so the change is re-reviewed once quota returns. The "permanently quota-dead account" scenario is speculative — a cancelled subscription surfaces as auth/error status, routing to the bounded infra-defer or misconfig hard-block, not the parsed quota-exhausted path. At most this is a design-tradeoff discussion item, not a logic error.
- **A disabled (or host-tier-disabled) primary provider silently drops the slot's ENTIRE fallback chain**
  - Widerlegung: The cited control flow is real (orchestrator.ts:969/972 return null before the fallback walk at 1118 and last-resort at 1158), but it is documented, deliberate design rather than a logic bug. (1) The contract that a reviewer slot's PRIMARY must be both listed AND providers.<id>.enabled is explicitly documented and surfaced by a dedicated `reviewgate doctor` check (src/cli/commands/doctor.ts:42-64), whose FAIL message describes precisely the claimed scenario: "configured but NOT enabled in providers: … → the gate cannot review and will ERROR". (2) The single-slot consequence the claim presents as harm — settled.length===0 → hard-block misconfig ERROR — is explicitly chosen in the code comment at orchestrator.ts:1291-1295: "settled.length === 0 (none enabled/available …) is a real MISCONFIG → stays a hard block". This is fail-closed and loud, not a fail-open or silent path. (3) The host-tier null case is documented intent at orchestrator.ts:818-820: "returns null when that tier is disabled → the slot/fallback candidate is skipped". (4) The asymmetry vs a quota-capped primary is spec'd in the config schema (define-config.ts:52-58): the fallback chain is a RUNTIME failover for an attempted-but-failed primary; for fallback providers "listing it here IS the opt-in" (they run regardless of their own enabled flag), while for primaries the enabled flag is the opt-in — tests in orchestrator-fallback.test.ts exercise exactly these semantics. The claim is a design disagreement ("disabled primary should substitute its fallback") about behavior that is documented, diagnosable via doctor, and fail-closed.
- **Signature includes category although the system's own dedup rationale documents category drift between reviewers/runs**
  - Widerlegung: The cited code is accurate (signature.ts:89 hashes category; aggregator.ts:91-98 excludes it from the region key citing drift), but this is an explicitly documented, deliberate design trade-off, not a bug. The M5 FP-ledger spec (docs/superpowers/specs/2026-05-21-reviewgate-m5-fp-ledger-design.md:40) names this EXACT behavior under "Signature reliability (honest)": because the signature includes reviewer-controlled rule_id and category, the same issue re-categorized produces a different signature and misses the ledger — declared "acceptable for a conservative v1" because a miss only RE-SHOWS a finding (fail-safe: blocks more, never over-suppresses), and fuzzy matching is an explicit non-goal due to over-suppression risk. The designed mitigation (per-member signature aliases from clustered findings) is implemented: claimedFixed and cycleRejected match against the finding's FULL signature set including members (aggregator.ts:345-361, 448-453; loop-driver.ts:129), absorbing cross-reviewer drift within a cycle. Removing category would create the opposite, real fail-open: a security finding at the same line-bucket as a rejected "quality" FP would inherit the suppression. The runaway-evasion analogy also fails: that incident was fixed via a non-signature-keyed cross-iteration FP accumulator (PR#27) plus hard backstops (maxIterations/cost-cap), which a category-flipping loop still hits. Every guard the claim lists degrades fail-safe (re-show/re-block) on a signature miss; the only mild weakening (claimedFixed pin miss → finding treated as fresh) stays within the spec's documented reliability envelope. Design tension, known and documented — not a logic error.
- **Critic payload extraction: successful whole-text JSON parse bypasses the verdicts-aware scan, silently no-opping the critic**
  - Widerlegung: The code shape is as described — /Users/markus/Developer/reviewgate/src/core/critic.ts:71-72 early-returns a successful whole-text parse without checking for a `verdicts` array, skipping the verdicts-aware brace scan (lines 73-84). But the claim fails as a real bug for three reasons:

1. The claimed input effectively cannot occur. The hypothesized wrapper (`{"response":{"verdicts":[...]}}`) would have to come from the model itself, because every adapter's complete() already unwraps its CLI envelope before the critic sees the text: claude.ts:261-266 parses the `-p --output-format json` envelope and returns only `.result`; codex.ts:320-321 returns the bare last-message file (`--output-last-message`); gemini.ts:272-273 returns verbatim agy stdout; openrouter.ts:289 returns `choices[0].message.content`. So no "schema-loose CLI wrapper" reaches extractCriticPayload — the claim's stated mechanism is wrong. For the bug to fire, the model must disobey the prompt ('Output ONLY JSON matching the schema: {"verdicts":[...]}', critic.ts:27-28) in the one peculiar way that keeps the ENTIRE output valid JSON while nesting verdicts under an invented key. Realistic non-compliance (prose around JSON, markdown ```json fences, stray braces) makes the direct parse FAIL, which routes to the scan — exactly the case the scan was built for per the comment at lines 62-65.

2. The code matches its own contract; the claim misquotes the comment. The comment (lines 65-68) reads "(1) try a direct parse, then (2) scan every `{` ... and return the FIRST one that parses and carries a `verdicts` array" — the carries-verdicts requirement is stated for step (2) only, not for the direct parse. No contradiction.

3. The no-verdicts direct-parse outcome is deliberately handled, not overlooked. parseCriticOutput's guard comment (critic.ts:117-129) explicitly anticipates direct payloads without a proper verdicts array ('JSON.parse("null") / "42" / "[..]" succeed ... any malformed payload must yield zero demotions, never an exception') and maps them to an empty map with info.status "empty" — surfaced, demote-only, fail-open by the module's documented contract (lines 39-41). The author considered this exact branch and chose zero demotions.

Net: a speculative robustness nicety (fall through to the scan when the direct parse lacks verdicts) on an input no component of the real pipeline produces, with a fail-open, verdict-neutral outcome that the code documents as intended. Not a reproducible logic error.
- **pending.md / pending.json written non-atomically — a torn pending.json silently drops the decisions requirement**
  - Widerlegung: The mechanical facts are accurate (report-writer.ts:249-250 are two truncate-in-place writeFileSync calls with no temp+rename; the loop-driver readers at lines 123-125, 169-171, 251-253 are never-throws → []), but the claimed consequences do not materialize when the control flow is traced — every reachable failure window is fail-closed, and the pins the claim says "silently reset" are not stored in pending.json at all.

1. The self-deadline abort CANNOT tear the write. writeFileSync is synchronous in a single-threaded Bun process, so the loop.runTimeoutMs timer can never fire between (or inside) lines 249-250. The abort path additionally has an explicit chokepoint (orchestrator.ts:1882-1887, signal.throwIfAborted() BEFORE any write) that skips the report write entirely on abort. Only an external SIGKILL of the whole gate process (Claude Code hook hard-timeout overrunning the self-deadline margin, OOM, power loss) can interrupt mid-write — a microsecond window for a small JSON file.

2. In that external-kill scenario, the block decision for the iteration was never returned (write() runs inside runIteration, before LoopDriver emits the block), so the agent never saw the report and decisions/<iter>.jsonl for that iteration does not exist. Therefore: (a) "decisions-gate requires zero decisions" is vacuous — there were never decisions to require; (b) priorIterationClaimedFixedSignatures/priorIterationRejectedSignatures (loop-driver.ts:141-143) return [] anyway because the decisions FILE is absent (existsSync gate), independent of pending.json integrity — nothing is dropped that ever existed.

3. The §4.3 fix-verification pin and per-cycle suppression are NOT "silently reset": pins from earlier iterations were already folded into state.cycle_rejected_signatures and state.claimed_fixed_signatures (loop-driver.ts:818-855), persisted via the locked/atomic StateStore the claim itself cites as the discipline baseline, and are passed to the next iteration from state (lines 974-975), not from pending.json. The per-run pending.json read only joins the PRIOR iteration's NEW decisions — which cannot exist in any torn-write scenario (see 2).

4. Recovery is conservative in both sub-cases. Torn json → previousFindingIds=[] → the gate falls through and runs a FRESH review iteration (loop-driver.ts:960+) on the still-set dirty flag, regenerating pending.{md,json} consistently and blocking again — no allow_stop, no skipped review. Kill between the two writes (new md, old INTACT json) produces the opposite of the claimed direction: the gate over-demands decisions for the old report (fail-closed), eventually escalating to the human — never fail-open.

The residual is a one-iteration, microsecond-window robustness divergence from the state-store atomic-write discipline with no fail-open path, no persistent state corruption, and no loss of decision/pin data — a hardening nicety, not a real logic bug with the described faulty behavior.
- **spawnSafely's 100ms exit→settle grace can truncate a reviewer's output, reintroducing the truncation bug the 'close'-settle was designed to fix**
  - Widerlegung: The mechanics are correctly described but the bug is not real in practice, and the behavior is deliberate. (1) The grace timer is a documented design tradeoff: src/utils/spawn.ts:216-225 and 269-277 explicitly state that 'close' is preferred and the 100ms exit-grace exists to bound wall time when an orphaned grandchild suppresses 'close' — applied to normal exits on purpose ("whether the child exited normally OR was killed"). Lines 234-237 acknowledge stream destruction is a no-op on the normal close-settled path. (2) The settled-guard means truncation requires 'close' to lag 'exit' by >100ms with data still undelivered. A sync stall beginning BEFORE the child exits is harmless: on loop resume the grace timer isn't yet scheduled, the poll phase drains the pipe, and close-settle wins with full data. The only fatal window is a continuous >=100ms synchronous block landing in the same event-loop iteration AFTER the exit handler but BEFORE the next poll read of that pipe. (3) The claim's cited stall sources can't occupy that window: sanitizeDiff/writeFileSync of prompt+diff (orchestrator.ts:976-1048) run at spawn/failover-spawn time inside the task closure, minutes before exits; the multi-MB readFileSync+JSON.parse (codex.ts:339, claude.ts:257/290) runs as another reviewer's settle continuation, so it would need two reviewers with minutes-scale high-variance runtimes to complete within the same event-loop iteration in the exact order exit(B) -> parse(A) -> timer-beats-poll, with B's final <=64KB (one pipe buffer max — the child blocks on write otherwise, so it can't exit with more in flight) unread. That is a freak sub-millisecond coincidence, not the routine condition the claim asserts. (4) The timers-phase-before-poll ordering the claim relies on is a libuv property; the gate runs under Bun's own event loop, so the load-bearing scheduling premise is unverified for the actual runtime. (5) The "truncation bug the close-settle was designed to fix" (resolving before delivered data hit the capture files) is NOT reintroduced: settle still awaits both WriteStream end-flush callbacks (lines 249-266); only kernel-undelivered bytes in the deliberately bounded grace path are at risk. Net: deliberate documented tradeoff plus a contrived trigger that cannot be concretely reproduced from the code's control flow.
- **pending.json/pending.md written non-atomically — an OS-kill mid-write silently voids the decisions gate for the prior iteration**
  - Widerlegung: The premise is factually true (src/core/report-writer.ts:249-250 writes pending.md/pending.json with plain writeFileSync, no tmp+rename; src/core/loop-driver.ts:107-126 previousFindingIds returns [] on a parse error), but the claimed consequence is unreachable under the claimed kill mechanism, due to strict ordering in LoopDriver.run:

1. pending.json is written INSIDE orchestrator.runIteration (writeReport, orchestrator.ts:1867/1912), which completes synchronously BEFORE LoopDriver advances state.iteration to nextIter (loop-driver.ts:1081-1136). So a SIGKILL landing mid-write of pending.json necessarily leaves state.iteration at the PRIOR value N, never N+1. A truncated pending.json paired with iteration=N+1 cannot be produced by killing the process (writeFileSync returns before state.update runs in the same process; SIGKILL does not lose page-cache data already written).

2. To even reach runIteration (and thus the pending.json overwrite), iteration N's decisions-gate must already have PASSED this very run: evaluateDecisions at loop-driver.ts:858 blocks/escalates otherwise. So in the only reachable kill window, the obligations the truncation would "void" were already satisfied — the next run's empty requiredIds changes nothing.

3. The learning signal for iteration N is likewise already consumed before the kill window: absorbPriorDecisions is hoisted to the TOP of the iteration block (loop-driver.ts:806, before runIteration), and the cycle_rejected/claimed_fixed signature fold is persisted into state.json via state.update at loop-driver.ts:845-855 — all reading the still-intact pending.json. computeRejectRate/fp-streak accounting (895-946) also runs before the new iteration. Nothing is lost.

4. The findings of the iteration whose pending.json write was interrupted never became obligations: iteration was never advanced, the block message was never delivered (the hook was killed — that turn ending un-reviewed is the separate, known M-A0 fail-open issue, independent of file atomicity). The dirty flag survives, so the next stop runs a fresh review that completely rewrites pending.json before anything gates on it.

The only way to pair a truncated pending.json with an advanced iteration is a kernel crash/power loss — outside the claimed Stop-hook-SIGKILL mechanism, and a scenario where the codebase's "atomic" writes are equally non-durable anyway (StateStore.writeAtomic is write-tmp+renameSync with no fsync, state-store.ts:68-74). Non-atomic writeFileSync here is at most a robustness inconsistency, not a logic bug with the claimed effect.
