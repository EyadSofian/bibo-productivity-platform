package handlers

import (
	"math"
	"testing"

	"ctracking/backend/internal/store"
)

func TestValidResourceSnapshot(t *testing.T) {
	valid := &store.ResourceSnapshot{
		CPUPct: 48.5, MemoryUsedBytes: 4_000, MemoryTotalBytes: 8_000,
		DiskUsedBytes: 20_000, DiskTotalBytes: 100_000,
		NetworkRxBPS: 5_000, NetworkTxBPS: 800,
	}
	if !validResourceSnapshot(nil) || !validResourceSnapshot(valid) {
		t.Fatal("nil and a bounded snapshot must be valid")
	}

	tests := map[string]store.ResourceSnapshot{
		"cpu above 100":       {CPUPct: 100.1},
		"cpu NaN":             {CPUPct: float32(math.NaN())},
		"memory used > total": {MemoryUsedBytes: 2, MemoryTotalBytes: 1},
		"negative network":    {NetworkRxBPS: -1},
		"disk used > total":   {DiskUsedBytes: 2, DiskTotalBytes: 1},
	}
	for name, snapshot := range tests {
		t.Run(name, func(t *testing.T) {
			if validResourceSnapshot(&snapshot) {
				t.Fatalf("invalid snapshot accepted: %#v", snapshot)
			}
		})
	}
}
