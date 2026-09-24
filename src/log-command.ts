import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThrottleConfig } from "./defaults";
import { registerOnOffCommand } from "./helpers";

/** Register command: `/throttle-log on|off`.  */
export function registerLogCommand(pi: ExtensionAPI, config: ThrottleConfig) {
  registerOnOffCommand(pi, {
    name: "throttle-log",
    description: "Turn logging to file `pi-throttle.log` on or off",
    label: "logging to pi-throttle.log",
    get: () => config.logToFile,
    set: (on) => (config.logToFile = on),
  });
}
