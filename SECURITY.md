# Security Policy

Reviewgate is **experimental alpha** software (`0.1.0-alpha`). Read this before
running it on any code you care about.

## ⚠️ Trusted local development only

Reviewgate works by spawning external provider CLIs (Codex, Gemini, Claude,
OpenRouter) as subprocesses and feeding them your working-tree diff. **Native
sandbox isolation is not yet available** — it depends on
`@anthropic-ai/sandbox-runtime`, which is unpublished. The honest default is
`sandbox.mode: "off"`, which runs reviewers **unisolated**. The `"strict"` and
`"permissive"` modes deliberately **fail closed** (refuse to review) rather than
pretend to isolate.

**Therefore:**

- ✅ Use Reviewgate on **your own code** in **trusted local repositories**.
- ❌ Do **not** use it to review untrusted, attacker-controlled, or unknown
  repositories/diffs. A malicious diff could attempt prompt-injection against
  the reviewer LLMs, and the reviewer subprocess has the same filesystem and
  network access you do.

This restriction is lifted once native isolation ships.

## Threat model

What Reviewgate already defends against:

- **Prompt-injection in the diff** — diffs pass through a sanitisation pipeline
  (Unicode NFKC normalisation → injection-marker neutralisation → fenced
  wrapping → high-entropy secret redaction → persona reaffirmation) before they
  reach any reviewer.
- **Self-review / sycophancy** — the host Claude session never reviews its own
  work; a Claude reviewer is downgraded to an adversarial persona.
- **Tampering with results** — every run appends a sha256 hash-chained JSONL
  audit log; `reviewgate audit verify` detects any modification after the fact.
- **Silent failure** — a reviewer that crashes or times out yields `ERROR`
  (block / fail-closed), never a silent pass.

What it does **not** yet defend against:

- Filesystem/network isolation of the reviewer subprocess (see above).
- A reviewer CLI or its model exfiltrating diff contents to its own provider —
  by design the diff is sent to whichever providers you enable. Only enable
  providers you trust with your source.

## Secrets

Reviewgate redacts high-entropy strings from the diff before sending it to
reviewers, but this is best-effort, not a guarantee. Do not rely on it to keep
credentials out of a provider's hands — keep secrets out of your diffs.

## Reporting a vulnerability

Please report security issues **privately**, not via public GitHub issues:

- Open a [GitHub Security Advisory](https://github.com/Codevena/reviewgate/security/advisories/new), or
- email **codevena@proton.me** with `SECURITY` in the subject.

Include reproduction steps and the affected version/commit. We aim to
acknowledge within 7 days. As an alpha-stage solo project there is no formal SLA
yet, but credible reports will be triaged as a priority.
