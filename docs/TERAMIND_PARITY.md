# Teramind parity — gap analysis

**Sources (reviewed 2026-08-26):** the published Teramind Dashboard API
collection at <https://apidoc.dev.teramind.co/> (34 folders, ~250 endpoints,
183 distinct capture keys), the official
[feature overview](https://kb.teramind.co/en/articles/9220916-overview),
[package comparison](https://kb.teramind.co/en/articles/8790885-what-is-the-difference-between-teramind-starter-teramind-uam-teramind-dlp-and-teramind-enterprise),
[employee-monitoring product page](https://www.teramind.co/solutions/employee-monitoring/),
and [current AI/product inventory](https://www.teramind.co/ai-info/).

**Decision of record (reconciled 2026-08-26):** the product targets broad
Teramind **capability parity for transparent employee monitoring**, with three
non-negotiable safety carve-outs inherited from the original product brief:
no stealth/hidden agent, no typed-key content capture, and no credential or
password capture. Keyboard activity remains aggregate counts. This document
does not supersede [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md); privacy limits
are acceptance criteria for every F40+ feature.

---

## 1. What Teramind actually is, architecturally

Three findings from the API that change our design, not just our backlog.

### 1.1 Capture is *scheduled*, not always-on

Every one of the 20 capture categories carries `days_of_week` and `time_range`.
Screenshots, keystrokes, websites, email, audio — each is independently
scheduled. A profile might capture websites 09:00–17:00 Mon–Fri and never
capture audio at all.

Our current agent has no such concept: capture is a set of global booleans.
This is the single largest architectural gap, because it is a *precondition*
for defensible monitoring ("we monitor during working hours on company
devices"), not a feature bolted on later. It also interacts with F42
(schedules) — a shift and a capture window are different objects, and
conflating them would be a mistake.

### 1.2 Configuration is a *profile* bound to a scope, not a per-employee setting

`PUT /tm-api/v1/monitoring-profile` takes `agent_id[]`, `computer_id[]`,
`ad_group_id[]`, `department_id[]` and a `details[]` array of
`{tracking_key, tracking_val}` pairs. So: one named profile, many keys, applied
to a set of targets. Profiles can be `private`.

Our settings model is per-business with an optional per-device override. Moving
to profiles is a schema change, and it is the model the productivity profiles
(F6) already want too — the same shape appears at
`/tm-api/v1/productivity-profile` with `parent_id` (profiles inherit) and
`assignments[]`.

**Both profile systems support inheritance via `parent_id`.** That is how the
brief's hierarchy (employee > role > department > company > global) is actually
implemented — as a profile tree, not as five separate lookup tables.

### 1.3 The `advanced__` group is not monitoring

18 keys under `advanced__` are endpoint *enforcement*:

```
advanced__restrictions_wifi_disable        advanced__block_print_screen
advanced__restrictions_bluetooth_disable   advanced__disable_clipboard_copy
advanced__restrictions_non_input_usb_disable
advanced__restrictions_wpd_disable         advanced__disable_pwd_manager
advanced__restrictions_builtin_admin_new_pass
advanced__restrictions_builtin_admin_new_user
```

This is a different product category — device control / DLP enforcement, not
workforce analytics. It carries different legal exposure, needs kernel-level
drivers on both platforms (`advanced__file_driver`, `advanced__network_driver`),
and two entries actively *degrade* the employee's own security posture
(`disable_pwd_manager` pushes people toward reused passwords;
`restrictions_builtin_admin_new_pass` mutates local admin credentials).

**Recommendation: do not build the `advanced__` group.** It is separable from
everything else here, it is the only part requiring signed kernel drivers, and
nothing else in the roadmap depends on it. Tracked as F61, status `NOT
STARTED — needs an explicit go/no-go`.

---

## 2. Capture categories — the 183 keys

| Category | Keys | We have | Gap |
|---|---:|---|---|
| `screen` | 14 | screenshots (interval, privacy mode, skip apps) | fps, live scale, remote control, record locked sessions, retention, async upload |
| `websites` | 15 | domain + URL + title + duration | scheduling, IP-only mode, suspend rules, private-mode policy, **password-keystroke toggle** |
| `applications` | 10 | app + window title + duration | scheduling, suspend rules, run-process capture |
| `keystrokes` | 3 | **counts only** | typed content is an explicit non-goal; clipboard DLP is metadata/classification only |
| `files` | 25 | — | all of it: access by type, copy/delete/rename/up/down, external drives, network shares, CD burning |
| `emails` | 14 | — | all of it: metadata, content, attachments, meetings, ignore lists |
| `network` | 10 | — | outbound connections, SSL, per-process, IP/port allow+deny |
| `printed_docs` | 8 | — | print jobs, document capture, page caps, printer exclusions |
| `conversations` | 7 | — | IM in/out, source, cutoff |
| `social_media` | 7 | — | posts, comments, edits |
| `audio` | 8 | — | input/output recording, bitrate, per-app |
| `voip` | 4 | — | call capture, internal-domain classification |
| `sql` | 4 | — | query monitoring, db/host exclusions |
| `registry` | 2 | — | Windows registry changes |
| `geo_location` | 3 | — | location + dwell threshold |
| `camera` | 2 | — | webcam capture |
| `ocr` | 2 | — | OCR over captured screens (makes screen content searchable) |
| `os_states` | 3 | — | **lock, sleep, screensaver** — needed by F5 |
| `offline_recording` | 2 | partial (SQLite queue) | byte/hour caps |
| `upload` | 2 | — | bandwidth cap, upload window |

`os_states` is worth calling out: it is 3 keys, trivial to implement, and F5
(activity engine) cannot correctly attribute idle vs away vs offline without
it. It should be pulled forward regardless of the parity decision.

---

## 3. Endpoint areas → roadmap

### Already covered by the existing roadmap
| Teramind area | Our feature |
|---|---|
| Departments | F7 |
| Productivity Profile | F6, F8 |
| Alert, Anomaly rules, Behavior policies, Rules, Policies | F18, F19 |
| Reports (grid), Report settings | F20 |
| Player, Video export | F15, F17 |
| Authorization | F24 |
| BI / BI Filter (`tma-query`, `tma-chart`) | F23 |
| Agent | F1 (employees) |

### New — no roadmap entry existed
| Teramind area | New feature | Priority |
|---|---|---|
| Computer, computer-notification | **F40** Devices & per-machine monitoring control | P1 |
| Monitoring | **F41** Monitoring profiles + scheduled capture | P0 |
| Schedule (template/position/modification) | **F42** Work schedules & shifts | P1 |
| Shared list | **F43** Shared lists | P2 |
| Reports export/status/download, batch | **F44** Reports hub + async export | P1 |
| computer-notification | **F45** Employee-facing notifications | P1 |
| LDAP, ldap-sync-status | **F46** Directory sync | P2 |
| License | **F47** License & seat usage | P2 |
| PlayerTags | **F48** Timeline tags & annotations | P2 |
| Time tracker (clock-in/out, note, history) | **F49** Attendance & clock-in | P1 |
| Instance (tma-state/categories/reset) | **F50** Instance analytics state | P3 |
| SMTP | **F51** Outbound mail configuration | P2 |

### New — additional activity channels (subject to the safety carve-outs)
| Area | New feature | Priority | Note |
|---|---|---|---|
| `emails__*`, activity/email/* | **F52** Email capture | P1 | metadata and body are separate keys — ship metadata first |
| `conversations__*`, report/im/* | **F53** IM / conversation capture | P2 | |
| `voip__*`, `audio__*`, voip-event | **F54** VoIP & audio capture | P2 | largest storage cost of anything here |
| `keystrokes__*`, report/keystrokes | **F55** Keyboard activity & input privacy | P1 | aggregate counts only; **see §4** |
| `files__*` | **F56** File activity | P1 | 25 keys — the biggest single category |
| `printed_docs__*` | **F57** Print activity | P2 | |
| `network__*` | **F58** Network connections | P2 | |
| `social_media__*` | **F59** Social media capture | P3 | |
| `sql__*` | **F60** SQL query monitoring | P3 | |
| `ocr__*` | **F62** Screen OCR | P3 | makes screenshots searchable; heavy CPU |
| `geo_location__*`, `camera__*` | **F63** Location & camera | P3 | highest legal sensitivity of the set |
| `advanced__*` | **F61** Endpoint restrictions | — | **go/no-go required, see §1.3** |
| Tasks, Time Tracking Reports | **F64** Tasks & cost reporting | P3 | excluded by the original brief; reinstated by the parity decision |

### Newly surfaced on the current official product site
| Teramind capability | New feature | Priority | Implementation boundary |
|---|---|---|---|
| AI-powered Insights feed | **F65** AI Insights & investigation summaries | P2 | evidence-linked summaries; no autonomous punishment |
| UEBA, behavioral baselines, risk scoring | **F66** Behavior baselines & risk scoring | P1 | explainable factors and manager review |
| Shadow AI / AI-agent governance | **F67** AI usage governance | P1 | tool/session/risk telemetry; never passwords or secure-field input |
| Employee sentiment and burnout trends | **F68** Workforce wellbeing signals | P2 | aggregated trends with minimum cohort sizes |
| Business-process mapping, in-app field parsing | **F69** Process mining & allowlisted field parsing | P2 | explicit app/field allowlists; sensitive-field masking |
| Citrix, VMware and RDP session recording | **F70** Virtual-session monitoring | P2 | visible agent and the same schedules/privacy policy |
| Remote desktop control | **F71** Consent-gated remote support | P2 | employee-visible session and revocable consent |
| Compliance templates and evidence packages | **F72** Compliance policy packs & evidence export | P1 | builds on F26/F27/F44 |
| Linux endpoint support | **F73** Linux agent | P2 | feature matrix and signed packages |
| Sensitive-data discovery, classification, fingerprinting | **F74** Content classification & fingerprinting | P1 | DLP matches/actions, not a credential vault |

Existing roadmap features already cover the rest of the refreshed surface:
F18/F19 scriptable rules and real-time actions, F22 webhooks/SIEM integration,
F24/F26 RBAC and audit evidence, F15/F17 live/history playback, and F27
retention/data-sovereignty controls.

---

## 4. Keyboard input — hard safety boundary

Teramind exposes typed-content and password-keystroke switches. BiBoTracking
does not implement either. F55 keeps the existing per-minute **count only**
model and adds schedule/profile controls, app/domain suspension, anomaly
signals and explicit proof tests that characters, clipboard payloads and secure
field values never enter SQLite, requests, Postgres, logs or analytics.

There is no configuration flag that can turn content capture on. This prevents
a future UI or policy mistake from converting the agent into a credential
database.

---

## 5. Sequencing

The parity list is ~24 new features on top of 37 unstarted ones. The order
below front-loads the things other features are blocked on:

```
1. F40  Devices                                   ← implemented; profiles bind to devices
2. F41  Monitoring profiles + scheduled capture  ← everything else configures through this
3. F7   Departments + job roles                   ← implemented core; opens scoped policy
4. os_states (3 keys, into F5)                    ← unblocks correct idle/away attribution
5. F42  Schedules                                 ← worked-vs-scheduled
6. F6/F8 Productivity profiles + score            ← already the roadmap's next step
7. F43  Shared lists                              ← rules reference these
8. F44  Reports hub + async export
9. F18/F19 Rules + Alerts
10. F45  Employee notifications
11. F52/F56 Email + file capture                  ← the two highest-value capture categories
12. F55 Keyboard activity/privacy proof tests
13. F65–F74 by dependency and priority
14. everything else by priority
```

**F41 precedes every remaining capture channel.** Each later channel is a set
of tracking keys inside a profile; building one outside that system means
building its configuration and schedule twice.
