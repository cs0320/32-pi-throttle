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

import { sleep, payloadHints, capMaxOutput, isRateLimitError, makeLoggers, rateLimitHeaders } from "./helpers";
import { ThrottleConfig, DEFAULT_CONFIG } from "./defaults";
import { registerDebugCommand } from "./debug-command";
import { registerLogCommand } from "./log-command";
import { registerCeilingCommand } from "./ceiling-command";
import { registerMaxOutputCommand } from "./max-output-command";

/**
 * Extensions export a single function that runs when the extension starts.
 * It registers a number of callbacks corresponding to pi.dev events.
 *    "Handlers run in extension load and registration order."
 * @param pi a handle to pi's extensions library
 */
export default function (pi: ExtensionAPI) {
  /** Adjustable configuration options. */
  const config: ThrottleConfig = { ...DEFAULT_CONFIG };

  registerDebugCommand(pi, config);
  registerLogCommand(pi, config);
  registerCeilingCommand(pi, config);
  registerMaxOutputCommand(pi, config);

  const { alwaysLog, debugLog } = makeLoggers(config);

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

  /** When was the latest request sent? Used to get round-trip time.*/
  const lastSentAt = { current: 0 };

  /** Remember whether the last assistant message ended in failure. 
   *  Used to detect pi's retries. */
  const lastEndedInError = { current: false };

  /** Helper for clarity: extend the debt clock. */
  const addDebt = (ms: number, now: number) => {
    debt.current = Math.max(debt.current, now) + ms;
  };

  /** Has the current request's 429 already been penalized? Used to disambiguate 
   * rate-limit behavior between providers. See after_provider_response. */
  const penalized = { current: false };

  /** Helper for clarity: add a full window of debt if rate-limited. */
  const penalize = (ctx: ExtensionContext, reason: string) => {
    if (penalized.current) {
      debugLog(ctx, `[throttle] .. ${reason} - already penalized for this request, skipping`);
      return;
    }
    penalized.current = true;
    addDebt(config.windowMs, Date.now());
    alwaysLog(ctx, `[throttle] !! ${reason} - forcing a full window (${config.windowMs}ms) of debt`);
  };

  /**
   * A request is about to be sent.
   *
   * - Attempt to parse the event info to obtain statistics like input tokens.
   * - Warn if another request is still outstanding (see `inFlight` above).
   * - Delay sending the request, if throttling is called for.
   * - Lower the output-token cap, if `/throttle-max-output` is set.
   */
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    const now = Date.now();
    const debtMs = Math.round(Math.max(0, debt.current - now));
    const { estInputTokens, maxOutputTokens, maxOutputField, thinkingBudget } = payloadHints(event.payload);
    debugLog(
      ctx,
      `[throttle] request (bucket debt: ${debtMs}ms, payload: ~${estInputTokens} est. input tokens, ` +
        `max output=${maxOutputTokens ?? "?"} via ${maxOutputField ?? "?"}, thinking budget=${thinkingBudget ?? "none"})`,
    );

    if (inFlight.count > 0) {
      debugLog(
        ctx,
        `[throttle] !! ${inFlight.count} other request(s) still in flight. Debt may be under-counted.`,
      );
    }
    if (lastEndedInError.current) {
      debugLog(ctx, `[throttle] .. previous request failed; this is likely a pi auto-retry`);
      lastEndedInError.current = false;
    }
    inFlight.count++;
    penalized.current = false;

    if (debtMs > Math.max(0, config.debtFloorMs)) {
      const delay = Math.min(debtMs, config.maxDelayMs);
      const capped = delay < debtMs ? " (capped)" : "";
      debugLog(ctx, `[throttle] bucket owes ${debtMs}ms, delaying ${delay}ms${capped}`);
      ctx.ui.setWorkingMessage(`...Waiting (throttled, ${delay}ms)`);
      try {
        await sleep(delay, ctx.signal);
      } finally {
        ctx.ui.setWorkingMessage();
      }
    }

    lastSentAt.current = Date.now();

    if (config.maxOutputTokens === undefined) return undefined;
    const capped = capMaxOutput(event.payload, config.maxOutputTokens);
    if (capped.field === undefined) {
      alwaysLog(ctx, `[throttle] !! max output cap ${config.maxOutputTokens} not applied: no output-token field in payload`);
    } else {
      debugLog(ctx, `[throttle] .. ${capped.field} capped: ${capped.from} -> ${config.maxOutputTokens}`);
    }
    return capped.payload;
  });

  /**
   * If the provider rejected a request with a 429 rate-limited response,
   * immediately fill the debt window. It is not the job of this extension
   * to do any backoff and retry: pi does that itself. Instead, we want to
   * avoid pouring too much "water" into the bucket once a request succeeds.
   *
   * Whether a 429 reaches this hook depends on provider. In some cases 
   * (e.g., pi's adapters for OpenAI and Anthropic, as of September 2026) 
   * we will only see a failed message_end. Thus, out of caution, we have 
   * checks both here and in message_end.
   */
  pi.on("after_provider_response", (event: AfterProviderResponseEvent, ctx: ExtensionContext) => {
    debugLog(ctx, `[throttle] <- response status=${event.status} ${rateLimitHeaders(event.headers) || "(no rate-limit headers)"}`);
    if (event.status !== 429) return;
    penalize(ctx, "429 received");
  });

  /**
   * A message has ended, so we know how many tokens were really used.
   * Charge the bucket with the real usage.
   */
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    if (event.message.role !== "assistant") return;
    const { input, output, totalTokens } = event.message.usage;
    const now = Date.now();
    debugLog(
      ctx,
      `[throttle] <- final usage: input=${input} output=${output} total=${totalTokens} stop=${event.message.stopReason} (round trip: ${now - lastSentAt.current}ms)`,
    );

    inFlight.count = Math.max(0, inFlight.count - 1);

    // Each token is worth windowMs / ceilingTokens milliseconds of debt.
    const charge = totalTokens * (config.windowMs / config.ceilingTokens);
    addDebt(charge, now);
    debugLog(ctx, `[throttle] .. bucket charged +${Math.round(charge)}ms (debt now clears at +${Math.round(debt.current - now)}ms)`);

    lastEndedInError.current = event.message.stopReason === "error";
    if (event.message.stopReason === "error") {
      if (event.message.errorMessage) {
        debugLog(ctx, `[throttle] !! error detail: ${event.message.errorMessage}`);
      }
      if (isRateLimitError(event.message.errorMessage)) {
        penalize(ctx, "rate-limit error");
      }
    }
  });
}
