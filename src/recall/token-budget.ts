/**
 * Recall injection budget (product-requirements.md "Recall"): at most 10
 * items and roughly 1500 tokens per turn, computed from Unicode-safe length
 * so multi-byte text is not undercounted.
 */

export const RECALL_MAX_ITEMS = 10;
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
export function capRecallItems<T extends { text: string }>(items: readonly T[]): T[] {
  const capped: T[] = [];
  let tokens = 0;
  for (const item of items) {
    if (capped.length >= RECALL_MAX_ITEMS) break;
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
): T[] {
  const capped: T[] = [];
  let tokens = estimateTokens(fixedPrefix.join("\n"));
  for (const item of items) {
    if (capped.length >= RECALL_MAX_ITEMS) break;
    const rendered = renderItem(item);
    const nextTokens = tokens + estimateTokens(`\n${rendered}`);
    if (nextTokens > RECALL_MAX_TOKENS) break;
    capped.push(item);
    tokens = nextTokens;
  }
  return capped;
}
