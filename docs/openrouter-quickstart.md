# OpenRouter-only quickstart

This path needs no reviewer CLI. You still need git, a supported coding-agent host
(Claude Code or Codex), the Reviewgate binary and an OpenRouter API key.

## Install and configure

```bash
npm i -g reviewgate@0.1.0-alpha.11
cd your-git-repository
export OPENROUTER_API_KEY='…'
reviewgate init --host both
```

In the guided flow:

1. choose **Custom** setup;
2. select **OpenRouter** as the reviewer;
3. choose the model you want to use;
4. configure upstream routing if that model needs a specific compatible host;
5. finish the sandbox, soft-pass, memory, notification and pre-push questions.

`reviewgate init` writes a data-only `reviewgate.config.ts`, installs the selected
native host hooks, records the initial last-known-good policy and runs Doctor. The
API key stays in `OPENROUTER_API_KEY`; do not put it in the config or commit it.

For Codex, installation is followed by one human activation step: restart Codex
in the repository, open `/hooks`, inspect SessionStart, PostToolUse and Stop, then
trust their exact current hash. Reviewgate cannot approve or read that private
trust decision. Claude Code does not use this Codex-specific checkpoint.

Verify the installation:

```bash
reviewgate config status
reviewgate doctor
```

Expected policy state after the first init is `APPROVED`. Doctor should report at
least one enabled and available reviewer. A single-reviewer warning is honest and
expected in this minimal setup: consensus, cross-provider FP promotion and
reputation demotion need more than one effective reviewer.

## Tested Alpha.11 model route

The recorded 2026-07-13 smoke used:

```ts
export default {
  providers: {
    openrouter: {
      enabled: true,
      openrouterProvider: { only: ["alibaba"] },
    },
  },
  phases: {
    review: {
      reviewers: [{ provider: "openrouter", persona: "security" }],
    },
  },
};
```

The effective default model was `deepseek/deepseek-v4-flash`. On that date,
OpenRouter's `alibaba` upstream accepted Reviewgate's strict structured-response
request. The wizard-suggested `deepseek` upstream accepted the lightweight model
probe but rejected the real review with `This response_format type is unavailable
now`.

This is a dated compatibility observation, not a permanent recommendation.
OpenRouter routes and provider capabilities change. The setup probe currently
proves basic completion only; your first real code review is the authoritative
structured-output smoke. If it defers with a response-format error, select a
schema-capable upstream or another model and repeat the review.

Changing provider routing is a policy-control-plane change. Reviewgate continues
checking code under the last-known-good policy and may require an explicit human
`reviewgate config approve` after the candidate passes under that prior policy.
Never automate that approval.

## Exercise the real loop

After setup, make a small code change through the selected host and end the turn.
The host's Stop hook should run Reviewgate. Outcomes are deliberately distinct:

- `GATE OPEN — PASS`: the configured review completed cleanly;
- `GATE CLOSED`: read `.reviewgate/pending.md`, fix or reason about each blocking
  finding, write the required decision lines and stop again;
- `DEFER` / `ERROR`: the review did not complete; this is not a pass;
- `GATE ESCALATED`: the bounded loop handed the unresolved state to a human.

The [recorded Alpha.11 evidence](evidence.md#reproducible-alpha11-gate-run) shows
the full closed → decision → fix → open sequence without requiring your API key.

## Cost and security

OpenRouter is API-billed according to the selected model and route. Reviewgate
does not promise a zero-cost OpenRouter path. Its filesystem sandbox applies to
subprocess-based reviewer CLIs; OpenRouter is an HTTP adapter. The reviewed diff
and prompt context leave your machine for the selected provider. Network egress
is not isolated by Reviewgate. Read [SECURITY.md](../SECURITY.md) before using
sensitive repositories.
