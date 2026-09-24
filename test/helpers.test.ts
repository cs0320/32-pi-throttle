import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/defaults";
import {
  isRateLimitError,
  makeLoggers,
  payloadHints,
  rateLimitHeaders,
  registerOnOffCommand,
  sleep,
} from "../src/helpers";
import { fakeCtx, fakePi, notified } from "./fakes";

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimitHeaders", () => {
  it("keeps rate-limit, retry-after and request-id headers only", () => {
    const line = rateLimitHeaders({
      "x-ratelimit-remaining-tokens": "1200",
      "anthropic-ratelimit-tokens-reset": "2026-09-24T12:00:00Z",
      "retry-after": "3",
      "x-request-id": "abc",
      "set-cookie": "secret",
      "content-type": "text/event-stream",
    });
    expect(line).toBe(
      "x-ratelimit-remaining-tokens=1200 anthropic-ratelimit-tokens-reset=2026-09-24T12:00:00Z retry-after=3 x-request-id=abc",
    );
  });

  it("returns an empty string when none match", () => {
    expect(rateLimitHeaders({ "content-type": "application/json" })).toBe("");
  });
});

describe("isRateLimitError", () => {
  it.each([
    ["429 Too Many Requests", true],
    ["Rate limit exceeded", true],
    ["rate-limit hit", true],
    ["ratelimit", true],
    ["500 Internal Server Error", false],
    [undefined, false],
    ["", false],
  ])("%s -> %s", (message, expected) => {
    expect(isRateLimitError(message)).toBe(expected);
  });
});

describe("payloadHints", () => {
  it("estimates input from system and message text, and reads max_tokens", () => {
    const hints = payloadHints({
      system: "hello world",
      messages: [{ role: "user", content: [{ type: "text", text: "a b" }] }],
      max_tokens: 100,
    });
    expect(hints).toEqual({ estInputTokens: 4, maxOutputTokens: 100 });
  });

  it("reads OpenAI-style output limits", () => {
    expect(payloadHints({ max_completion_tokens: 7 }).maxOutputTokens).toBe(7);
    expect(payloadHints({ max_output_tokens: 8 }).maxOutputTokens).toBe(8);
  });

  it("handles a missing payload", () => {
    expect(payloadHints(undefined)).toEqual({ estInputTokens: 0, maxOutputTokens: undefined });
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    await sleep(60_000, controller.signal);
  });

  it("resolves early when the signal aborts mid-sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    const p = sleep(60_000, controller.signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await p;
    expect(done).toBe(true);
  });
});

describe("makeLoggers", () => {
  it("debugLog is silent unless config.debug is on; alwaysLog always shows", () => {
    const config = { ...DEFAULT_CONFIG };
    const { alwaysLog, debugLog } = makeLoggers(config);
    const { ctx, ui } = fakeCtx();

    debugLog(ctx, "hidden");
    alwaysLog(ctx, "shown");
    config.debug = true;
    debugLog(ctx, "now shown");

    expect(notified(ui, "warning")).toEqual(["shown", "now shown"]);
  });

  it("writes to pi-throttle.log only when config.logToFile is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "throttle-test-"));
    const file = join(dir, "pi-throttle.log");
    const config = { ...DEFAULT_CONFIG };
    const { alwaysLog } = makeLoggers(config);
    const { ctx } = fakeCtx(dir);

    alwaysLog(ctx, "not in file");
    expect(existsSync(file)).toBe(false);

    config.logToFile = true;
    alwaysLog(ctx, "in file");
    const contents = readFileSync(file, "utf8");
    expect(contents).toMatch(/^\[.+\] in file\n$/);
  });

  it("on a write failure, reports one error and turns file logging off", () => {
    const config = { ...DEFAULT_CONFIG, logToFile: true };
    const { alwaysLog } = makeLoggers(config);
    const { ctx, ui } = fakeCtx("/nonexistent-throttle-test-dir");

    alwaysLog(ctx, "first");
    alwaysLog(ctx, "second");

    expect(config.logToFile).toBe(false);
    const errors = notified(ui, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("couldn't write pi-throttle.log");
    expect(notified(ui, "warning")).toEqual(["first", "second"]);
  });
});

describe("registerOnOffCommand", () => {
  function setup() {
    const { pi, commands } = fakePi();
    const state = { on: false };
    registerOnOffCommand(pi, {
      name: "t",
      description: "test on/off",
      label: "thing",
      get: () => state.on,
      set: (on) => (state.on = on),
    });
    const command = commands.get("t");
    if (!command) throw new Error("command not registered");
    return { command, state };
  }

  it("sets on and off", async () => {
    const { command, state } = setup();
    const { ctx, ui } = fakeCtx();

    await command.handler("on", ctx);
    expect(state.on).toBe(true);
    await command.handler(" OFF ", ctx);
    expect(state.on).toBe(false);

    expect(notified(ui, "info")).toEqual(["[throttle] thing on", "[throttle] thing off"]);
  });

  it.each(["", "maybe"])("shows usage and the current value for %j, without changing state", async (arg) => {
    const { command, state } = setup();
    const { ctx, ui } = fakeCtx();

    await command.handler(arg, ctx);
    expect(state.on).toBe(false);
    expect(notified(ui, "error")).toEqual(["Usage: /t on|off (thing is off)"]);
  });

  it("completes on/off by prefix", async () => {
    const { command } = setup();
    expect(await command.getArgumentCompletions?.("o")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    expect(await command.getArgumentCompletions?.("of")).toEqual([{ value: "off", label: "off" }]);
  });
});
