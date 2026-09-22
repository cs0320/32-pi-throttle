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
   * Diagnostic-only tracking, independent of the `config` knobs above - the
   * point is to answer "what really happened" without trusting our own
   * throttle math, so this doesn't feed back into `debt` at all.
   */

  /** Real per-minute cap as reported by the admin - not `config.windowMs`,
   * which is what *we* choose to throttle to, and could be wrong. */
  const REAL_LIMIT_WINDOW_MS = 60_000;

  /** {time, tokens} for every completed (successful or failed) request,
   * pruned to the trailing REAL_LIMIT_WINDOW_MS - lets us log, on every
   * request, the actual real-token sum a strict 60s window would show,
   * to compare against what the provider itself reports remaining. */
  const usageHistory: { time: number; tokens: number }[] = [];

  /** When the most recent request actually left (after any throttle
   * delay) - used to log real provider round-trip time, since a hidden
   * retry inside pi's own request layer would show up as an oddly long
   * one of these that our hooks can't otherwise see. */
  const lastRequestSentAt = { current: 0 };

  /** How long a request's max-output reservation might still be held by
   * the provider's rate limiter after we've already seen its real, much
   * smaller usage - a guess (~3.5 requests' worth of gap, at this
   * session's request spacing), pending confirmation from real numbers. */
  const TRAILING_RESERVATION_MS = 30_000;

  /** {time, amount} for every request SENT (not completed) in the last
   * TRAILING_RESERVATION_MS, where amount = input + declared max output -
   * i.e. what the provider reserved for it, regardless of whether it has
   * resolved yet. Entries are pruned by *send* time, not completion time,
   * so a request stays counted here for the full settle window even after
   * its real (much smaller) usage already landed in `usageHistory` above -
   * that overlap is the point: it's what "not yet released" would look
   * like from the outside. */
  const reservationHistory: { time: number; amount: number }[] = [];

  /** Best guess at what the *next* request's input will cost, for
   * reservation purposes - `estInputTokens` (regex-based) badly
   * undercounts (seen ~5x off in practice), but real conversational input
   * only grows turn over turn, so the last real figure is a solid floor. */
  const lastRealInput = { current: 0 };

  /**
   * A request is about to be sent.
   *
   * - Attempt to parse the event info to obtain statistics like input tokens.
   * - Warn if another request is still outstanding (see `inFlight` above).
   * - Delay sending the request, if throttling is called for.
   */
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    const now = Date.now();
    const debtMs = Math.round(Math.max(0, debt.current - now));
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

    const sentAt = Date.now();
    lastRequestSentAt.current = sentAt;
    reservationHistory.push({
      time: sentAt,
      amount: (lastRealInput.current || estInputTokens) + (maxOutputTokens ?? 0),
    });
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
    const now = Date.now();
    const roundTripMs = lastRequestSentAt.current ? now - lastRequestSentAt.current : undefined;
    log(
      ctx,
      `[throttle] <- final usage: input=${input} output=${output} total=${totalTokens}${roundTripMs !== undefined ? ` (round trip: ${roundTripMs}ms)` : ""}`,
    );

    // Diagnostic only - not used for throttling. Real per-`REAL_LIMIT_WINDOW_MS`
    // token sum as WE observe it, to compare against what the provider says
    // it's seen (in the error text logged below) when the two disagree.
    usageHistory.push({ time: now, tokens: totalTokens });
    while (usageHistory.length && usageHistory[0].time < now - REAL_LIMIT_WINDOW_MS) {
      usageHistory.shift();
    }
    const observedWindowSum = usageHistory.reduce((sum, entry) => sum + entry.tokens, 0);
    log(ctx, `[throttle] .. observed real usage in trailing ${REAL_LIMIT_WINDOW_MS}ms: ${observedWindowSum} tokens`);

    // Diagnostic only, same as above - sum of (input + max output) for every
    // request SENT within TRAILING_RESERVATION_MS, whether or not it has
    // resolved yet. Compare `observedWindowSum + pendingReservation` against
    // what the provider reports to test the "reservations settle with a lag"
    // theory directly, instead of doing this arithmetic by hand after the fact.
    while (reservationHistory.length && reservationHistory[0].time < now - TRAILING_RESERVATION_MS) {
      reservationHistory.shift();
    }
    const pendingReservation = reservationHistory.reduce((sum, entry) => sum + entry.amount, 0);
    log(
      ctx,
      `[throttle] .. pending reservation in trailing ${TRAILING_RESERVATION_MS}ms: ${pendingReservation} tokens (observed + pending: ${observedWindowSum + pendingReservation})`,
    );

    lastRealInput.current = input;

    inFlight.count = Math.max(0, inFlight.count - 1);

    const charge = totalTokens * msPerToken();
    debt.current = Math.max(debt.current, now) + charge;
    log(ctx, `[throttle] .. bucket charged +${Math.round(charge)}ms (debt now clears at +${Math.round(debt.current - now)}ms)`);

    if (event.message.stopReason === "error") {
      if (event.message.errorMessage) {
        log(ctx, `[throttle] !! error detail: ${event.message.errorMessage}`);
      }
      if (isRateLimitError(event.message.errorMessage)) {
        const penalized = Date.now();
        debt.current = Math.max(debt.current, penalized) + config.windowMs;
        log(ctx, `[throttle] !! rate-limit error - forcing a full window (${config.windowMs}ms) of debt`);
      }
    }
  });
}
