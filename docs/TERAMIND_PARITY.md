# Teramind parity — gap analysis

**Source:** the published Teramind Dashboard API collection at
<https://apidoc.dev.teramind.co/> (Postman collection `12825404/TW74jRAB`,
pulled 2026-08-26). 34 folders, ~250 endpoints, 183 distinct capture keys.

**Decision of record (2026-08-26):** the product targets **full Teramind
parity**, including the content capture the original brief excluded. This
document supersedes the capture limits in
[`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) §privacy and FEATURE 33 of the
original brief; both are updated to match rather than silently contradicted.

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
| `keystrokes` | 3 | **counts only** | content capture, clipboard tracking |
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

### New — content capture (the parity decision)
| Area | New feature | Priority | Note |
|---|---|---|---|
| `emails__*`, activity/email/* | **F52** Email capture | P1 | metadata and body are separate keys — ship metadata first |
| `conversations__*`, report/im/* | **F53** IM / conversation capture | P2 | |
| `voip__*`, `audio__*`, voip-event | **F54** VoIP & audio capture | P2 | largest storage cost of anything here |
| `keystrokes__*`, report/keystrokes | **F55** Keystroke content capture | P1 | **see §4** |
| `files__*` | **F56** File activity | P1 | 25 keys — the biggest single category |
| `printed_docs__*` | **F57** Print activity | P2 | |
| `network__*` | **F58** Network connections | P2 | |
| `social_media__*` | **F59** Social media capture | P3 | |
| `sql__*` | **F60** SQL query monitoring | P3 | |
| `ocr__*` | **F62** Screen OCR | P3 | makes screenshots searchable; heavy CPU |
| `geo_location__*`, `camera__*` | **F63** Location & camera | P3 | highest legal sensitivity of the set |
| `advanced__*` | **F61** Endpoint restrictions | — | **go/no-go required, see §1.3** |
| Tasks, Time Tracking Reports | **F64** Tasks & cost reporting | P3 | excluded by the original brief; reinstated by the parity decision |

---

## 4. Keystroke content capture — the one design constraint

Teramind ships `websites__monitor_password_keystrokes` as an explicit,
separately-toggled key, and `applications__suspend_keystrokes` /
`websites__suspend_keystrokes` for per-app and per-site suspension. That is not
incidental: **a keylogger that does not mask password fields is a credential
database**, and a credential database is a breach-severity liability regardless
of how the monitoring itself is disclosed.

F55 therefore ships with:

- `keystrokes__mask_password_fields` — **default on**. Fields the OS reports as
  secure-entry (`NSSecureTextField` on macOS, `ES_PASSWORD` on Windows) record
  a length only, never characters.
- `keystrokes__suspend_apps` / `keystrokes__suspend_domains` — per-target
  suspension, prefilled from the existing screenshot skip list (which already
  ships with password managers and banking apps in it).
- Reading captured keystroke content is a distinct RBAC permission
  (`view_keystroke_content`), separate from `view_reports`, and every read is
  written to the F26 audit log.

Turning masking off is a config change, not a code change. The default is what
matters.

---

## 5. Sequencing

The parity list is ~24 new features on top of 37 unstarted ones. The order
below front-loads the things other features are blocked on:

```
1. F41  Monitoring profiles + scheduled capture   ← everything else configures through this
2. os_states (3 keys, into F5)                    ← unblocks correct idle/away attribution
3. F40  Devices                                   ← profiles bind to devices
4. F42  Schedules                                 ← worked-vs-scheduled
5. F6/F8 Productivity profiles + score            ← already the roadmap's next step
6. F43  Shared lists                              ← rules reference these
7. F44  Reports hub + async export
8. F18/F19 Rules + Alerts
9. F45  Employee notifications
10. F52/F56 Email + file capture                  ← the two highest-value capture categories
11. F55 Keystroke content (with §4 defaults)
12. everything else by priority
```

**F41 first is not negotiable.** Every capture feature after it is a set of
tracking keys inside a profile; building them before the profile system exists
means building each one twice.
