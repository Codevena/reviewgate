import {
  type ControlPlaneStatus,
  approveControlPlane,
  controlPlaneStatus,
} from "../../config/control-plane.ts";
import type { EffectiveConfigInput } from "../../config/global.ts";

function short(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 12) : "none";
}

export function formatControlPlaneStatus(status: ControlPlaneStatus): string {
  if (!status.state) {
    return [
      "Gate policy: UNINITIALIZED",
      "No last-known-good policy exists yet.",
      status.challenge ? `Approval challenge: ${status.challenge}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const lines = [
    `Gate policy: ${status.state.pending ? "PENDING" : "APPROVED"}`,
    `Approved effective fingerprint: ${short(status.state.approved_effective_fingerprint)}`,
    `Approved at: ${status.state.approved_at} via ${status.state.approved_via}`,
  ];
  const pending = status.state.pending;
  if (pending) {
    lines.push(
      `Candidate effective fingerprint: ${short(pending.effective_fingerprint)}`,
      `Classification: ${pending.classification}`,
      `Reviewed under last-known-good: ${pending.reviewed_under_lkg_at ?? "no"}`,
      `Changed paths: ${pending.changed_paths.length > 0 ? pending.changed_paths.join(", ") : "effective policy unchanged"}`,
    );
    for (const reason of pending.reasons) lines.push(`Reason: ${reason}`);
    if (pending.error) lines.push(`Config error: ${pending.error}`);
    if (status.challenge) lines.push(`Approval challenge: ${status.challenge}`);
    else if (pending.classification === "approval-required")
      lines.push("Next: complete a gate pass under the last-known-good policy.");
    else if (pending.classification === "invalid")
      lines.push("Next: fix the invalid present config; it cannot be approved.");
    else lines.push("Next: this candidate auto-adopts only after a successful prior-policy pass.");
  }
  return lines.join("\n");
}

export async function runConfigStatus(
  repoRoot: string,
): Promise<{ exitCode: number; stdout: string }> {
  const status = await controlPlaneStatus(repoRoot);
  return { exitCode: 0, stdout: `${formatControlPlaneStatus(status)}\n` };
}

// Exit code 0 must mean "the policy baseline was written" and nothing else.
// Two ways it used to lie: EOF at the prompt left rl.question() unsettled, so
// the process drained its event loop and exited 0 having approved nothing; and
// a rejected confirmation threw out of here into the CLI framework, which
// printed an ERROR banner and still exited 0. Any script gating on
// `reviewgate config approve` would have read either as an approval.
export async function runConfigApprove(
  repoRoot: string,
  // `null` = the prompt was closed without an answer (EOF / Ctrl-D).
  confirmation: string | null,
  input?: Omit<EffectiveConfigInput, "cwd">,
): Promise<{ exitCode: number; stdout: string }> {
  if (confirmation === null) {
    return { exitCode: 1, stdout: "Aborted: no confirmation read — nothing was approved.\n" };
  }
  try {
    const state = input
      ? await approveControlPlane(repoRoot, confirmation, input)
      : await approveControlPlane(repoRoot, confirmation);
    return {
      exitCode: 0,
      stdout: `Gate policy approved: ${state.approved_effective_fingerprint.slice(0, 12)}\n`,
    };
  } catch (err) {
    // approveControlPlane throws for every refusal (mismatch, not yet reviewed
    // under LKG, invalid config, concurrent change). None of those wrote a
    // baseline, so all of them are exit 1.
    return { exitCode: 1, stdout: `${(err as Error).message}\n` };
  }
}
