# Codex host setup and hook trust

Reviewgate can use Codex in two different roles:

- **Codex as a reviewer** — Reviewgate starts the Codex CLI as one independent
  member of the reviewer panel.
- **Codex as the authoring host** — Codex writes the code and native lifecycle
  hooks run Reviewgate when tools mutate the checkout and when Codex tries to
  finish the turn.

This page covers the second role.

## Complete first run

Run the guided setup from the repository you want to protect:

```bash
reviewgate init --host codex
```

Use `--host both` to protect Claude Code and Codex. `init` configures the policy,
installs the selected native hooks, records the initial last-known-good policy
and runs `reviewgate doctor`. To repair hooks without rewriting policy, use:

```bash
reviewgate init --hooks-only --host codex
```

The generated hook file and shims are a **per-checkout installation**. Keep them
local rather than copying them between clones or worktrees: the commands include
an init-time fallback root, and Codex trusts their exact resulting hash. Run init
inside every checkout that should be gated, then trust that checkout's definition.

## Installation is not activation

Codex treats a project hook as repository-supplied code. A malicious repository
could otherwise run arbitrary commands as soon as it is opened. Codex therefore
keeps new or changed non-managed command hooks disabled until the user reviews
and trusts their **exact current hash**.

There are three distinct states:

| State | Meaning | Who controls it |
|---|---|---|
| Installed | `.codex/hooks.json` and `.reviewgate/bin/*` exist | `reviewgate init` |
| Trusted | The current hook definitions were reviewed and their hash approved | The user in Codex `/hooks` |
| Active | The project layer is trusted, hooks are enabled and no managed policy disables them | Codex / workspace administration |

Reviewgate can verify installation, syntax, timeouts and whether the baked binary
is reachable. It cannot read or alter Codex's per-hash trust decision, so
`reviewgate doctor` reports Codex trust as a manual checkpoint rather than
claiming the hook is active.

## Activate Reviewgate in Codex

1. Start or restart Codex in the repository after `reviewgate init`.
2. Open `/hooks` in the Codex CLI.
3. Inspect the Reviewgate project hooks from `.codex/hooks.json`.
4. Trust the exact current definitions.
5. Run `reviewgate doctor` and perform the smoke test from the README.

The generated hooks have deliberately narrow responsibilities:

- `SessionStart` runs `.reviewgate/bin/reset` from the Git root.
- `PostToolUse` runs `.reviewgate/bin/trigger` after supported Bash and
  `apply_patch`/Edit/Write mutations.
- `Stop` runs `.reviewgate/bin/gate`. If the shim is missing or unreachable, the
  hook emits a blocking response instead of silently allowing an unreviewed turn.

Trust is bound to the hook definition, not granted permanently to every future
Reviewgate command. If an update changes the generated hook, Codex marks the new
hash for review and skips it until you approve it again.

## Why Reviewgate does not approve itself

The installer and the coding agent are precisely the parties this checkpoint is
meant to constrain. Letting either one silently approve repository-supplied shell
commands would make the trust prompt meaningless. Codex exposes `/hooks` for the
user-controlled review. It also documents a dangerous one-off trust bypass;
Reviewgate neither invokes nor recommends that bypass.

An AI agent may inspect the generated file, explain every command and report
whether it matches Reviewgate's expected template. The final Codex trust action
still belongs to the user.

## Interpreting Doctor warnings

These two warnings are independent:

- **Codex hook trust cannot be verified** means the files are installed but
  Reviewgate cannot see Codex's private trust decision. It does not mean the hook
  is malformed.
- **Reviewer reputation … demoting** means Reviewgate's local adjudication history
  has placed that reviewer below the configured trust floor after enough samples.
  The provider can still be reachable and run normally. Its uncorroborated
  findings receive the configured reputation safeguards; this is reviewer
  calibration, not a hook or authentication failure.

Inspect the learned reviewer history with:

```bash
reviewgate learn status
```

## Known Codex boundary

Codex documents lifecycle hooks as guardrails, not a complete enforcement
boundary. Rich streaming shell execution is not fully intercepted. Reviewgate
therefore also compares the final HEAD, working-tree fingerprint and separate
configuration-control-plane fingerprint before allowing a clean stop.

Official reference: [OpenAI Codex Hooks](https://learn.chatgpt.com/docs/hooks).
