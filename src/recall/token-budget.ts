/**
 * Recall injection budget (product-requirements.md "Recall"): approximately
 * 1500 tokens per turn. Item count is version-aware — legacy `0.8.3` keeps
 * at most 10; semantic-filtered `0.10.0` keeps at most 3 — computed from
 * Unicode-safe length so multi-byte text is not undercounted.
 */

/** Legacy Hindsight `0.8.3` injection cap (no semantic filtering). */
export const RECALL_MAX_ITEMS_LEGACY = 10;
/** Hindsight `0.10.0` injection cap after semantic filtering/ranking. */
export const RECALL_MAX_ITEMS_SEMANTIC = 3;
/** Default/legacy alias kept for existing call sites and tests. */
export const RECALL_MAX_ITEMS = RECALL_MAX_ITEMS_LEGACY;
export const RECALL_MAX_TOKENS = 1500;

function isCjkChar(char: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char);
}

function isAsciiLike(char: string): boolean {
  return /^[\u0000-\u007f]$/u.test(char);
}

/** Conservative token estimate for mixed English/CJK text; deterministic and tokenizer-free. */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const char of Array.from(text)) {
    if (isCjkChar(char)) {
      total += 1.1;
    } else if (isAsciiLike(char)) {
      total += 0.25;
    } else {
      total += 0.5;
    }
  }
  return Math.max(1, Math.ceil(total));
}

/** Caps an ordered list of recall items to the item-count and token budget, preserving order. */
export function capRecallItems<T extends { text: string }>(
  items: readonly T[],
  maxItems: number = RECALL_MAX_ITEMS,
): T[] {
  const capped: T[] = [];
  let tokens = 0;
  const itemLimit = Math.max(0, maxItems);
  for (const item of items) {
    if (capped.length >= itemLimit) break;
    const itemTokens = estimateTokens(item.text);
    if (tokens + itemTokens > RECALL_MAX_TOKENS) break;
    capped.push(item);
    tokens += itemTokens;
  }
  return capped;
}

/**
 * Caps an ordered list of already-ranked items against the FINAL rendered block
 * token budget, including header/disclaimer/item labels/suffixes.
 */
export function capRenderedRecallItems<T>(
  items: readonly T[],
  fixedPrefix: readonly string[],
  renderItem: (item: T) => string,
  maxItems: number = RECALL_MAX_ITEMS,
): T[] {
  const capped: T[] = [];
  let tokens = estimateTokens(fixedPrefix.join("\n"));
  const itemLimit = Math.max(0, maxItems);
  for (const item of items) {
    if (capped.length >= itemLimit) break;
    const rendered = renderItem(item);
    const nextTokens = tokens + estimateTokens(`\n${rendered}`);
    if (nextTokens > RECALL_MAX_TOKENS) break;
    capped.push(item);
    tokens = nextTokens;
  }
  return capped;
}
