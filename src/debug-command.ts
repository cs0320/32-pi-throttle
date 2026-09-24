import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThrottleConfig } from "./defaults";
import { registerOnOffCommand } from "./helpers";

/** Registers `/throttle-debug on|off`. */
export function registerDebugCommand(pi: ExtensionAPI, config: ThrottleConfig) {
  registerOnOffCommand(pi, {
    name: "throttle-debug",
    description: "Turn debug logging on or off",
    label: "debug logging",
    get: () => config.debug,
    set: (on) => (config.debug = on),
  });
}
