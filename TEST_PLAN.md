# Reviewgate — Full Test Series (M1–M4 + 2026-05-21 improvements)

How to use: **Layer 1+2** run in this repo (`/Users/markus/Developer/reviewgate`).
**Layer 3** runs in the consumer project **flashbuddy** (`/Users/markus/Developer/flashbuddy`)
through real Claude Code and Codex sessions. Always `export PATH="$HOME/.bun/bin:$PATH"` first.

Per Layer-3 test: the human tells the flashbuddy agent the **Prompt**; the agent makes the
change, ends its turn, and **on the gate block runs the `cp` snapshot command FIRST**, then
resolves normally (delete file + write `.reviewgate/decisions/<iter>.jsonl`). Then the
reviewgate-session agent inspects the snapshot. Restart Claude Code in flashbuddy once before
the series (loads the latest config + binary; SessionStart resets state).

Snapshot/inspect files live under `flashbuddy/.reviewgate/`: `pending.json`/`pending.md`,
`decisions/<iter>.jsonl`, `research.md`, `audit/…`, `brain/brain.{json,md}`,
`brain/proposals/curator-decisions/*.jsonl`, `ESCALATION.md`.

---

## Layer 1 — Automated (deterministic, no network)
```
export PATH="$HOME/.bun/bin:$PATH"
bun test            # require the real terminal summary: 0 fail
bun run typecheck   # clean
bun run lint        # clean
```
Covers every phase's logic with fakes: loop FSM, triage, aggregator (+dedup/critic),
signatures, cache, brain (store/select/engine/curator/lifecycle/fetcher/embeddings),
config, audit, all adapters, full P0→P4 integration.

### Policy Accountability & Replay — Slice 1

This deterministic block is the focused acceptance suite for the closed 18-pass catalog, both
explanatory stages, fail-open production tracing and fail-closed authoritative measurement:

```bash
bun test tests/unit/policy-catalog.test.ts \
  tests/unit/policy-trace-schema.test.ts \
  tests/unit/policy-trace-recorder.test.ts \
  tests/unit/policy-pass-contract-matrix.test.ts \
  tests/integration/policy-trace-equivalence.test.ts \
  tests/integration/policy-trace-offline-replay.test.ts \
  tests/unit/bench-matrix.test.ts \
  tests/unit/rig-replay.test.ts \
  tests/unit/audit-verify-corruption.test.ts
```

The suite must prove:

- all 18 catalog rows and the `aggregation.cluster`/`verdict.compute` stages are present in fixed
  order, with explicit no-opportunity, no-match, active, ablated and protected contracts;
- trace-on/off leaves findings, legacy markers, Markdown, counts and verdict byte-equivalent after
  optional telemetry is removed;
- Audit/Bench policy artifacts are canonical and content-addressed; Rig state and Cassette evidence
  are mode-`0600`, contained and bound by exact content hashes/identities;
- Bench uses one live baseline and exact captured-response replay for internally ablated variants;
- Rig replays exact calls in persistent, isolated baseline/counterfactual branches without live
  provider or network calls and without production-state writes;
- missing, corrupt, overflowed, reordered, cross-catalog or mismatched evidence is non-authoritative
  and authoritative commands exit `4` rather than substituting zero counters.

The ten required mutation proofs, their named red regressions and restored source hashes are kept in
`docs/dev/2026-08-10-policy-trace-mutation-evidence.md`. Do not replace them with a green-only full
suite. Slice 1 is measurement plumbing, not evidence that a pass is useful or useless: zero
opportunities do not support deletion, Lore is additive/outside the 18, and history passes need
seeded multi-turn sequences.

## Layer 2 — Real CLI/API e2e (gated; needs real providers + OPENROUTER_API_KEY)
```
REVIEWGATE_E2E=1 bun test tests/e2e/
```
Real codex/gemini/claude/openrouter reviewers, real OpenRouter embeddings
(`baai/bge-base-en-v1.5`, expect near-dup ≥0.85 / unrelated <0.85), real SSRF-safe web-fetch.

### Native Codex host smoke

```bash
reviewgate init --hooks-only --host codex
codex
# human action inside Codex: /hooks → inspect + trust the exact project hook hash
```

Installation alone is not activation. Before trust, confirm Codex lists the new
or changed project commands as requiring review and skips them. After the human
trusts the current hash, confirm they run. `reviewgate doctor` may verify the
installed file and binary but must not claim it can observe Codex's trust store.

1. Start Codex from a repository subdirectory; confirm `SessionStart` resets the
   root checkout state rather than creating nested `.reviewgate/` state.
2. Mutate one file with `apply_patch`, then one with a simple Bash command. Each
   Stop must invoke Reviewgate. Repeat with a committed mutation and an
   uncommitted mutation.
3. Change only `reviewgate.config.ts`, then change code + config together. Confirm
   the dedicated policy path appears and code is reviewed under the LKG.
4. On a blocking finding, confirm Codex receives the reason as an automatic
   continuation prompt. The repeated Stop has `stop_hook_active:true`, consumes
   decisions, and converges without an unbounded loop.
5. Temporarily rename `.reviewgate/bin/gate`; the Codex Stop hook must emit a
   valid `{"decision":"block"}` fail-closed response.

---

## Layer 3 — flashbuddy end-to-end (the real proof)

### T1 — M1: loop + decisions protocol + audit
**Prompt:** „Erstelle `src/lib/_t1.ts` mit einem hardcodierten Secret (`sk_live_…`) UND einer SQL-Injection (`email` per String-Interpolation in `prisma.$queryRawUnsafe`). Turn beenden. Bei Block: `cp .reviewgate/pending.json /tmp/t1.json`, dann Datei löschen + decisions schreiben, erneut beenden."
**Verify:** 🔴 GATE CLOSED iter 1 → decisions/1.jsonl (one line per finding) → 🟢 GATE OPEN PASS iter 2. `reviewgate audit verify --file <newest .reviewgate/audit/**/*.jsonl>` = chain verified. `state.json` after: `iteration:0` (PASS re-arm), `escalated:false`.

### T2 — M2: panel + aggregation (confirmed_by / consensus / severity veto)
**Prompt:** „Erstelle `src/lib/_t2.ts` mit EINER klaren SQL-Injection (raw query, user input interpoliert). Turn beenden. Bei Block: `cp .reviewgate/pending.json /tmp/t2.json`, dann beheben + decisions, erneut beenden."
**Verify (`/tmp/t2.json`):** ≥2 reviewers ran; the SQL-injection finding has `confirmed_by` listing ≥2 providers + `consensus: unanimous|majority` (one merged finding, not N duplicates); verdict FAIL driven by the CRITICAL; coverage banner present iff a reviewer dropped.

### T3 — M2 critic + observability + OpenCode/MiniMax (the combined run)
**Prompt:** „Erstelle `src/lib/_t3.ts` mit (1) hardcodiertem Secret `sk_live_…`, (2) Magic Number `setTimeout(x, 3600000)`, (3) `==` statt `===`. Turn beenden. Bei Block: `cp .reviewgate/pending.json /tmp/t3.json`, dann beheben + decisions, erneut beenden."
**Verify (`/tmp/t3.json`):** `critic` field = `{ provider:"opencode", status:"ran", verdicts>0, demoted≥0 }` (status `ran` confirms the MiniMax/`default` critic works — `empty` would mean it returned nothing, `error`/`misconfigured` = setup issue). Style nits may carry `critic_verdict:"likely_fp"` (WARN→INFO); the secret stays CRITICAL/`keep`. The magic-number and `==` should NOT appear duplicated across WARN+INFO (dedup); a cross-category merge shows `⚠ merges concerns categorized as…` in `details`. All 4 reviewers `ok` (timeout fix).

### T4 — M3: adaptive triage (doc-only skip)
**Prompt:** „Ändere nur einen Kommentar in einer bestehenden `.md`- oder `.ts`-Datei (keine Logik). Turn beenden."
**Verify:** instant 🟢 GATE OPEN PASS, NO reviewer entries in `pending.json` (triage skipped the panel), $0.

### T5 — M3: research / symbol graph
**Prompt:** „Ändere eine Funktion in `src/lib/<eine .ts>` die eine andere Funktion derselben Datei aufruft. Turn beenden. Bei Block: `cp .reviewgate/research.md /tmp/t5-research.md`, dann beheben + decisions."
**Verify:** `/tmp/t5-research.md` exists and lists the changed symbol + callees/callers (tree-sitter + ripgrep graph).

### T6 — M3: content-addressed cache
**Prompt:** „Mache exakt dieselbe kleine Code-Änderung wie im vorigen Turn nochmal (gleicher Diff). Turn beenden."
**Verify:** 2nd identical diff → verdict from cache, no reviewer spawn (noticeably faster; reviewers list is the trivial placeholder).

### T7 — #1 fix: full changed-file context (no false "undefined symbol")
**Prompt:** „Refactore eine bestehende Datei in `src/lib/`, die Symbole nutzt, die WEITER UNTEN/woanders in derselben Datei definiert sind (z. B. eine Helper-Funktion vor ihrer Definition aufrufen lassen via Reordering). Turn beenden. Bei Block: `cp .reviewgate/pending.json /tmp/t7.json`, dann decisions."
**Verify (`/tmp/t7.json`):** NO false-positive findings claiming an in-file symbol is undefined/missing (pre-#1 these appeared; reviewers now get the full file).

### T8 — Dedup (category-independent + masking note)
Covered partly by T3. **Verify in `/tmp/t3.json`:** the same line flagged by different reviewers under different categories/rule_ids appears as ONE finding (not duplicated WARN+INFO); multi-category clusters carry the `⚠ merges concerns categorized as…` note in `details`; genuinely separate issues (>5 lines apart) stay separate.

### T9 — M4: brain WRITE path (curator)
**Prompt:** „Refactore `src/lib/<datei>` und kommentiere bewusste, nicht-offensichtliche Konventionen als Absicht (z. B. ein absichtlicher null-guard, ein bewusster `as`-Cast auf Netzwerkdaten). Turn beenden + normal abarbeiten."
**Verify:** `flashbuddy/.reviewgate/brain/proposals/curator-decisions/*.jsonl` shows proposals + verdicts (`promoted` / `rejected:quorum` / `queued`). A promotion needs ≥2 distinct providers to agree (anti-collusion) OR a web-fetch citation (egressAllowlist is empty → cross-provider only). Promoted entries land in `brain/brain.json`. `reviewgate brain list`.

### T10 — M4: brain READ path
**Prompt (after a promoted entry exists):** „Fass dieselbe Datei/denselben Bereich nochmal an. Turn beenden."
**Verify:** on the next review, the brain entry is injected (`## Brain context`) → reviewers no longer re-flag the as-intended pattern. (Observe indirectly: fewer/no repeat findings on that pattern; or a `contradicts_memory` field if a reviewer disagrees.)

### T11 — M4: brain CLI / user veto
```
cd /Users/markus/Developer/flashbuddy
reviewgate brain list
reviewgate brain show --id <id>
reviewgate brain revoke --id <id>   # entry gone immediately
```

### T12 — loop: escalation
**Prompt:** „Erzeuge einen Fehler und 'fixe' ihn 3 Runden lang absichtlich NICHT richtig (z. B. immer dieselbe ungültige Decision), bis das Gate aufgibt."
**Verify:** 🟠 GATE ESCALATED + `.reviewgate/ESCALATION.md` written; gate stops gating until reset/restart; re-arms after a commit or a clean PASS.

### T13 — #3 fix: reviewer failure diagnosability
Opportunistic — whenever a reviewer errors/timeouts in any test, check `pending.json` reviewers[]: the failed one carries `status_detail` with the reason (e.g. "OpenRouter request failed: The operation was aborted"). Pre-#3 this was blank.

---

## Pass criteria
The series passes when: Layer 1+2 green; T1–T3 + T7–T9 show the expected gate behavior, aggregation, critic-`ran`, dedup, and brain write/read; T4–T6 confirm the adaptive pipeline; T11 the CLI; T12 escalation. Capture each `/tmp/t*.json` snapshot before resolving so findings can be inspected after the PASS overwrites `pending.json`.
