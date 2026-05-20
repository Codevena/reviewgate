// src/cli/commands/doctor.ts
export interface DoctorInput {
  repoRoot: string;
  capture?: boolean;
}

// STUB — replaced in Task 24.
export async function runDoctor(_input: DoctorInput): Promise<number> {
  return 0;
}
