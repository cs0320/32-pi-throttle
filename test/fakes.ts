import { vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Claude: the subset of ExtensionContext the extension uses, with spies. */
export function fakeCtx(cwd = "/nonexistent-throttle-test-dir") {
  const ui = { notify: vi.fn(), setWorkingMessage: vi.fn() };
  const ctx = { cwd, hasUI: true, ui, signal: undefined };
  return { ctx: ctx as unknown as ExtensionContext & ExtensionCommandContext, ui };
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

/** Claude: captures the handlers and commands an extension registers. */
export function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, options: Command) => commands.set(name, options),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands };
}

/** Claude: notify messages sent at `level`. */
export function notified(ui: ReturnType<typeof fakeCtx>["ui"], level: string): string[] {
  return ui.notify.mock.calls.filter((call) => call[1] === level).map((call) => String(call[0]));
}
