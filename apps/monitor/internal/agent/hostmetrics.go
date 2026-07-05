package agent

import (
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"

	"ctracking/monitor/internal/wire"
)

// hostMetric samples CPU/mem/disk/load. cpu.Percent(0) measures since the
// previous call, which matches our tick cadence.
func hostMetric(now int64) (wire.Metric, error) {
	m := wire.Metric{TS: now}
	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		m.CPUPct = pcts[0]
	}
	vm, err := mem.VirtualMemory()
	if err != nil {
		return m, err
	}
	m.MemPct = vm.UsedPercent
	if du, err := disk.Usage("/"); err == nil {
		m.DiskPct = du.UsedPercent
	}
	if avg, err := load.Avg(); err == nil {
		m.Load1 = avg.Load1
	}
	return m, nil
}
