export const DEFAULT_CONFIG = {
  /** Window size. Using 1 minute, since it matches the TPM config unit.
   *  This should not be changed. */
  windowMs: 60_000,
  /** Prevent a very large request from stalling the session. 
   * Same as windowMs for now.*/
  maxDelayMs: 60_000,
  
  /**
   * Don't delay sending requests for under this amount of time. Wait for
   * more debt to accumulate. */
  debtFloorMs: 200,
  
  /** Approximate max per-user tokens per minute. Configurable in TUI. 
   *  However: changing the ceiling should not be done without talking 
   *  to course staff first. We have observed over-eager rate limiting 
   *  on the 0320/1340 LLM server in September 2026.
  */
  ceilingTokens: 300_000,
  
  /** Show the per-request diagnostic log lines. Configurable in TUI. */
  debug: false,
  /** Append log entries to `pi-throttle.log`. Configurable in TUI. */
  logToFile: false,
};

export type ThrottleConfig = typeof DEFAULT_CONFIG & {
  /** Claude: lower each request's output-token cap to this value; unset leaves pi's value.
   *  For live testing only: reasoning and answer share this cap, so responses may be cut off.
   *  Configurable in TUI. */
  maxOutputTokens?: number;
};