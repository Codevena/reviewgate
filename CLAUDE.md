---
verified_commit: e17de4e
verified_at: 2026-08-07
---

# reviewgate — Trailhead

> Prüfe mich zuerst: `node /Users/markus/.claude/scripts/verify-map.js`.
> Bei STALE bin ich ein Hinweis, kein Fakt.

<!-- Pfade IMMER repo-relativ und mit mindestens einem "/". Wurzeldateien als ./name.ts.
     Aliase (@/...), Globs und Paketnamen werden absichtlich uebersprungen. -->

## Commands

**Bun** (Node 20+ führt nur das kompilierte Binary aus) · TypeScript · Biome · `bun test`, nie jest/vitest.
`bun run` + `dev <subcommand>` · `build` · `typecheck` · `lint` · `format` · `test:unit` · `test:integration` ·
`verify:npm` · `build:npm` · `self-review` (armt das Repo und feuert das eigene Gate)
**Vor „fertig" immer beides:** `bunx tsc --noEmit` **und** `bun run lint` — beide sauber. Nach Schema-/Config-Änderungen volle `bun test`.
Einzeltest `bun test tests/unit/foo.test.ts` bzw. `bun test -t "Namensteil"`. `lint` deckt `src tests bin` ab,
`format` nur `src tests` — `bin/` wird gelintet, aber nie formatiert. Bun-Built-ins bevorzugen (`Bun.Glob`,
`Bun.$`, `Bun.file`), `.env` lädt Bun selbst. State = JSON unter `.reviewgate/`, kein Server/SQLite/Redis.

## Steht nicht hier

- **Das Warum steht in Lore** (`.reviewgate/lore/`, freigegeben über `bun run dev lore approve <id>`, TTY-pflichtig).
- Agenten-/Decision-Protokoll: `docs/AGENTS.md` · Architektur: `docs/architecture.md` · Sandbox: `SECURITY.md` · Tests: `TEST_PLAN.md`
- Sessionstand und nächste Aufgabe: NEXT_SESSION.md im Wurzelverzeichnis
- Projektstand, Feldrückmeldungen, Entscheidungen: Brain → `02 Projekte/Aktiv/ReviewGate.md`

## Wo liegt was — nach Aufgabe

| Aufgabe | Einstieg | Mit betroffen | Tests |
|---|---|---|---|
| Hook-Eintritt / Gate-Lauf | `src/cli/commands/gate.ts` | `src/core/loop-driver.ts`, `src/hooks/` | `tests/integration/` |
| Pipeline einer Iteration | `src/core/orchestrator.ts` | `src/core/aggregator.ts`, `src/core/critic.ts`, `src/core/report-writer.ts` | `tests/unit/` |
| Reviewer-Adapter | `src/providers/registry.ts` | `src/providers/adapter-base.ts`, `src/providers/review-output.ts`, `src/utils/spawn.ts` | `tests/unit/` |
| Diff und Signaturen | `src/utils/git.ts` (`collectDiff`) | `src/diff/sanitizer.ts`, `src/diff/signature.ts` | `tests/unit/` |
| Triage / Risikoklasse | `src/triage/matrix.ts` (`triageFromFacts`) | `src/triage/triage-engine.ts`, `src/research/diff-facts.ts` (**nicht** unter `src/triage/`) | `tests/unit/diff-facts.test.ts` |
| Config und Control-Plane | `src/config/control-plane.ts` | `src/config/`, `src/schemas/` | `tests/integration/` |
| Lore (Projektwissen) | `src/core/lore/store.ts` | `src/core/lore/staleness.ts`, `src/core/lore/guard.ts`, `src/core/lore/approve.ts` | `tests/unit/` |
| Brain (Repo-Gedächtnis) | `src/core/brain/` | `src/core/state-store.ts` | `tests/unit/` |
| Research-Kontext | `src/research/symbol-graph.ts` | `src/research/conventions.ts`, `src/research/research-writer.ts` | `tests/unit/` |
| Sandbox / Isolation | `src/sandbox/` | `src/utils/spawn.ts` | `tests/unit/` |
| Mess-Rig (Turn-Skripte) | `src/rig/driver.ts` | `src/rig/harvest.ts`, `src/rig/replay.ts`, `src/rig/ablate.ts`, `rig/scripts/`, `rig/preregistrations/` | `tests/unit/rig-driver.test.ts` |
| Cassette (Roh-Findings) | `src/cassette/store.ts` | `src/cassette/recording-adapter.ts`, `src/cassette/replay-adapter.ts` | `tests/unit/` |
| Benchmark | `src/cli/commands/bench.ts` | `src/bench/runner.ts`, `src/bench/metrics.ts`, `src/schemas/bench-result.ts` | `tests/unit/bench-preregistration.test.ts` |
| Statistik / Reports | `src/stats/aggregate.ts` | `src/stats/render.ts`, `src/cli/commands/stats.ts` | `tests/unit/` |
| Erstinstallation | `src/cli/commands/init.ts` | `src/cli/setup/prefill.ts`, `src/cli/setup/build-config.ts`, `src/cli/setup/probe.ts` | `tests/unit/setup-prefill.test.ts` |
| Persistierte Formate | `src/schemas/` | `src/schemas/pending-report.ts`, `src/schemas/finding.ts` | `tests/unit/` |
| Website | `website/index.html` | `website/styles.css` | — |

CLI-Subkommandos: `init` · `gate` · `reset` · `doctor` · `config` · `audit` · `brain` · `lore` · `review-plan` ·
`rig` · `bench` · `stats` · `report` · `fp` · `learn-status` · `pre-push` · `setup` (je ein Modul in `src/cli/commands/`).

## Fallen

- **Reviewer-Persona kommt aus `PERSONA_REAFFIRM` + Prompt-Präambel in `src/core/orchestrator.ts`, NICHT aus
  `src/personas/`** — die Dateien dort sind in diesem Milestone dekorativ. Verhalten ändert man im Code.
- **`REVIEW_OUTPUT_SCHEMA` strict-valid halten**, sonst stirbt jedes *echte* Codex-Review mit HTTP 400 und kein
  Stub-Test merkt es. Wächter: `tests/unit/review-output-schema.test.ts`. Warum → Lore `review-output-schema-strict`.
- **Provider-Änderungen gegen eine echte CLI prüfen, nicht gegen Stubs.** `codex exec` im Vordergrund mit
  geschlossenem stdin (`</dev/null`) — sonst hängt es an „Reading additional input from stdin…".
- **Worktrees sind per Default NICHT gegated** (Fail-open): `reviewgate init` im Worktree, oder `init --user`.
  `doctor` schlägt in einem ungegateten Linked-Worktree FEHL. Warum → Lore `worktree-gating`.
- **Sandbox: `mode:"off"` ist der Default**, die `deniedReads`-Liste ist dann wirkungslos; `strict` schlägt ohne
  OS-Sandbox fehl-geschlossen. Warum → Lore `codex-sandbox-readonly-by-design`.
- **Unbewaffnete Checkouts schreiben nichts (S2)** — bewaffnet ist erst, wer eine freigegebene Control-Plane-
  Baseline hat. Deren Löschen entwaffnet einen per `init` bewaffneten Checkout **nicht**: der Hook bleibt, das
  Gate schlägt fehl-geschlossen, bis die Freigabe zurück ist.
- **Für Messungen ist die Cassette die Quelle, nicht die Reports.** `turns/*/reports/*-pending.json` enthält nur
  post-Aggregations-Überlebende — eine Rate darüber misst, was durchkam. Warum → Lore `rig-metrics-corpus`.
  Der Rig darf zudem nie in das `.reviewgate/` des vermessenen Repos schreiben, sonst misst er sich selbst.
- **Deadline-Budgets:** Reviewer-Spawns klemmen aufs Restbudget minus Tail-Reserve; ein budget-geklemmter Abbruch
  kostet **keinen** Cooldown, ein selbst gerissener `timeoutMs` schon. Invariante: 120s + `runTimeoutMs` + 30s < Hook-Timeout.
- **Ein canon-Lore-Eintrag ohne Zeile in `.reviewgate/lore/approvals.jsonl` wird NICHT injiziert** und verhält sich
  wie ein Draft. Der canon-promotion-Befund feuert nur, wenn die Promotion **im Diff** liegt (`src/core/lore/guard.ts`)
  — für längst committete canon-Einträge bleibt `lore approve` der einzige Weg.
- **Dieses Repo dogfooded sich selbst** — das Gate läuft auf den eigenen Turns. Läuft parallel eine andere Session
  (gate.lock unter .reviewgate mit lebender PID, oder frische Commits), nichts committen.
