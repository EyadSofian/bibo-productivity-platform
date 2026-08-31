//! Device state timeline (audit finding P0-2).
//!
//! `WindowTracker` records *which app had focus*, and only while the user was
//! active. That makes idle time the absence of rows, which is indistinguishable
//! from "the laptop was shut", "the agent was paused" and "the network was down" —
//! so idle time, total device time and first/last activity were not computable.
//!
//! This tracker records what the *machine* was doing as explicit, closed
//! intervals. The design guarantee that makes the numbers trustworthy:
//!
//!   **emitted intervals are contiguous and never overlap**, so for any window
//!   `sum(durations)` equals the wall-clock time the agent was running.
//!
//! Two deliberate differences from `WindowTracker`:
//!
//! * Durations come from wall-clock arithmetic (`now - start`), not from counting
//!   ticks. Counting assumes every poll is exactly one second, which it never is
//!   (the poll sleeps 1s and *then* does work), so tick-counting undercounts.
//! * A jump in the clock larger than the poll interval is treated as the machine
//!   having been suspended, and is emitted as its own interval rather than being
//!   silently absorbed into whatever was open.
//!
//! `offline` is not a state here: a disconnected agent cannot report that it is
//! disconnected. Offline is derived on the backend from gaps between intervals.
//! Screen lock is likewise absent until a platform probe exists for it — see
//! docs/FULL_SYSTEM_AUDIT.md §11 — rather than being guessed at.

/// A wall-clock gap larger than this means the process was not running: the
/// machine slept, was hibernated, or the agent was stopped. Well above the 1s
/// poll so ordinary scheduling jitter is never mistaken for a suspend.
pub const SUSPEND_GAP_S: i64 = 90;

/// Emit an in-progress interval at least this often, so a long idle stretch is
/// visible in the dashboard before it ends, and a crash loses at most this much.
pub const MAX_STATE_CHUNK_S: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsState {
    Active,
    Idle,
    /// The process was not running: sleep, hibernate, or the agent being stopped.
    Suspended,
}

impl OsState {
    pub fn as_str(self) -> &'static str {
        match self {
            OsState::Active => "active",
            OsState::Idle => "idle",
            OsState::Suspended => "suspended",
        }
    }
}

/// One closed interval, ready to persist and sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsStateSample {
    pub state: OsState,
    pub start_ts: i64,
    pub duration_s: i64,
}

/// Pure decision core. `tick` is a function of (now, idle, threshold, collecting)
/// over the held interval, so the whole timeline is unit-testable without timers,
/// sleeping, or platform calls.
#[derive(Debug, Default)]
pub struct StateTracker {
    /// The open interval: (state, when it started).
    current: Option<(OsState, i64)>,
    /// When `tick` last ran, used to detect a suspend.
    last_tick: Option<i64>,
}

impl StateTracker {
    /// Advance one poll step. Returns every interval that closed on this step
    /// (usually none or one; a suspend can close two).
    ///
    /// * `now` — wall-clock unix seconds.
    /// * `idle_s` — seconds since the last user input.
    /// * `threshold_s` — idle seconds before the user counts as away.
    /// * `collecting` — whether capture is allowed right now (pause, schedule,
    ///   owner switch). While false the timeline stops rather than recording a
    ///   state nobody consented to.
    pub fn tick(
        &mut self,
        now: i64,
        idle_s: f64,
        threshold_s: i64,
        collecting: bool,
    ) -> Vec<OsStateSample> {
        let mut out = Vec::new();

        if !collecting {
            // Close what is open and stop the clock. `last_tick` is cleared so the
            // paused stretch is not later reported as a suspend.
            self.close_at(now, &mut out);
            self.last_tick = None;
            return out;
        }

        // A gap means this process was not running for that stretch.
        if let Some(last) = self.last_tick {
            if now.saturating_sub(last) > SUSPEND_GAP_S {
                self.close_at(last, &mut out);
                push(&mut out, OsState::Suspended, last, now);
                self.current = None;
            }
        }
        self.last_tick = Some(now);

        // A clock that moved backwards makes every duration meaningless. Restart
        // the timeline rather than emitting a negative or invented interval.
        if let Some((_, start)) = self.current {
            if now < start {
                self.current = None;
            }
        }

        let desired = if idle_s >= threshold_s as f64 {
            OsState::Idle
        } else {
            OsState::Active
        };

        match self.current {
            None => self.current = Some((desired, now)),

            Some((state, start)) if state == desired => {
                if now - start >= MAX_STATE_CHUNK_S {
                    push(&mut out, state, start, now);
                    self.current = Some((state, now));
                }
            }

            Some((state, start)) => {
                // The transition instant is not always "now". Going idle is only
                // *detected* after `threshold_s` of silence, but the user actually
                // stopped when that silence began — so the boundary is backdated.
                // Both intervals share the boundary, which keeps them contiguous
                // and stops the grace window being counted as active work.
                let boundary = match desired {
                    OsState::Idle => (now - threshold_s).max(start),
                    _ => now,
                };
                push(&mut out, state, start, boundary);
                self.current = Some((desired, boundary));
            }
        }

        out
    }

    /// Close the open interval at `at` (shutdown, pause, or a detected suspend).
    fn close_at(&mut self, at: i64, out: &mut Vec<OsStateSample>) {
        if let Some((state, start)) = self.current.take() {
            push(out, state, start, at);
        }
    }

    /// Close the open interval at `now`.
    ///
    /// Test-only. Production has no clean shutdown hook here: the tracker owns
    /// its state inside a detached loop, and reaching it from the tray's Quit
    /// handler would mean sharing it behind a lock for one write. It is not
    /// needed, because the stretch between a quit and the next start is caught by
    /// the suspend gap on the next boot — recorded as `suspended`, which is what
    /// it was: time the machine was not being monitored. The only cost is that a
    /// few final seconds land in `suspended` rather than `active`.
    #[cfg(test)]
    pub fn flush(&mut self, now: i64) -> Vec<OsStateSample> {
        let mut out = Vec::new();
        self.close_at(now, &mut out);
        self.last_tick = None;
        out
    }

    #[cfg(test)]
    fn open_state(&self) -> Option<OsState> {
        self.current.map(|(s, _)| s)
    }
}

/// Record `[start, end)`, dropping empty intervals so a zero-length transition
/// never reaches the database.
fn push(out: &mut Vec<OsStateSample>, state: OsState, start: i64, end: i64) {
    let duration_s = end - start;
    if duration_s > 0 {
        out.push(OsStateSample {
            state,
            start_ts: start,
            duration_s,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THRESHOLD: i64 = 60;

    /// Drive the tracker one second at a time, as the real loop does.
    /// `idle_at` decides the idle reading for each second.
    fn run(
        tracker: &mut StateTracker,
        from: i64,
        to: i64,
        idle_at: impl Fn(i64) -> f64,
    ) -> Vec<OsStateSample> {
        let mut out = Vec::new();
        for now in from..to {
            out.extend(tracker.tick(now, idle_at(now), THRESHOLD, true));
        }
        out
    }

    fn total(samples: &[OsStateSample], state: OsState) -> i64 {
        samples
            .iter()
            .filter(|s| s.state == state)
            .map(|s| s.duration_s)
            .sum()
    }

    /// The invariant the whole feature rests on.
    fn assert_contiguous(samples: &[OsStateSample]) {
        for pair in samples.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            assert_eq!(
                a.start_ts + a.duration_s,
                b.start_ts,
                "intervals must be contiguous: {a:?} then {b:?}"
            );
        }
        assert!(
            samples.iter().all(|s| s.duration_s > 0),
            "no empty intervals"
        );
    }

    #[test]
    fn active_hour_is_all_active_and_contiguous() {
        let mut t = StateTracker::default();
        let mut out = run(&mut t, 0, 3600, |_| 0.0);
        out.extend(t.flush(3600));

        assert_contiguous(&out);
        assert_eq!(total(&out, OsState::Active), 3600);
        assert_eq!(total(&out, OsState::Idle), 0);
    }

    #[test]
    fn idle_in_the_middle_splits_the_hour_without_gaps_or_overlap() {
        let mut t = StateTracker::default();
        // Active 0..1200, then no input until 2400, then active again.
        let mut out = run(&mut t, 0, 3600, |now| {
            // Input stops at 1200 and resumes at 2400.
            if (1200..2400).contains(&now) {
                (now - 1200) as f64
            } else {
                0.0
            }
        });
        out.extend(t.flush(3600));

        assert_contiguous(&out);
        // Every second of the hour is accounted for exactly once.
        assert_eq!(
            total(&out, OsState::Active) + total(&out, OsState::Idle),
            3600
        );
        // The idle stretch is real and is not swallowed by the active total.
        assert!(
            total(&out, OsState::Idle) > 1000,
            "idle: {}",
            total(&out, OsState::Idle)
        );
    }

    #[test]
    fn the_idle_grace_window_is_not_counted_as_active() {
        let mut t = StateTracker::default();
        // Input stops at t=100; idle grows from there and crosses the threshold
        // at t=160, when the tracker first notices.
        let mut out = run(&mut t, 0, 400, |now| {
            if now < 100 {
                0.0
            } else {
                (now - 100) as f64
            }
        });
        out.extend(t.flush(400));

        assert_contiguous(&out);
        let active = total(&out, OsState::Active);
        // Active must end when input stopped (100), not when idle was detected
        // (160) — otherwise every idle transition inflates active time by the
        // whole threshold.
        assert_eq!(active, 100, "active time leaked the grace window");
        assert_eq!(total(&out, OsState::Idle), 300);
    }

    #[test]
    fn a_clock_jump_is_recorded_as_suspended_not_absorbed() {
        let mut t = StateTracker::default();
        // Ticks land on 0..=99, so the last moment we observed the machine is 99.
        let last_live_tick = 99;
        let mut out = run(&mut t, 0, last_live_tick + 1, |_| 0.0);

        // The lid closes; the next tick lands eight hours later.
        let wake = 100 + 8 * 3600;
        out.extend(t.tick(wake, 0.0, THRESHOLD, true));
        out.extend(t.flush(wake + 10));

        assert_contiguous(&out);
        // The suspend covers exactly the unobserved stretch: last tick → wake.
        assert_eq!(total(&out, OsState::Suspended), wake - last_live_tick);
        // The active interval before the sleep is closed at the last live tick,
        // not stretched across the night.
        assert_eq!(total(&out, OsState::Active), last_live_tick + 10);
    }

    #[test]
    fn pausing_stops_the_timeline_and_does_not_backfill_a_suspend() {
        let mut t = StateTracker::default();
        let mut out = run(&mut t, 0, 100, |_| 0.0);

        // Capture turns off (schedule ends / owner disables monitoring).
        out.extend(t.tick(100, 0.0, THRESHOLD, false));
        assert_eq!(t.open_state(), None);

        // It comes back on hours later. That stretch is not ours to describe, so
        // it must not appear as suspended.
        let resume = 100 + 4 * 3600;
        out.extend(t.tick(resume, 0.0, THRESHOLD, true));
        out.extend(t.flush(resume + 60));

        assert_eq!(total(&out, OsState::Suspended), 0);
        assert_eq!(total(&out, OsState::Active), 100 + 60);
    }

    #[test]
    fn long_states_are_chunked_but_stay_contiguous() {
        let mut t = StateTracker::default();
        let mut out = run(&mut t, 0, 3600, |_| 0.0);
        out.extend(t.flush(3600));

        assert!(out.len() > 1, "a long state should be chunked");
        assert_contiguous(&out);
        assert!(out
            .iter()
            .all(|s| s.duration_s <= MAX_STATE_CHUNK_S && s.duration_s > 0));
    }

    #[test]
    fn a_backwards_clock_never_produces_a_negative_interval() {
        let mut t = StateTracker::default();
        let mut out = run(&mut t, 1000, 1100, |_| 0.0);
        // NTP corrects the clock backwards by an hour.
        out.extend(t.tick(1100 - 3600, 0.0, THRESHOLD, true));
        out.extend(t.flush(1100 - 3600 + 50));

        assert!(out.iter().all(|s| s.duration_s > 0));
    }

    #[test]
    fn brief_input_during_a_long_idle_does_not_fragment_the_timeline() {
        let mut t = StateTracker::default();
        // Idle all day except one keypress at t=1000.
        let mut out = run(&mut t, 0, 2000, |now| {
            if now < 1000 {
                now as f64
            } else {
                (now - 1000) as f64
            }
        });
        out.extend(t.flush(2000));

        assert_contiguous(&out);
        assert_eq!(
            total(&out, OsState::Active) + total(&out, OsState::Idle),
            2000
        );
    }
}
