/**
 * A committed reservation: there's a request in flight, and our debt estimate
 * has to account for it. Store the timestamp to detect stale reservations.
 */
export interface Reservation {
  timestamp: number;
  ms: number;
}
