/* BiBo Monitor dashboard. Plain JS + uPlot; data from /api/*. */
"use strict";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtTime = (ms) => new Date(ms).toLocaleString("en-GB", { hour12: false });
const fmtAgo = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
};

let hours = 24;
let plots = [];

function destroyPlots() { plots.forEach((p) => p.destroy()); plots = []; }

function makePlot(el, title, data, seriesDefs, opts = {}) {
  const div = document.createElement("div");
  const t = document.createElement("div");
  t.className = "charttitle";
  t.textContent = title;
  el.appendChild(t);
  el.appendChild(div);
  const axisStyle = { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { stroke: css("--grid") } };
  const p = new uPlot({
    width: Math.max(280, div.clientWidth || el.clientWidth - 30),
    height: 190,
    series: [
      { label: "time", value: (u, v) => (v == null ? "" : new Date(v * 1000).toLocaleString("en-GB", { hour12: false })) },
      ...seriesDefs.map((s) => ({ label: s.label, stroke: s.color, width: 2, points: { show: false }, value: (u, v) => (v == null ? "–" : s.fmt ? s.fmt(v) : v.toFixed(1)) })),
    ],
    axes: [axisStyle, { ...axisStyle, size: 52, ...(opts.yAxis || {}) }],
    scales: opts.scales || {},
    cursor: { drag: { setScale: false } },
    legend: { live: true },
  }, data, div);
  plots.push(p);
  return p;
}

async function api(path) {
  // Resolve against origin so the page works even when opened with
  // credentials embedded in the URL (Chrome blocks relative fetch there).
  const r = await fetch(new URL(path, location.origin).href);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/* ---------- Overview ---------- */

async function renderOverview() {
  const [ov, metrics] = await Promise.all([api("api/overview"), api(`api/metrics?hours=${hours}`)]);

  const alertsEl = document.getElementById("alerts");
  alertsEl.innerHTML = "";
  if (ov.alerts.length === 0) {
    alertsEl.innerHTML = `<div class="ok">✓ No firing alerts</div>`;
  } else {
    for (const a of ov.alerts) {
      const d = document.createElement("div");
      d.className = "alert";
      d.textContent = `🔥 ${a.summary} — since ${fmtAgo(a.since)}`;
      alertsEl.appendChild(d);
    }
  }

  const probesEl = document.getElementById("probes");
  probesEl.innerHTML = "";
  for (const p of ov.probes) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="name">${p.target}</div>
      <div class="val"><span class="dot ${p.up ? "up" : "down"}"></span>${p.up ? "UP" : "DOWN"}</div>
      <div class="sub">${p.ms.toFixed(0)} ms · ${(p.uptime24h * 100).toFixed(2)}% (24h) · ${fmtAgo(p.ts)}</div>`;
    probesEl.appendChild(card);
  }

  const unitsEl = document.getElementById("units");
  unitsEl.innerHTML = "";
  for (const u of ov.units) {
    const cls = u.stale ? "stale" : u.active ? "up" : "down";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="name">${u.host}</div>
      <div class="val"><span class="dot ${cls}"></span>${u.unit}</div>
      <div class="sub">${u.stale ? "no data" : u.state} · ${fmtAgo(u.ts)}</div>`;
    unitsEl.appendChild(card);
  }

  const hostsEl = document.getElementById("hosts");
  hostsEl.innerHTML = "";
  destroyPlots();
  const byHost = new Map();
  for (const m of metrics) {
    if (!byHost.has(m.host)) byHost.set(m.host, []);
    byHost.get(m.host).push(m);
  }
  for (const h of ov.hosts) {
    const rows = byHost.get(h.host) || [];
    const block = document.createElement("div");
    block.className = "hostblock";
    block.innerHTML = `<h3>${h.host}${h.stale ? " — ⚠ no recent data" : ""}</h3>
      <div class="statrow">
        <div class="stat"><div class="k">CPU</div><div class="v">${h.cpu.toFixed(0)}%</div></div>
        <div class="stat"><div class="k">Memory</div><div class="v">${h.mem.toFixed(0)}%</div></div>
        <div class="stat"><div class="k">Disk</div><div class="v">${h.disk.toFixed(0)}%</div></div>
        <div class="stat"><div class="k">Load 1m</div><div class="v">${h.load1.toFixed(2)}</div></div>
        <div class="stat"><div class="k">Last sample</div><div class="v" style="font-size:13px">${fmtAgo(h.ts)}</div></div>
      </div>`;
    hostsEl.appendChild(block);
    if (rows.length > 1) {
      const data = [
        rows.map((r) => r.ts / 1000),
        rows.map((r) => r.cpu),
        rows.map((r) => r.mem),
        rows.map((r) => r.disk),
      ];
      makePlot(block, "CPU / Memory / Disk %", data, [
        { label: "CPU %", color: css("--s1") },
        { label: "Mem %", color: css("--s5") },
        { label: "Disk %", color: css("--s3") },
      ], { scales: { y: { range: [0, 100] } } });
    }
  }
}

/* ---------- API tab ---------- */

async function renderAPI() {
  const rows = await api(`api/rollup?hours=${hours}`);
  const el = document.getElementById("apiCharts");
  el.innerHTML = "";
  destroyPlots();
  const byService = new Map();
  for (const r of rows) {
    if (!byService.has(r.service)) byService.set(r.service, []);
    byService.get(r.service).push(r);
  }
  if (byService.size === 0) {
    el.innerHTML = `<p class="sub">No API data yet for this range.</p>`;
    return;
  }
  for (const [service, list] of [...byService.entries()].sort()) {
    // Fill minute gaps with nulls so quiet periods show as gaps, not slopes.
    const total = list.reduce((a, r) => a + r.count, 0);
    const errs = list.reduce((a, r) => a + r.c5xx, 0);
    const block = document.createElement("div");
    block.className = "svcblock";
    block.innerHTML = `<h3>${service}</h3>
      <div class="statrow">
        <div class="stat"><div class="k">Requests</div><div class="v">${total.toLocaleString()}</div></div>
        <div class="stat"><div class="k">5xx</div><div class="v">${errs.toLocaleString()}</div></div>
        <div class="stat"><div class="k">Fail rate</div><div class="v">${total ? ((errs / total) * 100).toFixed(2) : "0.00"}%</div></div>
      </div>
      <div class="chartpair"><div class="c1"></div><div class="c2"></div></div>`;
    el.appendChild(block);

    const xs = [], counts = [], c4 = [], c5 = [], avg = [], p95 = [];
    let prev = null;
    for (const r of list) {
      if (prev !== null && r.minute > prev + 1) {
        xs.push((prev + 1) * 60); counts.push(null); c4.push(null); c5.push(null); avg.push(null); p95.push(null);
      }
      xs.push(r.minute * 60);
      counts.push(r.count); c4.push(r.c4xx); c5.push(r.c5xx);
      avg.push(r.avg_ms); p95.push(r.p95_ms);
      prev = r.minute;
    }
    makePlot(block.querySelector(".c1"), "Requests per minute", [xs, counts, c4, c5], [
      { label: "total", color: css("--s1"), fmt: (v) => v.toFixed(0) },
      { label: "4xx", color: css("--s3"), fmt: (v) => v.toFixed(0) },
      { label: "5xx", color: css("--s6"), fmt: (v) => v.toFixed(0) },
    ]);
    makePlot(block.querySelector(".c2"), "Latency ms (keepalive excluded)", [xs, avg, p95], [
      { label: "avg", color: css("--s1"), fmt: (v) => v.toFixed(1) + " ms" },
      { label: "p95", color: css("--s5"), fmt: (v) => v.toFixed(1) + " ms" },
    ]);
  }
}

/* ---------- Logs tab ---------- */

let logOldest = 0;

function logParams(before) {
  const p = new URLSearchParams();
  const svc = document.getElementById("logService").value;
  const lvl = document.getElementById("logLevel").value;
  const q = document.getElementById("logQ").value.trim();
  if (svc) p.set("service", svc);
  if (lvl) p.set("level", lvl);
  if (q) p.set("q", q);
  if (before) p.set("before", before);
  p.set("limit", "200");
  return p;
}

function logRow(l) {
  const d = document.createElement("div");
  d.className = "logrow";
  const ts = document.createElement("span"); ts.className = "lts"; ts.textContent = fmtTime(l.ts);
  const svc = document.createElement("span"); svc.className = "lsvc"; svc.textContent = l.service;
  const lvl = document.createElement("span"); lvl.className = "llvl " + l.level; lvl.textContent = l.level;
  const line = document.createElement("span"); line.className = "lline"; line.textContent = l.line;
  d.append(ts, svc, lvl, line);
  return d;
}

async function renderLogs(append) {
  const list = document.getElementById("logList");
  const more = document.getElementById("logMore");
  const rows = await api("api/logs?" + logParams(append ? logOldest : 0));
  if (!append) list.innerHTML = "";
  for (const l of rows) list.appendChild(logRow(l));
  if (rows.length) logOldest = rows[rows.length - 1].ts;
  more.hidden = rows.length < 200;
  if (!append && rows.length === 0) list.innerHTML = `<div class="logrow"><span class="lline">no matching lines</span></div>`;
}

async function fillLogServices() {
  const ov = await api("api/overview");
  const seen = new Set();
  const sel = document.getElementById("logService");
  for (const u of ov.units) {
    if (seen.has(u.unit)) continue;
    seen.add(u.unit);
    const o = document.createElement("option");
    o.value = o.textContent = u.unit;
    sel.appendChild(o);
  }
}

/* ---------- shell ---------- */

let current = "overview";
const renderers = { overview: renderOverview, api: renderAPI, logs: () => renderLogs(false) };

function show(tab) {
  current = tab;
  document.querySelectorAll("nav .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of ["overview", "api", "logs"]) document.getElementById("tab-" + t).hidden = t !== tab;
  renderers[tab]().catch((e) => console.error(e));
}

document.querySelectorAll("nav .tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
document.querySelectorAll("#range button").forEach((b) => b.addEventListener("click", () => {
  hours = +b.dataset.h;
  document.querySelectorAll("#range button").forEach((x) => x.classList.toggle("active", x === b));
  if (current !== "logs") renderers[current]().catch((e) => console.error(e));
}));
document.getElementById("logGo").addEventListener("click", () => renderLogs(false));
document.getElementById("logQ").addEventListener("keydown", (e) => { if (e.key === "Enter") renderLogs(false); });
document.getElementById("logMore").addEventListener("click", () => renderLogs(true));

fillLogServices().catch(() => {});
show("overview");
setInterval(() => { if (current === "overview") renderOverview().catch(() => {}); }, 30000);
