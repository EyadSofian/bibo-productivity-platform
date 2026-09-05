# البرومبت التنفيذي الرئيسي: إعادة هيكلة Engosoft Workforce إلى Live Video وSession Recording

> **حالة الوثيقة:** مواصفة تنفيذ ملزمة، وليست وصفًا تسويقيًا.
>
> **الأولوية:** عند التعارض، تتقدم هذه الوثيقة على أي جزء قديم في المشروع يعتمد على
> screenshots أو JPEG/WebP frames أو SSE/REST frame polling لبناء الـLive View أو الـPlayback.
>
> **النطاق الأساسي:** Windows Agent + Go Backend + React Web Admin + بنية النشر والتخزين.

---

## البرومبت الجاهز للنسخ

أنت Principal Software Architect وStaff Engineer مسؤول عن إعادة هيكلة مشروع
`bibo-emplooyee-tracking` إلى منصة Engosoft Workforce Monitoring احترافية، مستوحاة وظيفيًا
من طريقة تنظيم Teramind، ولكن بهوية Engosoft وبكود وتصميم أصليين بالكامل.

اعمل داخل المستودع الحالي ولا تبدأ مشروعًا جديدًا ولا تهدم الوظائف الصحيحة بلا داعٍ. اقرأ الكود
الحالي والاختبارات والـmigrations والوثائق قبل التعديل. نفّذ العمل على Vertical Slices قابلة للتشغيل،
ولا تعتبر أي UI أو API مكتملًا إذا كان Mock أو Demo أو غير موصول فعليًا بالـWindows Agent.

### 1. الحقيقة الحالية التي يجب ألا تخفيها

التنفيذ الحالي للعرض الحي ليس فيديو. هو يلتقط صورة منفصلة كل نحو ثانية، يضغطها JPEG/WebP،
يرفعها إلى الـGo backend، ثم يرسلها إلى واجهة الإدارة عبر SSE لتُعرض داخل عنصر `<img>`.
الصور الحية عابرة في الذاكرة وليست محفوظة في Postgres، لكن التجربة تظل سلسلة screenshots
متقطعة وثقيلة وليست live video حقيقيًا.

كما يوجد مسار آخر مستقل للـscheduled screenshots يقوم بحفظ الصور محليًا ورفعها وتخزين
metadata ومساراتها، وتوجد واجهات Screenshot Gallery وPlayback مبني على هذه الصور. هذا المسار
لا يحقق المطلوب الجديد ويجب إيقافه ثم إزالته تدريجيًا.

لا تلمّع هذا الوضع ولا تغيّر اسمه إلى Video. أصلح البنية نفسها.

### 2. القرار المنتجـي غير القابل للتفاوض

طبّق نموذج **Video First / No Still Screenshots**:

1. **Live View:** بث شاشة حي حقيقي عبر WebRTC، داخل عنصر HTML `<video>`، بلا حفظ للوسائط.
2. **Session Recording:** تسجيل فيديو مستمر أو مشروط، محفوظ كملفات/segments فيديو، وليس صورًا.
3. **No Still Images:** ممنوع إنشاء أو رفع أو تخزين أو عرض screenshots ثابتة لأغراض المراقبة.
4. **No Fake Video:** ممنوع تحويل سلسلة JPEG/PNG/WebP إلى `<video>` وتسميتها بثًا.
5. **No Media Through API:** الـGo API لا ينقل bytes الفيديو ولا يعمل media relay.
6. **No Screenshot Fallback:** إذا فشل WebRTC اعرض حالة خطأ واضحة ومحاولات reconnect؛ لا تعد
   سرًا إلى JPEG polling.
7. **No Stored Thumbnails:** لا تولّد أو تخزن thumbnails أو preview image files من التسجيلات.
   شاشة Video Moments الموصوفة لاحقًا يمكنها عرض frame يفكّه عنصر `<video>` من تسجيل الفيديو
   داخل ذاكرة المتصفح فقط؛ بلا image endpoint أو رفع أو حفظ أو سجل screenshot مستقل.

تنبيه مفاهيمي: أي video codec يتعامل داخليًا مع frames، لكن الحظر هنا يعني عدم إنشاء image
files أو image HTTP payloads أو image database records، وعدم بناء تجربة العرض من صور منفصلة.

### 3. الفرق الملزم بين Live وRecording

لا تخلط المسارين:

| الوضع | النقل | التخزين | النتيجة |
|---|---|---|---|
| Live Only | WebRTC | لا يوجد | مشاهدة اللحظة الحالية فقط |
| Live + Recording | WebRTC + Egress/Recorder | video segments فقط | مشاهدة حية + Session Player تاريخي |
| Recording Only | Agent/room إلى recorder | video segments فقط | تاريخ فيديو بلا مشاهد حي |
| Recording Off | لا recorder | لا يوجد | لا Playback تاريخي، وهذا متوقع |

إذا قال صاحب المشروع «لا أريد تخزينًا مطلقًا»، عطّل Recording ووضّح داخل المنتج أنه لن يوجد
History أو Playback. الافتراض الافتراضي لهذه المهمة هو: **لا تخزين صور، مع السماح بتخزين فيديو
عند تفعيل Session Recording من Monitoring Profile.**

### 4. الهدف المعماري

ابنِ البنية التالية:

```text
Windows interactive session
  └─ Engosoft Media Agent
       ├─ Windows Graphics Capture / DXGI capture
       ├─ Hardware video encoder when available
       ├─ WebRTC publisher
       ├─ Media policy/redaction gate
       └─ Offline video segment buffer (only when recording policy allows)
                    │
                    │ encrypted WebRTC media
                    ▼
           WebRTC SFU + STUN/TURN
             ├─ Admin viewer subscribes live
             ├─ Typed DataChannel for remote input
             └─ Recorder/Egress subscribes when recording is enabled
                          │
                          │ fMP4/HLS or WebM video segments
                          ▼
                 S3-compatible object storage
                          │
                          ▼
React Admin <video> ── Go API metadata/auth ── Postgres
```

المكونات ومسؤولياتها:

- **Windows Agent:** capture وencode وpublish؛ لا يرسل JPEG screenshots.
- **SFU:** ينقل realtime media؛ لا يمر عبر Railway HTTP service.
- **TURN:** fallback للاتصالات التي تمنع peer-to-peer UDP.
- **Recorder/Egress:** يشترك في video track فقط عندما تسمح السياسة بالتسجيل.
- **Object Storage:** يحفظ video manifests/segments فقط، وليس screenshots.
- **Go Backend:** authentication، authorization، session orchestration، token minting، metadata،
  audit، retention jobs؛ لا يعالج كل frame.
- **Postgres:** metadata والأحداث والفهارس؛ لا video blobs ولا image blobs.
- **React Admin:** `<video>` للـLive وSession Player؛ لا `<img>` لبث الشاشة.

### 5. اختيار Media Stack

استخدم واجهات abstractions تمنع vendor lock-in، مع تنفيذ أول موصى به:

- SFU/Signaling: LiveKit Cloud لأول MVP موثوق، أو LiveKit self-hosted على بنية تدعم UDP فعلًا.
- NAT traversal: STUN + TURN/TLS، مع TURN credentials قصيرة العمر.
- Recording: LiveKit Egress أو recorder مطابق للواجهة، إلى S3-compatible object storage.
- Playback: HLS/fMP4 segmented video عبر signed URLs.
- Metrics: WebRTC `getStats()` + server-side room/egress telemetry.

لا تفترض أن Railway web service الحالي مناسب لحمل realtime media أو TURN. اترك API وPostgres
والـjobs على Railway، وانقل media plane إلى خدمة مخصصة. قبل self-hosting اختبر UDP، المنافذ،
الـpublic IP، autoscaling والـegress bandwidth. لا تنشر SFU داخل نفس عملية Go API.

أنشئ interfaces واضحة:

```go
type MediaProvider interface {
    CreateRoom(ctx context.Context, spec RoomSpec) (Room, error)
    MintPublisherToken(ctx context.Context, req PublisherTokenRequest) (Token, error)
    MintSubscriberToken(ctx context.Context, req SubscriberTokenRequest) (Token, error)
    StartRecording(ctx context.Context, req RecordingRequest) (RecordingJob, error)
    StopRecording(ctx context.Context, recordingID string) error
    EndRoom(ctx context.Context, roomID string) error
}

type RecordingStore interface {
    SignManifest(ctx context.Context, assetID string, ttl time.Duration) (SignedPlayback, error)
    DeleteAsset(ctx context.Context, assetID string) error
    VerifyAsset(ctx context.Context, assetID string) (AssetVerification, error)
}
```

لا تربط الـhandlers مباشرة بـLiveKit SDK أو S3 SDK.

### 6. Windows capture وencoding

نفّذ technical spike قصيرًا ومقاسًا قبل اختيار الربط النهائي، ثم سجل القرار في ADR. قارن:

1. C++/WinRT sidecar: Windows Graphics Capture + libwebrtc + Media Foundation.
2. Rust native pipeline: WGC/DXGI + encoder + WebRTC SDK مثبت النضج.
3. حل وسيط يستخدم LiveKit-compatible native publisher من process منفصل.

معايير الاختيار ليست سهولة كتابة demo؛ بل:

- القدرة على capture من interactive Windows session باستقرار.
- دعم multi-monitor.
- hardware H.264 أو codec مناسب مع software fallback مضبوط.
- عدم نسخ الـframe مرات كثيرة بين GPU وCPU.
- reconnect، ICE restart، suspend/resume، lock/unlock.
- إمكانية التوقيع والتحديث مع الـWindows installer الحالي.
- CPU/RAM/GPU المقاسة على أجهزة حقيقية.

المواصفات الافتراضية:

- 1280×720 عند 15 FPS كبداية.
- Adaptive: من 5 إلى 24 FPS حسب الشبكة والنشاط والسياسة.
- Bitrate ابتدائي 1.2 Mbps، قابل للتكيف تقريبًا بين 400 Kbps و3 Mbps.
- Keyframe كل 2–4 ثوانٍ أو عند join/reconnect.
- Cursor مرئي افتراضيًا.
- التقاط monitor واحد أو عدة monitors كـtracks مستقلة، لا giant bitmap.
- لا تسجيل عند lock/off-hours/private blackout إلا إذا نصت السياسة صراحة.
- لا capture قبل اكتمال enrollment وتطبيق monitoring profile صالح.

لا تجعل Tauri WebView مسؤولًا عن capture. افصل media runtime عن UI runtime حتى يظل البث قائمًا
عند إغلاق نافذة التطبيق أو تحديثها، مع Windows service supervisor وper-user interactive helper
إذا احتاجت صلاحيات Windows ذلك.

### 7. دورة حياة Live Session

نفّذ state machine صريحة:

```text
IDLE
  -> REQUESTED
  -> AUTHORIZING
  -> WAITING_FOR_AGENT
  -> NEGOTIATING
  -> LIVE
  -> RECONNECTING
  -> LIVE
  -> ENDING
  -> ENDED

Terminal failures:
  DENIED_BY_POLICY | AGENT_OFFLINE | TOKEN_EXPIRED | ICE_FAILED |
  CAPTURE_FAILED | ENCODER_FAILED | ROOM_FAILED | TIMEOUT
```

قواعد الجلسة:

- أنشئ room باسم opaque UUID؛ لا تضع email أو employee name في الاسم.
- publisher token يسمح لجهاز واحد بنشر screen tracks فقط.
- viewer token يسمح بالاشتراك فقط، ولجلسة/tenant محددين.
- token TTL قصير ويجدد من backend بعد إعادة التحقق من الصلاحيات.
- نهاية آخر viewer توقف live-only capture بعد grace period قصير.
- إذا كان recording policy فعالًا يستمر التسجيل حتى نهاية schedule/session لا حتى خروج viewer.
- heartbeat منفصل للmetadata وليس لنقل media.
- كل start/join/leave/reconnect/end يسجل Audit Event.
- امنع concurrent sessions المتعارضة لنفس الجهاز بسياسة واضحة.

### 8. Remote Control الحقيقي

لا ترسل mouse/keyboard actions عبر REST polling. استخدم WebRTC DataChannel موثق الأنواع، أو
data transport مكافئ منخفض التأخير داخل نفس media session.

Schema مبدئي:

```json
{
  "v": 1,
  "session_id": "uuid",
  "seq": 9821,
  "sent_at_ms": 1788192000000,
  "type": "pointer_move",
  "display_id": "display-1",
  "payload": { "x_norm": 0.421, "y_norm": 0.733 }
}
```

الأنواع المسموحة في MVP:

- `pointer_move`
- `pointer_button`
- `wheel`
- `key_down`
- `key_up`
- `key_text` للنص المرسل عمدًا أثناء جلسة التحكم، وليس keylogging عام
- `control_ping`
- `control_ack`
- `control_error`

المتطلبات:

- sequence numbers وACKs للأحداث الحساسة.
- coalescing لحركة الماوس بدل إرسال backlog.
- backpressure وحد أعلى للرسائل.
- تحويل الإحداثيات normalized إلى display coordinates على الجهاز.
- تعامل صحيح مع DPI scaling وmulti-monitor وkeyboard layout وmodifier keys.
- emergency stop واضح، session expiry، وRBAC منفصل `remote_control.start`.
- تطبيق سياسة المؤسسة المسجلة على الجهاز؛ per-session consent يكون configurable وليس منطقًا
  مخفيًا داخل الواجهة، مع indicator وإشعار وسياسة واضحة وسجل تدقيق غير قابل للتلاعب.
- لا تضف arbitrary shell، file exfiltration أو clipboard transfer ضمن هذه المرحلة.

### 9. Recording Pipeline — فيديو فقط

دعم ثلاثة أوضاع في Monitoring Profile:

```text
recording.mode = off | continuous | on_rule
```

- `off`: لا Egress ولا object storage ولا Playback.
- `continuous`: تسجيل داخل schedule فقط.
- `on_rule`: يبدأ clip بمدة pre-roll/post-roll محددة عندما تطلق rule حدثًا.

المخرجات:

- HLS/fMP4 segments بمدة 2–6 ثوانٍ، أو WebM segmented إذا ثبت أفضل عمليًا.
- manifest واحد لكل recording asset.
- object key غير قابل للتخمين:
  `tenant/{tenant_uuid}/device/{device_uuid}/date/YYYY-MM-DD/session/{session_uuid}/...`
- تشفير at rest، bucket private، signed URLs قصيرة العمر.
- CORS محدود إلى domains لوحة الإدارة.
- لا public bucket.
- لا thumbnails ولا JPEG previews.
- metadata في Postgres فقط؛ bytes في object storage فقط.

تعامل مع gaps كبيانات صريحة:

- offline
- locked
- outside_schedule
- privacy_blackout
- capture_error
- network_unavailable
- recorder_error

لا تمدد آخر frame لتخفي gap. اعرض gap على timeline وسببها ومدتها.

Offline recording:

- خزّن video segments مشفرة محليًا فقط عندما تسمح السياسة.
- ضع quota بالحجم والمدة مع eviction للأقدم.
- ارفع resumable عند عودة الشبكة.
- hash لكل segment وidempotency key لمنع التكرار.
- احذف النسخة المحلية فقط بعد server acknowledgement والتحقق من object.

### 10. نموذج البيانات

أنشئ migrations تدريجية مع tenant isolation وفهارس فعلية:

```text
media_sessions
  id uuid pk
  business_id uuid not null
  employee_id uuid null
  device_id uuid not null
  kind live | recording | remote_control
  state requested | negotiating | live | reconnecting | ended | failed
  provider text
  provider_room_id text encrypted/opaque
  policy_snapshot jsonb
  started_at timestamptz
  ended_at timestamptz null
  failure_code text null
  created_by uuid null

media_tracks
  id uuid pk
  business_id uuid not null
  media_session_id uuid not null
  source screen | screen_2 | audio
  codec text
  width int null
  height int null
  nominal_fps numeric null
  started_at timestamptz
  ended_at timestamptz null

recording_assets
  id uuid pk
  business_id uuid not null
  media_session_id uuid not null
  status pending | recording | processing | ready | failed | deleted
  format hls | fmp4 | webm
  storage_provider text
  manifest_key text
  duration_ms bigint
  byte_size bigint
  sha256 text null
  started_at timestamptz
  ended_at timestamptz null
  retention_until timestamptz null

recording_gaps
  id uuid pk
  business_id uuid not null
  recording_asset_id uuid not null
  reason text not null
  started_at timestamptz
  ended_at timestamptz

viewer_sessions
  id uuid pk
  business_id uuid not null
  media_session_id uuid not null
  viewer_user_id uuid not null
  joined_at timestamptz
  left_at timestamptz null
  end_reason text null

remote_control_sessions
  id uuid pk
  business_id uuid not null
  media_session_id uuid not null
  controller_user_id uuid not null
  policy_mode text not null
  started_at timestamptz
  ended_at timestamptz null
  end_reason text null

media_audit_events
  id bigserial pk
  business_id uuid not null
  media_session_id uuid null
  actor_type user | agent | system
  actor_id text
  action text
  outcome text
  metadata jsonb
  occurred_at timestamptz
```

لا تنشئ `frames` أو `screenshots_v2` أو `thumbnails` أو `image_blobs` كبديل بالاسم.

الفهارس الإلزامية:

- `(business_id, device_id, started_at desc)` على sessions.
- `(business_id, employee_id, started_at desc)` على sessions.
- `(business_id, status, retention_until)` على recording assets.
- `(business_id, media_session_id, occurred_at)` على audit events.
- partial index للتسجيلات الجاهزة وغير المحذوفة.

### 11. API Contracts

استخدم REST للـcontrol plane فقط:

```text
POST   /v1/devices/{deviceId}/media/live
GET    /v1/media/sessions/{sessionId}
POST   /v1/media/sessions/{sessionId}/viewer-token
POST   /v1/media/sessions/{sessionId}/publisher-token       # agent auth only
POST   /v1/media/sessions/{sessionId}/stop

POST   /v1/media/sessions/{sessionId}/remote-control
POST   /v1/media/control/{controlSessionId}/stop

GET    /v1/employees/{employeeId}/recordings
GET    /v1/employees/{employeeId}/video-moments?date=YYYY-MM-DD&interval_minutes=10
GET    /v1/recordings/{recordingId}
POST   /v1/recordings/{recordingId}/playback-token
DELETE /v1/recordings/{recordingId}                         # permission + audit

POST   /v1/agent/media/sessions/{sessionId}/state
POST   /v1/media/provider/webhook                           # signature required
```

كل response خطأ يستخدم machine-readable code:

```json
{
  "error": {
    "code": "MEDIA_AGENT_OFFLINE",
    "message": "The device is offline.",
    "request_id": "...",
    "retryable": true
  }
}
```

لا توجد endpoints من نوع:

```text
POST /frame
GET  /frames/stream
POST /live-view/jpeg
GET  /screenshots/{id}  # بعد اكتمال migration وإغلاق legacy
```

Webhooks يجب أن تكون signed وidempotent وتتحقق من replay window.

### 12. Monitoring Profiles

أعد تصميم profile ليكون policy engine واضحًا، مع assignment إلى employee/device/department.

قسم Video & Live يحتوي:

- Live viewing enabled.
- Session recording: off / continuous / on rule.
- Recording schedule + timezone IANA محفوظة canonical مثل `Africa/Cairo`.
- Resolution: 720p / 1080p / adaptive.
- Max FPS: 5 / 10 / 15 / 24.
- Max bitrate.
- Multi-monitor policy.
- Record locked session.
- Privacy blackout apps/domains.
- Retention days.
- Offline recording duration/size.
- Remote control enabled.
- Remote-control policy and indicator/message.

حل خطأ timezone الحالي من المصدر: لا تستخدم label مترجمًا ولا UTC offset كـtimezone. الواجهة ترسل
IANA identifier، والbackend يتحقق عبر timezone database ويعيد validation error عند الخطأ.

استخدم profile resolution ثابتة وموثقة:

```text
employee custom override
  > device assignment
  > employee assignment
  > department assignment
  > business default profile
```

احفظ `policy_snapshot` مع كل media session حتى يظل واضحًا أي policy كانت مطبقة تاريخيًا.

### 13. إعادة هيكلة لوحة الإدارة

نظّم المنتج بهوية Engosoft، لا تقلّد واجهة Teramind حرفيًا. الـinformation architecture:

```text
Overview
Employees
  └─ Employee Profile
       ├─ Summary
       ├─ Live
       ├─ Video Moments
       ├─ Session Player
       ├─ Applications & Websites
       ├─ Activity & Input Volume
       ├─ Communications Metadata
       ├─ Alerts & Rules
       └─ Audit
Devices
Live Monitor
Video Moments
Session Recordings
Activity
Applications & Websites
Rules & Alerts
Monitoring Profiles
Reports
Settings
Audit Log
```

#### Live Monitor

ابنِ تجربة video player حقيقية:

- `<video autoplay playsInline muted>` مربوط بـ`MediaStream`.
- لا `<img src=blob:...>`، لا canvas loop لعرض البث.
- cards للموظفين المتصلين تعرض الحالة والتطبيق/الموقع الحالي ومدة النشاط.
- فتح الموظف ينقل إلى single-device live view.
- multi-monitor selector.
- fit / actual size / zoom / fullscreen.
- quality badge يعرض: FPS، resolution، bitrate، RTT، packet loss، codec، relay/direct.
- حالة واضحة: connecting / live / reconnecting / offline / policy blocked / capture failed.
- زر Start/Stop Remote Control حسب RBAC والسياسة.
- لا spinner بلا timeout؛ بعد timeout اعرض diagnostic code وRetry.

#### Session Player

- استخدم `<video>` مع HLS/fMP4 source signed.
- play/pause، speed، seek، volume عند السماح بالصوت، fullscreen.
- timeline موحد مع application، window title، domain/URL policy-safe، active/idle، input volume،
  calls/messages events، alerts وrecording gaps.
- الضغط على event يعمل seek للفيديو إلى نفس timestamp.
- لا screenshot filmstrip ولا image gallery.
- لا تفترض أن وجود keyboard count يثبت معنى العمل؛ اعرض evidence streams منفصلة.
- عند عدم وجود تسجيل اعرض سببًا صريحًا: recording off، outside schedule، offline، privacy blackout.

#### Video Moments — بديل Snapshots المبني على الفيديو

أضف شاشة تؤدي وظيفة Teramind Snapshots في استعراض اليوم بسرعة، لكن لا تعيد مسار التقاط أو
تخزين screenshots. هذه الشاشة هي **فهرس زمني بصري لتسجيلات الفيديو الموجودة أصلًا** وليست
مصدر monitoring جديدًا.

وظيفتها:

- تقسيم يوم الموظف أو الجهاز إلى timeslots ثابتة، الافتراضي 10 دقائق.
- إظهار لحظة مرئية ممثلة لكل timeslot من تسجيل الفيديو الفعلي.
- إظهار المهمة، نسبة النشاط، التطبيق/الدومين والحالة في نفس الفترة.
- تمكين المدير من مسح يوم كامل بصريًا دون مشاهدة ساعات الفيديو بالتسلسل.
- الضغط على أي moment يفتح Session Player عند timestamp نفسه بدقة.
- إظهار الفترات المفقودة وأسبابها بدل إخفائها أو تكرار آخر frame.

لا تسم هذه البيانات في الـbackend `screenshots`. استخدم `video moments` أو `recording moments`.
يمكن أن يظهر اسم عربي مثل **لحظات الفيديو** أو **المراجعة البصرية**، مع subtitle يوضح أنها نقاط
انتقال إلى تسجيل الفيديو وليست صورًا مستقلة.

##### عناصر الشاشة

- Date picker يعتمد timezone الموظف.
- Employee selector أو Device selector؛ اختيار device يعرض مستخدميه عند الحاجة.
- Density selector: 3 / 4 / 6 / 8 moments per row، مع responsive auto mode.
- Filters: task، department، app/domain، activity band، availability، alerts only، display.
- Grid افتراضي 10-minute slots من بداية schedule إلى نهايته، لا 24 ساعة فارغة بلا داعٍ.
- كل tile يعرض:
  - وقت بداية الفترة.
  - preview مرئي من recording segment.
  - task name أو `No task`.
  - activity percentage مع label نصي Low/Medium/High.
  - app/domain الأساسي اختياريًا.
  - أيقونات alert/restricted/offline/gap عند وجودها.
  - زر Play واضح يفتح Session Player عند `preview_at`.
- Hover/focus actions: Open recording، View details، Add audit note، Restrict access، Delete
  recording range وفق RBAC مع confirmation وaudit.
- Add Manual Time يكون workflow مستقلًا للـtime record؛ لا ينشئ فيديو أو preview مزيفًا.

##### اختيار لحظة الـpreview

- Teramind يعرض slot كل 10 دقائق ويختار frame من التسجيل المتاح في تلك الفترة. في Engosoft،
  اجعل الاختيار deterministic حتى لا تتغير الصورة عند كل refresh.
- اختر timestamp صالحًا داخل أطول recorded span في الـslot، قريبًا من المنتصف، أو طبق خوارزمية
  representative moment موثقة. لا تختَر frame من خارج الفترة.
- إذا كان slot يحتوي alert ذا أولوية عالية، اسمح للمستخدم بتفعيل `Prefer alert moment`، مع badge
  يوضح أن اللحظة المختارة مرتبطة بالتنبيه وليست عينة عادية.
- لا تحسب preview قبل وصول segment وتأكيد جاهزيته.
- خزّن فقط metadata مثل `preview_at` و`recording_id` و`seek_ms` إذا احتجت caching؛ لا تخزن
  decoded frame أو image bytes.

##### العرض بلا صور مخزنة

- كل tile يستخدم عنصر `<video muted playsInline>` متوقفًا عند `preview_at` من manifest/segment
  موقع قصير العمر، أو decoder داخل المتصفح يعرض اللحظة في الذاكرة فقط.
- ممنوع `preview_image_url`، `image/jpeg`، `canvas.toDataURL()`، screenshot blob أو object key.
- لا تحمل تسجيل اليوم كله. استخدم virtualized grid وIntersectionObserver وlazy segment fetch.
- ضع حدًا أقصى 2–4 preview decodes متزامنة، وألغ الطلب عند خروج tile من viewport.
- حرر MediaSource/object URLs وbuffers عند unmount.
- يمكن تشغيل hover preview لمدة 2–3 ثوانٍ من الفيديو إذا لم يسبب عبئًا، لكنه يبقى video segment.
- عند E2EE أو عدم امتلاك المفتاح اعرض `Encrypted / No preview` من دون محاولة server thumbnail.

##### Activity percentage والألوان

- النسبة تقيس كثافة input activity في الفترة ولا تعني وحدها الإنتاجية أو جودة العمل.
- احسبها من 5-minute activity buckets ثم اعمل weighted average للتداخل مع 10-minute slot.
- لا تستخدم محتوى المفاتيح؛ استخدم counts/rate/active-idle signals المسموح بها فقط.
- أظهر tooltip يشرح مصدر النسبة والفترة، ولا تستخدم اللون وحده للمعلومة.
- اجعل thresholds قابلة للضبط في Productivity Profile لأن أسطح/إصدارات Teramind تستخدم حدودًا
  مختلفة. default يطابق العينة المطلوبة: Low `0–20` أحمر، Medium `21–69` أصفر/برتقالي،
  High `70–100` أخضر. خزّن threshold version مع التقرير لضمان ثبات العرض التاريخي.
- `No data/offline` رمادي وليس 0%، حتى لا يختلط غياب البيانات مع inactivity حقيقي.

##### حالات الـtimeslot

استخدم enum صريحًا ولا تستنتج الحالة من غياب URL:

```text
available
offline
monitoring_disabled
recording_disabled
outside_schedule
locked_not_recorded
privacy_blackout
restricted
deleted
processing
corrupted
future
manual_time_no_video
```

اعرض رسالة مختلفة لكل حالة. لا تستخدم `No preview available` كرسالة عامة تخفي السبب.

##### API metadata contract

الـendpoint يعيد metadata فقط، وليس image bytes:

```json
{
  "date": "2026-09-01",
  "timezone": "Africa/Cairo",
  "interval_minutes": 10,
  "moments": [
    {
      "slot_start": "2026-09-01T05:20:00+03:00",
      "slot_end": "2026-09-01T05:30:00+03:00",
      "state": "available",
      "recording_id": "uuid",
      "preview_at": "2026-09-01T05:24:18+03:00",
      "seek_ms": 1458000,
      "task": { "id": "uuid", "name": "My task" },
      "activity_percent": 16,
      "activity_band": "low",
      "primary_app": "Google Chrome",
      "domain": "example.com",
      "display_id": "display-1",
      "has_alert": false,
      "can_view": true,
      "can_restrict": false,
      "can_delete": false
    }
  ]
}
```

- لا ترسل signed media URL طويل العمر داخل grid response.
- اجلب playback token scoped عند lazy preview أو reuse token قصيرًا لنفس recording asset.
- اربط click بـ`recording_id + preview_at`، وليس بترتيب tile في الصفحة.
- pagination/windowing يكون بالوقت ويحافظ على slot alignment في timezone الموظف.

##### الأداء والوصول

- أول viewport usable في أقل من ثانيتين p95 بعد وصول metadata على اتصال مكتبي مرجعي.
- لا يزيد decoded video previews المتزامنة عن الحد المضبوط.
- لا prefetch لليوم كله؛ اجلب viewport مع overscan صف واحد فقط.
- keyboard navigation، focus state، aria-label يحتوي الوقت والحالة والمهمة والنشاط.
- RTL يعكس التخطيط البصري دون عكس التسلسل الزمني المنطقي أو timestamps.
- mobile/tablet يستخدم 1–2 columns وdesktop يستخدم density المحددة.
- لا overlap مع topbar/sidebar ولا nested scroll أفقي.

#### Dashboard

استبدل عداد Screenshots بـ:

- Employees online now.
- Employees active now.
- Live streams available.
- Recorded hours today.
- Recording coverage %.
- Devices with media errors.
- Current apps/domains.
- Active alerts.

### 14. URLs والتطبيق الحالي والتايملاين

حافظ على activity telemetry كمسار metadata منفصل عن الفيديو:

- Agent يلتقط foreground app/window title وفق السياسة.
- Browser Extension/API integrations تلتقط full URL المسموح فقط.
- بدون extension اعرض domain/title الذي يمكن إثباته، ولا تخترع full path من window title.
- احسب duration من ordered focus intervals مع heartbeat وgap handling.
- اربط كل event بـdevice/employee/timezone وserver received time.
- اعرض `Currently open` فقط عندما يكون الحدث حديثًا والجهاز online.
- input telemetry في الوضع الآمن يكون counts/rate/active-idle، لا كلمات المرور ولا محتوى حساس.
- calls/messages dashboard يعتمد على integrations أو app/mic/call-state events؛ لا يدّعي أن الضغطات
  وحدها تثبت إجراء مكالمة أو إرسال رسالة.

الفيديو يعطي سياقًا بصريًا، والmetadata يعطي بحثًا وتجميعًا؛ لا تستخدم OCR على screenshots لأن
screenshots غير موجودة. إذا أضيف OCR للفيديو لاحقًا، يكون service مستقلة على sampled decoded
frames في الذاكرة مع سياسة وretention لنتائج النص، وليس image storage مخفيًا.

### 15. الأمان والخصوصية والحوكمة

- RBAC منفصل: `live_view.start`, `live_view.watch`, `recordings.view`, `recordings.delete`,
  `remote_control.start`, `media_settings.manage`, `media_audit.view`.
- tenant isolation في كل query وكل token وكل object key.
- short-lived scoped tokens؛ لا token عام يسمح بكل rooms.
- TLS/WebRTC encryption in transit وobject encryption at rest.
- لا credentials أو signed URLs أو raw SDP في logs.
- audit لكل مشاهدة تسجيل أو بث حي أو تحكم أو حذف أو export.
- visible policy disclosure وdevice enrollment موثق ومؤشر monitoring مناسب لسياسة المؤسسة.
- privacy blackout للتطبيقات والمواقع الحساسة قبل encode قدر الإمكان.
- password fields ومحتوى الأسرار ليسا هدفًا للجمع.
- exports تحتاج permission، audit، expiry، ومياه علامة عند الحاجة.
- retention job يحذف objects ثم metadata بطريقة idempotent قابلة للرصد.

### 16. الأداء والـSLOs

الـMVP لا يمر إذا كان «شغال» فقط. قس على Windows حقيقي:

| المقياس | الهدف |
|---|---|
| Time to first live frame p95 | أقل من 3 ثوانٍ |
| Glass-to-glass latency p95 | أقل من 700ms، والهدف 500ms |
| Remote input visible echo p95 | أقل من 300ms |
| Stable live FPS | 12–15 FPS على profile الافتراضي |
| Reconnect after network change | أقل من 5 ثوانٍ p95 |
| Packet loss tolerated | 5% مع تعافٍ مقبول |
| Agent CPU at 720p15 | أقل من 12% على جهاز مرجعي |
| Agent RAM media increment | أقل من 250MB |
| Backend media bytes | صفر |
| Persisted still images | صفر |

استخدم WebRTC stats لعرض وقياس:

- inbound/outbound FPS
- frames dropped
- bitrate
- jitter
- RTT
- packets lost
- keyframes decoded
- ICE candidate type
- reconnect count

لا تعتمد على إحساس بصري فقط.

### 17. Observability

أضف metrics منظمة بلا بيانات حساسة:

```text
media_session_start_total{outcome}
media_session_active{kind}
media_time_to_first_frame_ms
media_viewer_join_ms
media_reconnect_total{reason}
media_ice_failure_total
media_turn_usage_total
media_recording_job_total{outcome}
media_recording_gap_seconds{reason}
media_recording_bytes_total
media_agent_capture_failure_total{code}
media_agent_encoder_fallback_total
remote_control_rtt_ms
```

أضف correlation IDs بين API session وprovider room وagent logs من دون كشف token أو PII.

### 18. Migration من التنفيذ الحالي

نفّذ migration على مراحل ولا تخلط القديم بالجديد:

#### M0 — Audit وBaseline

- اعثر على كل مسارات screenshot/live frame في desktop/backend/web/tests/docs.
- سجّل routes والجداول والملفات والـfeature flags والـretention الحالي.
- قس latency/CPU/network للوضع الحالي ليكون baseline.
- أضف ADR للقرار Video First.

#### M1 — أوقف الصور الجديدة

- أضف production guard يجعل still screenshot capture disabled افتراضيًا ثم إجباريًا.
- أوقف scheduled screenshot timer والرفع والـretention writes الجديدة.
- لا تحذف البيانات القديمة تلقائيًا؛ اعرض inventory واطلب قرار retention منفصل لأن الحذف destructive.
- أضف metrics/alerts إذا حاول legacy client رفع screenshot.

#### M2 — WebRTC Live read-only

- media provider abstraction.
- room/token APIs.
- Windows publisher.
- React `<video>` subscriber.
- multi-monitor + stats + reconnect.
- feature flag لمجموعة أجهزة اختبار حقيقية.

#### M3 — Remote Control DataChannel

- typed protocol، RBAC، policy، audit، latency tests.
- أوقف REST action polling بعد نجاح rollout.

#### M4 — Video Recording وSession Player

- recorder/egress + object storage.
- manifests/segments + signed playback.
- timeline synchronization + gaps + retention.
- لا thumbnails.

#### M5 — إزالة legacy بالكامل

- احذف SSE live-frame hub و`/frame` و`/frames/stream`.
- احذف live JPEG compression ladder إن لم يعد مستخدمًا في أي سياق مشروع.
- احذف Screenshot Gallery وimage playback وعدادات screenshots.
- احذف sync screenshot upload paths من agent/backend.
- عالج الجداول والملفات القديمة وفق migration موثقة وقرار صاحب البيانات.
- حدث API docs، i18n، tests، installers والوثائق.

لا تجعل rollout fallback يرجع إلى screenshots. عند تعطل الـnew media path استخدم rollback إصدارًا
كاملًا أو اعرض unavailable، لا تشغل legacy capture في الخلفية.

### 19. Feature Flags وConfiguration

استخدم أسماء صريحة:

```text
MEDIA_PROVIDER=livekit
MEDIA_LIVE_ENABLED=true
MEDIA_RECORDING_ENABLED=true
MEDIA_REMOTE_CONTROL_ENABLED=false
MEDIA_DEFAULT_FPS=15
MEDIA_DEFAULT_HEIGHT=720
MEDIA_MAX_BITRATE_KBPS=3000
MEDIA_RECONNECT_GRACE_SECONDS=15
MEDIA_TOKEN_TTL_SECONDS=120
MEDIA_OBJECT_BUCKET=...
MEDIA_OBJECT_REGION=...
MEDIA_OBJECT_ENDPOINT=...
MEDIA_RETENTION_DEFAULT_DAYS=30
LEGACY_STILL_CAPTURE_ENABLED=false
LEGACY_FRAME_STREAM_ENABLED=false
```

في production اجعل legacy flags غير قابلة للتفعيل accidently بعد M5. لا تضع secrets في repo أو
frontend build. وثّق Railway variables وmedia-provider secrets بدون قيم فعلية.

### 20. الاختبارات الإلزامية

#### Unit

- media state machines.
- token scopes وTTL.
- policy resolution/schedules/timezones.
- recording mode decisions.
- normalized-coordinate mapping وDPI.
- gap creation/merging.
- signed URL authorization.
- retention idempotency.

#### Contract/API

- tenant A لا يرى session/recording لـtenant B.
- viewer لا يحصل publisher permission.
- expired token مرفوض.
- agent لا ينشر لجهاز آخر.
- webhook signature/replay/idempotency.
- deleted/expired recording لا يصدر playback URL.

#### Media integration

- synthetic moving video، وليس static test image.
- subscribe/unsubscribe/rejoin/ICE restart.
- TURN-only network.
- 1%, 5%, 10% loss؛ latency 50/150/300ms؛ bandwidth shaping.
- recorder ينتج playable manifest وsegments متصلة.
- seek عبر gaps وبدايات segments.
- no recorder when mode=off.

#### Windows real-device matrix

- Windows 10 وWindows 11.
- Intel/AMD/NVIDIA where available.
- 100%/125%/150% DPI.
- single monitor + multi-monitor.
- lock/unlock، sleep/wake، RDP، display hot-plug.
- agent restart، update، network switch، offline buffer full.
- standard user وcompany-managed install.

#### Frontend

- `<video>` receives MediaStream.
- loading/error/reconnect/offline/policy states.
- keyboard accessibility وRTL/LTR وresponsive layout.
- stats panel correctness.
- timeline seek synchronization.
- Video Moments slot generation، filtering، lazy video preview وclick-to-seek.
- no legacy screenshot gallery/count؛ شاشة Video Moments مسموحة لأنها فهرس للفيديو وليست صورًا.
- لا overlay فوق sidebar/topbar ولا horizontal overflow عند widths الشائعة.

#### No-image guard

اكتب اختبارات وCI checks خاصة بمسارات المراقبة، لا بكل صور الـbranding:

- ممنوع `image/jpeg`, `image/png`, `image/webp` في live/recording APIs.
- ممنوع `/frame`, `/frames/stream`, `/sync/screenshots` بعد M5.
- ممنوع storage object extensions `.jpg`, `.jpeg`, `.png`, `.webp` تحت media prefixes.
- ممنوع استخدام `<img>` داخل LivePlayer أو SessionPlayer.
- ممنوع استخدام `<img>` أو image URL داخل VideoMoments؛ استخدم paused/lazy `<video>` فقط.
- ممنوع جداول/records جديدة من نوع screenshot.
- اسمح فقط بأصول UI الثابتة مثل logo/icons خارج media data plane.

#### Regression and quality gates

- Go: fmt، vet، unit/integration، race where practical.
- Rust: fmt، clippy `-D warnings`، tests، Windows build.
- React: typecheck، lint، unit/component، production build، E2E.
- migrations forward/backward في staging.
- `git diff --check`.
- dependency/security/license scan.
- لا claim نجاح Windows من macOS compilation فقط؛ يلزم artifact مبني واختبار smoke على Windows.

### 21. Definition of Done

لا تقل إن المهمة مكتملة إلا إذا تحقق كله:

1. Live View يعرض `MediaStream` داخل `<video>` بثبات، لا صورًا متتابعة.
2. قياسات p95 تحقق SLO على Windows حقيقي وشبكتين مختلفتين على الأقل.
3. الـGo API لا ينقل bytes للصور أو الفيديو.
4. لا يتم حفظ أي still monitoring image محليًا أو في DB/object storage.
5. recording-off ينتج صفر objects وصفر playback.
6. recording-on ينتج video manifest/segments قابلة للمشاهدة والـseek.
7. Session Player متزامن مع app/URL/activity events ويعرض gaps بصدق.
8. Remote Control يستخدم low-latency typed channel، لا REST polling.
9. كل start/view/control/delete مسجل في audit ومقيد بالـRBAC والtenant.
10. لا legacy screenshot gallery/counter في المنتج الجديد؛ Video Moments يعرض frames مفكوكة
    مؤقتًا من التسجيل داخل `<video>` بلا image storage أو image API.
11. كل UI states تعمل بالعربية والإنجليزية ولا يوجد overlap أو overflow واضح.
12. CI أخضر وRailway/API health أخضر وmedia provider/TURN/recording health مثبت.
13. Windows installer الجديد موثق بالإصدار والـchecksum ومختبر على clean VM.
14. وثيقة تشغيل ودليل troubleshooting وrollback مكتملان.

### 22. طريقة العمل والتقارير

في بداية كل مرحلة:

- اعرض baseline المثبت من الكود.
- اذكر الملفات والـAPIs والجداول التي ستتغير.
- اذكر المخاطر والـrollback.
- لا تغيّر design system خارج نطاق الشاشة إلا بقرار واضح.

في نهاية كل Vertical Slice سلّم:

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

لا تكتب نسب إنجاز تقديرية مثل 90% بلا قائمة acceptance دقيقة. لا تستخدم demo data لإخفاء غياب
backend. لا ترفع إلى `main` ولا تنشر production إلا بطلب صريح، وبعد نجاح gates المناسبة.

### 23. ترتيب التنفيذ الإجباري

نفّذ بالترتيب التالي:

```text
V01  Current media audit + measurements + ADR
V02  Disable all new still screenshot collection
V03  MediaProvider + room/token/security contracts
V04  Windows native capture/encode spike + benchmark
V05  WebRTC live read-only vertical slice
V06  Live UI, states, multi-monitor, getStats, reconnect
V07  Remote control typed DataChannel
V08  Video egress + object storage + metadata
V09  Session Player + Video Moments + unified event timeline + gaps
V10  Monitoring Profiles video policy + timezone fix
V11  Retention/audit/observability/security hardening
V12  Legacy screenshot deletion migration and code removal
V13  Windows installer/update + full real-device matrix
V14  Staging load/network test + production runbook
```

لا تبدأ V12 destructive deletion قبل inventory وقرار صريح عن الصور التاريخية. يمكنك إيقاف الصور
الجديدة من V02 بلا حذف القديم.

### 24. أول مهمة مطلوبة من المنفذ

ابدأ بـV01 فقط، لكن أكملها بالكامل:

1. افحص `apps/desktop/src-tauri/src/sync/live_view.rs` و`remote_assist.rs` و`client.rs`.
2. افحص `apps/backend/internal/live` وhandlers/routes الخاصة بالframes/screenshots.
3. افحص `apps/web-admin/src/pages/EmployeeDetail.tsx` و`api/sse.ts` وLive/Playback/Gallery components.
4. افحص screenshot storage في desktop SQLite وPostgres وfilestore وretention.
5. ارسم current data flow وtarget data flow.
6. قس actual cadence، payload size، latency، CPU/network إن أمكن.
7. أنشئ ADR: `Video-first WebRTC media plane; no still screenshots`.
8. أنشئ backlog V02–V14 مع dependencies وacceptance/tests لكل slice.
9. لا تدّع أن WebRTC بُني في مرحلة audit.
10. سلّم تقريرًا يمنع أي التباس بين «الخطة» و«المنفذ فعليًا».

---

## قرارات مرجعية مثبتة

- تنظيم Teramind يفصل Monitoring Profiles ويتيح إعداد Screen Recording وLive/History وremote
  control وسياسات التسجيل والـblackout والـretention. المرجع الوظيفي:
  [Teramind — Monitoring Profiles](https://knowledge.teramind.co/en/articles/11883526-configurations-monitoring-profiles).
- Teramind يوضح أن continuous recording يتطلب تعطيل خيار record-only-on-rule، وأن إعدادات
  event-only/lock/retention قد تصنع gaps. المرجع:
  [Teramind — Video/screen recordings aren't captured](https://knowledge.teramind.co/en/articles/11904514-video-screen-recordings-aren-t-captured).
- Teramind Snapshots هي شاشة فهرسة سريعة لتسجيلات الشاشة: timeslots كل 10 دقائق، preview مع
  task وactivity percentage، والضغط ينقل إلى Session Player. المرجع:
  [Teramind — Dashboards / Live View / Snapshots](https://knowledge.teramind.co/en/articles/11868894-dashboards).
- Teramind يوضح أن Activity % تُحسب عبر 5-minute chunks وتمثل كثافة نشاط الإدخال، ولا ينبغي
  مساواتها تلقائيًا بالإنتاجية. المرجع:
  [Teramind — Productivity Metrics FAQ](https://knowledge.teramind.co/en/articles/11903996-productivity-metrics-faq-how-is-work-time-idle-time-activity-percentage-productive-time-unproductive-time-total-time-determined).
- التخزين ينبغي أن يكون policy-driven؛ Teramind يوضح أن screen recordings هي أكبر مستهلك
  للتخزين وأن FPS/resolution/schedule/retention تؤثر مباشرة. المرجع:
  [Teramind — Reducing storage requirements](https://knowledge.teramind.co/en/articles/12020489-how-to-delete-data-and-adjust-monitoring-settings-to-reduce-the-storage-requirements).
- LiveKit Egress يدعم MP4 أو HLS segments وتخزينًا S3-compatible، وهو مناسب لمسار recording
  المنفصل عن WebRTC live. المرجع:
  [LiveKit — Egress overview](https://docs.livekit.io/transport/media/ingress-egress/egress/).
- يمكن استخدام participant/track recording لتسجيل screen share track منفردًا بدل compositing
  غير ضروري. المرجع:
  [LiveKit — Participant and TrackComposite egress](https://docs.livekit.io/transport/media/ingress-egress/egress/participant/).

هذه المراجع تحدد السلوك المتوقع ومكونات البنية، ولا تمنح إذنًا لنسخ تصميم أو كود أو علامات
Teramind. التنفيذ والـUI والهوية يجب أن تكون Engosoft أصلية.
