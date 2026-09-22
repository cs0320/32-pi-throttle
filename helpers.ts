import { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi.dev's TUI takes over stdout, so we shouldn't rely on console.log.
 * It provides a ctx.ui.notify function, which we'll use instead. Note 
 * that when its level is "info", it isn't a persistent log entry; if two 
 * calls happen in succession between other events occurring, the latter 
 * call will overwrite the first. This includes other extensions.
 * 
 * For debugging purposes, we'll use warning.
 * 
 * Moreover, the TUI (as of September, 2026) gives each of these a position
 * in the array of outputs, the elements of which can be updated (e.g., by 
 * streaming replies). 
 */
export function log(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    console.log(message);
  }
}

/** Sleep for a given number of ms. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts just text pieces from JSON, eliminating braces, quotes, etc. 
 */
export function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join(" ");
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return v.text;
    if ("content" in v) return extractText(v.content);
  }
  return "";
}

/**
 * Build a rough proxy for token count. Words, numbers, punctuation. 
 */
export function estimateTokens(text: string): number {
  return (text.match(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g) ?? []).length;
}

/**
 * Pi's types file defines event.payload as `unknown`. Agent speculation is that
 * this is because Pi supports many providers, and each may vary its request shape.
 *
 * At runtime, we have a real datum, so attempt to parse it and find data
 * on the estimated input and output token reservation.
 */
export function payloadHints(payload: unknown): { estInputTokens: number; maxOutputTokens: number | undefined } {
  const p = (payload ?? {}) as Record<string, unknown>;
  // p.system covers Anthropic-shaped payloads; OpenAI-style payloads embed
  // the system prompt as a role:"system" message inside p.messages instead,
  // so it's already picked up there - the p.system call is a harmless
  // no-op for this provider, kept for portability.
  const text = extractText(p.system) + " " + extractText(p.messages);
  const estInputTokens = estimateTokens(text);
  const maxOutputTokens =
    [p.max_tokens, p.max_output_tokens, p.max_completion_tokens].find(
      (v): v is number => typeof v === "number",
  );
  return { estInputTokens, maxOutputTokens };
}
