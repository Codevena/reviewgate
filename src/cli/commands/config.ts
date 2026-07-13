import {
  type ControlPlaneStatus,
  approveControlPlane,
  controlPlaneStatus,
} from "../../config/control-plane.ts";

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

export async function runConfigApprove(
  repoRoot: string,
  confirmation: string,
): Promise<{ exitCode: number; stdout: string }> {
  const state = await approveControlPlane(repoRoot, confirmation);
  return {
    exitCode: 0,
    stdout: `Gate policy approved: ${state.approved_effective_fingerprint.slice(0, 12)}\n`,
  };
}
