// Durable outbox for visit segments.
//
// Pure functions over a plain array, so the caller owns persistence and this
// stays testable. The ordering that matters is the caller's: append to storage
// *first*, then try to send, then drop what was accepted. Anything that fails
// to send is still on disk for the next attempt.
//
// Before this existed, a visit was posted once and discarded when the desktop
// app was unreachable — so every visit recorded while the app was restarting
// was lost for good.

/**
 * Cap on queued segments. At the 60s checkpoint this is ~8 hours of continuous
 * browsing, which comfortably covers a workday with the desktop app down. The
 * cap exists so a long outage cannot grow extension storage without bound.
 */
export const MAX_QUEUED = 500;

/**
 * Append segments, dropping the oldest once the cap is reached.
 *
 * Oldest-first eviction is deliberate: if we must lose data, lose the part
 * that is least likely to still be actionable, and keep the recent history
 * that a manager is most likely to look at.
 *
 * Returns the next queue and how many were evicted, so the caller can log it
 * rather than losing data silently.
 */
export function append(queue, segments, max = MAX_QUEUED) {
  const next = queue.concat(segments);
  if (next.length <= max) return { queue: next, dropped: 0 };

  const dropped = next.length - max;
  return { queue: next.slice(dropped), dropped };
}

/** The next `n` segments to attempt, oldest first. */
export function head(queue, n) {
  return queue.slice(0, n);
}

/**
 * Drop the first `n` segments — the ones the server accepted.
 *
 * Positional rather than by id: segments are only ever appended and only ever
 * sent oldest-first, so the accepted ones are always the head. This keeps the
 * queue free of identity bookkeeping that nothing else needs.
 */
export function drop(queue, n) {
  return queue.slice(n);
}
