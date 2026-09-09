import { resolveProjectIdentity } from "../identity/project-identity.js";
import { projectBankId } from "../identity/bank-id.js";

export type ProjectBankResult =
  | { enabled: true; identity: string; bankId: string }
  | { enabled: false; reason: string };

/** Resolves the Project scope's bank ID for `cwd`, or why Project scope is unavailable. */
export async function resolveProjectBank(cwd: string): Promise<ProjectBankResult> {
  const result = await resolveProjectIdentity(cwd);
  if (!result.enabled) {
    return { enabled: false, reason: result.reason };
  }
  return { enabled: true, identity: result.identity, bankId: projectBankId(result.identity) };
}
