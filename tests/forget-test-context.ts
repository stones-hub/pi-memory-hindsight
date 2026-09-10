import type { ForgetMemoryOptions } from "../src/governance/forget-service.js";

/** Trusted project cwd context for direct forgetMemory calls in tests. */
export function projectForgetCtx(projectIdentity = "demo"): ForgetMemoryOptions {
  return { projectIdentity, projectScopeEnabled: true };
}
