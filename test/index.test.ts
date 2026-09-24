import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index";
import { DEFAULT_CONFIG } from "../src/defaults";
import { fakeCtx, fakePi, notified } from "./fakes";

function setup() {
  const { pi, handlers, commands } = fakePi();
  extension(pi);
  const { ctx, ui } = fakeCtx();
  const handler = (name: string) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`no handler for ${name}`);
    return h;
  };
  const request = () => handler("before_provider_request")({ payload: {} }, ctx);
  const messageEnd = (totalTokens: number, extra: Record<string, unknown> = {}) =>
    handler("message_end")(
      { message: { role: "assistant", usage: { input: 0, output: 0, totalTokens }, stopReason: "stop", ...extra } },
      ctx,
    );
  return { handler, request, messageEnd, commands, ctx, ui };
}

/** Claude: ms of fake time a request is held before it resolves. */
async function delayOf(request: () => unknown): Promise<number> {
  const start = Date.now();
  let done = false;
  const p = Promise.resolve(request()).then(() => (done = true));
  await vi.advanceTimersByTimeAsync(0);
  while (!done) await vi.advanceTimersByTimeAsync(100);
  await p;
  return Date.now() - start;
}

/** Claude: tokens that charge `ms` of debt under the default config. */
const tokensFor = (ms: number) => (ms * DEFAULT_CONFIG.ceilingTokens) / DEFAULT_CONFIG.windowMs;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("throttle", () => {
  it("does not delay the first request", async () => {
    const { request, ui } = setup();
    expect(await delayOf(request)).toBe(0);
    expect(ui.setWorkingMessage).not.toHaveBeenCalled();
  });

  it("delays the next request by the debt charged for real usage", async () => {
    const { request, messageEnd, ui } = setup();
    await request();
    messageEnd(tokensFor(5_000));
    const delay = await delayOf(request);
    expect(delay).toBeGreaterThanOrEqual(5_000);
    expect(delay).toBeLessThan(5_200);
    expect(ui.setWorkingMessage).toHaveBeenCalledWith(expect.stringContaining("throttled"));
  });

  it("does not delay when debt is under debtFloorMs", async () => {
    const { request, messageEnd } = setup();
    await request();
    messageEnd(tokensFor(DEFAULT_CONFIG.debtFloorMs - 100));
    expect(await delayOf(request)).toBe(0);
  });

  it("caps the delay at maxDelayMs", async () => {
    const { request, messageEnd } = setup();
    await request();
    messageEnd(tokensFor(DEFAULT_CONFIG.maxDelayMs * 2));
    const delay = await delayOf(request);
    expect(delay).toBeGreaterThanOrEqual(DEFAULT_CONFIG.maxDelayMs);
    expect(delay).toBeLessThan(DEFAULT_CONFIG.maxDelayMs + 200);
  });

  it("penalizes a rate-limit error at message_end, even with debug off", async () => {
    const { request, messageEnd, ui } = setup();
    await request();
    messageEnd(0, { stopReason: "error", errorMessage: "429 Too Many Requests" });
    expect(notified(ui, "warning")).toEqual([expect.stringContaining("rate-limit error - forcing a full window")]);
    expect(await delayOf(request)).toBeGreaterThanOrEqual(DEFAULT_CONFIG.maxDelayMs);
  });

  it("penalizes a 429 from after_provider_response", async () => {
    const { handler, request, ctx, ui } = setup();
    handler("after_provider_response")({ status: 429, headers: {} }, ctx);
    expect(notified(ui, "warning")).toEqual([expect.stringContaining("429 received - forcing a full window")]);
    expect(await delayOf(request)).toBeGreaterThanOrEqual(DEFAULT_CONFIG.maxDelayMs);
  });

  it("charges one window when a 429 reaches both after_provider_response and message_end", async () => {
    const { handler, request, messageEnd, ctx, ui } = setup();
    await request();
    handler("after_provider_response")({ status: 429, headers: {} }, ctx);
    messageEnd(0, { stopReason: "error", errorMessage: "429 Too Many Requests" });
    expect(notified(ui, "warning")).toEqual([expect.stringContaining("429 received - forcing a full window")]);

    // Claude: one window of debt clears after this many capped delays; two windows would take twice as many.
    const cappedRequests = Math.ceil(DEFAULT_CONFIG.windowMs / DEFAULT_CONFIG.maxDelayMs);
    for (let i = 0; i < cappedRequests; i++) {
      expect(await delayOf(request)).toBeGreaterThanOrEqual(DEFAULT_CONFIG.maxDelayMs);
      messageEnd(0);
    }
    expect(await delayOf(request)).toBe(0);
  });

  it("penalizes again on a later request", async () => {
    const { handler, request, ctx, ui } = setup();
    await request();
    handler("after_provider_response")({ status: 429, headers: {} }, ctx);
    await delayOf(request);
    handler("after_provider_response")({ status: 429, headers: {} }, ctx);
    expect(notified(ui, "warning")).toHaveLength(2);
  });

  it("ignores non-429 responses and non-assistant messages", async () => {
    const { handler, request, ctx } = setup();
    handler("after_provider_response")({ status: 500, headers: {} }, ctx);
    handler("message_end")({ message: { role: "user" } }, ctx);
    expect(await delayOf(request)).toBe(0);
  });
});

describe("commands", () => {
  it("registers /throttle-debug, which turns on debug log lines", async () => {
    const { request, commands, ctx, ui } = setup();
    await request();
    expect(notified(ui, "warning")).toEqual([]);

    await commands.get("throttle-debug")?.handler("on", ctx);
    await request();
    expect(notified(ui, "warning").length).toBeGreaterThan(0);
  });

  it("with debug on, logs response headers and labels a request after a failure as a likely retry", async () => {
    const { handler, request, messageEnd, commands, ctx, ui } = setup();
    await commands.get("throttle-debug")?.handler("on", ctx);
    await request();
    handler("after_provider_response")({ status: 200, headers: { "x-ratelimit-remaining-tokens": "5" } }, ctx);
    messageEnd(0, { stopReason: "error", errorMessage: "500 Internal Server Error" });
    await request();

    const lines = notified(ui, "warning");
    expect(lines).toContain("[throttle] <- response status=200 x-ratelimit-remaining-tokens=5");
    expect(lines).toContain("[throttle] .. previous request failed; this is likely a pi auto-retry");
    expect(lines).toContainEqual(expect.stringContaining("max output=? via ?, thinking budget=none"));
  });

  it("registers /throttle-log", () => {
    const { commands } = setup();
    expect(commands.has("throttle-log")).toBe(true);
  });

  it("/throttle-ceiling changes the per-token charge", async () => {
    const { request, messageEnd, commands, ctx } = setup();
    await commands.get("throttle-ceiling")?.handler(String(DEFAULT_CONFIG.ceilingTokens * 2), ctx);
    await request();
    messageEnd(tokensFor(10_000));
    const delay = await delayOf(request);
    expect(delay).toBeGreaterThanOrEqual(5_000);
    expect(delay).toBeLessThan(5_200);
  });

  it("/throttle-ceiling rejects invalid values and leaves the ceiling unchanged", async () => {
    const { request, messageEnd, commands, ctx, ui } = setup();
    for (const bad of ["0", "-5", "abc", "1.5", "1e6"]) {
      await commands.get("throttle-ceiling")?.handler(bad, ctx);
    }
    expect(notified(ui, "error")).toHaveLength(5);
    await request();
    messageEnd(tokensFor(5_000));
    const delay = await delayOf(request);
    expect(delay).toBeGreaterThanOrEqual(5_000);
    expect(delay).toBeLessThan(5_200);
  });

  it("/throttle-ceiling with no argument reports the current value", async () => {
    const { commands, ctx, ui } = setup();
    await commands.get("throttle-ceiling")?.handler("", ctx);
    expect(notified(ui, "info")).toEqual([`[throttle] ceiling is ${DEFAULT_CONFIG.ceilingTokens} TPM`]);
  });
});
