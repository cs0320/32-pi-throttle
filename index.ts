/**
 * Prototyping a throttling/rate-limiter extension for pi.dev, 
 * specifically for use in CSCI 0320. By creating our own, we can 
 * both avoid external dependencies and produce useful course material
 * for when students are creating their own extensions.
 */

import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

import { log, sleep, extractText, estimateTokens } from "./helpers";

/**
 * Sliding window size. Using 1 minute, since it matches the TPM config unit.
 */
const WINDOW_MS = 60_000;
/**
 * Approximate per-user tokens per minute. Slightly smaller than the real cap.
 */
const CEILING_TOKENS = 250_000; 
const MS_PER_TOKEN = WINDOW_MS / CEILING_TOKENS;

/**
 * TODO
 * Prevent a very large request from stalling the session. It isn't clear 
 * whether this should be done or, if it is, what the right value is.
 */
const MAX_DELAY_MS = 20_000;

/**
 * Don't delay sending requests for under this amount of time. 
 */
const DEBT_FLOOR_MS = 500; 

/**
 * Pi's types file defines event.payload as `unknown`. Agent speculation is that
 * this is because Pi supports many providers, and each may vary its request shape.
 *
 * At runtime, we have a real datum, so attempt to parse it and find data
 * on the estimated input and output token reservation.
 */
function payloadHints(payload: unknown): { estInputTokens: number; maxOutputTokens: number | undefined } {
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

/**
 * Extensions export a single function that runs when the extension starts.
 * It registers a number of callbacks corresponding to pi.dev events.
 *    "Handlers run in extension load and registration order."
 * @param pi a handle to pi's extensions library
 */
export default function (pi: ExtensionAPI) {
  /**
   * A "debt clock" for the "bucket" of available tokens. Once this timestamp
   * is reached, we have no more remaining token debt. (See: GCRA.)
   */
  let debtUntil = 0;

  /**
   * A request is about to be sent. 
   * 
   * - Reset this extension's per-request state, and attempt to parse the event info 
   * to obtain statistics like input tokens.
   * 
   * - Delay sending the request, if throttling is called for. 
   */
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    const now = Date.now();
    const debtMs = Math.max(0, debtUntil - now);
    const { estInputTokens, maxOutputTokens } = payloadHints(event.payload);
    log(
      ctx,
      `[throttle] request (bucket debt: ${debtMs}ms, payload: ~${estInputTokens} est. input tokens, max output=${maxOutputTokens ?? "?"})`,
    );

    if (debtMs > Math.max(0,DEBT_FLOOR_MS)) {
      const delay = Math.min(debtMs, MAX_DELAY_MS);
      const capped = delay < debtMs ? " (capped)" : "";
      log(ctx, `[throttle] bucket owes ${debtMs}ms, delaying ${delay}ms${capped}`);
      await sleep(delay);
    }
  });

  /**
   * A message has ended, so we should know how many output tokens were really used.
   */
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    if (event.message.role !== "assistant") return;
    const { input, output, totalTokens } = event.message.usage;
    log(ctx, `[throttle] <- final usage: input=${input} output=${output} total=${totalTokens}`);

    const now = Date.now();
    const charge = totalTokens * MS_PER_TOKEN;
    debtUntil = Math.max(debtUntil, now) + charge;
    log(ctx, `[throttle] .. bucket charged +${Math.round(charge)}ms (debt now clears at +${Math.round(debtUntil - now)}ms)`);
  });
}
