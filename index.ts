/**
 * A throttling/rate-limiter extension for pi.dev,
 * specifically for use in CSCI 0320. By creating our own, we can
 * both avoid external dependencies and produce useful course material
 * for when students are creating their own extensions.
 */

import type {
  AfterProviderResponseEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

import { log, sleep, payloadHints, isRateLimitError } from "./helpers";
import { ThrottleConfig, DEFAULT_CONFIG } from "./defaults";

/**
 * Extensions export a single function that runs when the extension starts.
 * It registers a number of callbacks corresponding to pi.dev events.
 *    "Handlers run in extension load and registration order."
 * @param pi a handle to pi's extensions library
 */
export default function (pi: ExtensionAPI) {
  /** Adjustable configuration options. */
  const config: ThrottleConfig = { ...DEFAULT_CONFIG };

  /** Returns the ms of delay one token of debt is worth. Relative to
   * the current configuration. */
  const msPerToken = () => config.windowMs / config.ceilingTokens;

  /**
   * A "debt clock" for the "bucket" of available tokens. Once this timestamp
   * is reached, we have no more remaining token debt. (See: GCRA.) Boxed
   * so the reference can be easily passed to external handler modules.
   */
  const debt = { current: 0 };

  /**
   * Count of provider requests sent but not yet resolved. This extension 
   * is built under the assumption that requests are sequential. If that fails
   * (e.g., concurrent tool calls), we need to revisit strategy and include 
   * in-flight calls as reservations to constrain new requests. 
   * 
   * Boxed for the same reason as `debt`.
   */
  const inFlight = { count: 0 };

  /**
   * A request is about to be sent.
   *
   * - Attempt to parse the event info to obtain statistics like input tokens.
   * - Warn if another request is still outstanding (see `inFlight` above).
   * - Delay sending the request, if throttling is called for.
   */
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    const now = Date.now();
    const debtMs = Math.max(0, debt.current - now);
    const { estInputTokens, maxOutputTokens } = payloadHints(event.payload);
    log(
      ctx,
      `[throttle] request (bucket debt: ${debtMs}ms, payload: ~${estInputTokens} est. input tokens, max output=${maxOutputTokens ?? "?"})`,
    );

    if (inFlight.count > 0) {
      log(
        ctx,
        `[throttle] !! ${inFlight.count} other request(s) still in flight. Debt may be under-counted.`,
      );
    }
    inFlight.count++;

    if (debtMs > Math.max(0, config.debtFloorMs)) {
      const delay = Math.min(debtMs, config.maxDelayMs);
      const capped = delay < debtMs ? " (capped)" : "";
      log(ctx, `[throttle] bucket owes ${debtMs}ms, delaying ${delay}ms${capped}`);
      ctx.ui.setWorkingMessage(`...Waiting (throttled, ${delay}ms)`);
      try {
        await sleep(delay, ctx.signal);
      } finally {
        ctx.ui.setWorkingMessage();
      }
    }
  });

  /**
   * If the provider rejected a request with a 429 rate-limited response,
   * immediately fill the debt window. It is not the job of this extension
   * to do any backoff and retry: pi does that itself. Instead, we want to
   * avoid pouring too much "water" into the bucket once a request succeeds.
   *
   * In practice this rarely fires: pi retries a failed request internally
   * before this hook ever runs, and only calls it once that retry resolves
   * - a request that still fails after those retries are exhausted throws
   * instead, skipping this hook entirely. Kept as a fallback for provider
   * paths where a 429 status does reach us this way; `message_end` below is
   * the handler that reliably sees a terminal rate-limit failure.
   */
  pi.on("after_provider_response", (event: AfterProviderResponseEvent, ctx: ExtensionContext) => {
    if (event.status !== 429) return;
    const now = Date.now();
    debt.current = Math.max(debt.current, now) + config.windowMs;
    log(ctx, `[throttle] !! 429 received - forcing a full window (${config.windowMs}ms) of debt`);
  });

  /**
   * A message has ended, so we know how many tokens were really used.
   * Charge the bucket with the real usage.
   *
   * This also fires for a message that failed after pi exhausted its own
   * retries (with zero usage, since the request never completed) - that's
   * pi's one reliable signal that a request came back rate-limited, so a
   * 429-looking failure here also fills the debt window, same as a "real"
   * `after_provider_response` 429 would.
   */
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    if (event.message.role !== "assistant") return;
    const { input, output, totalTokens } = event.message.usage;
    log(ctx, `[throttle] <- final usage: input=${input} output=${output} total=${totalTokens}`);

    inFlight.count = Math.max(0, inFlight.count - 1);

    const now = Date.now();
    const charge = totalTokens * msPerToken();
    debt.current = Math.max(debt.current, now) + charge;
    log(ctx, `[throttle] .. bucket charged +${Math.round(charge)}ms (debt now clears at +${Math.round(debt.current - now)}ms)`);

    if (event.message.stopReason === "error" && isRateLimitError(event.message.errorMessage)) {
      const penalized = Date.now();
      debt.current = Math.max(debt.current, penalized) + config.windowMs;
      log(ctx, `[throttle] !! rate-limit error - forcing a full window (${config.windowMs}ms) of debt`);
    }
  });
}
