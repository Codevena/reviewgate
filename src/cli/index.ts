// src/cli/index.ts
import { homedir } from "node:os";
import { defineCommand, runMain } from "citty";
import { fmtMetric } from "../bench/report.ts";
import { controlPlaneStatus } from "../config/control-plane.ts";
import { POLICY_PASS_IDS } from "../core/policy/catalog.ts";
import type { AgentHostSelection } from "../hosts/hooks.ts";
import { repoClaudeHookActive } from "../hosts/user-hooks.ts";
import type { ProviderId } from "../providers/registry.ts";
import { SUPPRESSION_LAYERS } from "../rig/ablate.ts";
import { RigAuthorityError } from "../rig/policy-replay-state.ts";
import { RG_VERSION } from "../version.ts";
import { runAuditVerify } from "./commands/audit.ts";
import {
  parseProviderModels,
  runBenchMatrix,
  runBenchPolicy,
  runBenchReport,
  runBenchRun,
} from "./commands/bench.ts";
import { runBrainList, runBrainRevoke, runBrainShow } from "./commands/brain.ts";
import { formatControlPlaneStatus, runConfigApprove, runConfigStatus } from "./commands/config.ts";
import { runDoctor } from "./commands/doctor.ts";
import {
  runFpAudit,
  runFpClusters,
  runFpList,
  runFpPin,
  runFpShow,
  runFpUnpin,
} from "./commands/fp.ts";
import { runGate, runGateSafe } from "./commands/gate.ts";
import { runInit, runInitUser } from "./commands/init.ts";
import { runLearnStatus } from "./commands/learn-status.ts";
import {
  formatLoreApprovePreflight,
  loreApprovePreflight,
  runLoreApprove,
  runLoreStatus,
  runLoreVerify,
} from "./commands/lore.ts";
import { runPrePush } from "./commands/pre-push.ts";
import { runReport } from "./commands/report.ts";
import { runReset } from "./commands/reset.ts";
import { runReviewPlan } from "./commands/review-plan.ts";
import {
  RigLayerSelectorError,
  runRigAblate,
  runRigHarvest,
  runRigReplay,
  runRigReport,
  runRigRun,
} from "./commands/rig.ts";
import { runSetup } from "./commands/setup.ts";
import { runPolicyDogfoodAttestation, runPolicyStats, runStats } from "./commands/stats.ts";
import { hookFeedbackMessage } from "./hook-feedback.ts";
import { readHookStdin } from "./hook-stdin.ts";
import { validateSince, validateWeek } from "./validate-time-args.ts";

/** Print a one-line CLI error to stderr and exit non-zero (no stack trace). */
function failArg(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

async function runRigAuthorityCommand<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RigLayerSelectorError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(error.exitCode);
    }
    if (!(error instanceof RigAuthorityError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode);
  }
}

// The activity query the user-scoped shims call. Exit 0 = a repo-local Claude hook for
// this event will really fire here, so the user shim stands down; 1 = it will not; 2 = the
// event is missing or unrecognised. Nothing is ever printed: the shims treat every
// non-zero code as "not active", so a bad invocation can only cause a RUN, never a silent
// stand-down. It lives here rather than in bash because the check is structural — a text
// match over settings.json would also accept a foreign command or the wrong event.
const hooks = defineCommand({
  meta: { name: "hooks", description: "Query the installed hook wiring (used by the shims)" },
  subCommands: {
    "repo-hook-active": defineCommand({
      meta: {
        name: "repo-hook-active",
        description: "Exit 0 if a repo-local Claude hook for --event fires in this checkout",
      },
      args: {
        event: {
          type: "string",
          description: "Stop | PostToolUse | SessionStart",
        },
      },
      run({ args }) {
        const event = typeof args.event === "string" ? args.event : "";
        if (event !== "Stop" && event !== "PostToolUse" && event !== "SessionStart") {
          process.exit(2);
        }
        process.exit(repoClaudeHookActive(process.cwd(), event) ? 0 : 1);
      },
    }),
  },
});

const init = defineCommand({
  meta: {
    name: "init",
    description: "Complete first-run setup: policy, agent hosts, hooks, LKG and health check",
  },
  args: {
    mode: { type: "string", default: "agent-loop" },
    host: {
      type: "string",
      description: "Agent host: claude, codex, or both (interactive default: prompt)",
    },
    quick: {
      type: "boolean",
      description: "Use the recommended policy preset without interactive policy questions",
    },
    "hooks-only": {
      type: "boolean",
      description: "Repair/reinstall host hooks without changing configuration",
    },
    user: {
      type: "boolean",
      description:
        "Install USER-scoped hooks in ~/.claude/settings.json (fire in every repo; repo-local hooks win where present)",
    },
    remove: {
      type: "boolean",
      description: "With --user: remove the user-scoped hooks and shims again",
    },
    "skip-doctor": {
      type: "boolean",
      description: "Skip the final health check",
    },
  },
  async run({ args }) {
    // S4: user scope is its own mode and returns BEFORE any repository work — it must not
    // create .reviewgate/, arm anything, or touch the CWD.
    if (args.user === true) {
      process.exit(runInitUser({ home: homedir(), remove: args.remove === true }));
    }
    if (args.remove === true) failArg("--remove is only meaningful together with --user");
    const rawHost = typeof args.host === "string" ? args.host : undefined;
    if (rawHost && rawHost !== "claude" && rawHost !== "codex" && rawHost !== "both") {
      failArg(`invalid --host "${rawHost}": expected claude, codex, or both`);
    }
    const host = rawHost as AgentHostSelection | undefined;
    if (args["hooks-only"] === true) {
      const result = await runInit({
        repoRoot: process.cwd(),
        mode: args.mode as "agent-loop",
        host: host ?? "both",
      });
      process.stdout.write(
        `Reviewgate hooks installed for ${result.installedHosts.join(" + ")}.\n` +
          `${result.prePushHook.installed ? "✔" : "ℹ"} pre-push: ${result.prePushHook.note}\n`,
      );
      for (const warning of result.warnings) process.stdout.write(`⚠ ${warning}\n`);
      if (result.installedHosts.includes("codex")) {
        process.stdout.write(
          "Codex activation: start or restart Codex in this repo, open `/hooks`, inspect SessionStart/PostToolUse/Stop, and trust their exact current hash. Installation alone does not activate new project hooks.\n",
        );
      }
      return;
    }

    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    process.exit(
      await runSetup({
        repoRoot: process.cwd(),
        install: true,
        projectOnly: true,
        commandName: "reviewgate init",
        quick: args.quick === true || !interactive,
        keepExistingOnQuick: !interactive,
        skipDoctor: args["skip-doctor"] === true,
        ...(host ? { host } : {}),
      }),
    );
  },
});

const gate = defineCommand({
  meta: { name: "gate", description: "Run the review gate (internal hook entry point)" },
  args: { hook: { type: "string", default: "stop" } },
  async run({ args }) {
    const hook = args.hook as "trigger" | "stop" | "reset";
    // Backstop (M-A0.1): a truly uncaught exception (Node/Bun's default is to
    // terminate the process → EMPTY stdout → Claude Code reads the Stop hook as
    // "allow" → un-reviewed turn = fail-OPEN). For a STOP hook, intercept it and
    // emit a block instead (fail CLOSED — strictly better than dying silently).
    // Only for `stop`; trigger/reset are not the review and must not block.
    if (hook === "stop") {
      const failClosed = (err: unknown): never => {
        const msg = err instanceof Error ? err.message : String(err);
        const reason = `🔴 Reviewgate · GATE CLOSED — internal error: ${msg}. Run \`reviewgate doctor\`; end your turn again to retry.`;
        try {
          process.stdout.write(JSON.stringify({ decision: "block", reason }));
        } catch {
          /* stdout gone — nothing more we can do */
        }
        process.exit(0);
      };
      process.on("uncaughtException", failClosed);
      // Mirror the uncaughtException backstop for a rejected fire-and-forget promise
      // (no .catch()). Without this, an unhandled rejection terminates the process
      // with EMPTY stdout → Claude Code reads the Stop hook as "allow" → the turn
      // ends UN-reviewed = fail-OPEN, exactly what this gate prevents. Fail CLOSED.
      process.on("unhandledRejection", failClosed);
    }
    // runGateSafe wraps the WHOLE pipeline (incl. readHookStdin) in a
    // fail-closed catch so no awaited throw can escape to citty. Never block on
    // an interactive TTY — only the piped hook payload is read (see readHookStdin).
    const res = await runGateSafe({ repoRoot: process.cwd(), hook, hookStdinRaw: "" }, async () => {
      const raw = await readHookStdin();
      return runGate({ repoRoot: process.cwd(), hook, hookStdinRaw: raw });
    });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    // Interactive-only confirmation (a human running the hook by hand); silent
    // under a real piped hook so the hook protocol is never polluted.
    const feedback = hookFeedbackMessage(hook, Boolean(process.stdout.isTTY));
    if (feedback) process.stdout.write(`${feedback}\n`);
    process.exit(res.exitCode);
  },
});

const prePush = defineCommand({
  meta: {
    name: "pre-push",
    description:
      "Git pre-push hook entry point: WARN (never block) when the pushed commit has no recorded clean Reviewgate PASS.",
  },
  async run() {
    // git feeds the pre-push hook its ref lines on stdin; read them (best-effort —
    // a TTY/no-stdin invocation just yields no shas → no warning). Always exit 0.
    const raw = await readHookStdin();
    const res = await runPrePush({ repoRoot: process.cwd(), stdinRaw: raw });
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.exitCode);
  },
});

const doctor = defineCommand({
  meta: { name: "doctor", description: "Health-check Reviewgate dependencies" },
  async run() {
    const exitCode = await runDoctor({ repoRoot: process.cwd() });
    process.exit(exitCode);
  },
});

const config = defineCommand({
  meta: { name: "config", description: "Inspect and approve the gate policy control plane" },
  subCommands: {
    status: defineCommand({
      meta: {
        name: "status",
        description: "Show approved and pending gate-policy fingerprints",
      },
      async run() {
        const result = await runConfigStatus(process.cwd());
        process.stdout.write(result.stdout);
        process.exit(result.exitCode);
      },
    }),
    approve: defineCommand({
      meta: {
        name: "approve",
        description: "Explicitly approve a policy candidate after its last-known-good review",
      },
      async run() {
        // No --yes escape hatch: this forces an interactive checkpoint on the
        // normal Claude Code Bash path. It is intentionally procedural, not a
        // cryptographic identity boundary against same-user shell/state access;
        // SECURITY.md documents that limit explicitly.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stderr.write(
            "Error: policy approval requires a real interactive terminal (TTY); no non-interactive override exists.\n",
          );
          process.exit(1);
        }
        const status = await controlPlaneStatus(process.cwd());
        process.stdout.write(`${formatControlPlaneStatus(status)}\n`);
        if (!status.challenge) {
          process.stdout.write(
            status.state?.pending
              ? "This candidate is not eligible for human approval yet; follow the Next step above.\n"
              : "No policy change requires approval.\n",
          );
          process.exit(0);
        }
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // Race the answer against the interface closing: rl.question() never
        // settles on EOF (Ctrl-D / closed stdin), so awaiting it bare would drain
        // the event loop and exit 0 without approving anything. `null` = no
        // answer, which runConfigApprove turns into an explicit exit 1.
        const answer = await new Promise<string | null>((resolve) => {
          let settled = false;
          const finish = (v: string | null) => {
            if (settled) return;
            settled = true;
            resolve(v);
          };
          rl.on("close", () => finish(null));
          rl.question(`Type exactly "${status.challenge}" to approve: `).then(
            (a) => finish(a),
            () => finish(null),
          );
        });
        rl.close();
        const result = await runConfigApprove(
          process.cwd(),
          answer === null ? null : answer.trim(),
        );
        (result.exitCode === 0 ? process.stdout : process.stderr).write(result.stdout);
        process.exit(result.exitCode);
      },
    }),
  },
});

const reset = defineCommand({
  meta: {
    name: "reset",
    description:
      "Re-arm the gate: clear this session's review state (pending findings, decisions, escalation, session state). Learned memory (FP-ledger, brain) is preserved.",
  },
  async run() {
    // No stdin read, no --hook: this is the user-facing alias for the
    // SessionStart reset path. Shares handleReset → 1:1 parity.
    process.exit(await runReset({ repoRoot: process.cwd() }));
  },
});

const audit = defineCommand({
  meta: { name: "audit", description: "Audit utilities" },
  subCommands: {
    verify: defineCommand({
      meta: {
        name: "verify",
        description: "Verify the audit log's hash chain is intact (tamper check)",
      },
      args: {
        file: {
          type: "string",
          required: true,
          description: "Audit .jsonl file to verify",
        },
      },
      async run({ args }) {
        const exitCode = await runAuditVerify({ file: args.file as string });
        process.exit(exitCode);
      },
    }),
  },
});

const reviewPlan = defineCommand({
  meta: {
    name: "review-plan",
    description: "Review a plan/spec markdown file (one-shot, committed or not)",
  },
  args: { file: { type: "positional", required: true, description: "Path(s) to plan file(s)" } },
  async run({ args }) {
    const files = (args._ ?? []).filter((s) => typeof s === "string" && s.length > 0);
    const res = await runReviewPlan({ repoRoot: process.cwd(), files });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.exitCode);
  },
});

const brain = defineCommand({
  meta: { name: "brain", description: "Brain entry management" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List brain (repo-memory) entries by stage" },
      args: {
        filter: {
          type: "string",
          description: "Filter by stage (active|candidate|stale|archived)",
        },
      },
      async run({ args }) {
        const filter = typeof args.filter === "string" ? args.filter : undefined;
        const exitCode = await runBrainList({
          repoRoot: process.cwd(),
          ...(filter !== undefined ? { filter } : {}),
        });
        process.exit(exitCode);
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show a single brain entry by id" },
      args: {
        id: { type: "string", required: true, description: "Brain entry id (from `brain list`)" },
      },
      async run({ args }) {
        const exitCode = await runBrainShow({ repoRoot: process.cwd(), id: args.id as string });
        process.exit(exitCode);
      },
    }),
    revoke: defineCommand({
      meta: {
        name: "revoke",
        description: "Revoke (archive) a brain entry so it stops being recalled",
      },
      args: {
        id: { type: "string", required: true, description: "Brain entry id (from `brain list`)" },
      },
      async run({ args }) {
        const exitCode = await runBrainRevoke({ repoRoot: process.cwd(), id: args.id as string });
        process.exit(exitCode);
      },
    }),
  },
});

const lore = defineCommand({
  meta: {
    name: "lore",
    description: "Per-repo curated project knowledge (lore, draft->canon) inspection",
  },
  subCommands: {
    status: defineCommand({
      meta: {
        name: "status",
        description:
          "Read-only table of lore entries (id, status, state, anchors) + totals; exit 0 always",
      },
      async run() {
        process.exit(await runLoreStatus({ repoRoot: process.cwd() }));
      },
    }),
    verify: defineCommand({
      meta: {
        name: "verify",
        description:
          "Recompute verified_tree/verified_at for one or more lore entries (or --all) and write them back; exit 1 if any entry errors",
      },
      args: {
        slug: {
          type: "positional",
          required: false,
          description: "Lore entry id(s) to verify (omit when using --all)",
        },
        all: { type: "boolean", description: "Verify every entry under .reviewgate/lore/" },
      },
      async run({ args }) {
        const all = args.all === true;
        const slugs = (args._ ?? []).filter((s) => typeof s === "string" && s.length > 0);
        process.exit(
          await runLoreVerify({
            repoRoot: process.cwd(),
            all,
            slugs,
          }),
        );
      },
    }),
    approve: defineCommand({
      meta: {
        name: "approve",
        description:
          "Approve a canon lore entry so reviewers may trust it (interactive; writes .reviewgate/lore/approvals.jsonl)",
      },
      args: {
        slug: {
          type: "positional",
          required: true,
          description: "Lore entry id to approve",
        },
      },
      async run({ args }) {
        // TTY-only, no --yes escape hatch — same procedural checkpoint as
        // `config approve`: no agent can run this, which is the entire point of
        // the canon trust boundary. Not a cryptographic identity boundary
        // against same-user shell access; SECURITY.md documents that limit.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stderr.write(
            "Error: lore approval requires a real interactive terminal (TTY); no non-interactive override exists.\n",
          );
          process.exit(1);
        }
        const slug = String(args.slug);
        const pre = loreApprovePreflight(process.cwd(), slug);
        process.stdout.write(formatLoreApprovePreflight(pre));
        if (!pre.eligible || !pre.challenge) {
          // Already-approved is a no-op, not a failure; everything else is.
          process.exit(pre.alreadyApproved ? 0 : 1);
        }
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // Race the answer against the interface closing: rl.question() never
        // settles on EOF (Ctrl-D / closed stdin), so awaiting it bare would drain
        // the event loop and exit 0 with nothing written. `null` = no answer,
        // which runLoreApprove turns into an explicit exit 1.
        const answer = await new Promise<string | null>((resolve) => {
          let settled = false;
          const finish = (v: string | null) => {
            if (settled) return;
            settled = true;
            resolve(v);
          };
          rl.on("close", () => finish(null));
          rl.question(`Type exactly "${pre.challenge}" to approve: `).then(
            (a) => finish(a),
            () => finish(null),
          );
        });
        rl.close();
        process.exit(
          runLoreApprove({
            repoRoot: process.cwd(),
            slug,
            confirmation: answer === null ? null : answer.trim(),
          }),
        );
      },
    }),
  },
});

const fp = defineCommand({
  meta: { name: "fp", description: "FP-ledger (known false positives) management" },
  subCommands: {
    list: defineCommand({
      meta: {
        name: "list",
        description: "List FP-ledger entries (known false positives) by stage",
      },
      args: {
        filter: { type: "string", description: "Filter by stage (candidate|active|sticky)" },
      },
      async run({ args }) {
        const filter = typeof args.filter === "string" ? args.filter : undefined;
        process.exit(
          await runFpList({ repoRoot: process.cwd(), ...(filter !== undefined ? { filter } : {}) }),
        );
      },
    }),
    show: defineCommand({
      meta: { name: "show", description: "Show a single FP-ledger entry by id" },
      args: {
        id: { type: "string", required: true, description: "FP id, e.g. FP-001 (from `fp list`)" },
      },
      async run({ args }) {
        process.exit(await runFpShow({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    pin: defineCommand({
      meta: {
        name: "pin",
        description: "Pin an entry as a sticky known-FP so matching findings are always suppressed",
      },
      args: {
        id: { type: "string", description: "FP id to pin, e.g. FP-001 (from `fp list`)" },
        signature: { type: "string", description: "Pin by signature instead of id" },
        by: { type: "string", description: "Who pinned it (recorded for audit)" },
      },
      async run({ args }) {
        process.exit(
          await runFpPin({
            repoRoot: process.cwd(),
            ...(typeof args.id === "string" ? { id: args.id } : {}),
            ...(typeof args.signature === "string" ? { signature: args.signature } : {}),
            ...(typeof args.by === "string" ? { by: args.by } : {}),
          }),
        );
      },
    }),
    unpin: defineCommand({
      meta: { name: "unpin", description: "Remove a pin so the entry reverts to its earned stage" },
      args: {
        id: { type: "string", required: true, description: "FP id to unpin, e.g. FP-001" },
      },
      async run({ args }) {
        process.exit(await runFpUnpin({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    audit: defineCommand({
      meta: {
        name: "audit",
        description: "Print FP-ledger health/stats (entries per stage, pins)",
      },
      async run() {
        process.exit(await runFpAudit({ repoRoot: process.cwd() }));
      },
    }),
    clusters: defineCommand({
      meta: {
        name: "clusters",
        description:
          "F3 Phase 1 — derived (rule_id_token0 × file) view over the FP ledger; read-only, no schema change. --file <substr> filters by path.",
      },
      args: { file: { type: "string" } },
      async run({ args }) {
        const file = typeof args.file === "string" ? args.file : undefined;
        process.exit(
          await runFpClusters({
            repoRoot: process.cwd(),
            ...(file !== undefined ? { file } : {}),
          }),
        );
      },
    }),
  },
});

const stats = defineCommand({
  meta: {
    name: "stats",
    description: "Show review stats (verdicts, cost, reviewers, learn-state)",
  },
  args: { since: { type: "string" }, last: { type: "string" }, json: { type: "boolean" } },
  subCommands: {
    policy: defineCommand({
      meta: {
        name: "policy",
        description:
          "Validate no-provider policy counterfactual evidence and atomically publish its report; authority failures exit 4.",
      },
      args: {
        preregistration: {
          type: "string",
          description: "Committed policy measurement JSON (required for direct policy analysis)",
        },
        bench: {
          type: "string",
          description: "Authoritative Bench bundle JSON (required for direct policy analysis)",
        },
        rig: {
          type: "string",
          description:
            "Authoritative Rig scenario manifest JSON (required for direct policy analysis)",
        },
        out: {
          type: "string",
          description: "Absent attempt directory to publish (required for direct policy analysis)",
        },
      },
      async run({ args }) {
        for (const name of ["preregistration", "bench", "rig", "out"] as const) {
          if (typeof args[name] !== "string" || args[name].length === 0) {
            process.stderr.write(`Missing required argument: --${name}\n`);
            process.exit(2);
          }
        }
        const result = await runPolicyStats({
          repoRoot: process.cwd(),
          preregistration: args.preregistration as string,
          bench: args.bench as string,
          rig: args.rig as string,
          out: args.out as string,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
      subCommands: {
        "attest-dogfood": defineCommand({
          meta: {
            name: "attest-dogfood",
            description:
              "TTY-only human attestation for a frozen dogfood manifest; prints the full dossier before its exact challenge.",
          },
          args: {
            "input-manifest": {
              type: "string",
              required: true,
              description: "Frozen content-addressed dogfood input manifest",
            },
            adjudication: {
              type: "string",
              required: true,
              description: "JSON draft containing the human TP/FP adjudication rows",
            },
            actor: {
              type: "string",
              required: true,
              description: "Explicit human attestation actor",
            },
            out: {
              type: "string",
              required: true,
              description: "Artifact root for the immutable attestation",
            },
          },
          async run({ args }) {
            const result = await runPolicyDogfoodAttestation({
              repoRoot: process.cwd(),
              inputManifest: args["input-manifest"] as string,
              adjudication: args.adjudication as string,
              actor: args.actor as string,
              out: args.out as string,
            });
            if (result.exitCode === 0 && result.artifact !== undefined) {
              process.stdout.write(`Dogfood attestation written: ${result.artifact.ref}\n`);
            }
            process.exit(result.exitCode);
          },
        }),
      },
    }),
  },
  async run({ args }) {
    const since = typeof args.since === "string" ? args.since : undefined;
    if (since !== undefined) {
      const err = validateSince(since);
      if (err) failArg(err);
    }
    const last = typeof args.last === "string" ? Number(args.last) : undefined;
    const output = await runStats({
      repoRoot: process.cwd(),
      ...(since !== undefined ? { since } : {}),
      ...(last !== undefined && Number.isFinite(last) ? { last } : {}),
      json: args.json === true,
    });
    process.stdout.write(`${output}\n`);
  },
});

const report = defineCommand({
  meta: {
    name: "report",
    description: "Generate a weekly review report (Markdown + .reviewgate/reports/<iso>.md)",
  },
  args: { week: { type: "string" }, json: { type: "boolean" } },
  async run({ args }) {
    const week = typeof args.week === "string" ? args.week : undefined;
    if (week !== undefined) {
      const err = validateWeek(week);
      if (err) failArg(err);
    }
    const output = await runReport({
      repoRoot: process.cwd(),
      ...(week !== undefined ? { week } : {}),
      json: args.json === true,
    });
    process.stdout.write(`${output}\n`);
  },
});

const setup = defineCommand({
  meta: {
    name: "setup",
    description: "Alias for the interactive init wizard; --global remains config-only",
  },
  args: {
    global: { type: "boolean" },
    print: { type: "boolean" },
    host: { type: "string", description: "Agent host: claude, codex, or both" },
    quick: { type: "boolean" },
    "skip-doctor": { type: "boolean" },
  },
  async run({ args }) {
    const rawHost = typeof args.host === "string" ? args.host : undefined;
    if (rawHost && rawHost !== "claude" && rawHost !== "codex" && rawHost !== "both") {
      failArg(`invalid --host "${rawHost}": expected claude, codex, or both`);
    }
    process.exit(
      await runSetup({
        repoRoot: process.cwd(),
        global: args.global === true,
        print: args.print === true,
        install: args.global !== true && args.print !== true,
        projectOnly: args.global !== true,
        commandName: "reviewgate setup",
        quick: args.quick === true,
        skipDoctor: args["skip-doctor"] === true,
        ...(rawHost ? { host: rawHost as AgentHostSelection } : {}),
      }),
    );
  },
});

const learn = defineCommand({
  meta: {
    name: "learn",
    description: "Self-learning subsystem status (brain, FP-ledger, reputation, proposal pools)",
  },
  subCommands: {
    status: defineCommand({
      meta: {
        name: "status",
        description:
          "Snapshot every self-learning subsystem: brain entries, cross-run candidates, F2 proposal pools, curator decisions, FP ledger + clusters, reviewer reputation. --since <ISO> defaults to 30d. --json for machine output.",
      },
      args: { since: { type: "string" }, json: { type: "boolean" } },
      async run({ args }) {
        const since = typeof args.since === "string" ? args.since : undefined;
        if (since !== undefined) {
          const err = validateSince(since);
          if (err) failArg(err);
        }
        process.exit(
          await runLearnStatus({
            repoRoot: process.cwd(),
            ...(since !== undefined ? { since } : {}),
            json: args.json === true,
          }),
        );
      },
    }),
  },
});

const bench = defineCommand({
  meta: {
    name: "bench",
    description: "Benchmark the reviewer panel against a labelled ground-truth corpus",
  },
  subCommands: {
    policy: defineCommand({
      meta: {
        name: "policy",
        description:
          "Capture one live baseline and no-provider offline policy counterfactuals from a committed preregistration.",
      },
      args: {
        preregistration: {
          type: "string",
          required: true,
          description: "Committed policy measurement preregistration JSON",
        },
        out: { type: "string", required: true, description: "Absent immutable Bench bundle path" },
      },
      async run({ args }) {
        const result = await runBenchPolicy({
          repoRoot: process.cwd(),
          preregistration: args.preregistration as string,
          out: args.out as string,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    }),
    run: defineCommand({
      meta: {
        name: "run",
        description:
          "Run every case in a corpus and write a reviewgate.bench.result.v1 JSON (precision/recall/FP-rate + per-provider + provenance)",
      },
      args: {
        corpus: {
          type: "string",
          required: true,
          description: "Corpus directory (dir of case dirs)",
        },
        out: { type: "string", required: true, description: "Output results JSON path" },
        providers: {
          type: "string",
          description:
            "Comma-separated reviewer PANEL, e.g. codex,gemini,claude-code (1 vs. N reviewers). Omitted → single codex.",
        },
        window: { type: "string", description: "Line-match window radius (default 5)" },
        "include-advisory": {
          type: "boolean",
          description: "Fold INFO/advisory findings into scoring",
        },
        "no-cache": {
          type: "boolean",
          description:
            "No-op in P1: bench always measures cold (the review cache is force-disabled because a cache hit omits the per-provider raw layer). Accepted for forward-compat.",
        },
        "min-clean": { type: "string", description: "Quality-gate floor on scored clean cases" },
        "min-seeded": { type: "string", description: "Quality-gate floor on scored seeded cases" },
        "max-failed-frac": {
          type: "string",
          description: "Max review-error fraction before benchmark-invalid (default 0.1)",
        },
        repeat: {
          type: "string",
          description:
            "Run the corpus K times; report mean ± spread per metric (tames LLM variance)",
        },
        critic: {
          type: "string",
          description: "Enable the post-review LLM critic with this provider (e.g. openrouter)",
        },
        "critic-model": {
          type: "string",
          description: "Exact model used by the critic (recorded in provenance)",
        },
        "provider-model": {
          type: "string",
          description:
            "Pin a reviewer's model, e.g. opencode=alibaba-token-plan/qwen3.8-max (comma-separated for several; recorded in provenance)",
        },
        "critic-openrouter-provider": {
          type: "string",
          description: "Pinned OpenRouter upstream slug for the critic (for example alibaba)",
        },
        "critic-max-attempts": {
          type: "string",
          description: "Maximum critic completions per eligible case (benchmark only; default 1)",
        },
        "reviewer-max-attempts": {
          type: "string",
          description:
            "Maximum reviewer invocations per configured reviewer/case (benchmark only; default 1)",
        },
        "max-provider-calls": {
          type: "string",
          description: "Hard ceiling on paid/quota provider calls",
        },
        "max-output-tokens": {
          type: "string",
          description: "Hard OpenRouter output-token ceiling",
        },
        "no-scope-to-diff": {
          type: "boolean",
          description: "Ablation: score the whole file, not just changed hunks",
        },
        "confidence-floor": {
          type: "string",
          description: "Ablation: low-confidence demote floor (0 disables)",
        },
        "no-reputation": { type: "boolean", description: "Ablation: disable reputation demote" },
      },
      async run({ args }) {
        const num = (v: unknown): number | undefined => {
          if (typeof v !== "string" || v.length === 0) return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const providers =
          typeof args.providers === "string" && args.providers.length > 0
            ? (args.providers
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean) as ProviderId[])
            : undefined;
        const window = num(args.window);
        const minClean = num(args["min-clean"]);
        const minSeeded = num(args["min-seeded"]);
        const maxFailedFrac = num(args["max-failed-frac"]);
        const repeat = num(args.repeat);
        const maxProviderCalls = num(args["max-provider-calls"]);
        const maxOutputTokens = num(args["max-output-tokens"]);
        const criticMaxAttempts = num(args["critic-max-attempts"]);
        const reviewerMaxAttempts = num(args["reviewer-max-attempts"]);
        const confidenceFloor = num(args["confidence-floor"]);
        const suppressors = {
          ...(typeof args.critic === "string" && args.critic.length > 0
            ? { critic: args.critic.trim() as ProviderId }
            : {}),
          ...(confidenceFloor !== undefined ? { confidenceFloor } : {}),
          ...(args["no-scope-to-diff"] === true ? { scopeToDiff: false } : {}),
          ...(args["no-reputation"] === true ? { reputation: false } : {}),
        };
        const res = await runBenchRun({
          repoRoot: process.cwd(),
          corpus: args.corpus as string,
          out: args.out as string,
          ...(providers ? { providers } : {}),
          ...(window !== undefined ? { window } : {}),
          includeAdvisory: args["include-advisory"] === true,
          ...(minClean !== undefined ? { minClean } : {}),
          ...(minSeeded !== undefined ? { minSeeded } : {}),
          ...(maxFailedFrac !== undefined ? { maxFailedFrac } : {}),
          ...(repeat !== undefined ? { repeat } : {}),
          ...(typeof args["critic-model"] === "string"
            ? { criticModel: args["critic-model"].trim() }
            : {}),
          ...(typeof args["provider-model"] === "string" && args["provider-model"].trim()
            ? { providerModels: parseProviderModels(args["provider-model"].trim()) }
            : {}),
          ...(typeof args["critic-openrouter-provider"] === "string"
            ? {
                criticOpenrouterProvider: {
                  only: [args["critic-openrouter-provider"].trim()],
                  allowFallbacks: false,
                },
              }
            : {}),
          ...(maxProviderCalls !== undefined ? { maxProviderCalls } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(criticMaxAttempts !== undefined ? { criticMaxAttempts } : {}),
          ...(reviewerMaxAttempts !== undefined ? { reviewerMaxAttempts } : {}),
          ...(Object.keys(suppressors).length > 0 ? { suppressors } : {}),
        });
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.exitCode);
      },
    }),
    report: defineCommand({
      meta: {
        name: "report",
        description:
          "Render a saved bench results JSON to a terminal table + a paste-ready markdown block",
      },
      args: {
        file: { type: "positional", required: true, description: "Path to a results JSON" },
        markdown: { type: "boolean", description: "Print only the markdown block (for piping)" },
      },
      async run({ args }) {
        const res = await runBenchReport({
          repoRoot: process.cwd(),
          file: args.file as string,
          markdown: args.markdown === true,
        });
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.exitCode);
      },
    }),
    matrix: defineCommand({
      meta: {
        name: "matrix",
        description:
          "Run exact internal policy ablations over captured baseline responses and print per-pass deltas",
      },
      args: {
        corpus: { type: "string", required: true, description: "Corpus directory" },
        out: { type: "string", required: true, description: "Output matrix JSON path" },
        ablate: {
          type: "string",
          required: true,
          description:
            "Comma-separated closed catalog IDs (e.g. evidence.fact-location); legacy aliases accepted for compatibility: critic,confidence-floor,reputation,scope-to-diff",
        },
        providers: {
          type: "string",
          description: "Reviewer panel, e.g. codex,gemini,claude-code (omitted → single codex)",
        },
        critic: {
          type: "string",
          description: "Critic provider enabled in the baseline (required to ablate `critic`)",
        },
        "critic-model": { type: "string", description: "Exact critic model" },
        "critic-openrouter-provider": {
          type: "string",
          description: "Pinned OpenRouter upstream slug for the critic",
        },
        "critic-max-attempts": {
          type: "string",
          description: "Maximum critic completions per eligible case (benchmark only; default 1)",
        },
        "reviewer-max-attempts": {
          type: "string",
          description:
            "Maximum reviewer invocations per configured reviewer/case (benchmark only; default 1)",
        },
        "max-provider-calls": { type: "string", description: "Shared hard call ceiling" },
        "max-output-tokens": { type: "string", description: "OpenRouter output ceiling" },
        authoritative: {
          type: "boolean",
          description: "Require complete paired trace and evidence validation",
        },
        preregistration: { type: "string", description: "Committed preregistration JSON" },
        "min-clean": { type: "string", description: "Required distinct clean cases" },
        "min-seeded": { type: "string", description: "Required distinct seeded cases" },
        "max-failed-frac": {
          type: "string",
          description: "Maximum review-error fraction",
        },
        repeat: { type: "string", description: "Run each variant K times (mean pooled)" },
        window: { type: "string", description: "Line-match window radius (default 5)" },
        "include-advisory": { type: "boolean" },
      },
      async run({ args }) {
        const num = (v: unknown): number | undefined => {
          if (typeof v !== "string" || v.length === 0) return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        const csv = (v: unknown): string[] =>
          typeof v === "string" && v.length > 0
            ? v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
        const providers = csv(args.providers) as ProviderId[];
        const window = num(args.window);
        const repeat = num(args.repeat);
        const maxProviderCalls = num(args["max-provider-calls"]);
        const maxOutputTokens = num(args["max-output-tokens"]);
        const criticMaxAttempts = num(args["critic-max-attempts"]);
        const reviewerMaxAttempts = num(args["reviewer-max-attempts"]);
        const minClean = num(args["min-clean"]);
        const minSeeded = num(args["min-seeded"]);
        const maxFailedFrac = num(args["max-failed-frac"]);
        const res = await runBenchMatrix({
          repoRoot: process.cwd(),
          corpus: args.corpus as string,
          out: args.out as string,
          ablate: csv(args.ablate),
          ...(providers.length > 0 ? { providers } : {}),
          ...(typeof args.critic === "string" && args.critic.length > 0
            ? { criticProvider: args.critic.trim() as ProviderId }
            : {}),
          ...(typeof args["critic-model"] === "string"
            ? { criticModel: args["critic-model"].trim() }
            : {}),
          ...(typeof args["critic-openrouter-provider"] === "string"
            ? {
                criticOpenrouterProvider: {
                  only: [args["critic-openrouter-provider"].trim()],
                  allowFallbacks: false,
                },
              }
            : {}),
          ...(maxProviderCalls !== undefined ? { maxProviderCalls } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...(criticMaxAttempts !== undefined ? { criticMaxAttempts } : {}),
          ...(reviewerMaxAttempts !== undefined ? { reviewerMaxAttempts } : {}),
          ...(minClean !== undefined ? { minClean } : {}),
          ...(minSeeded !== undefined ? { minSeeded } : {}),
          ...(maxFailedFrac !== undefined ? { maxFailedFrac } : {}),
          authoritative: args.authoritative === true,
          ...(typeof args.preregistration === "string"
            ? { preregistration: args.preregistration }
            : {}),
          ...(repeat !== undefined ? { repeat } : {}),
          ...(window !== undefined ? { window } : {}),
          includeAdvisory: args["include-advisory"] === true,
        });
        if (res.stdout) process.stdout.write(res.stdout);
        if (res.stderr) process.stderr.write(res.stderr);
        process.exit(res.exitCode);
      },
    }),
  },
});

const rig = defineCommand({
  meta: {
    name: "rig",
    description:
      "Longitudinal effectiveness rig: drive a headless agent through a scripted, defect-seeded run and measure the gate as a loop (what bench, running each case fresh, structurally cannot)",
  },
  subCommands: {
    run: defineCommand({
      meta: {
        name: "run",
        description:
          "Drive the turn script against this repo, snapshotting .reviewgate/ after every turn. Requires REVIEWGATE_CASSETTE=record:<path>. COSTS REAL AGENT QUOTA.",
      },
      args: {
        script: { type: "string", required: true, description: "Turn-script JSON path" },
        out: { type: "string", required: true, description: "Output directory for snapshots" },
        "max-turns": {
          type: "string",
          description: "Stop after N turns (default: every turn in the script)",
        },
      },
      async run({ args }) {
        const maxTurnsRaw = args["max-turns"];
        const maxTurns = maxTurnsRaw === undefined ? undefined : Number(maxTurnsRaw);
        if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
          console.error("reviewgate rig run: --max-turns must be a positive integer");
          process.exit(2);
        }
        const manifest = await runRigRun({
          // `as string` matches the existing bench commands: citty types every arg widely
          // even when `required: true`, and it enforces presence at parse time.
          scriptPath: args.script as string,
          outDir: args.out as string,
          repoRoot: process.cwd(),
          // Conditional spread, not `maxTurns`: exactOptionalPropertyTypes rejects an
          // explicit undefined on an optional property.
          ...(maxTurns === undefined ? {} : { maxTurns }),
          cassetteEnv: process.env.REVIEWGATE_CASSETTE,
        });
        process.stdout.write(
          `rig run complete: ${manifest.turns.length} turn(s) → ${manifest.outDir}/manifest.json\n`,
        );
      },
    }),
    harvest: defineCommand({
      meta: {
        name: "harvest",
        description:
          "Fold a run's per-turn snapshots into one reviewgate.rig.result.v1 (M1–M6). Offline and free — no agent, no quota.",
      },
      args: {
        manifest: { type: "string", required: true, description: "manifest.json from `rig run`" },
        script: {
          type: "string",
          required: true,
          description: "The SAME turn script the run used (it carries the ground truth)",
        },
        out: { type: "string", description: "Write the result JSON here (default: stdout only)" },
      },
      async run({ args }) {
        const result = await runRigAuthorityCommand(() =>
          runRigHarvest({
            scriptPath: args.script as string,
            manifestPath: args.manifest as string,
            outPath: args.out as string | undefined,
          }),
        );
        const p = result.provenance;
        const slope =
          result.metrics.fpBurdenSlope.slope === null
            ? `insufficient data (n=${result.metrics.fpBurdenSlope.n})`
            : `${result.metrics.fpBurdenSlope.slope.toFixed(4)}/turn (n=${result.metrics.fpBurdenSlope.n})`;
        // Every rate with its raw denominator — a rate printed bare is the failure mode this
        // project already guards against in bench. Full rendering is Task 5's reporter.
        process.stdout.write(
          [
            `rig harvest: ${p.turn_count.harvested}/${p.turn_count.script_total} turn(s) (${p.turn_count.seeded} seeded, ${p.turn_count.clean} clean)`,
            `  recall      ${fmtMetric(result.metrics.recall)}`,
            `  escape rate ${fmtMetric(result.metrics.escapeRate)}`,
            `  M2 slope    ${slope}`,
            `  iterations  median ${result.metrics.iterations.median ?? "n/a"} over ${result.metrics.iterations.spread.samples} reviewed turn(s)`,
            `  cost        $${result.metrics.cost.totalUsd.toFixed(4)} total`,
            args.out === undefined ? "" : `  → ${args.out}`,
            "",
          ]
            .filter((l, i, all) => l.length > 0 || i === all.length - 1)
            .join("\n"),
        );
      },
    }),
    report: defineCommand({
      meta: {
        name: "report",
        description:
          "Render a harvested rig result as a terminal table, or as a paste-ready markdown block with --markdown.",
      },
      args: {
        result: {
          type: "positional",
          required: true,
          description: "result.json from `rig harvest`",
        },
        markdown: { type: "boolean", description: "Emit the markdown block instead of the table" },
      },
      run({ args }) {
        process.stdout.write(
          runRigReport({
            resultPath: args.result as string,
            markdown: args.markdown === true,
          }),
        );
      },
    }),
    ablate: defineCommand({
      meta: {
        name: "ablate",
        description:
          "Run exact closed-catalog policy ablations for traced runs; legacy four-layer results remain explicitly non-authoritative.",
      },
      args: {
        result: { type: "string", required: true, description: "result.json from `rig harvest`" },
        script: {
          type: "string",
          required: true,
          description: "The turn script the run used (its seeded tags are the ground truth)",
        },
        layer: {
          type: "string",
          description: `Exact: one closed-catalog id (${POLICY_PASS_IDS.join(" | ")}); legacy: ${SUPPRESSION_LAYERS.join(" | ")} (default: all)`,
        },
      },
      async run({ args }) {
        const layer = args.layer as string | undefined;
        process.stdout.write(
          await runRigAuthorityCommand(() =>
            runRigAblate({
              resultPath: args.result as string,
              scriptPath: args.script as string,
              sourceRepoRoot: process.cwd(),
              ...(layer === undefined ? {} : { layer }),
            }),
          ),
        );
      },
    }),
    replay: defineCommand({
      meta: {
        name: "replay",
        description:
          "Validate exact policy envelopes and replay production policy in isolated checkouts without live provider calls; legacy runs get only the deterministic harness check.",
      },
      args: {
        manifest: { type: "string", required: true, description: "manifest.json from `rig run`" },
        script: { type: "string", required: true, description: "The turn script the run used" },
        cassette: {
          type: "string",
          description:
            "Also verify the recording by stable logical call identity, ordered response hashes, and bodies",
        },
      },
      async run({ args }) {
        const report = await runRigAuthorityCommand(() =>
          runRigReplay({
            manifestPath: args.manifest as string,
            scriptPath: args.script as string,
            cassettePath: args.cassette as string | undefined,
            sourceRepoRoot: process.cwd(),
          }),
        );
        process.stdout.write(`${report.text}\n`);
        // Non-zero on nondeterminism: this is a CHECK, and a check that always exits 0 is a
        // report. CI (or a refactor's acceptance step) must be able to gate on it.
        if (!report.ok) process.exit(1);
      },
    }),
  },
});

const main = defineCommand({
  meta: {
    name: "reviewgate",
    version: RG_VERSION,
    description: "Heterogeneous LLM code-review gate for Claude Code and Codex agent loops",
  },
  subCommands: {
    init,
    hooks,
    gate,
    "pre-push": prePush,
    "review-plan": reviewPlan,
    doctor,
    reset,
    config,
    audit,
    brain,
    lore,
    fp,
    stats,
    report,
    setup,
    learn,
    bench,
    rig,
  },
});

void runMain(main);
