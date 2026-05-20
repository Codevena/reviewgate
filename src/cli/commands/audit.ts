// src/cli/commands/audit.ts
import { existsSync } from "node:fs";
import { verifyChain } from "../../audit/verifier.ts";

export interface AuditVerifyInput {
  file: string;
}

export async function runAuditVerify(input: AuditVerifyInput): Promise<number> {
  if (!input.file) {
    process.stderr.write("audit verify: --file <path> is required\n");
    return 2;
  }
  if (!existsSync(input.file)) {
    process.stderr.write(`audit verify: file not found: ${input.file}\n`);
    return 2;
  }
  const v = await verifyChain(input.file);
  if (v.ok) {
    process.stdout.write(`✓ audit chain verified — ${v.totalLines} events, all hashes match.\n`);
    return 0;
  }
  process.stderr.write(`✗ audit chain broken at line ${v.brokenAtLine} of ${v.totalLines}.\n`);
  return 1;
}
