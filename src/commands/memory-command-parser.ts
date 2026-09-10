import type { MemoryType, Scope } from "../db/types.js";
import type { Language } from "../i18n/messages.js";

export type ParsedMemoryCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "last" }
  | { kind: "language"; language: Language }
  | { kind: "remember"; scope: Scope; memoryType: MemoryType; content: string }
  | { kind: "update"; id: string; content: string }
  | { kind: "list"; filter: "all" | "profile" | "project" }
  | { kind: "show"; id: string }
  | { kind: "cleanup-status" }
  | { kind: "cleanup-now" }
  | { kind: "candidates" }
  | { kind: "candidates-list" }
  | { kind: "candidates-approve"; id: string }
  | { kind: "candidates-reject"; id: string }
  | { kind: "candidates-edit-approve"; id: string; content: string }
  | { kind: "forget"; id: string }
  | { kind: "reflect"; scope: Scope; query: string };

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function consumeToken(input: string, start: number): { token: string | null; next: number } {
  let index = start;
  while (index < input.length && isWhitespace(input[index]!)) index += 1;
  if (index >= input.length) return { token: null, next: input.length };
  const begin = index;
  while (index < input.length && !isWhitespace(input[index]!)) index += 1;
  return { token: input.slice(begin, index), next: index };
}

function consumeRemainder(input: string, start: number): string {
  let index = start;
  while (index < input.length && isWhitespace(input[index]!)) index += 1;
  return input.slice(index).trim();
}

function parseScope(value: string | null): Scope | null {
  return value === "profile" || value === "project" ? value : null;
}

function isValidScopeType(scope: Scope, memoryType: string): memoryType is MemoryType {
  return (
    (scope === "profile" && (memoryType === "preference" || memoryType === "habit")) ||
    (scope === "project" &&
      ["project_fact", "decision", "lesson", "task_state", "inference"].includes(memoryType))
  );
}

export function parseMemoryCommand(input: string): ParsedMemoryCommand | null {
  const first = consumeToken(input, 0);
  if (first.token === null) return { kind: "help" };
  const second = consumeToken(input, first.next);
  const third = consumeToken(input, second.next);

  switch (first.token) {
    case "status":
      return second.token === null ? { kind: "status" } : null;
    case "on":
      return second.token === null ? { kind: "on" } : null;
    case "off":
      return second.token === null ? { kind: "off" } : null;
    case "last":
      return second.token === null ? { kind: "last" } : null;
    case "language":
      return second.token !== null &&
        third.token === null &&
        (second.token === "en" || second.token === "zh")
        ? { kind: "language", language: second.token }
        : null;
    case "remember": {
      const scope = parseScope(second.token);
      if (!scope || third.token === null || !isValidScopeType(scope, third.token)) return null;
      const content = consumeRemainder(input, third.next);
      return content ? { kind: "remember", scope, memoryType: third.token, content } : null;
    }
    case "update": {
      if (second.token === null) return null;
      const content = consumeRemainder(input, second.next);
      return content ? { kind: "update", id: second.token, content } : null;
    }
    case "list":
      if (second.token === null) return { kind: "list", filter: "all" };
      if (second.token === "profile" && third.token === null) return { kind: "list", filter: "profile" };
      if (second.token === "project" && third.token === null) return { kind: "list", filter: "project" };
      return null;
    case "show":
      return second.token !== null && third.token === null ? { kind: "show", id: second.token } : null;
    case "cleanup":
      if (second.token === "status" && third.token === null) return { kind: "cleanup-status" };
      if (second.token === "now" && third.token === null) return { kind: "cleanup-now" };
      return null;
    case "candidates":
      if (second.token === null) return { kind: "candidates" };
      if (second.token === "list" && third.token === null) return { kind: "candidates-list" };
      if (second.token === "approve" && third.token !== null && consumeToken(input, third.next).token === null) {
        return { kind: "candidates-approve", id: third.token };
      }
      if (second.token === "reject" && third.token !== null && consumeToken(input, third.next).token === null) {
        return { kind: "candidates-reject", id: third.token };
      }
      if (second.token === "edit-approve" && third.token !== null) {
        const content = consumeRemainder(input, third.next);
        return content ? { kind: "candidates-edit-approve", id: third.token, content } : null;
      }
      return null;
    case "forget":
      return second.token !== null && third.token === null ? { kind: "forget", id: second.token } : null;
    case "reflect": {
      const scope = parseScope(second.token);
      if (!scope) return null;
      const query = consumeRemainder(input, second.next);
      return query ? { kind: "reflect", scope, query } : null;
    }
    default:
      return null;
  }
}
