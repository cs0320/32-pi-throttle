export const DEFAULT_CONFIG = {
  /** Window size. Using 1 minute, since it matches the TPM config unit. */
  windowMs: 60_000,
  /** Approximate max per-user tokens per minute. */
  ceilingTokens: 300_000,
  /**
   * Prevent a very large request from stalling the session. It isn't clear
   * whether this should be done or, if it is, what the right value is.
   */
  maxDelayMs: 20_000,
  /**
   * Don't delay sending requests for under this amount of time. Wait for
   * more debt to accumulate.
   */
  debtFloorMs: 500,
  /**
   * Show the per-request diagnostic log lines. Configurable in TUI.
   */
  debug: false,
  /** Append log entries to `pi-throttle.log`. Configurable in TUI. */
  logToFile: false,
};

export type ThrottleConfig = typeof DEFAULT_CONFIG;