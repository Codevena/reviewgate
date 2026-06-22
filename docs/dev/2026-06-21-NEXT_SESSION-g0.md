# NEXT SESSION — implement G0 (soft-pass-decision-required)

Paste the block below into a fresh Claude Code session in `/Users/markus/Developer/reviewgate`.

---

## Kickoff prompt

Implementiere **G0** in Reviewgate — der gate-locked Plan liegt fertig in
`docs/dev/2026-06-21-g0-soft-pass-decision-required.md`. **Lies diesen Plan zuerst vollständig**;
er ist die Spec und wurde durch einen 3-Agenten-Design-Schwarm + **6 Codex-Plan-Gate-Runden**
gehärtet (jede Runde fand einen echten fail-open). Nicht neu erfinden — umsetzen.

**Branch:** schon angelegt + ausgecheckt: `feat/g0-demoted-critical-decision-required` (off master,
1 Commit = der Plan). master enthält bereits die gemergte Field-Report-Remediation (PR #68).

**Was G0 fixt:** Eine CRITICAL, die ein *value-judgment*-Demoter ein Schritt zu WARN demotet, soft-passt
als Einzel-Finding unter dem Default `softPassPolicy:"allow"` und re-armt **ohne erzwungene Decision**
(die decisions-gate läuft nur bei `iteration>0`, was der Soft-Pass-Re-Arm überspringt) → eine evtl.
echte CRITICAL wird auto-versteckt. G0 macht so ein Finding entscheidungspflichtig.

**Die gelockte Kern-Mechanik (Details im Plan):**
- `demoted_from_critical` (boolean) ist die **alleinige Source-of-Truth** — NICHT `original_severity`
  (max-propagiert würde von einem strukturell-demoteten Member kontaminieren). Nur die **value-judgment**-
  Demoter setzen es; via **OR** durch den Merge propagiert (strukturell/agent/ledger setzen es nie).
- **Clamp** an ALLEN value-judgment-Severity-Senkungen, damit ein `demoted_from_critical` nie unter WARN
  geht: critic-`DEMOTE`(:516) + reputation-pure-quality-`DEMOTE`(:703) via `demoteOneStep`-Helper;
  **confidence-floor** direct-INFO(:654-657); **reputation-correctness** direct-WARN→INFO(:682-700,
  `demoteCorrectness:true`). Die CRITICAL→WARN-Stellen (hypothetical, grounding L1+L2) landen schon bei WARN.
- **grounding-layer-2** (`applyGroundingJudgeVerdicts`) bekommt die security/correctness-Exemption (wie L1).
- **RunSummary**: optional `from_critical_demoted` = Anzahl **CRITICAL oder WARN** Findings mit
  `demoted_from_critical`. **loop-driver:** `softPassBlocks |= SOFT-PASS && from_critical_demoted>0` —
  reused die bestehende `softPassPolicy:"block"`-Maschinerie (KEINE neue Terminierung; NICHT über
  ask-once/acknowledgePass routen — die löschen die dirty.flag + re-armen = Loch wieder offen). `ask-once`
  hier wie `block` behandeln.
- **Cache:** `softPassNeedsFindings` erweitern (SOFT-PASS nie counts-only unter G0) **UND** die Cache-
  `schemaVersion` bumpen (`computeCacheKey` "reviewgate.pending.v1"→"…v2"), sonst umgeht ein stale
  Pre-G0-PASS den Fix.
- **FindingSchema** (top-level UND `members[]`): `demoted_from_critical` ergänzen — sonst strippt
  `readPendingReport`'s `safeParse` es beim Round-Trip.

**Reihenfolge (TDD, je RED→GREEN, je eigener Commit):**
1. Schema: `finding.ts` +`demoted_from_critical` (finding + member).
2. Provenance: setzen an den value-judgment-Demotern (hypothetical, grounding L1+L2, critic, reputation
   pure-quality, confidence-floor, reputation-correctness), gated auf from-CRITICAL.
3. Clamp: `demoteOneStep` + die 2 direct-INFO-Pfade clampen bei WARN.
4. grounding-L2 security/correctness-Exemption.
5. Merge: `memberOf` + Repräsentant OR-Propagation.
6. RunSummary `from_critical_demoted` (optional/.default(0)) + `buildRunSummary`.
7. loop-driver `softPassBlocks` + ask-once-Upgrade.
8. Cache: `softPassNeedsFindings` + schemaVersion-bump.
9. report-writer Badge + docs/AGENTS.md (off-ramps + ack-loop-bounded + wording-merge-Caveat).

**Bewusst absichtlich (im Plan begründet, nicht „fixen"):** ack-Loop ist iteration-cap-bounded (fail-safe);
ein from-CRITICAL der per wording-merge in einen high-stakes-Cluster gerät, konvergiert nur per fix
(reject von G0b-Decke abgelehnt) → eskaliert zum Menschen = strikt fail-safe, kein fail-open.

**Intentional zu ändernde Tests:** `orchestrator.test.ts` + `grounding-judge.test.ts` erwarten heute,
dass layer-2-grounding eine security/correctness-CRITICAL demotet — nach G0 bleibt sie blockierend.
Cache-Fixtures wegen schemaVersion-bump prüfen.

**Prozess (CLAUDE.md):** `bunx tsc --noEmit` + `bun run lint` + `bun test` müssen je grün sein, bevor
„done". Danach voller DoD: **codex ×2 + opus ×2** (datei-basierte Prompts, codex im Vordergrund mit
`</dev/null`, Findings in `.review/`; `rm -rf .review/` vor dem Commit). **NICHT** ohne explizite
Freigabe pushen. Fortschritt am Ende im Brain festhalten.

**Gotchas dieser Session:** macOS hat kein `timeout` (Bash-Tool-Timeout nutzen). `agy` taugt NICHT als
DoD-Reviewer (0-Byte agentic-crawl-Hang) — codex oder opus. Nie `git add -A` (trackt `.reviewgate/`).
Der Dogfood-Gate läuft jetzt als codex+claude-code Consensus-Panel; bei Stop-Block dem normalen
Reviewgate-Protokoll folgen.
