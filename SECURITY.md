# Security Policy

Reviewgate is **experimental alpha** software (`0.1.0-alpha`). Read this before
running it on any code you care about.

## Security posture

Reviewgate spawns external provider CLIs (Codex, Gemini, Claude, OpenRouter) as
subprocesses and feeds them your working-tree diff.

**Filesystem isolation ships and is opt-in.** With `sandbox.mode: "strict"` or
`"permissive"`, reviewer subprocesses run under OS-level filesystem isolation —
macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap (`bwrap`): the reviewer can
read its working directory, tmp, and its own credentials, but secret paths
(`~/.ssh`, `~/.aws`, `.env`, `~/.netrc`, `~/.git-credentials`, foreign provider
creds) are denied, and writes are restricted to findings + tmp + its own cred dir.
`"strict"` **fails closed** (refuses to review) when the OS sandbox is unavailable;
`"permissive"` runs unisolated with a warning. The **default is `"off"`**.

**The remaining caveats (why we still say "prefer trusted repos"):**

- **Network egress is NOT isolated** on either platform — API reviewers need it, so
  neither Seatbelt nor bwrap host-allowlists network. Once the filesystem is locked
  down this is the material exfiltration vector. Only enable providers you trust
  with your source.
- **Linux does not enforce glob secret-denies** (`*.pem`, `*.key`, `.env*`): the
  bind-mount model can't pattern-match files, so a repo-local `.env`/`*.pem` is
  visible to a Linux reviewer though denied on macOS. (Secret *paths* like `~/.ssh`
  are masked on both.)
- macOS `sandbox-exec` is Apple-deprecated (still functional); Windows is
  unsupported (use `"off"` or WSL2).

**Recommendation:**

- ✅ Use Reviewgate on **your own code**; set `sandbox.mode: "strict"` to isolate the
  reviewer's filesystem access.
- ⚠️ Reviewing **untrusted / attacker-controlled** diffs is higher-risk: a malicious
  diff can attempt prompt-injection (blunted by the sanitiser, not eliminated), and
  network egress is not contained. Do so only with providers and a threat model you
  trust.

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

What it does **not** defend against:

- **Network egress** from the reviewer subprocess — not isolated on either platform
  (by design: API reviewers need network). A reviewer CLI or its model can send the
  diff to its own provider; only enable providers you trust with your source.
- **Linux glob secret-denies** (`*.pem`, `.env*`) — not enforced on Linux (the
  bind-mount model can't pattern-match files), so a repo-local `.env` is readable by
  a Linux reviewer (denied on macOS). Filesystem isolation otherwise ships — see
  *Security posture* above.

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
