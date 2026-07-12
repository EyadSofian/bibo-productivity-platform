package agent

import (
	"os/exec"
	"strings"

	"ctracking/monitor/internal/wire"
)

// unitStates asks systemd for each unit's active state in one exec.
// `systemctl is-active a b c` prints one state per line; nonzero exit just
// means some unit is not active, so the error is ignored.
func unitStates(units []string, now int64) []wire.UnitState {
	if len(units) == 0 {
		return nil
	}
	out, _ := exec.Command("systemctl", append([]string{"is-active"}, units...)...).Output()
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	states := make([]wire.UnitState, 0, len(units))
	for i, u := range units {
		state := "unknown"
		if i < len(lines) && strings.TrimSpace(lines[i]) != "" {
			state = strings.TrimSpace(lines[i])
		}
		states = append(states, wire.UnitState{TS: now, Unit: u, Active: state == "active", State: state})
	}
	return states
}
