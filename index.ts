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
 * Extensions export a single function that runs when the extension starts.
 * It registers a number of callbacks corresponding to pi.dev events.
 *    "Handlers run in extension load and registration order."
 * @param pi a handle to pi's extensions library
 */

/**
 * How far back to look when summing current token usage.
 */
const WINDOW_MS = 60_000;

/**
 * Artificial cap after which we will trigger a client-side delay.
 */
const CEILING_TOKENS = 10_000;

/**
 * Artificial, constant delay. Consider dynamic delays later.
 */
const PENALTY_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  let loggedEarlyInput = false;

  // Record of completed requests' token usage. This gets pruned to WINDOW_MS.
  const usageWindow: { timestamp: number; tokens: number }[] = [];

  function trailingTokens(now: number): number {
    while (usageWindow.length > 0 && now - usageWindow[0].timestamp > WINDOW_MS) {
      usageWindow.shift();
    }
    return usageWindow.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  /**
   * A request is about to be sent. Reset this extension's per-request state
   */
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    loggedEarlyInput = false;
    const trailing = trailingTokens(Date.now());
    log(
      ctx,
      `[throttle] -> request sent (trailing ${WINDOW_MS / 1000}s: ${trailing} tokens across ${usageWindow.length} request(s))`,
    );

    if (trailing >= CEILING_TOKENS) {
      log(ctx, `[throttle] .. over ceiling (${trailing} >= ${CEILING_TOKENS}), delaying ${PENALTY_DELAY_MS}ms`);
      await sleep(PENALTY_DELAY_MS);
    }
  });

  /**
   * We might get more than one of these events if streaming responses are enabled.
   * Since our goal is to detect the input-token count early, we don't want to 
   * do anything here beyond the first update.
   */
  pi.on("message_update", (event: MessageUpdateEvent, ctx: ExtensionContext) => {
    if (loggedEarlyInput || event.message.role !== "assistant") return;
    const { input } = event.message.usage;
    if (input > 0) {
      loggedEarlyInput = true;
      log(ctx, `[throttle] .. input known early: ${input} (stream event: ${event.assistantMessageEvent.type})`);
    }
  });

  /**
   * A message has ended, so we should know how many output tokens were really used.
   */
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    if (event.message.role !== "assistant") return;
    const { input, output, totalTokens } = event.message.usage;
    usageWindow.push({ timestamp: Date.now(), tokens: totalTokens });
    log(ctx, `[throttle] <- final usage: input=${input} output=${output} total=${totalTokens}`);
  });
}
