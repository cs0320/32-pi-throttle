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
 * Pi.dev's TUI takes over stdout, so we should use its built-in logging function
 * rather than console.log when we can. If there's no UI ready, use console.log. 
 */
function log(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "info");
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
export default function (pi: ExtensionAPI) {
  let loggedEarlyInput = false;

  /**
   * A request is about to be sent. Reset this extension's per-request state
   */
  pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
    loggedEarlyInput = false;
    log(ctx, "[throttle] -> request sent");
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
    log(ctx, `[throttle] <- final usage: input=${input} output=${output} total=${totalTokens}`);
  });
}
