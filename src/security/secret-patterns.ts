/**
 * Secret and sensitive-content detection patterns (threat-model.md "Primary
 * threats" #2, memory-policy.md "Content/Forbidden").
 *
 * These patterns are a defense-in-depth minimization control, not a
 * guarantee (threat-model.md "Accepted limitations": secret detection is
 * imperfect). They run before any model call and before any storage write.
 */

export interface SecretPattern {
  name: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "aws_access_key_id", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws_secret_key_assignment", regex: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { name: "generic_api_key_assignment", regex: /\b(api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9\-_./+=]{12,}['"]?/gi },
  { name: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9\-_.=]{10,}\b/g },
  { name: "authorization_header", regex: /^\s*Authorization\s*:.*$/gim },
  { name: "cookie_header", regex: /^\s*Cookie\s*:.*$/gim },
  { name: "set_cookie_header", regex: /^\s*Set-Cookie\s*:.*$/gim },
  { name: "jwt", regex: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "pem_private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "openssh_private_key", regex: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g },
  { name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "generic_password_assignment", regex: /\bpassword\s*[:=]\s*['"]?[^\s'"]{4,}['"]?/gi },
  { name: "dotenv_line", regex: /^\s*[A-Z][A-Z0-9_]*\s*=\s*\S+\s*$/gm },
  { name: "private_ip_or_conn_string_with_credentials", regex: /\b\w+:\/\/[^\s/:@]+:[^\s/:@]+@[^\s]+/g },
];

/** Names of patterns considered too broad to reject content outright, only to redact. */
export const REDACT_ONLY_PATTERNS = new Set(["dotenv_line"]);
