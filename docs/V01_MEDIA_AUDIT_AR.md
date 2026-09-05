# V01 — أوديت مسار الوسائط الحالي (Media Audit + Baseline)

> **الشريحة:** V01 من `docs/ENGOSOFT_VIDEO_FIRST_MONITORING_MASTER_PROMPT_AR.md`
> **التاريخ:** 2026-09-01 · **الفرع:** `main` · **آخر commit:** `96332fa`
> **القرار الناتج:** [ADR 0002 — Video-first WebRTC media plane](adr/0002-video-first-media-plane.md)
> **الـbacklog الناتج:** [ENGOSOFT_MEDIA_BACKLOG_AR.md](ENGOSOFT_MEDIA_BACKLOG_AR.md)

## 0. ما هذه الوثيقة وما ليست

هذه **قياس وجرد للموجود فعليًا**. لم يُكتب في V01 أي كود WebRTC، ولم يُبنَ أي SFU،
ولم يُنشأ أي جدول جديد، ولم يُحذف أي شيء. كل ما يخص الفيديو في هذه الوثيقة هو
**هدف مكتوب**، لا شيء منه منفَّذ.

| | الحالة |
|---|---|
| WebRTC live | ❌ غير موجود — لا كود ولا تبعية ولا إعداد |
| Session recording / object storage | ❌ غير موجود |
| Video Moments | ❌ غير موجود |
| Remote control عبر DataChannel | ❌ غير موجود (الموجود REST polling) |
| جداول `media_*` / `recording_*` | ❌ غير موجودة |
| أوديت + قياسات + ADR + backlog | ✅ هذه الوثيقة |

---

## 1. الخلاصة التنفيذية

المنتج يسمّي ميزة الشاشة **Live View**، وهي ليست فيديو. الوكيل يلتقط **صورة مستقلة
كل 900 ms**، يضغطها WebP عبر سُلَّم (أبعاد × جودة)، يرفعها إلى الـGo API، والـAPI
يحوّلها base64 داخل حدث JSON عبر SSE، وواجهة الإدارة تعرضها في `<img>`.

**ثلاثة مسارات صور مستقلة** تعمل اليوم، ورابع يعيد تشغيل الصور المخزّنة كـfilmstrip:

| # | المسار | يخزّن؟ | أين يظهر |
|---|---|---|---|
| 1 | Live View المستمر (~1.11 FPS) | لا — ذاكرة الـbackend بـTTL 30s | `EmployeeDetail.tsx` → `<img>` |
| 2 | Remote assistance frames (~1.11 FPS) | لا — نفس الـhub | نفس الـ`<img>` |
| 3 | Scheduled screenshots (كل 300s افتراضيًا) | **نعم** — قرص + Postgres metadata | Screenshot Gallery |
| 4 | One-shot live capture (`POST /devices/:id/live-capture`) | **نعم** — يمر بمسار (3) الدائم | لا شيء (لا مستدعي في الواجهة) |

**أهم رقم في هذا الأوديت:** المسار الحالي ينفق **0.72–2.16 Mbps ليسلّم 1.11 FPS**.
البروفايل المستهدف (720p / 15 FPS / H.264) ينفق 1.2 Mbps ليسلّم 15 FPS. أي أن
التكلفة لكل إطار مسلَّم **أعلى 8.1× إلى 24.3×** مقابل **1/13.5** من معدل الإطارات.
هذه فجوة بنيوية وليست مسألة ضبط: هذا هو ثمن غياب الضغط الزمني بين الإطارات.

ADR 0001 (2026-08-31) عالج بالفعل أسوأ ما في المسار — أخرج البايتات من Postgres
وحوّل التوصيل من polling إلى push — وقال صراحةً إن **WebRTC هو الهدف**. ما لم
يستطع إصلاحه هو **التمثيل نفسه**: صور مستقلة كاملة الترميز.

---

## 2. مخطط التدفق الحالي (Current data flow)

```text
                        Windows / macOS agent (Tauri + Rust)
  +--------------------------------------------------------------------------+
  |  trackers::capture_remote_frame()        trackers::capture_once()         |
  |    xcap::Monitor[0].capture_image()        xcap Monitor/Window capture    |
  |    compress_ladder(4 dims x 5 q)           compress_webp_to_limit()       |
  |    <=180 KiB WebP                          <=50 KiB WebP                  |
  |           |                                        |                      |
  |  sync/live_view.rs      (900 ms)         trackers::start_screenshots      |
  |  sync/remote_assist.rs  (900 ms)           (every 300 s)                  |
  |           |                                        |                      |
  |           |                              SQLite `screenshot` + .webp file |
  |           |                                        |                      |
  |           |                              sync/worker.rs -> multipart      |
  +-----------|----------------------------------------|---------------------+
              | POST /v1/agent/live/frame              | POST /v1/sync/screenshots
              | POST /v1/remote-assist/:id/frame       | (multipart, <=200 KiB)
              | Content-Type: image/webp               |
              | [IngestRateLimit: 10 rps per IP]       | [same limiter]
              v                                        v
  +------------------------------------+   +----------------------------------+
  |  Go API (Railway) - MEDIA RELAY    |   |  filestore.Write()               |
  |  internal/live.Hub                 |   |  STORAGE_DIR/screenshots/        |
  |    map[key] -> newest Frame        |   |    <biz>/<user>/<date>/          |
  |    TTL 30 s, cap 64 sessions       |   |    <uuid>.webp                   |
  |    (~16 MiB worst case)            |   |  + Postgres `screenshots`        |
  |    no Postgres, no disk            |   |    (metadata + file_path)        |
  +------------------------------------+   +----------------------------------+
              | SSE: base64(WebP) inside JSON          |
              | GET /v1/devices/:id/live/stream        | GET /v1/screenshots/:uuid
              | GET /v1/remote-assist/:id/frames/stream|
              v                                        v
  +--------------------------------------------------------------------------+
  |  React web-admin                                                         |
  |   EmployeeDetail.tsx    -> <img src="data:image/webp;base64,...">        |
  |   ScreenshotGallery.tsx -> fetchImageObjectUrl() -> <img src=blob:...>   |
  |   PlaybackPanel.tsx     -> the same images as a filmstrip @ 1x/2x/5x/10x |
  +--------------------------------------------------------------------------+

  command channel (not media): GET /v1/agent/commands/stream -> live_view_active
  input channel (remote ctrl): GET /v1/remote-assist/:id/actions every 180 ms (poll)
```

**قراءة المخطط:** كل سهم يحمل صورة كاملة الترميز. الـGo API في المنتصف **ناقل
وسائط** فعليًا. المسار الأيسر عابر (ذاكرة بـTTL)، والأيمن **دائم** (قرص + Postgres).
قناة الإدخال للتحكم عن بُعد ليست بثًا: إنها REST polling كل 180 ms.

### دورة حياة جلسة العرض الحالية

لا توجد state machine صريحة. الحالة موزّعة على أربعة مواضع:

1. **الويب:** `enabled` boolean في `EmployeeDetail.tsx` — فتح الـSSE هو ما يبدأ الجلسة.
2. **الـbackend:** عدد المشتركين في `Hub.Subscribers(key)` هو مصدر الحقيقة الوحيد
   لـ«هل يشاهد أحد؟».
3. **الوكيل:** deadline متجدّد (`PushSignals::live_view`) بـTTL 16s، يُجدَّد كل 5s.
4. **fallback:** `GET /v1/agent/live/status` كل 4s حين تنقطع قناة الأوامر.

التصميم سليم في اتجاهه (الرسالة الضائعة **توقف** الالتقاط ولا تتركه شغّالًا)، لكنه
لا يميّز `AUTHORIZING` من `WAITING_FOR_AGENT` من `NEGOTIATING` من `ICE_FAILED`،
فكل فشل يظهر كـspinner أو كرسالة واحدة عامة.

---

## 3. مخطط التدفق المستهدف (Target data flow)

```text
                    Windows interactive session
  +------------------------------------------------------------------+
  |  Engosoft Media Agent   (own process, not the Tauri WebView)      |
  |    Windows Graphics Capture / DXGI                                |
  |    hardware H.264 encoder (+ tuned software fallback)             |
  |    WebRTC publisher | policy / redaction gate                     |
  |    offline segment buffer (only when policy allows recording)     |
  +---------------------------+--------------------------------------+
                              | encrypted WebRTC media (DTLS-SRTP)
                              v
                 +--------------------------------+
                 |  WebRTC SFU + STUN/TURN        |  NOT on Railway
                 |   |- admin viewer (subscribe)  |
                 |   |- typed DataChannel (input) |
                 |   \- recorder / egress         |  only if recording is on
                 +---------------+----------------+
                                 | fMP4 / HLS segments (2-6 s)
                                 v
                 +--------------------------------+
                 |  S3-compatible object storage  |  private, encrypted,
                 +---------------+----------------+  short-lived signed URLs
                                 | signed manifest
   React <video> ----------------+---- Go API ---------------- Postgres
                                       CONTROL PLANE ONLY      metadata only
                                       zero media bytes
```

**الفارق الجوهري:** الـGo API ينتقل من **ناقل وسائط** إلى **control plane**:
مصادقة، تفويض، إنشاء rooms، إصدار tokens قصيرة العمر، metadata، audit، retention.
البايتات لا تلمسه إطلاقًا.

---

## 4. القياسات (Baseline measurements)

### 4.1 بيئة القياس

`cargo test --release -- --ignored --nocapture capture_cost` على Apple Silicon
(أسرع عتاد متاح في هذه الجلسة)، مصدر 2560×1440 RGBA.
المصدر: `apps/desktop/src-tauri/src/trackers/mod.rs`.

### 4.2 تكلفة الترميز على الوكيل — مقيسة اليوم

| القياس | النتيجة |
|---|---|
| سُلَّم الإطار الحي (الحالة النموذجية) | **66.8 ms** → 1600×900، **59 KiB** |
| سُلَّم الإطار الحي (الحالة السيئة) | **453.6 ms** → 1600×900، **178 KiB** |
| سُلَّم اللقطة الدورية | 63.7 ms → 1366×768، 23 KiB |
| سُلَّم اللقطة الدورية (الحالة السيئة) | 524.0 ms → 1152×648، 41 KiB |
| تصغير واحد 2560×1440 → 1600×900 | 15.6 ms |
| ترميز WebP واحد @1600×900 | 44–50 ms لكل درجة جودة |
| بث 10 إطارات كثيفة — سُلَّم بارد | 478.4 ms/إطار |
| بث 10 إطارات كثيفة — استئناف من آخر درجة | **137.6 ms/إطار** |

الفاصل بين الإطارات `FRAME_INTERVAL = 900 ms`. أي أن الحالة السيئة تستهلك
**453.6/900 = 50.4% من نواة كاملة** على أسرع عتاد متاح. §3.2 من
`FULL_SYSTEM_AUDIT.md` قدّرت لابتوب Windows مكتبيًا بأنه أبطأ 3–4× أحادي النواة،
أي **1.4–1.8 ثانية للإطار** — أطول من الفاصل نفسه.

### 4.3 عرض النطاق — مشتق من القياسات أعلاه

الإطار يُرسَل خامًا (`image/webp`) صعودًا، ثم **base64 داخل JSON** نزولًا (+33%).

| الحالة | KiB خام | KiB بعد base64 | KB/s | **Mbps** | MB/ساعة لمشاهد واحد |
|---|---|---|---|---|---|
| إطار حي نموذجي | 59 | 78.7 | 89.5 | **0.72** | 322 |
| إطار حي — الحالة السيئة | 178 | 237.3 | 270.0 | **2.16** | 972 |
| لقطة دورية | 23 | 30.7 | 34.9 | 0.28 | 126 |

**المقارنة الحاسمة** مقابل بروفايل الهدف (720p15 @ 1.2 Mbps):

| | bits/إطار مسلَّم | FPS |
|---|---|---|
| الحالي — نموذجي | 0.648 Mbit | 1.11 |
| الحالي — الحالة السيئة | 1.944 Mbit | 1.11 |
| **الهدف — H.264 720p15** | **0.080 Mbit** | **15** |

أي **8.1×–24.3×** تكلفة لكل إطار، مقابل **7.4%** من معدل الإطارات.

### 4.4 حدود التوسّع — مقروءة من الكود

`POST /v1/agent/live/frame` مسجَّل داخل مجموعة `ingest` خلف
`middleware.IngestRateLimit()` = **10 rps لكل IP** (burst 60)
(`internal/middleware/ratelimit.go:15-20`, `internal/server/server.go:167-172`).

عند 1.11 FPS للجهاز الواحد، **9 أجهزة خلف NAT مكتب واحد تُشبع الحد** وتبدأ
بفقدان إطارات. هذا سقف بنيوي على مسار الوسائط لأنه يمر أصلًا على الـcontrol plane.

### 4.5 زمن التنسيق — من ADR 0001 (loopback، ليس قياسًا جديدًا)

| الخطوة | قبل ADR 0001 | بعده |
|---|---|---|
| فتح العرض الحي → الوكيل يُبلَّغ | لم يكن موجودًا | 7 ms |
| رفع الإطار → عرضه عند المشاهد | 0–3000 ms | 7 ms |
| معدل الإطارات | 0.05 FPS | ~1.1 FPS |

**تحذير:** هذه أرقام loopback ولا تشمل WAN ولا تشمل زمن الالتقاط/الترميز
(66.8–453.6 ms أعلاه). وهي **لم تُقَس على جهاز Windows حقيقي** — ADR 0001 يذكر
ذلك صراحةً في «Still open».

### 4.6 الحالة القاعدية للاختبارات — مُشغَّلة اليوم

| المكوّن | الأمر | النتيجة |
|---|---|---|
| Backend Go | `TEST_DATABASE_URL=… go test -count=1 ./...` | ✅ **100 passed**، 0 فشل |
| Desktop Rust | `cargo test` | ✅ **78 passed**، 0 فشل، 4 ignored |
| web-admin | `pnpm -r --if-present test` | ✅ **192 passed** (17 ملفًا) |
| extension | نفس الأمر | ✅ **63 passed** (4 ملفات) |
| **الإجمالي** | | **433 اختبارًا، 0 فشل** |

الاختبارات الأربعة المتجاهَلة (`--ignored`) هي بالضبط قياسات `capture_cost` في §4.2.

---

## 5. الجرد الكامل (Inventory)

### 5.1 مسارات API — الصور والإطارات

| المسار | المجموعة | الحمولة | المصير |
|---|---|---|---|
| `POST /v1/agent/live/frame` | ingest | `image/webp` خام | يُحذف في V12 |
| `GET /v1/devices/:device_id/live/stream` | authed | SSE base64 WebP | يُستبدل بـWebRTC في V05، يُحذف في V12 |
| `GET /v1/agent/live/status` | authed | JSON TTL | يُستبدل في V05 |
| `GET /v1/agent/commands/stream` | authed | SSE أوامر | يُعاد تقييمه في V05 (قد يبقى للـmetadata) |
| `POST /v1/remote-assist/:session_id/frame` | ingest | `image/webp` خام | يُحذف في V12 |
| `GET /v1/remote-assist/:session_id/frame` | authed | `image/webp` | يُحذف في V12 |
| `GET /v1/remote-assist/:session_id/frames/stream` | authed | SSE base64 WebP | يُحذف في V12 |
| `GET /v1/remote-assist/:session_id/actions` | authed | JSON — **polling 180 ms** | يُستبدل بـDataChannel في V07 |
| `POST /v1/remote-assist/:session_id/actions` | authed | JSON | يُستبدل في V07 |
| `POST /v1/sync/screenshots` | ingest | multipart image | يُوقَف في V02، يُحذف في V12 |
| `GET /v1/reports/employees/:id/screenshots` | authed | JSON metadata | يُحذف في V12 |
| `GET /v1/screenshots/:client_uuid` | authed | `image/webp` | يُحذف في V12 |
| `POST /v1/devices/:device_id/live-capture` | authed | JSON (يُطلق مسار الصور الدائم) | يُوقَف في V02 |
| `POST /v1/businesses/:id/screenshots/cleanup` | authed | JSON | يُراجَع في V12 |

### 5.2 الجداول

| الجدول | الهجرة | يحتوي بايتات؟ | ملاحظة |
|---|---|---|---|
| `screenshots` | `00004_screenshots.sql` | لا (metadata + `file_path`) | البايتات على القرص تحت `STORAGE_DIR` |
| `remote_assist_frames` | `00018_remote_assist.sql` | `image bytea` | **جدول ميت** — لا كتابة منذ ADR 0001، فقط `DELETE` |
| `remote_assist_sessions` / `_actions` / `_audit` | `00018` | لا | يُستبدل بـ`media_sessions` + `remote_control_sessions` |
| `businesses.screenshot_*` | `00002/00005/00009` | لا | `retention_days`, `interval_s`, `mode`, `skip_apps` |
| `devices.live_capture_requested_at/_served_at` | `00017_live_monitoring.sql` | لا | مسار اللقطة الواحدة |
| `monitoring_profile_details` | `00013` | لا | `timezone` **IANA صحيح** — انظر §6 |

**غير موجود:** `media_sessions`, `media_tracks`, `recording_assets`,
`recording_gaps`, `viewer_sessions`, `remote_control_sessions`,
`media_audit_events`. آخر هجرة: `00019_os_states.sql`.

### 5.3 الملفات — سطح الوسائط القديم (~2 600 سطر)

**Backend:** `internal/live/hub.go` (310) · `internal/live/commands.go` (120) ·
`internal/handlers/live_view.go` (288) · `internal/handlers/remote_assist.go` (~450) ·
`internal/handlers/screenshot.go` (165) · `internal/retention/retention.go` (97) ·
`internal/filestore/filestore.go` (89) · مسارات `internal/store/{device,screenshot,remote_assist,reports}.go`.

**Desktop:** `sync/live_view.rs` (169) · `sync/remote_assist.rs` (~430) ·
`sync/client.rs` (`live_view_upload_frame`, `live_view_status`, `remote_assist_upload_frame`, `sync_screenshot`) ·
`trackers/mod.rs` (سُلَّم الضغط، `capture_once`, `capture_remote_frame`, `start_screenshots`, `start_cleanup`) ·
`storage/mod.rs` (جدول `screenshot` في SQLite) · `src/screens/Screenshots.tsx`.

**Web-admin:** `pages/EmployeeDetail.tsx` (`<img>` للبث) ·
`components/reports/ScreenshotGallery.tsx` (237) ·
`components/reports/PlaybackPanel.tsx` (258) ·
`api/client.ts` (`fetchImageObjectUrl`, `subscribeFrameStream`) · `api/sse.ts` (59) ·
عدّاد `statScreenshots` في `pages/Dashboard.tsx`.

### 5.4 Feature flags وإعدادات التخزين

**لا توجد أي feature flags للوسائط اليوم.** لا `MEDIA_*` ولا `LEGACY_*`.
التحكم كله عبر إعدادات المؤسسة في Postgres (`businesses.screenshot_*`) وسياسة
Monitoring Profile. `STORAGE_DIR` هو الجذر الوحيد لتخزين الصور.

**الاحتفاظ (retention) اليوم:**

- **الوكيل:** `trackers::start_cleanup` كل ساعة، يحذف ملفات + صفوف SQLite أقدم من
  `screenshot_retention_days` (افتراضي 30 يومًا).
- **الـbackend:** `retention.Service.StartSweeper` — يحذف الملف أولًا ثم الصف،
  والملف المفقود ليس خطأ (self-healing).
- **مساحة القرص الحالية:** `apps/backend/storage/` تحتوي `.gitignore` فقط —
  **صفر لقطات محلية**. الجرد الفعلي للإنتاج مطلوب قبل V12.

---

## 6. مسائل تبيّن أنها ليست كما وُصفت

الأمانة تقتضي تسجيل ما وجدته **مخالفًا** لافتراضات البرومبت:

1. **الصور الحية لا تُخزَّن في Postgres.** ADR 0001 أخرجها فعلًا. البرومبت يصف هذا
   بدقة، لكن يجدر التأكيد: `remote_assist_frames.image` جدول ميت، والـhub في الذاكرة.
2. **خطأ الـtimezone مُصلَح بالفعل.** الواجهة ترسل IANA identifier
   (`src/timeZone.ts` + قائمة `TIMEZONES` في `MonitoringProfiles.tsx`)، والـbackend
   يتحقق عبر `time.LoadLocation` مع `_ "time/tzdata"` مُضمَّنًا
   (`handlers/monitoring_profile.go:99`)، والوكيل يفسّرها عبر `chrono-tz`. لا label
   مترجم ولا UTC offset في أي طرف. **V10 يتقلّص** إلى: قسم Video & Live في
   البروفايل + `policy_snapshot` + اختبار انحدار للـtimezone، لا إصلاح.
3. **`POST /devices/:id/live-capture` لا مستدعي له في الواجهة** — موجود في
   `api/endpoints.ts:332` وغير مستخدم في أي صفحة. لكنه **حي في الـbackend والوكيل**،
   ويكتب لقطة **دائمة**. زر «حي» ينتج صورة محفوظة: يجب إغلاقه في V02.
4. **`apps/backend/cmd/admin-audit/` و`cmd/admin-reset/` مجلدان فارغان.** لا كود.
5. **`pnpm -r --if-present test` شغّل web-admin فقط في تشغيل واحد ثم شغّل الاثنين في
   التالي.** لم أتمكن من تفسيره؛ سُجِّل كخطر على مصداقية بوابة CI ويحتاج تثبيتًا
   (تشغيل صريح لكل workspace) — انظر V02 acceptance.

---

## 7. الفجوات مقابل الهدف

### 7.1 معماريًا

| المطلوب | الحالة |
|---|---|
| `MediaProvider` / `RecordingStore` abstractions | ❌ لا وجود |
| SFU / STUN / TURN | ❌ لا وجود |
| Recorder / Egress | ❌ لا وجود |
| Object storage (S3-compatible) | ❌ لا وجود — التخزين قرص محلي |
| media runtime منفصل عن Tauri WebView | ❌ الالتقاط داخل عملية التطبيق |
| state machine صريحة للجلسة | ❌ الحالة موزّعة على 4 مواضع |

### 7.2 أمنيًا وحوكميًا — أخطر ما وجدته

1. **لا audit للعرض الحي إطلاقًا.** فتح `GET /v1/devices/:id/live/stream` ومشاهدة
   شاشة موظف **لا يكتب أي سجل**. `remote_assist_audit` يغطي المساعدة عن بُعد فقط.
2. **لا RBAC دقيق.** `memberships.role` = `owner|employee` فقط.
   `live_view.start`, `live_view.watch`, `recordings.view`, `recordings.delete`,
   `remote_control.start`, `media_settings.manage`, `media_audit.view` — **لا شيء منها موجود**.
   التفويض كله فحص ملكية واحد (`AuthorizeLiveView`).
3. **لا مؤشر مرئي أثناء العرض الحي.** المساعدة عن بُعد تعرض زر Stop دائم الظهور؛
   العرض الحي المستمر لا يعرض شيئًا. ADR 0001 رصد هذا ووسمه «قرار منتج/قانوني» ولم يغيّره.
4. **`policy_snapshot` غير موجود** — لا يمكن معرفة أي سياسة كانت مطبَّقة تاريخيًا.

### 7.3 في الواجهة

الـIA الحالي: `Dashboard · Employees(+detail) · Devices · Monitoring · Organization · Settings`.

**ناقص بالكامل:** Live Monitor · Video Moments · Session Recordings · Session Player ·
Activity · Applications & Websites · Rules & Alerts · Reports · Audit Log.

عدّاد Dashboard الحالي `statScreenshots` يقيس شيئًا سيختفي.

---

## 8. ما لم أستطع قياسه، ولماذا

| البند | السبب |
|---|---|
| Time to first live frame على Windows حقيقي | لا جهاز Windows في هذه الجلسة |
| Glass-to-glass latency فعلي | يحتاج جهازين وشبكة حقيقية |
| CPU/RAM للوكيل أثناء البث | يحتاج تشغيل الوكيل على عتاد مرجعي |
| سلوك multi-monitor وDPI | الالتقاط الحالي يستخدم `Monitor::all()[0]` فقط — سلوك معروف من الكود، غير مقيس |
| حجم الصور التاريخية في الإنتاج | `storage/` محلية فارغة؛ يلزم جرد على خادم الإنتاج قبل V12 |
| زمن الاستجابة الحقيقي للتحكم عن بُعد | 90 ms متوسط / 180 ms أسوأ **مشتق من الكود** (`ACTIVE_POLL`)، لا مقيس على الشبكة |

---

## 9. مخاطر التنفيذ القادمة

| الخطر | الأثر | التخفيف |
|---|---|---|
| Railway لا يدعم UDP للـmedia | يعطّل V05 كليًا | فصل الـmedia plane من البداية؛ LiveKit Cloud أولًا (ADR 0002) |
| اختيار خاطئ لربط الالتقاط على Windows | إعادة كتابة V04–V06 | V04 spike مقاس على عتاد حقيقي + ADR 0003 قبل الالتزام |
| حذف الصور التاريخية بلا إذن | فقدان بيانات لا رجعة فيه | V02 يوقف الجديد فقط؛ V12 لا يبدأ قبل جرد وقرار صريح من مالك البيانات |
| rollout يعود سرًا إلى الصور | يُبقي المشكلة للأبد | ممنوع صراحةً في ADR 0002 §6؛ حارس CI في V02 |
| ضياع سياق «الخطة» مقابل «المنفَّذ» | تقارير غير صادقة | §0 من هذه الوثيقة + تنسيق تسليم إلزامي لكل شريحة |

---

## 10. ما تغيّر في المستودع في V01

| الملف | التغيير |
|---|---|
| `docs/adr/0002-video-first-media-plane.md` | جديد — القرار المعماري |
| `docs/V01_MEDIA_AUDIT_AR.md` | جديد — هذه الوثيقة |
| `docs/ENGOSOFT_MEDIA_BACKLOG_AR.md` | جديد — شرائح V02–V14 |
| `docs/tickets/143-video-first-media-plane.md` | جديد — تذكرة العمل |
| `docs/tickets/00-INDEX.md` | سطر واحد مضاف |

**لا كود مُعدَّل. لا هجرات. لا حذف.** الاختبارات الـ433 كما هي.
