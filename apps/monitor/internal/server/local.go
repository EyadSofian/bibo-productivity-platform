package server

import (
	"bufio"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"ctracking/monitor/internal/parse"
	"ctracking/monitor/internal/wire"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
)

// runLocalCollector monitors the server's own box (the mac VPS): host
// metrics, staging health checks (represented as unit states), and staging
// log file tails. Everything is written through the same InsertBatch path
// the remote agent uses.
func (s *Server) runLocalCollector() {
	lc := s.cfg.Local
	if lc.Host == "" {
		return
	}
	client := &http.Client{Timeout: 10 * time.Second}
	tails := make([]*fileTail, len(lc.Tails))
	for i, t := range lc.Tails {
		tails[i] = &fileTail{path: t.File, service: t.Service}
	}
	tick := time.NewTicker(15 * time.Second)
	for ; ; <-tick.C {
		now := time.Now().UnixMilli()
		b := &wire.Batch{Host: lc.Host}

		m := wire.Metric{TS: now}
		if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
			m.CPUPct = pcts[0]
		}
		if vm, err := mem.VirtualMemory(); err == nil {
			m.MemPct = vm.UsedPercent
		}
		if du, err := disk.Usage(dataVolume()); err == nil {
			m.DiskPct = du.UsedPercent
		}
		if avg, err := load.Avg(); err == nil {
			m.Load1 = avg.Load1
		}
		b.Metrics = append(b.Metrics, m)

		for _, c := range lc.Checks {
			state, active := "inactive", false
			if resp, err := client.Get(c.URL); err == nil {
				resp.Body.Close()
				if resp.StatusCode < 400 {
					state, active = "active", true
				}
			}
			b.Units = append(b.Units, wire.UnitState{TS: now, Unit: c.Unit, Active: active, State: state})
		}

		for _, t := range tails {
			reqs, logs := t.read(now)
			b.Requests = append(b.Requests, reqs...)
			b.Logs = append(b.Logs, logs...)
		}

		if err := s.store.InsertBatch(b); err != nil {
			log.Printf("local collector: %v", err)
		}
	}
}

// dataVolume returns the mount whose usage matters: on macOS "/" is the
// sealed read-only system volume, the real data lives on /System/Volumes/Data.
func dataVolume() string {
	if st, err := os.Stat("/System/Volumes/Data"); err == nil && st.IsDir() {
		return "/System/Volumes/Data"
	}
	return "/"
}

// fileTail follows a log file across truncation/rotation by offset+size.
type fileTail struct {
	path    string
	service string
	offset  int64
	primed  bool
}

func (t *fileTail) read(now int64) ([]wire.Request, []wire.LogLine) {
	st, err := os.Stat(t.path)
	if err != nil {
		return nil, nil
	}
	if !t.primed {
		// First pass: start at EOF, only ship new lines from now on.
		t.offset = st.Size()
		t.primed = true
		return nil, nil
	}
	if st.Size() < t.offset {
		t.offset = 0 // rotated/truncated
	}
	if st.Size() == t.offset {
		return nil, nil
	}
	f, err := os.Open(t.path)
	if err != nil {
		return nil, nil
	}
	defer f.Close()
	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return nil, nil
	}
	var reqs []wire.Request
	var logs []wire.LogLine
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if r, ok := parse.ParseRequest(line); ok {
			reqs = append(reqs, wire.Request{TS: now, Service: t.service, Status: r.Status, DurMS: r.DurMS, Method: r.Method, Path: r.Path})
		}
		logs = append(logs, wire.LogLine{TS: now, Service: t.service, Level: parse.Level(line), Line: line})
	}
	off, _ := f.Seek(0, io.SeekCurrent)
	t.offset = off
	return reqs, logs
}
