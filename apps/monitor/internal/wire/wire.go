// Package wire defines the JSON batch format the agent POSTs to the server's
// /ingest endpoint. Timestamps are unix milliseconds.
package wire

type Batch struct {
	Host     string      `json:"host"`
	Metrics  []Metric    `json:"metrics,omitempty"`
	Units    []UnitState `json:"units,omitempty"`
	Requests []Request   `json:"requests,omitempty"`
	Logs     []LogLine   `json:"logs,omitempty"`
}

type Metric struct {
	TS      int64   `json:"ts"`
	CPUPct  float64 `json:"cpu"`
	MemPct  float64 `json:"mem"`
	DiskPct float64 `json:"disk"`
	Load1   float64 `json:"load1"`
}

type UnitState struct {
	TS     int64  `json:"ts"`
	Unit   string `json:"unit"`
	Active bool   `json:"active"`
	State  string `json:"state"`
}

type Request struct {
	TS      int64   `json:"ts"`
	Service string  `json:"service"`
	Status  int     `json:"status"`
	DurMS   float64 `json:"dur_ms"`
	Method  string  `json:"method"`
	Path    string  `json:"path"`
}

type LogLine struct {
	TS      int64  `json:"ts"`
	Service string `json:"service"`
	Level   string `json:"level"`
	Line    string `json:"line"`
}
