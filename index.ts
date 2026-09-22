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
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";


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
function log(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    console.log(message);
  }
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pi's types file defines event.payload as `unknown`. Agent speculation is that 
 * this is because Pi supports many providers, and each may vary its request shape. 
 * 
 * At runtime, we have a real datum, so attempt to parse it and find data 
 * on the estimated input and output token reservation. 
 */
function payloadHints(payload: unknown): { estInputChars: number; maxOutputTokens: number | undefined } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const estInputChars = JSON.stringify(p.system ?? "").length + 
                        JSON.stringify(p.messages ?? []).length;
  const maxOutputTokens = 
    [p.max_tokens, p.max_output_tokens, p.max_completion_tokens].find(
      (v): v is number => typeof v === "number",
  );
  return { estInputChars, maxOutputTokens };
}

/**
 * Extensions export a single function that runs when the extension starts.
 * It registers a number of callbacks corresponding to pi.dev events.
 *    "Handlers run in extension load and registration order."
 * @param pi a handle to pi's extensions library
 */
export default function (pi: ExtensionAPI) {
  //let loggedEarlyInput = false;

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
    //loggedEarlyInput = false;
    const now = Date.now();
    const debtMs = Math.max(0, debtUntil - now);
    const { estInputChars, maxOutputTokens } = payloadHints(event.payload);
    log(
      ctx,
      `[throttle] request (bucket debt: ${debtMs}ms, payload: ~${estInputChars} input chars, max output=${maxOutputTokens ?? "?"})`,
    );

    if (debtMs > Math.max(0,DEBT_FLOOR_MS)) {
      const delay = Math.min(debtMs, MAX_DELAY_MS);
      const capped = delay < debtMs ? " (capped)" : "";
      log(ctx, `[throttle] bucket owes ${debtMs}ms, delaying ${delay}ms${capped}`);
      await sleep(delay);
    }
  });

  /**
   * We might get more than one of these events if streaming responses are enabled.
   * Since our goal is to detect the input-token count early, we don't want to 
   * do anything here beyond the first update.
   */
  // pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
  //   if (loggedEarlyInput || event.message.role !== "assistant") return;
  //   const { input } = event.message.usage;
  //   if (input > 0) {
  //     loggedEarlyInput = true;
  //     log(ctx, `[throttle] .. input known early: ${input} (stream event: ${event.assistantMessageEvent.type})`);
  //   }
  // });

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
