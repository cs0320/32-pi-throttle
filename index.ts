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

import { log, sleep, payloadHints } from "./helpers";
import { Reservation } from "./types";

/**
 * Window size. Using 1 minute, since it matches the TPM config unit.
 */
const WINDOW_MS = 60_000;
/**
 * Approximate per-user tokens per minute. Slightly smaller than the real cap.
 */
const CEILING_TOKENS = 250_000; 
const MS_PER_TOKEN = WINDOW_MS / CEILING_TOKENS;

/**
 * Prevent a very large request from stalling the session. It isn't clear 
 * whether this should be done or, if it is, what the right value is.
 */
const MAX_DELAY_MS = 30_000;

/**
 * Don't delay sending requests for under this amount of time. Wait for more
 * debt to accumulate. 
 */
const DEBT_FLOOR_MS = 500;

/**
 * If a reservation sits unreconciled for longer than this, we count it as stale 
 * and remove it from the reservation set. 
 */
const RESERVATION_STALE_MS = 90_000;

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
   * A list of token reservations for "in-flight" requests. The oldest active
   * reservation will be first on the list. 
   * 
   * Because pi.dev doesn't provide us with a request ID 
   * (as of September 22, 2026) we assume that the oldest non-stale 
   * reservation will be replied to first. This is an assumption, but 
   * is sound absent concurrent requests (e.g., parallel tool calls).
   * 
   * If parallel tool calls _are_ happening, then it is possible for this
   * mechanism to under-count, and rate-limiting errors are possible. 
   */
  const reservations: Reservation[] = [];

  /**
   * A request is about to be sent.
   *
   * - Attempt to parse the event info to obtain statistics like input tokens.
   * - Delay sending the request, if throttling is called for.
   * - Reserve the request's worst-case cost (input + max output) so a
   *   second request right behind it sees accurate debt, not the stale
   *   pre-this-request number.
   */
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    const now = Date.now();
    const debtMs = Math.max(0, debtUntil - now);
    const { estInputTokens, maxOutputTokens } = payloadHints(event.payload);
    log(
      ctx,
      `[throttle] request (bucket debt: ${debtMs}ms, payload: ~${estInputTokens} est. input tokens, max output=${maxOutputTokens ?? "?"}, ${reservations.length} reservation(s) pending)`,
    );

    if (debtMs > Math.max(0, DEBT_FLOOR_MS)) {
      const delay = Math.min(debtMs, MAX_DELAY_MS);
      const capped = delay < debtMs ? " (capped)" : "";
      log(ctx, `[throttle] bucket owes ${debtMs}ms, delaying ${delay}ms${capped}`);
      await sleep(delay);
    }

    const reservedTokens = estInputTokens + (maxOutputTokens ?? 0);
    const reservationMs = reservedTokens * MS_PER_TOKEN;
    const sentAt = Date.now();
    reservations.push({ timestamp: sentAt, ms: reservationMs });
    debtUntil = Math.max(debtUntil, sentAt) + reservationMs;
    log(ctx, `[throttle] .. reserved +${Math.round(reservationMs)}ms for ~${reservedTokens} worst-case tokens`);
  });

  /**
   * A message has ended, so we should know how many output tokens were
   * really used. True up: drop this request's provisional reservation
   * (oldest pending, expiring anything abandoned along the way) and charge
   * the real usage instead.
   */
  pi.on("message_end", (event: MessageEndEvent, ctx: ExtensionContext) => {
    if (event.message.role !== "assistant") return;
    const { input, output, totalTokens } = event.message.usage;
    log(ctx, `[throttle] <- final usage: input=${input} output=${output} total=${totalTokens}`);

    // Check to see if we have stale reservations. These would come from (e.g.) 
    // requests that were ignored or errored.
    const now = Date.now();
    while (reservations.length > 0 && now - reservations[0].timestamp > RESERVATION_STALE_MS) {
      const stale = reservations.shift();
      log(ctx, `[throttle] .. dropped stale reservation (+${Math.round(stale!.ms)}ms, ${now - stale!.timestamp}ms old)`);
    }

    // We should have an unreconciled reservation remaining. Recover any over-estimation.
    const reservation = reservations.shift();
    if (reservation) {
      debtUntil = Math.max(0, debtUntil - reservation.ms);
    }

    const charge = totalTokens * MS_PER_TOKEN;
    debtUntil = Math.max(debtUntil, now) + charge;
    log(ctx, `[throttle] .. bucket charged +${Math.round(charge)}ms (debt now clears at +${Math.round(debtUntil - now)}ms)`);
  });
}
