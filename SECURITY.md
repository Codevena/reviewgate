# Security Policy

Reviewgate is **experimental alpha** software (`0.1.0-alpha`). Read this before
running it on any code you care about.

## Security posture

Reviewgate can spawn Codex, Gemini/agy, Claude Code and OpenCode CLIs and can call
OpenRouter or Ollama over HTTP. Every configured reviewer receives the review
prompt and working-tree diff.

**Filesystem isolation ships and is opt-in, but it is a denylist model — not a
read allowlist.** With `sandbox.mode: "strict"` or `"permissive"`:

- macOS Seatbelt starts from `(allow default)`, denies filesystem writes, then
  re-allows only the exact findings file, run temp and the reviewer's own
  credential directories. It denies known secret paths/globs.
- Linux bubblewrap exposes `/` read-only, binds only those exact targets writable,
  and masks known secret paths.

Consequently, the reviewer may still read host files outside the working directory
unless a deny rule covers them — for example another repository, Documents, browser
state or application data. Known paths such as `~/.ssh`, `~/.aws`, `~/.netrc`,
`~/.git-credentials` and foreign-provider credentials are denied/masked, but the
list is not exhaustive. Broad `.reviewgate/` writes are **not** allowed by default.

`"strict"` fails closed when the OS sandbox is unavailable; `"permissive"` runs
unisolated with a warning. The default is `"off"`.

**The remaining caveats (why we still say "prefer trusted repos"):**

- **Network egress is NOT isolated** on either platform. A local reviewer process
  that can read a file may be able to send it to its provider or another host.
  Only enable providers you trust with both the reviewed source and the reachable
  host data.
- **Linux does not enforce glob secret-denies** (`*.pem`, `*.key`, `.env*`): the
  bind-mount model can't pattern-match files, so a repo-local `.env`/`*.pem` is
  visible to a Linux reviewer though denied on macOS. (Secret *paths* like `~/.ssh`
  are masked on both.)
- macOS `sandbox-exec` is Apple-deprecated (still functional); Windows is
  unsupported (use `"off"` or WSL2).

## Provider execution profiles

Provider risk is intentionally not presented as uniform:

| Provider path | Local execution profile | Main residual risk |
| --- | --- | --- |
| Codex CLI | Review subprocess configured read-only; shell tool disabled | CLI/model receives source; sandbox is still opt-in |
| Claude Code CLI | Reviewer prompt restricts Bash/Edit/Write-style tools | CLI/model receives source; restrictions rely on provider CLI behaviour |
| Gemini/agy | Coding-agent CLI with `--dangerously-skip-permissions`; may read/view files and run tools | Host exploration/tool execution when sandbox is off or incomplete |
| OpenCode | Coding-agent CLI with `--dangerously-skip-permissions` | Host exploration/tool execution when sandbox is off or incomplete |
| OpenRouter | In-process HTTP adapter; no local agent tools | Prompt/diff leaves the host over the network |
| Ollama | In-process HTTP adapter; no local agent tools | Prompt/diff goes to the configured local/cloud endpoint |

Use `sandbox.mode: "strict"` for every subprocess reviewer, especially agy and
OpenCode. For attacker-controlled repositories, prefer a separate container or VM
with an explicit filesystem and network allowlist; the shipped sandbox is not that
boundary.

## Configuration control plane

`reviewgate.config.ts` retains its familiar filename but is parsed as data, not
executed as TypeScript. Only literal objects, arrays and scalar values are allowed.
Imports, function calls, spreads and environment access are rejected.

`reviewgate init` records a last-known-good effective-policy fingerprint. Later
config candidates are kept out of the normal reviewer diff and code continues to
be checked under that approved policy. Provable monotonic strengthenings are
adopted only after a successful pass under the prior policy. Weakening or
non-monotonic changes require a successful prior-policy pass followed by
`reviewgate config approve` in a real interactive TTY. There is no non-interactive
override. A present invalid config never falls back to defaults; it remains a loud,
blocking policy candidate while the last-known-good policy continues reviewing code.
Provider/reviewer additions and deterministic-check commands are deliberately
non-monotonic: they can disclose source, change consensus, invoke agentic tools or
execute a shell command, so they are never auto-adopted as mere "strengthening".

## Agent-host hook boundary

Reviewgate supports native repository hooks for both Claude Code
(`.claude/settings.json`) and Codex (`.codex/hooks.json`). `reviewgate init` merges
its entries without replacing foreign hooks. For Codex, new or changed project
hooks remain disabled until the user reviews and trusts their exact hash through
Codex `/hooks`; Reviewgate never sets or recommends a hook-trust bypass.

For Codex, **installed**, **trusted** and **active** are separate claims:

- installed: the project hook file and Reviewgate shims exist;
- trusted: the user approved the exact current command-hook hash in `/hooks`;
- active: Codex also trusts the project layer, hooks are enabled, and managed
  policy does not disable project hooks.

Reviewgate can verify only the first state plus its own syntax, timeout and binary
reachability invariants. Codex does not expose the user's per-hash trust decision
to Reviewgate, so Doctor deliberately reports that activation as unverifiable.
The installer and the coding agent must not approve their own repository-supplied
commands: doing so would collapse the boundary the trust review exists to provide.
See [Codex host setup and hook trust](docs/codex-host.md).

Codex currently documents `PostToolUse` interception as incomplete for richer
streaming shell execution (`unified_exec`) and other non-shell/non-MCP tools.
Reviewgate therefore does not treat `PostToolUse` as the security boundary: the
Stop path independently compares HEAD, the working-tree content fingerprint and
the config-control-plane fingerprint. A missed mutation trigger still fails toward
a review when the final workspace differs from the last reviewed snapshot.

Lifecycle hooks are guardrails inside the same user account, not an external
security boundary. A same-user agent with unrestricted shell access can edit hook
files, shims or local state. Protected CI, a VM/container boundary or a separate
identity is still required against a deliberately hostile/compromised host agent.

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
- **Self-review / sycophancy** — reviewers are fresh subprocesses, separate from
  the authoring Claude Code or Codex session. A Claude reviewer is tier-downgraded
  only when Claude itself is the authoring host.
- **Tampering with results** — every run appends a sha256 hash-chained JSONL
  audit log; `reviewgate audit verify` detects any modification after the fact.
- **Silent failure** — a reviewer that crashes or times out yields `ERROR`
  or an explicitly labelled bounded defer/escalation, never a clean PASS.

What it does **not** defend against:

- **Network egress** from the reviewer subprocess — not isolated on either platform
  (by design: API reviewers need network). A reviewer CLI or its model can send the
  diff to its own provider; only enable providers you trust with your source.
- **Linux glob secret-denies** (`*.pem`, `.env*`) — not enforced on Linux (the
  bind-mount model can't pattern-match files), so a repo-local `.env` is readable by
  a Linux reviewer (denied on macOS). Filesystem isolation otherwise ships — see
  *Security posture* above.
- **General host reads outside denylisted paths** — the shipped filesystem sandbox
  constrains writes and masks named secrets; it does not expose only the repository.
- **A host coding agent with unrestricted shell/home access** — TTY-only policy
  approval prevents the normal non-interactive CLI path from approving its own
  weakening. The LKG and approval metadata are plain, unsigned local files under
  `.reviewgate/`; an unrestricted same-user shell can edit those files directly.
  This is therefore a procedural human checkpoint, not a cryptographic identity or
  tamper-proof boundary against a compromised account. Use an external trust
  boundary (protected CI, container/VM, or signed review workflow) for that threat.
- **Disabled/untrusted project hooks** — Codex intentionally skips untrusted
  project hooks. Installation is not activation: the human must review them with
  `/hooks`, and an administrator can disable hooks through managed policy.

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
