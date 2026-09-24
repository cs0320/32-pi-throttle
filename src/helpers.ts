import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThrottleConfig } from "./defaults";

/** Debug log file, constant for now */
const LOG_FILE_NAME = "pi-throttle.log";

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
 * streaming replies). Thus, ordering in the TUI (rather than file) is not reliable.
 */
function log(ctx: ExtensionContext, message: string, config: ThrottleConfig) {
  if (config.logToFile) {
    const line = `[${new Date().toISOString()}] ${message}`;
    try {
      appendFileSync(join(ctx.cwd, LOG_FILE_NAME), line + "\n");
    } catch (err) {
      // Report once and stop writing, but don't throw into pi's request hooks.
      config.logToFile = false;
      const reason = err instanceof Error ? err.message : String(err);
      const failure = `[throttle] couldn't write ${LOG_FILE_NAME} (${reason}); logging to file is off`;
      if (ctx.hasUI) {
        ctx.ui.notify(failure, "error");
      } else {
        console.error(failure);
      }
    }
  }
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
  } else {
    console.log(message);
  }
}

export type Logger = (ctx: ExtensionContext, message: string) => void;

/** Claude: `alwaysLog` ignores `config.debug`; `debugLog` logs only when it's on.
 * Both write to file per `config.logToFile`. */
export function makeLoggers(config: ThrottleConfig): { alwaysLog: Logger; debugLog: Logger } {
  const alwaysLog: Logger = (ctx, message) => log(ctx, message, config);
  const debugLog: Logger = (ctx, message) => {
    if (config.debug) alwaysLog(ctx, message);
  };
  return { alwaysLog, debugLog };
}

/** Helper to registers a `/<name> on|off` command. */
export function registerOnOffCommand(
  pi: ExtensionAPI,
  options: { name: string; description: string; label: string; get: () => boolean; set: (on: boolean) => void },
) {
  const { name, description, label, get, set } = options;
  pi.registerCommand(name, {
    description,
    getArgumentCompletions: (prefix) =>
      ["on", "off"]
        .filter((v) => v.startsWith(prefix.trim().toLowerCase()))
        .map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") set(true);
      else if (arg === "off") set(false);
      else {
        ctx.ui.notify(`Usage: /${name} on|off (${label} is ${get() ? "on" : "off"})`, "error");
        return;
      }
      ctx.ui.notify(`[throttle] ${label} ${get() ? "on" : "off"}`, "info");
    },
  });
}

/**
 * Sleep for a given number of ms. If `signal` aborts partway through, 
 * (e.g., if the user interrupts) wake up immediately.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Extract response headers relevant to rate limiting, for logging.  */
export function rateLimitHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([name]) => /rate-?limit|retry-after|request-?id/i.test(name))
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
}

/**
 * Best-effort at extracting `errorMessage` text. Likely to vary by provider.
 */
export function isRateLimitError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return /429|rate[ -]?limit/i.test(errorMessage);
}

/**
 * Extracts just text pieces from JSON, eliminating braces, quotes, etc. */
function extractText(value: unknown): string {
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
function estimateTokens(text: string): number {
  return (text.match(/[A-Za-z]+|[0-9]+|[^\sA-Za-z0-9]/g) ?? []).length;
}

/** Payload fields that may carry the output-token cap, depending on provider. */
const MAX_OUTPUT_FIELDS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

/**
 * Pi's types file defines event.payload as `unknown`.
 * Attempt to parse the datum at runtime and find data
 * on the estimated input and output token reservation.
 */
export function payloadHints(payload: unknown): {
  estInputTokens: number;
  maxOutputTokens: number | undefined;
  maxOutputField: string | undefined;
  thinkingBudget: number | undefined;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const text = extractText(p.system) + " " + extractText(p.messages);
  const estInputTokens = estimateTokens(text);
  const maxOutputField = MAX_OUTPUT_FIELDS.find((field) => typeof p[field] === "number");
  const maxOutput = maxOutputField ? p[maxOutputField] : undefined;
  const maxOutputTokens = typeof maxOutput === "number" ? maxOutput : undefined;
  const thinkingBudget = typeof p.thinking_token_budget === "number" ? p.thinking_token_budget : undefined;
  return { estInputTokens, maxOutputTokens, maxOutputField, thinkingBudget };
}

/**
 * Claude: returns a copy of `payload` with its output-token cap lowered to `cap`, never raised.
 * `field` is undefined when the payload has no recognized cap field, and `payload` is then unchanged.
 */
export function capMaxOutput(
  payload: unknown,
  cap: number,
): { payload: unknown; field: string | undefined; from: number | undefined } {
  if (typeof payload !== "object" || payload === null) return { payload, field: undefined, from: undefined };
  const copy: Record<string, unknown> = Object.fromEntries(Object.entries(payload));
  const field = MAX_OUTPUT_FIELDS.find((f) => typeof copy[f] === "number");
  if (!field) return { payload, field: undefined, from: undefined };
  const from = copy[field];
  if (typeof from !== "number") return { payload, field: undefined, from: undefined };
  copy[field] = Math.min(from, cap);
  return { payload: copy, field, from };
}
