import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThrottleConfig } from "./defaults";

/** Register command: `/throttle-max-output <tokens>|off`. With no argument, reports the current value. */
export function registerMaxOutputCommand(pi: ExtensionAPI, config: ThrottleConfig) {
  const current = () => (config.maxOutputTokens === undefined ? "off" : `${config.maxOutputTokens} tokens`);
  pi.registerCommand("throttle-max-output", {
    description: "Cap output tokens per request (changing may render agent unstable)",
    getArgumentCompletions: (prefix) =>
      "off".startsWith(prefix.trim().toLowerCase()) ? [{ value: "off", label: "off" }] : [],
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "") {
        ctx.ui.notify(`[throttle] max output cap is ${current()}`, "info");
        return;
      }
      if (arg === "off") {
        config.maxOutputTokens = undefined;
        ctx.ui.notify(`[throttle] max output cap off`, "info");
        return;
      }
      const tokens = /^\d+$/.test(arg) ? Number(arg) : NaN;
      if (!Number.isSafeInteger(tokens) || tokens <= 0) {
        ctx.ui.notify(`Usage: /throttle-max-output <positive integer>|off (cap is ${current()})`, "error");
        return;
      }
      config.maxOutputTokens = tokens;
      ctx.ui.notify(
        `[throttle] max output cap set to ${tokens} tokens.`,
        "warning",
      );
    },
  });
}
