// Counters are process-lifetime totals for events an operator needs to see even
// when the log stream is being sampled or has rotated away. They are deliberately
// tiny: monotonic counts, no labels, no cardinality, no new dependency. The health
// endpoint exposes them, which is what the existing bibomon probes already read.
//
// A counter is not a substitute for a log line. Rejections log too (rate-limited);
// the counter answers "how many, in total, since this process started".

package obs

import "sync/atomic"

// legacyStillCaptureRejected counts how many still-image submissions were refused
// because the legacy screenshot pipeline is retired (docs/adr/0002). A non-zero
// value means agents are still running code that captures stills, so it is the
// signal that the V02 rollout is not finished.
var legacyStillCaptureRejected atomic.Uint64

// RecordLegacyStillCaptureRejected records one refused still-image submission.
func RecordLegacyStillCaptureRejected() { legacyStillCaptureRejected.Add(1) }

// LegacyStillCaptureRejected reports the running total.
func LegacyStillCaptureRejected() uint64 { return legacyStillCaptureRejected.Load() }

// ResetCounters zeroes every counter. Tests only: counters are process-lifetime
// totals, so production code must never call this.
func ResetCounters() { legacyStillCaptureRejected.Store(0) }
