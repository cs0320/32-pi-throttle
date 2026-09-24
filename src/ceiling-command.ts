import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThrottleConfig } from "./defaults";

/** Register command: `/throttle-ceiling <tokens>`. With no argument, reports the current value. */
export function registerCeilingCommand(pi: ExtensionAPI, config: ThrottleConfig) {
  pi.registerCommand("throttle-ceiling", {
    description: "Set the tokens-per-minute ceiling. Speak with course staff before changing this.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "") {
        ctx.ui.notify(`[throttle] ceiling is ${config.ceilingTokens} TPM`, "info");
        return;
      }
      const tokens = /^\d+$/.test(arg) ? Number(arg) : NaN;
      if (!Number.isSafeInteger(tokens) || tokens <= 0) {
        ctx.ui.notify(
          `Usage: /throttle-ceiling <positive integer> (ceiling is ${config.ceilingTokens} TPM)`,
          "error",
        );
        return;
      }
      config.ceilingTokens = tokens;
      ctx.ui.notify(`[throttle] ceiling set to ${tokens} TPM`, "info");
    },
  });
}
