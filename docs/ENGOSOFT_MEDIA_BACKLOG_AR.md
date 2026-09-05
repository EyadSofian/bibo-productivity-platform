# Engosoft Media — backlog الشرائح V02 → V14

> **المصدر:** `ENGOSOFT_VIDEO_FIRST_MONITORING_MASTER_PROMPT_AR.md` §23
> **القرار:** [ADR 0002](adr/0002-video-first-media-plane.md) · **الأساس:** [V01](V01_MEDIA_AUDIT_AR.md)
> **قاعدة:** لا شريحة «مكتملة» بـUI أو API غير موصول فعليًا بالوكيل.
> **حالة اليوم:** V01 ✅ · V02 ✅ · V03 ✅ · V05 جزئيًا ⏳ (الأجزاء غير المعتمدة على الوكيل)
> · V04 **لم تبدأ — تحتاج جهاز Windows** · V06 → V14 **لم تبدأ**.

## خريطة الاعتمادية

```text
V01  audit + ADR                       [DONE]
 |
 |-- V02  stop new still capture [DONE] --------------+
 |                                                    |
 |-- V03  MediaProvider + tokens + RBAC [DONE] +      |
 |                                            |       |
 \-- V04  Windows capture/encode spike -------+       |
                                              |       |
                                              v       v
                                    V05  WebRTC live (read-only)
                                              |
                             +----------------+----------------+
                             v                                 v
                    V06  Live UI + getStats          V07  Remote control
                             |                            (DataChannel)
                             v                                 |
                    V08  Egress + object storage               |
                             |                                 |
                             v                                 |
                    V09  Session Player + Video Moments        |
                             |                                 |
                             v                                 |
                    V10  Monitoring Profiles (video policy)    |
                             |                                 |
                             +----------------+----------------+
                                              v
                    V11  Retention / audit / observability / security
                                              v
                    V12  legacy removal   [DESTRUCTIVE - needs sign-off]
                                              v
                    V13  Windows installer + real-device matrix
                                              v
                    V14  staging load test + production runbook
```

**المسار الحرج:** V03 و V04 مستقلان ويمكن تنفيذهما بالتوازي؛ V05 يحتاجهما معًا.
V02 مستقل تمامًا ويجب أن يسبق كل شيء لأنه يوقف نزيف البيانات.

---

## V02 — إيقاف كل جمع جديد للصور الثابتة ✅ منفَّذ (2026-09-01)

**يعتمد على:** V01 · **destructive?** لا — إيقاف فقط، بلا حذف.
**التسليم:** `docs/tickets/144-stop-still-capture.md`

### النطاق
- `LEGACY_STILL_CAPTURE_ENABLED=false` كافتراضي في الـbackend، يرفض
  `POST /v1/sync/screenshots` و`POST /v1/devices/:id/live-capture` بكود
  `MEDIA_LEGACY_CAPTURE_DISABLED`.
- الوكيل: تعطيل `trackers::start_screenshots` و`capture_requested_frame`
  خلف نفس الراية القادمة من `GET /v1/policy`.
- **لا يُمَس** `trackers::start_cleanup` ولا `retention.Service` — الاحتفاظ يستمر
  في تقليص القديم.
- metric + تنبيه عند محاولة عميل قديم رفع لقطة.

### القبول
1. وكيل بإصدار قديم يرفع لقطة → 403 بكود صريح، وmetric `media_legacy_capture_rejected_total` يزيد.
2. صفر صفوف جديدة في `screenshots` وصفر ملفات جديدة تحت `STORAGE_DIR` خلال 24 ساعة staging.
3. البيانات التاريخية **سليمة** — العدّاد قبل/بعد متطابق عدا ما حذفه الاحتفاظ.
4. جرد مكتوب لصور الإنتاج (عدد، حجم، أقدم تاريخ) مرفوع للقرار، **بلا حذف**.
5. `pnpm` gate: تشغيل صريح لكل workspace بدل `-r --if-present` (خطر V01 §6.5).

### الاختبارات
- Go: رفض الرفع مع الراية مطفأة/مشتعلة · بقاء `GET /screenshots/:uuid` عاملًا للتاريخي.
- Rust: `start_screenshots` لا يلتقط عند `legacy_still_capture=false`.
- CI guard: لا `image/jpeg|png|webp` في أي مسار live/recording جديد.

---

## V03 — MediaProvider + عقود الغرف والـtokens والأمن ✅ منفَّذ (2026-09-01)

**يعتمد على:** V01 · **بالتوازي مع:** V04
**التسليم:** `docs/tickets/145-media-control-plane.md`

### النطاق
- `MediaProvider` و`RecordingStore` كـinterfaces (§5 من البرومبت). لا ربط
  مباشر بـLiveKit SDK أو S3 SDK داخل الـhandlers.
- هجرة: `media_sessions`, `media_tracks`, `viewer_sessions`, `media_audit_events`
  مع فهارس §10 الإلزامية و`policy_snapshot jsonb`.
- REST control plane: `POST /v1/devices/:id/media/live`,
  `GET /v1/media/sessions/:id`, `…/viewer-token`, `…/publisher-token`, `…/stop`.
- أخطاء machine-readable (`{error:{code,message,request_id,retryable}}`).
- RBAC: صلاحيات `live_view.*`, `recordings.*`, `remote_control.start`,
  `media_settings.manage`, `media_audit.view` — **جديدة، غير موجودة اليوم**.
- room id = UUID مبهم؛ ممنوع بريد أو اسم موظف في الاسم.

### القبول
1. tenant A لا يرى session لـtenant B عبر أي endpoint.
2. viewer token لا يمنح publisher permission (اختبار عقد صريح).
3. token منتهٍ مرفوض؛ TTL ≤ `MEDIA_TOKEN_TTL_SECONDS` (افتراضي 120).
4. وكيل لا يستطيع إصدار publisher token لجهاز آخر.
5. كل start/join/leave/end يكتب صفًا في `media_audit_events`.
6. صفر tokens/SDP/signed URLs في الـlogs (اختبار grep على مخرجات الاختبار).

### الاختبارات
- Contract: مصفوفة tenant/role × endpoint.
- Unit: token scopes وTTL · state machine transitions · policy resolution.
- Fake `MediaProvider` في الاختبارات — لا اتصال بمزوّد حقيقي في CI.

---

## V04 — spike الالتقاط والترميز على Windows (مقاس) + ADR 0003

**يعتمد على:** V01 · **بالتوازي مع:** V03 · **يحتاج:** جهاز Windows حقيقي

### النطاق
مقارنة مقاسة بين ثلاثة بدائل (§6 من البرومبت):
1. C++/WinRT sidecar: WGC + libwebrtc + Media Foundation.
2. Rust native: WGC/DXGI + encoder + WebRTC SDK ناضج.
3. LiveKit-compatible native publisher في عملية منفصلة.

### القبول — لا يُختار بديل بلا رقم مقابل كل بند
1. الالتقاط من interactive session مستقر ≥ 30 دقيقة بلا تسريب.
2. multi-monitor كـtracks مستقلة (لا bitmap عملاق).
3. hardware H.264 مع software fallback مضبوط ومقاس.
4. عدد نسخ الإطار بين GPU وCPU موثَّق.
5. reconnect / ICE restart / suspend-resume / lock-unlock مختبَرة.
6. CPU < 12% وRAM increment < 250 MB عند 720p15 على جهاز مرجعي.
7. توقيع وتحديث متوافقان مع الـWindows installer الحالي.
8. **ADR 0003** يسجّل الاختيار والأرقام — قبل أي كود إنتاج في V05.

---

## V05 — شريحة WebRTC live رأسية (read-only) ⏳ منفَّذ جزئيًا (2026-09-01)

> **المنفَّذ:** agent-state callback · `media_tracks` · MediaTransport seam ·
> LivePlayer (`MediaStream` → `<video>`) · SyntheticTransport كبديل للوكيل ·
> dev harness. التسليم: `docs/tickets/146-live-player-and-synthetic-publisher.md`
> **الباقي (يحتاج وكيلًا أو SFU):** تنفيذ MediaProvider حقيقي · Windows publisher ·
> كل الـSLOs · feature flag rollout.

**يعتمد على:** V03 + V04

### النطاق
- تنفيذ `MediaProvider` فوق LiveKit Cloud.
- Windows publisher حقيقي ينشر screen track.
- React subscriber: `<video autoplay playsInline muted>` مربوط بـ`MediaStream`.
- state machine كاملة (§7): `IDLE → REQUESTED → AUTHORIZING → WAITING_FOR_AGENT
  → NEGOTIATING → LIVE → RECONNECTING → ENDING → ENDED` + الأخطاء النهائية.
- feature flag `MEDIA_LIVE_ENABLED` على مجموعة أجهزة اختبار حقيقية.

### القبول
1. **صفر بايت وسائط عبر الـGo API** — مُثبت بقياس، لا بادّعاء.
2. `<video>` يستقبل `MediaStream` — لا `<img>` ولا canvas في مسار العرض.
3. Time to first live frame p95 < 3s على Windows حقيقي، **شبكتان مختلفتان**.
4. Glass-to-glass p95 < 700 ms (هدف 500 ms).
5. FPS مستقر 12–15 على البروفايل الافتراضي.
6. Reconnect بعد تغيّر الشبكة < 5s p95.
7. TURN-only network يعمل.
8. عند فشل WebRTC: حالة خطأ مصنَّفة + إعادة محاولة — **لا رجوع إلى الصور**.

### الاختبارات
- Media integration بفيديو **متحرك اصطناعي** (لا صورة ثابتة).
- خسارة 1% / 5% / 10% · latency 50/150/300 ms · bandwidth shaping.
- subscribe/unsubscribe/rejoin/ICE restart.

---

## V06 — واجهة Live Monitor: الحالات وmulti-monitor وgetStats وreconnect

**يعتمد على:** V05

### النطاق
صفحة Live Monitor + Live tab في ملف الموظف: cards للمتصلين · multi-monitor
selector · fit/actual/zoom/fullscreen · quality badge من `getStats()`
(FPS, resolution, bitrate, RTT, packet loss, codec, relay/direct) · حالات صريحة
(connecting/live/reconnecting/offline/policy blocked/capture failed) ·
زر Remote Control حسب RBAC.

### القبول
1. لا spinner بلا timeout — بعده diagnostic code + Retry.
2. كل حالة لها رسالة مختلفة؛ ممنوع «غير متاح» كرسالة عامة.
3. جميع الحالات تعمل بالعربية والإنجليزية، RTL بلا overlap ولا overflow أفقي.
4. quality badge أرقامه من `getStats()` الحقيقي (اختبار صحة).
5. keyboard navigation وaria-labels كاملة.

---

## V07 — التحكم عن بُعد عبر typed DataChannel

**يعتمد على:** V05 (وV06 عمليًا للواجهة)

### النطاق
- بروتوكول §8: `pointer_move`, `pointer_button`, `wheel`, `key_down`, `key_up`,
  `key_text`, `control_ping`, `control_ack`, `control_error` بـ`v`, `seq`,
  `sent_at_ms`, `display_id`, إحداثيات normalized.
- coalescing لحركة الماوس · backpressure · حد أعلى للرسائل · ACK للحساس.
- DPI scaling + multi-monitor + keyboard layout + modifiers.
- emergency stop · session expiry · RBAC `remote_control.start` · مؤشر وإشعار وaudit.
- جدول `remote_control_sessions`.
- **إيقاف** `GET/POST /v1/remote-assist/:id/actions` بعد نجاح الطرح.
- **خارج النطاق:** arbitrary shell · file exfiltration · clipboard transfer.

### القبول
1. Remote input visible echo p95 < 300 ms على Windows حقيقي.
2. لا REST polling للإدخال بعد الطرح (اختبار غياب الطلبات).
3. إحداثيات normalized → display صحيحة عند 100%/125%/150% DPI وشاشتين.
4. emergency stop يوقف خلال < 500 ms.
5. per-session consent قابل للضبط بالسياسة، لا منطق مخفي في الواجهة.
6. سجل تدقيق لكل جلسة تحكم غير قابل للتلاعب.

---

## V08 — Video egress + object storage + metadata

**يعتمد على:** V05 · **يحتاج قرارًا:** [ADR 0004 retention/legal hold] قبل الشحن

### النطاق
- `recording.mode = off | continuous | on_rule` (pre-roll/post-roll للأخير).
- Recorder/Egress → HLS/fMP4 segments 2–6s + manifest واحد لكل asset.
- object key: `tenant/{uuid}/device/{uuid}/date/YYYY-MM-DD/session/{uuid}/…`
- تشفير at rest · bucket خاص · signed URLs قصيرة · CORS محدود.
- جداول `recording_assets` + `recording_gaps` (الأسباب السبعة من §9).
- offline buffer مشفَّر بحصة حجم/مدة + eviction + resumable upload + sha256 +
  idempotency key؛ الحذف المحلي **بعد** تأكيد الخادم والتحقق من الobject.
- webhooks موقّعة وidempotent مع replay window.

### القبول
1. `mode=off` → **صفر objects وصفر playback** (اختبار صريح).
2. `mode=continuous` → manifest قابل للتشغيل وsegments متصلة.
3. seek عبر gaps وعبر بدايات segments يعمل.
4. **صفر thumbnails وصفر `.jpg/.jpeg/.png/.webp`** تحت media prefixes (حارس CI).
5. تسجيل محذوف/منتهٍ لا يصدر playback URL.
6. الفجوات مسجَّلة بسببها ومدتها — **ممنوع تمديد آخر frame**.

---

## V09 — Session Player + Video Moments + timeline موحّد

**يعتمد على:** V08

### النطاق
- **Session Player:** `<video>` + HLS/fMP4 موقّع · play/pause/speed/seek/volume/
  fullscreen · timeline موحّد (app, window title, domain, active/idle, input
  volume, calls/messages, alerts, gaps) · الضغط على حدث يعمل seek.
- **Video Moments:** `GET /v1/employees/:id/video-moments?date=&interval_minutes=`
  يعيد **metadata فقط** (§13). timeslots 10 دقائق افتراضيًا من بداية الجدول لنهايته.
  كل tile = `<video muted playsInline>` متوقف عند `preview_at`.
  enum الحالات الثلاث عشرة صريح؛ لكل حالة رسالة مختلفة.
  activity % من 5-minute buckets بمتوسط مرجَّح، thresholds قابلة للضبط
  (افتراضي 0–20 أحمر / 21–69 أصفر / 70–100 أخضر)، و`No data` رمادي **وليس 0%**.

### القبول
1. **ممنوع `<img>` أو image URL في Session Player أو Video Moments** (حارس CI).
2. اختيار `preview_at` **deterministic** — لا يتغيّر مع refresh.
3. أول viewport usable < 2s p95 بعد وصول الـmetadata.
4. ≤ 2–4 decodes متزامنة؛ إلغاء عند خروج tile من viewport؛ تحرير buffers عند unmount.
5. لا prefetch لليوم كله — viewport + صف overscan فقط.
6. الضغط يفتح Player عند نفس الـtimestamp عبر `recording_id + preview_at`.
7. RTL يعكس التخطيط دون عكس التسلسل الزمني.
8. عند غياب التسجيل: سبب صريح (recording off / outside schedule / offline / blackout).

---

## V10 — سياسة الفيديو في Monitoring Profiles

**يعتمد على:** V08 (+V09 للعرض)

### النطاق
قسم **Video & Live**: live enabled · recording mode · schedule + IANA timezone ·
resolution · max FPS · max bitrate · multi-monitor policy · record locked session ·
privacy blackout apps/domains · retention days · offline duration/size ·
remote control enabled + policy + indicator.
ترتيب الحسم: `employee override > device > employee > department > business default`.
`policy_snapshot` يُحفظ مع كل media session.

> **ملاحظة V01:** خطأ الـtimezone الموصوف في البرومبت **مُصلَح بالفعل** (IANA سليم
> من الواجهة إلى الوكيل). هذه الشريحة تضيف قسم الفيديو + snapshot + اختبار انحدار،
> لا إصلاحًا.

### القبول
1. تغيير البروفايل يغيّر سلوك الالتقاط خلال ≤ دورة سياسة واحدة، مُثبت على جهاز حقيقي.
2. جدول ينتهي أثناء جلسة → التسجيل يتوقف وتُسجَّل gap بسبب `outside_schedule`.
3. blackout يُطبَّق **قبل encode** قدر الإمكان.
4. `policy_snapshot` يعيد إنتاج القرار التاريخي بدقة.

---

## V11 — الاحتفاظ والتدقيق والرصد وتصليب الأمن

**يعتمد على:** V07 + V10

### النطاق
- retention job: يحذف objects ثم metadata، idempotent وقابل للرصد.
- audit لكل مشاهدة/تحكم/حذف/export؛ exports بصلاحية وanti-forgery وexpiry.
- metrics §17 كاملة + correlation IDs بلا token أو PII.
- مراجعة أمنية: tenant isolation في كل query/token/object key.

### القبول
1. تشغيل retention مرتين لا يحذف مرتين ولا يترك يتيمًا (اختبار idempotency).
2. كل مسار في §15 له اختبار سلبي (منع) وإيجابي (سماح).
3. صفر credentials/signed URLs/SDP في الـlogs.
4. `media_recording_gap_seconds{reason}` يطابق `recording_gaps` فعليًا.

---

## V12 — حذف legacy (destructive)

**يعتمد على:** V11 · **⛔ لا يبدأ قبل جرد V02 + قرار صريح من مالك البيانات**

### النطاق
حذف: `internal/live` (hub + command bus) · `handlers/live_view.go` ·
مسارات `/frame` و`/frames/stream` · `handlers/screenshot.go` ·
`ScreenshotGallery.tsx` · `PlaybackPanel.tsx` · عدّاد `statScreenshots` ·
`sync_screenshot` من الوكيل · سُلَّم WebP إن لم يبقَ له سياق ·
`remote_assist_frames` (متابعة ADR 0001) · مفاتيح i18n · الاختبارات المرتبطة.
الصور التاريخية والجداول تُعالَج بهجرة موثَّقة **وفق القرار المكتوب فقط**.

### القبول
1. قرار مكتوب وموقَّع بشأن الصور التاريخية **قبل** أي `DROP` أو حذف ملفات.
2. `go build` + `cargo check` + `tsc` + `vite build` خضراء بعد الحذف.
3. حارس CI يفشل على أي عودة لمسار صور.
4. الوثائق وi18n والinstallers محدَّثة.

---

## V13 — Windows installer/update + مصفوفة الأجهزة الحقيقية

**يعتمد على:** V12 · **يحتاج:** أجهزة حقيقية

Windows 10 و11 · Intel/AMD/NVIDIA · DPI 100/125/150% · single + multi-monitor ·
lock/unlock · sleep/wake · RDP · display hot-plug · agent restart/update ·
network switch · offline buffer ممتلئ · standard user + company-managed install.

**القبول:** installer موثَّق بالإصدار والchecksum ومختبَر على clean VM.
**ممنوع** ادّعاء نجاح Windows من تجميع macOS.

---

## V14 — اختبار staging تحت الحمل + runbook الإنتاج

**يعتمد على:** V13

اختبار حمل وشبكة على staging · runbook تشغيل · دليل troubleshooting · خطة rollback.

**القبول:** كل بنود §21 (Definition of Done) الأربعة عشر مستوفاة ومُثبتة بأرقام،
وCI أخضر، وصحة media provider/TURN/recording مثبتة.

---

## تنسيق التسليم الإلزامي لكل شريحة

```text
Outcome
Changed files
API/schema changes
Tests executed + exact results
Windows evidence
Performance numbers
Security/privacy checks
Known limitations
Next slice
```

ممنوع نِسَب إنجاز تقديرية بلا قائمة acceptance. ممنوع demo data لإخفاء غياب backend.
ممنوع الرفع إلى `main` أو النشر للإنتاج بلا طلب صريح.
