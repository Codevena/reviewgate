// src/cli/hook-feedback.ts
// A small, human-facing confirmation for `reviewgate gate` hooks that a person may
// run by hand. When Claude Code invokes a hook the output is piped (non-TTY) and
// must stay silent so it never pollutes the hook protocol — so a message is only
// produced when stdout is an interactive terminal. Currently only `reset` (which
// otherwise exits silently) gets a confirmation; `stop`/`trigger` have their own
// output contracts and stay quiet.
export function hookFeedbackMessage(hook: string, isTTY: boolean): string | null {
  if (!isTTY) return null;
  if (hook === "reset") return "✓ Reviewgate: per-session state reset.";
  return null;
}
