import type { GlobalRuntime } from "../runtime/global-runtime.js";
import type { MemoryRow } from "../db/types.js";
import { projectBankId } from "../identity/bank-id.js";
import { rowOwnsDocumentId, validateBankId, validateDocumentId } from "../provider/validation.js";

const TEXT_HASH_HEX = /^[0-9a-f]{64}$/;

export function expectedMemoryBankId(runtime: GlobalRuntime, row: MemoryRow): string | null {
  if (row.scope === "profile") return runtime.profileBankId;
  if (row.project_identity) return projectBankId(row.project_identity);
  return null;
}

/** Fail-closed owned locator proof for governed memory I/O and expiry maintenance. */
export function isValidOwnedMemoryLocator(runtime: GlobalRuntime, row: MemoryRow): boolean {
  const expectedBank = expectedMemoryBankId(runtime, row);
  if (
    !validateBankId(row.bank_id).ok ||
    !validateDocumentId(row.document_id).ok ||
    !TEXT_HASH_HEX.test(row.text_hash)
  ) {
    return false;
  }
  if (row.scope === "profile" && row.project_identity !== null) return false;
  if (row.scope === "project" && row.project_identity === null) return false;
  if (expectedBank === null || row.bank_id !== expectedBank) return false;
  return rowOwnsDocumentId(row);
}
