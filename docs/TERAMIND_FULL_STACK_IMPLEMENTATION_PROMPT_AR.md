# البرومبت التنفيذي الشامل — Engosoft Workforce

> هذا الملف هو البرومبت الرئيسي للتنفيذ. يُرسل كاملًا إلى Codex/فريق التطوير، مع تحديد
> المرحلة المطلوبة في خانة `CURRENT_PHASE`. لا تختصره إلى طلب مثل “اعمل نسخة Teramind”،
> لأن كل Phase هنا لها عقود واعتماد واختبارات تمنع بناء واجهة جميلة فوق بيانات غير صحيحة.

---

# بداية البرومبت

## 0. الدور والهدف

أنت Principal Full-Stack Engineer وSecurity/Product Architect مسؤول عن تطوير المستودع
الحالي إلى منصة **Engosoft Workforce** المؤسسية لمراقبة نشاط موظفي الشركة وإدارة الإنتاجية والدعم
عن بعد، مكافئة وظيفيًا للقدرات العامة المدروسة من Teramind، ولكن:

- بكود وهيكل وتصميم وهوية أصلية بالكامل.
- على الـstack الموجود في المشروع، دون إعادة كتابة غير مبررة.
- مع أولوية صحة البيانات والأمان والأداء قبل عدد الصفحات.
- مع دعم Windows أولًا، ثم macOS، ثم Linux وفق capability matrix صريحة.
- دون ادعاء أن feature مدعومة على نظام لا ينفذها Agent فعليًا.

لا تنسخ واجهة Teramind أو نصوصه أو صوره أو علامته أو أي كود خاص به. استخدم تحليل القدرات
الموجود في المستودع كمرجع متطلبات فقط.

### متغيرات المهمة

```text
CURRENT_PHASE = AUTO
TARGET_ENV = local + staging + production
PRIMARY_AGENT_OS = Windows 10/11 x64
SECONDARY_AGENT_OS = macOS
DEPLOYMENT = Railway حاليًا، مع قابلية فصل الخدمات لاحقًا
LANGUAGES_REQUIRED = Arabic RTL + English LTR، والحفاظ على اللغات القائمة
```

عندما تكون `CURRENT_PHASE=AUTO`:

1. اقرأ حالة المشروع والكود والاختبارات.
2. حدد أول Phase غير مكتملة اعتمادًا على الـexit gates، لا على اسم status فقط.
3. نفذ vertical slice واحدة مكتملة منها.
4. لا تقفز إلى Phase لاحقة لتجميل الواجهة إذا كان اعتمادها غير مكتمل.

---

## 1. المستندات الملزمة قبل لمس الكود

اقرأ الملفات التالية كاملة بالترتيب:

1. `docs/TERAMIND_KNOWLEDGE_BASE_AUDIT_AR.md`
2. `docs/FULL_SYSTEM_AUDIT.md`
3. `docs/TERAMIND_PARITY.md`
4. `docs/PRODUCT_ROADMAP.md`
5. `docs/SECURITY_REVIEW.md`
6. `docs/STATUS.md`
7. `docs/TERAMIND_EQUIVALENT_MASTER_PROMPT_AR.md`
8. هذا الملف.

إذا تعارض مستند قديم مع الكود أو اختبار أو قياس أحدث، فالكود والقياس هما الحقيقة، ثم حدّث
المستند القديم. لا تكرر ميزة أو migration موجودة لمجرد أن status لم يُحدّث.

---

## 2. فحص البداية الإلزامي

قبل أي تعديل:

1. شغّل `git status --short` و`git diff --stat` وراجع الملفات المعدلة.
2. اعتبر كل تغيير سابق ملكًا للمستخدم ما لم يثبت العكس.
3. لا تستخدم `git reset --hard` أو `git checkout --` أو حذفًا جماعيًا.
4. اكتشف `AGENTS.md` واقرأ التعليمات المنطبقة.
5. سجل branch وHEAD وإصدارات Go/Rust/Node/pnpm/Postgres.
6. ارسم مسار البيانات الفعلي للميزة المطلوبة من المصدر حتى الشاشة.
7. شغّل baseline tests للمكونات التي ستتأثر وسجل عدد الناجح/الفاشل/المتخطى.
8. افحص migrations والجداول والroutes والـtypes قبل اختراع أسماء جديدة.
9. افحص البيئة وملفات `.env.example` دون طباعة secrets.
10. اكتب خطة تنفيذ من خطوات صغيرة؛ خطوة واحدة فقط `in_progress` في كل وقت.

إذا كانت الشجرة dirty ويمكن العمل دون دهسها، أكمل. إذا كان التعديل المطلوب يصطدم مباشرة
بتغيير غير مفهوم، أوقف هذا الجزء فقط واشرح التعارض بدل محو التغيير.

---

## 3. حدود المنتج والأمان غير القابلة للتغيير

### 3.1 مسموح

- مراقبة أجهزة تملكها أو تديرها المؤسسة وبسياسة معلنة للموظفين.
- تطبيقات ونوافذ وURLs وfocused time وinput volume والحالات الزمنية.
- لقطات/تسجيل شاشة وفق schedule وblackout وretention وصلاحيات.
- دعم عن بعد unattended على جهاز شركة إذا كانت السياسة المعلنة تسمح، مع مؤشر ظاهر دائم.
- سياسات إنتاجية وتنبيهات وتحقيقات وتصدير وأرشفة.
- تشغيل Agent كخدمة Windows وبدء تلقائي وحماية من الإيقاف العرضي بواسطة IT.

### 3.2 ممنوع

- stealth/hidden agent أو إخفاء وجود المراقبة عن الموظف.
- تسجيل النص المكتوب أو keylogging للمحتوى.
- كلمات المرور أو credentials أو secure-field input.
- arbitrary shell/PowerShell/Command Prompt من Dashboard.
- webcam recording.
- remote command نصي غير محدد النوع وغير موقّع.
- تقييم أو عقوبة آلية اعتمادًا على كثرة النقر/الكتابة أو risk score وحده.
- TLS interception عام كحل افتراضي لجلب URLs.
- رفع محتوى clipboard/email/IM/AI prompts افتراضيًا.

### 3.3 يحتاج Go/No-Go مستقلًا

- Audio recording.
- Clipboard payload.
- Email/IM body capture.
- OCR شامل للشاشات.
- Geolocation خارج وقت العمل.
- Network/file kernel drivers.
- USB/Wi-Fi/Bluetooth restrictions.
- Automated block/lock actions.
- Reconstructed accessibility video.

لا تنفذ أي عنصر من هذه القائمة لمجرد وجوده في feature matrix. أنشئ ADR يتضمن use case،
الأساس القانوني، disclosure، retention، supported OS، false positives، owner وموافقة صريحة.

---

## 4. الـStack الحالي والحدود المعمارية

### 4.1 حافظ على الـstack

| الطبقة | التقنية الحالية | التوجيه |
|---|---|---|
| Backend | Go + Gin + pgx | تطوير تدريجي، packages واضحة، لا framework rewrite |
| Database | PostgreSQL | metadata/events/aggregates/audit؛ لا live binary frames |
| Web Admin | React + TypeScript + Vite | الحفاظ على design tokens والـrouting والترجمة |
| Desktop Agent | Tauri + Rust | Windows أولًا، SQLite outbox، collectors منفصلة |
| Browser | Chrome MV3 extension | Chrome/Edge enterprise deployment، durable outbox |
| Hosting | Railway حاليًا | افصل worker/Redis/object storage/media عند الحاجة |
| Tests | Go/Rust/Vitest | زد integration/E2E/perf تدريجيًا |

أي تقنية جديدة كبيرة مثل Redis أو S3 أو coturn أو WebRTC تحتاج ADR قصيرة توضح سببها،
تشغيلها محليًا، متغيرات البيئة، health check، فشلها، تكلفتها وrollback plan.

### 4.2 بنية الهدف

```text
Windows/macOS Agent
├── App/Window Collector
├── Input Counter (counts only)
├── OS State Collector
├── Screen Capture
├── Browser Bridge
├── Policy Resolver + Scheduler
├── Encrypted SQLite Outbox
├── Batch Sync Client
├── Presence/Command WebSocket
└── WebRTC Media + Typed Control DataChannel
                │
                ▼
API Gateway / Auth / Tenant Guard / Rate Limit / Request ID
├── Ingest API → validation → durable events → aggregation
├── Query API → reports/profile/dashboard
├── Presence Gateway → Redis TTL/pub-sub
├── Signaling Gateway → WebRTC session lifecycle
├── Rule Engine → incidents/actions/notifications
├── Background Workers → exports/retention/reclassification
└── Audit Service
                │
       ┌────────┼─────────┐
       ▼        ▼         ▼
   Postgres   Redis   Object Storage
   metadata   live    media/exports
```

### 4.3 قواعد التخزين

- Postgres: identities، profiles، versions، raw metadata events الضرورية، aggregates، audit.
- Object storage: screenshots، recording chunks، evidence، exports، printed copies إن سُمح.
- Redis: presence، viewer count، signaling state، short-lived locks/rate counters.
- Agent SQLite: encrypted capped outbox وpolicy cache وsync cursors.
- لا يُحفظ latest live frame في Postgres؛ لا WAL/TOAST لبيانات ephemeral.
- كل binary object له tenant prefix وcontent hash وsize/MIME وretention class.
- لا signed URL يتجاوز أقصر مدة لازمة، ولا يعمل بعد سحب الصلاحية قدر الإمكان.

---

## 5. مبادئ الكود المشتركة

### 5.1 Backend

- Handler يفك الطلب ويتحقق من auth/shape ثم يستدعي service؛ لا business logic ثقيل داخله.
- Service يطبق القواعد والمعاملات والصلاحيات.
- Store يحتوي SQL tenant-scoped ولا يعيد صفًا من tenant آخر.
- Domain models لا تعتمد على Gin أو pgx.
- كل external error يتحول إلى error code ثابت ورسالة آمنة وrequest ID.
- لا log للtokens أو full URLs الحساسة أو payloads أو screenshots.
- جميع list queries paginated ولها حدود قصوى.
- جميع jobs idempotent وقابلة للاستئناف.
- time في قاعدة البيانات UTC؛ timezone صريحة عند التجميع والعرض.

### 5.2 Frontend

- API types لا تُكرر يدويًا في عدة ملفات؛ استخدم مصدرًا واحدًا أو generated schema تدريجيًا.
- كل request لها loading/empty/error/stale/refetch/abort behavior.
- الفلاتر والتاريخ والموظف والجهاز والتبويب في URL عند جدوى المشاركة/العودة.
- لا تحمل raw events ضخمة إذا كان المطلوب aggregate.
- tables server-paginated وvirtualized عند الحجم الكبير.
- media thumbnails lazy، والكائنات المؤقتة تُلغى عند الاستبدال/unmount.
- لا تضع منطق حساب metrics في React؛ الخادم يعيد أرقامًا وتعريفاتها.
- كل نص في i18n؛ العربية RTL والإنجليزية LTR في نفس PR.
- حافظ على design system الحالي؛ لا تغيّر الألوان والخطوط والتباعد عالميًا بلا طلب.

### 5.3 Agent

- collector لا يرسل مباشرة للشبكة؛ يكتب event/outbox أولًا.
- client UUID ثابت لكل event لضمان idempotency.
- لا block للcollector بسبب network.
- bounded queues وbackpressure وdisk cap وسياسة drop معلنة للبيانات الأقل أهمية فقط.
- policy cache موقعة/متحقق منها ولها version/effective time.
- secure storage للtokens عبر OS APIs، وDPAPI/Keychain حيث يمكن.
- كل permission/capability ترسل إلى health endpoint.
- Agent لا ينفذ command غير typed allowlist.

### 5.4 Extension

- MV3 service worker قد يموت في أي وقت؛ state في `chrome.storage.local` لا الذاكرة وحدها.
- checkpoints دورية وعند switch/update/close/suspend.
- retry exponential bounded مع jitter.
- لا query/fragment افتراضيًا، ولا incognito افتراضيًا.
- loopback/native messaging authenticated وغير مفتوح لأي موقع.
- extension version/last event/queue depth/permission تظهر في device health.

---

## 6. العقود المشتركة

### 6.1 Event Envelope

كل حدث من Agent أو Extension يتبع عقدًا versioned:

```json
{
  "schema_version": 1,
  "event_id": "uuid-v7-or-v4",
  "client_uuid": "stable-idempotency-uuid",
  "tenant_id": "uuid",
  "employee_id": "uuid-or-null",
  "device_id": "uuid",
  "session_id": "uuid",
  "event_type": "app.focus",
  "occurred_at": "2026-08-31T10:00:00.000Z",
  "ended_at": "2026-08-31T10:01:00.000Z",
  "timezone_offset_min": 120,
  "monotonic_seq": 1234,
  "policy_version": "uuid",
  "source": "agent|extension|server",
  "payload": {}
}
```

الخادم يضيف `received_at` و`request_id`. لا يثق في tenant/employee القادم وحده؛ يربطه
بهوية الجهاز/token. يرفض duration سالبة أو مستقبلًا غير معقول ويسجل clock skew.

### 6.2 API Envelope

لـAPI v1 الجديدة:

```json
{
  "data": {},
  "meta": {
    "request_id": "uuid",
    "next_cursor": null,
    "timezone": "Africa/Cairo",
    "generated_at": "RFC3339"
  }
}
```

والخطأ:

```json
{
  "error": {
    "code": "monitoring_profile_invalid_timezone",
    "message": "رسالة آمنة وقابلة للترجمة",
    "field_errors": {"timezone": "invalid"},
    "request_id": "uuid"
  }
}
```

لا تكسر العقود الحالية دفعة واحدة. أضف compatibility adapter أو versioned endpoint، ثم
حدّث العميل والاختبارات، ثم أزل القديم في release موثق.

### 6.3 Pagination/filter/sort

- Cursor pagination للأحداث: `(occurred_at,id)`، لا offset على الجداول الكبيرة.
- `limit` افتراضي 50 وحد أقصى 200 إلا exports.
- sort fields allowlisted.
- filters typed وليست SQL fragments.
- time range له حد افتراضي وحد أقصى أو يتحول إلى async export.
- الرد يعيد timezone والتجميع المستخدمين.

### 6.4 Idempotency

- unique `(tenant_id, source, client_uuid)`.
- batch response يعيد accepted/duplicate/rejected مع سبب لكل index.
- retry لن ينتج صفًا أو incident مكررًا.
- actions وexports وremote sessions تقبل `Idempotency-Key` عند الإنشاء.

---

## 7. الهوية والمستأجر والصلاحيات

### 7.1 الكيانات

```text
Tenant/Business
├── Admin Users
├── Employees
├── Departments
├── Job Roles/Positions
├── Devices
├── Login Sessions
├── Locations
└── Directory Connections
```

Employee ليس Device. Employee قد يستخدم عدة أجهزة، والجهاز قد يحتوي جلسات لعدة موظفين.
كل telemetry تربط `employee_id + device_id + session_id` عندما تتوفر الهوية.

### 7.2 RBAC + Scope

الأدوار baseline:

- Owner.
- Administrator.
- Infrastructure Administrator.
- Operational Administrator.
- Manager.
- Investigator/Auditor.
- Employee self-view.

الصلاحيات الدقيقة:

```text
employees.view
employees.manage
devices.view
devices.manage
activity.view
websites.view
screenshots.view
recordings.play
live_view.start
remote_support.control
remote_support.elevated
incidents.view
incidents.manage
policies.configure
exports.create
audit.view
sensitive_content.view
settings.manage
```

كل grant له scope: tenant أو departments أو employees أو devices. الخادم يطبق الصلاحية
والscope في SQL/service. إخفاء زر في React ليس authorization.

### 7.3 Audit

سجل append-only أو tamper-evident لكل:

- login/logout/failure/MFA/reset.
- إنشاء/تعديل/حذف profile/rule/role/token.
- تغيير monitoring state أو archive/restore/lock.
- مشاهدة screenshot/recording/live session.
- remote action.
- إنشاء/تنزيل export.
- support access.
- retention/delete/legal hold.

الحدث يحمل actor، target، tenant، action، result، reason، IP/device، request ID، timestamp
وbefore/after redacted diff. لا يسجل secret أو media payload.

---

## 8. نموذج الوقت والنشاط

### 8.1 الأبعاد

```text
Wall state: active | idle | locked | sleeping | offline
Focus: app | window | browser tab
Classification: productive | unproductive | unclassified | custom
Schedule: scheduled | unscheduled | holiday
Location: office | remote | unknown
```

### 8.2 القواعد

- لا تستنتج idle/offline من غياب row فقط.
- كل transition يغلق segment السابق ويفتح التالي.
- app/tab focus طبقة فوق wall state ولا تستبدله.
- browser focused active لا يتجاوز browser foreground ولا work time.
- sleep/lock يفوزان على idle.
- disconnect لا يتحول فورًا إلى offline تاريخي قبل grace window محددة.
- multi-device يعرض per-device وdeduplicated employee wall time؛ اشرح طريقة التجميع.
- split عند midnight حسب timezone المختارة مع DST tests.
- historical data قبل cutover تحمل `quality=legacy_estimated` ولا تُعرض كحقيقة دقيقة.

### 8.3 المعادلات

```text
active_time = SUM(wall_state=active)
idle_time = SUM(wall_state=idle)
work_time = active_time + included_idle_time
focused_time(context) = SUM(foreground=context AND wall_state IN active,idle)
productive_time = SUM(classification=productive within work segments)
utilization_pct = work_time / scheduled_time
activity_pct(bucket) = normalized input counts over configured bucket
```

كل metric في API يعيد `value`, `unit`, `definition_version`, `quality`, و`timezone` عند
الحاجة. لا تحسب النسب مرتين في Backend وFrontend.

---

## 9. قاعدة البيانات المستهدفة

لا تنشئ كل الجداول مرة واحدة؛ كل Phase تنشئ ما تحتاجه فقط، لكن حافظ على هذا النموذج:

### 9.1 Identity/organization

- `businesses`
- `users/admin_users`
- `employees`
- `departments`
- `job_roles/positions`
- `employee_assignments`
- `devices`
- `login_sessions`
- `locations`

### 9.2 Policy/configuration

- `monitoring_profiles`
- `monitoring_profile_versions`
- `monitoring_assignments`
- `monitoring_channel_settings`
- `channel_schedules`
- `work_schedules`
- `holidays`
- `productivity_profiles`
- `productivity_profile_versions`
- `productivity_categories`
- `classification_rules`

### 9.3 Telemetry

- `activity_segments`
- `os_state_segments`
- `browser_visits`
- `input_buckets`
- `file_events`
- `print_events`
- `network_events`
- `email_events`
- `camera_usage_events`
- `ai_usage_events`
- `agent_health_samples`

### 9.4 Media/realtime

- `media_objects`
- `screenshots`
- `recording_sessions`
- `recording_chunks`
- `remote_support_sessions`
- `remote_support_actions`
- realtime presence/signaling في Redis.

### 9.5 Rules/investigation

- `shared_lists`
- `shared_list_versions`
- `policies`
- `policy_versions`
- `rules`
- `rule_versions`
- `incidents`
- `incident_evidence`
- `incident_actions`
- `incident_comments`
- `timeline_tags`

### 9.6 Operations

- `audit_events`
- `export_jobs`
- `notification_jobs`
- `retention_policies`
- `retention_jobs`
- `legal_holds`
- `directory_connections`
- `directory_sync_runs`
- `api_tokens`
- `webhook_endpoints`
- `webhook_deliveries`

### 9.7 Aggregates

- `employee_minute_metrics`
- `employee_hour_metrics`
- `employee_day_metrics`
- `app_day_metrics`
- `domain_day_metrics`
- `department_day_metrics`

قواعد DB:

- `business_id/tenant_id` mandatory في الجداول متعددة المستأجرين.
- FK وCHECK وunique idempotency keys.
- indexes تبدأ بـtenant ثم employee/device ثم time.
- partitioning للجداول الزمنية الكبيرة بعد قياس، لا افتراضيًا بلا داعٍ.
- migrations forward-safe؛ لا تحذف column في نفس release الذي يوقف استخدامه.
- store tests تثبت cross-tenant isolation لكل مسار جديد.

---

## 10. خريطة المراحل والاعتماد

```text
P00 Baseline & contracts
 ├─> P01 Security, ingest & audit foundation
 ├─> P02 Time/state/activity engine
 └─> P03 Object storage & media lifecycle

P01 + P02 ─> P04 Organization, employee, device & health
P02 + P04 ─> P05 Monitoring profiles, schedules & policy delivery
P02 + P05 ─> P06 Application/browser URL tracking
P04 + P06 ─> P07 Employee profile & unified timeline
P01 + P03 + P04 ─> P08 WebRTC live view & remote support
P02 + P05 + P06 ─> P09 Productivity, work schedules, tasks & time cards
P07 + P09 ─> P10 Dashboards, reports & exports
P01 + P05 + P06 + P09 ─> P11 Rules, alerts & incidents
P03 + P05 + P11 ─> P12 Advanced monitoring/DLP channels
P01 + P04 + P10 + P11 ─> P13 SSO, directory, API, webhooks & SIEM
P00..P13 ─> P14 Production hardening, release & operations
```

لا يبدأ P07 قبل صحة P02/P06، ولا يبدأ P08 قبل P01/P03، ولا يبدأ P11 قبل versioned
profiles/events. يمكن تنفيذ فرعين مستقلين بالتوازي فقط عندما لا يلمسان نفس العقود.

---

## 11. كتالوج الـAPI النهائي

### 11.1 Auth/account

```text
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
POST   /api/v1/auth/forgot-password
POST   /api/v1/auth/reset-password
POST   /api/v1/auth/mfa/challenge
POST   /api/v1/auth/mfa/verify
GET    /api/v1/me
PATCH  /api/v1/me
```

### 11.2 Organization

```text
GET/POST       /api/v1/businesses
GET/PATCH      /api/v1/businesses/{business_id}
GET/POST       /api/v1/departments
GET/PATCH/DELETE /api/v1/departments/{id}
GET/POST       /api/v1/job-roles
GET/PATCH/DELETE /api/v1/job-roles/{id}
GET/POST       /api/v1/locations
GET/PATCH/DELETE /api/v1/locations/{id}
GET/POST       /api/v1/work-schedules
GET/PATCH/DELETE /api/v1/work-schedules/{id}
```

### 11.3 Employees/devices

```text
GET/POST       /api/v1/employees
GET/PATCH      /api/v1/employees/{id}
POST           /api/v1/employees/import
POST           /api/v1/employees/bulk
POST           /api/v1/employees/{id}/archive
POST           /api/v1/employees/{id}/restore
GET            /api/v1/employees/{id}/overview
GET            /api/v1/employees/{id}/timeline
GET            /api/v1/employees/{id}/applications
GET            /api/v1/employees/{id}/websites
GET            /api/v1/employees/{id}/input
GET            /api/v1/employees/{id}/sessions
GET            /api/v1/employees/{id}/screenshots
GET            /api/v1/employees/{id}/incidents

GET            /api/v1/devices
GET/PATCH      /api/v1/devices/{id}
GET            /api/v1/devices/{id}/health
POST           /api/v1/devices/{id}/monitoring
POST           /api/v1/devices/{id}/archive
POST           /api/v1/devices/{id}/restore
GET            /api/v1/devices/{id}/desired-policy
POST           /api/v1/devices/{id}/update
```

### 11.4 Profiles/productivity

```text
GET/POST       /api/v1/monitoring-profiles
GET/PATCH/DELETE /api/v1/monitoring-profiles/{id}
POST           /api/v1/monitoring-profiles/{id}/clone
GET            /api/v1/monitoring-profiles/{id}/preview
GET            /api/v1/monitoring-profiles/resolved
GET/POST       /api/v1/productivity-profiles
GET/PATCH/DELETE /api/v1/productivity-profiles/{id}
POST           /api/v1/productivity-profiles/{id}/rules
GET/POST       /api/v1/productivity-categories
GET            /api/v1/productivity/unclassified
POST           /api/v1/productivity/classify
POST           /api/v1/productivity/reclassify
```

### 11.5 Policies/incidents

```text
GET/POST       /api/v1/shared-lists
GET/PATCH/DELETE /api/v1/shared-lists/{id}
POST           /api/v1/shared-lists/{id}/import
POST           /api/v1/shared-lists/{id}/test
GET/POST       /api/v1/policies
GET/PATCH/DELETE /api/v1/policies/{id}
GET/POST       /api/v1/rules
GET/PATCH/DELETE /api/v1/rules/{id}
POST           /api/v1/rules/{id}/preview
POST           /api/v1/rules/{id}/replay
GET            /api/v1/incidents
GET/PATCH      /api/v1/incidents/{id}
POST           /api/v1/incidents/{id}/comments
POST           /api/v1/incidents/{id}/resolve
GET            /api/v1/incidents/{id}/evidence
```

### 11.6 Media/live/remote

```text
GET            /api/v1/screenshots/{id}
POST           /api/v1/live/sessions
GET/DELETE     /api/v1/live/sessions/{id}
WS             /api/v1/live/sessions/{id}/signal
POST           /api/v1/remote-support/sessions
GET/DELETE     /api/v1/remote-support/sessions/{id}
WS             /api/v1/remote-support/sessions/{id}/signal
POST           /api/v1/remote-support/sessions/{id}/actions
GET            /api/v1/recordings/{id}
POST           /api/v1/recordings/{id}/export
```

### 11.7 Dashboards/reports/operations

```text
GET/POST       /api/v1/dashboards
GET/PATCH/DELETE /api/v1/dashboards/{id}
POST           /api/v1/dashboards/{id}/clone
POST           /api/v1/dashboards/{id}/widgets
GET            /api/v1/reports/{report_key}
POST           /api/v1/exports
GET            /api/v1/exports/{id}
GET            /api/v1/exports/{id}/download
GET            /api/v1/audit
GET            /api/v1/system/health
GET            /api/v1/system/missing-agents
GET/POST       /api/v1/api-tokens
DELETE         /api/v1/api-tokens/{id}
GET/POST       /api/v1/webhooks
GET/PATCH/DELETE /api/v1/webhooks/{id}
```

### 11.8 Agent ingest/control

```text
POST /api/v1/agent/enroll
POST /api/v1/agent/refresh-token
POST /api/v1/agent/heartbeat
POST /api/v1/agent/sync/events
POST /api/v1/agent/sync/screenshots
POST /api/v1/agent/sync/health
GET  /api/v1/agent/policy
GET  /api/v1/agent/update-manifest
WS   /api/v1/agent/connect
```

Agent routes لها token/device binding وbatch byte/event limits وcompression وrate limits
منفصلة عن Dashboard. لا تستخدم admin JWT داخل Agent.

---

## 12. صفحات الـFrontend النهائية

```text
/admin/login
/admin
/admin/employees
/admin/employees/:id
/admin/devices
/admin/devices/:id
/admin/live
/admin/incidents
/admin/incidents/:id
/admin/dashboards/:id
/admin/reports/:key
/admin/configuration/monitoring-profiles
/admin/configuration/productivity-profiles
/admin/configuration/policies
/admin/configuration/shared-lists
/admin/configuration/access-control
/admin/organization/departments
/admin/organization/job-roles
/admin/organization/schedules
/admin/organization/locations
/admin/system/agents
/admin/system/health
/admin/system/missing-agents
/admin/system/integrations
/admin/system/audit
/admin/settings
```

حافظ على routes الحالية وأضف redirects عند إعادة التنظيم. لا تكسر bookmarked URLs.

### 12.1 App shell

- sidebar قابل للطي ولا يغطي المحتوى.
- top bar: business selector، search، timezone/date، language، theme، notifications، user.
- permission-aware navigation.
- mobile drawer وليس fixed overlay.
- breadcrumb وpage title ثابتان.
- global error boundary وoffline/stale banner.

### 12.2 نظام التصميم

- الهوية الرسمية هي **Engosoft Workforce**. استخدم شعار Engosoft المقدم، ولا تعرض
  `BiBoTracking` أو `BiBo` كاسم منتج للمستخدم؛ تبقى الأسماء التقنية القديمة داخليًا إلى
  أن تمر بخطة migration مستقلة لا تكسر updater أو installer أو device identity.
- مرجع الهوية المؤسسية: <https://engosoft.com/>، مع عدم نسخ تصميم الموقع التعليمي حرفيًا.
- لوحة الألوان: `Engosoft Navy #061B35`، `Engosoft Blue #086BE8`،
  `Engosoft Blue 600 #0056C7`، `Sky #48A5FF`، و`Paper #F3F7FC`.
- اللون الأزرق للهوية والتنقل والإجراءات الأساسية فقط. احتفظ بـmint للحالة النشطة،
  amber للخمول/التحذير، red للخطر، grey لغير المتصل؛ لا تجعل الحالة الزرقاء تعني “نشط”.
- مصدر الحقيقة البصري هو tokens في `apps/web-admin/src/theme/theme.css` ومكوّن
  `apps/web-admin/src/components/EngosoftBrand.tsx`؛ لا تكرر hex داخل الصفحات.
- استخدم أيقونات line موحّدة 20/24px، `stroke-width` بين 1.8 و2، مع labels واضحة؛ لا تستخدم
  emoji أو مكتبات أيقونات مختلطة أو أيقونات بلا `aria-label` عندما يكون النص مخفيًا.
- استخدم tokens الحالية للألوان والمسافات والradius والظلال والخط، ووسّعها دلاليًا بدل
  اختراع نظام ثانٍ داخل الصفحة.
- grid مرن، cards حد أدنى 280px، لا قيم عرض صلبة تسبب overflow.
- logical CSS properties لدعم RTL.
- dialogs لها focus trap وEscape وscroll lock صحيح.
- sticky/fixed elements تحجز مساحة فعلية ولا تتراكب.
- جدول كثيف/عادي، columns hide/reorder مستقبلًا.
- charts لها table/text fallback وألوان يمكن تمييزها.

### 12.3 هيكلة لوحة الإدارة وهوية كل مساحة

```text
Overview          حالة الفريق الآن + KPIs + live desk + roster
People            الموظفون + ملف الموظف + timeline + evidence
Devices           الصحة + الإصدار + الصلاحيات + policy + last heartbeat
Live              مشاهدة الأجهزة المتصلة + جلسات الدعم المصرح بها
Activity          apps + websites + URLs + focused/idle + input counts
Evidence          screenshots + playback + exports + annotations
Rules & Incidents policies + alerts + cases + review workflow
Reports           saved reports + schedules + async export center
Configuration     monitoring/productivity/shared lists/retention
Organization      departments/roles/schedules/locations/access
System            agents/health/missing/integrations/audit
```

- لا تعرض route فارغًا في production. اخفِ الوحدة خلف capability/feature flag حتى يكتمل
  المصدر وAPI والصلاحيات والحالات الست في الواجهة.
- ملف الموظف هو نقطة العمل الأساسية: header مضغوط، presence/current app، KPIs، unified
  timeline، ثم تبويبات Activity/Browser/Input/Screenshots/Playback/Incidents.
- صفحة Live لا تعيد تحميل لوحة الموظف كاملة، وتستخدم transport منفصلًا عن REST reporting.
- كل action حساس يعرض scope والجهاز والمدة والسبب، ويسجل audit event.

---

## 13. خطة التنفيذ التفصيلية

كل Phase أدناه يجب تنفيذها عبر migration/domain/store/service/handler/agent/frontend/tests
بقدر ما ينطبق. لا تعلن اكتمالها قبل تحقق Exit Gate.

### P00 — Baseline، العقود، CI وبيئة التطوير

**الهدف:** جعل الحالة الحالية قابلة للقياس والبناء والتكرار قبل تغيير السلوك.

**الاعتماد:** لا شيء.

**Repository/Docs:**

- وثق خريطة apps والخدمات والمنافذ ومتغيرات البيئة.
- وحّد أو فسّر اختلاف local/staging/prod env examples.
- حدّث architecture diagram من الكود الفعلي.
- سجل current test counts دون تثبيتها إلى الأبد.

**Backend:**

- `/healthz` و`/readyz` منفصلان؛ readiness يفحص DB والخدمات المطلوبة.
- request IDs وstructured logs وpanic recovery.
- graceful shutdown وtimeouts وحدود body.

**Frontend:**

- error boundary وAPI error normalization.
- build info/version في system/about.

**Agent/Extension:**

- version/build/channel في heartbeat.
- commands موحدة للفحص والبناء والاختبار.

**CI:**

- Go fmt/vet/test-race/build.
- Rust fmt/clippy `-D warnings`/test/check.
- pnpm typecheck/test/build.
- extension tests/build.
- migration smoke و`git diff --check`.

**الاختبارات:** fresh clone bootstrap، empty DB migration، upgrade DB migration، health failure.

**Exit Gate:** clone جديد يبني ويختبر ويشغّل stack موثقًا بلا خطوات سرية.

### P01 — أمان المصادقة، المستأجر، الابتلاع والتدقيق

**الهدف:** لا توسع telemetry قبل ضمان أن كل طلب وجهاز وبيان معزول ومحدود.

**الاعتماد:** P00.

**Database:**

- API/agent token metadata وexpiry/revocation.
- audit events schema.
- idempotency constraints لكل ingest stream.

**Backend:**

- trusted proxy allowlist؛ لا ثقة عمياء في X-Forwarded-For.
- rate limits منفصلة login/admin/ingest/media.
- max batch count/bytes/event size وdecompression limit.
- tenant guard مركزي واختبارات store cross-tenant.
- password hashing policy، refresh rotation، logout revocation، MFA hooks.
- audit writer transactional للأفعال الحساسة.

**Frontend:**

- session expiry/refresh behavior بلا loops.
- 401 logout و403 permission state مختلفان.
- access denied page، لا blank screen.

**Agent:**

- enrollment token قصير العمر يتحول إلى device credential.
- credential مرتبط بـdevice ID، rotation/revoke.
- TLS verification لا يمكن تعطيله في production.

**APIs:** auth، agent enroll/refresh، audit query baseline.

**Tests:** spoofed proxy، brute force، oversized batch، zip bomb، revoked token، cross-tenant،
concurrent duplicate batch، audit before/after redaction.

**Exit Gate:** صفر tenant leakage؛ limits فعالة بقياس؛ كل فعل حساس في audit.

### P02 — محرك الوقت والحالات والنشاط الموحد

**الهدف:** إنتاج active/idle/locked/sleeping/offline وapps/windows بلا فجوات أو تضارب.

**الاعتماد:** P00 وP01 ingest safety.

**Database:**

- `os_state_segments`, `activity_segments`, `input_buckets`, `login_sessions`.
- unique client UUIDs وtime indexes.
- quality/source/schema version fields.

**Backend:**

- pure activity normalization package.
- state transition reducer وoverlap resolver وgap classifier.
- timezone/DST/day splitter.
- multi-device raw وdeduplicated views.
- minute/hour/day aggregation jobs.

**Agent:**

- Windows `GetLastInputInfo` + session lock/unlock + sleep/resume + logon/logoff.
- active window/app/pid/title collector.
- keyboard/mouse/click/scroll counts فقط، بلا key values.
- flush segment عند transition/shutdown والسياسة.
- offline outbox/retry/idempotency.

**Frontend:**

- مؤقتًا diagnostic state timeline في device/employee debug view.
- quality/stale badges، لا أرقام نهائية مزيفة.

**APIs:** employee states/activity/session summaries وagent sync events.

**Tests:** transition table، overlap، gap، duplicate، out-of-order، future clock، midnight، DST،
two devices، crash recovery، offline 8h، privacy proof بأن الحروف لا تدخل SQLite/request/log/DB.

**Exit Gate:** `active+idle+locked+sleeping+offline` يغطي النطاق وفق قواعد معلنة ±1%،
وإعادة إرسال batch لا تغير النتيجة.

### P03 — Object Storage والوسائط والاحتفاظ

**الهدف:** إزالة binary churn من Postgres وبناء lifecycle صحيح للصور والتسجيلات.

**الاعتماد:** P00 وP01.

**Infrastructure:** S3-compatible storage محلي/production، bucket policy، lifecycle، CORS محدود.

**Database:** media metadata فقط: key/hash/size/MIME/dimensions/captured_at/retention/status.

**Backend:**

- upload flow server-mediated أو presigned محدود.
- MIME/magic-byte/size validation.
- tenant-scoped download authorization.
- thumbnail job.
- retention/delete/legal hold jobs idempotent.
- orphan reconciliation DB↔storage.

**Agent:**

- adaptive WebP/JPEG/AVIF بعد benchmark.
- local disk cap، retry، checksum، delete after confirmed commit.
- blackout قبل الضغط والرفع، لا في الواجهة فقط.

**Frontend:** lazy thumbnails، full image on demand، abort fetch، revoke object URLs، download audit.

**APIs:** screenshots list/detail/image، media signed access، export job baseline.

**Tests:** unauthorized object، expired URL، wrong MIME، duplicate upload، partial failure، retention،
legal hold، orphan cleanup، storage unavailable، 10k gallery performance.

**Exit Gate:** لا frames/screenshots جديدة في `bytea`؛ حذف retention موثق ويشمل object وmetadata.

### P04 — المؤسسة والموظفون والأجهزة والصحة

**الهدف:** هوية صحيحة لكل موظف وجهاز وجلسة، وإدارة أسطول قابلة للتشخيص.

**الاعتماد:** P01 وP02.

**Database:** departments، job roles، assignments، device capabilities/health، license state، archives.

**Backend:**

- CRUD + import/bulk edit مع validation.
- employee-device-session relationships.
- presence status rules وmissing-agent thresholds.
- device health aggregate: collector permissions، queue age، extension، version، clock skew.
- archive non-destructive وrestore واضح.

**Agent:** heartbeat كل فترة مناسبة مع current app/window/state/version/capabilities/queue/error.

**Frontend:**

- employees roster بفلاتر department/role/status/license.
- devices fleet: OS/version/employee/last seen/monitoring/health/archive.
- device detail health diagnostics وfix guidance.
- Missing Employees/Devices tabs وCSV export لاحقًا.

**APIs:** employees/devices/organization/health/missing agents.

**Tests:** shared computer، employee two devices، user switch، archived device heartbeat، future clock،
missing threshold، bulk operation partial failure، responsive/RTL tables.

**Exit Gate:** يمكن معرفة من يستخدم أي جهاز الآن ولماذا توقف جهاز عن الإبلاغ دون فحص DB.

### P05 — Monitoring Profiles والجداول وتسليم السياسة

**الهدف:** تحديد ماذا ومتى ولمن يجمع Agent، مع versioning وresolution قابل للتفسير.

**الاعتماد:** P02 وP04.

**Database:** profile/version/assignment/channel settings/schedules مع FK ومنع دورات الوراثة.

**Backend:**

- CRUD/clone/archive/preview.
- assignments: company/department/job role/employee/device/directory group لاحقًا.
- resolution priority موثقة، include/exclude وprivacy deny wins.
- IANA timezone وovernight ranges وDST.
- signed/canonical policy document + ETag/version.
- push invalidation عبر agent WebSocket مع polling fallback.

**Agent:**

- encrypted policy cache.
- atomic apply عند effective time.
- collectors start/stop بلا restart إن أمكن.
- لا capture خارج schedule، حتى offline.
- report applied version/error.

**Frontend:**

- list + editor wizard: Basic، Scope، Schedule، Channels، Review.
- resolved profile inspector يبين مصدر كل قيمة.
- channel capability حسب OS/version.
- منع save مع timezone/overlap errors inline.

**APIs:** monitoring profiles CRUD/preview/resolved + agent policy.

**Tests:** inheritance cycle، conflicting scopes، overnight، DST، employee/device override، offline schedule،
stale version، push reconnect، unsupported setting، E2E UI→Agent applied version.

**Exit Gate:** proof test يثبت عدم جمع channel خارج schedule، واللوحة تفسر resolved policy.

### P06 — التطبيقات والمتصفح وURLs والوقت المركّز

**الهدف:** معرفة التطبيق/النافذة/التبويب/URL المركّز ومدة كل منها بدقة.

**الاعتماد:** P02 وP05.

**Database:** browser visits مع browser/domain/url redacted/title/start/end/focus/idle/profile/incognito.

**Backend:**

- ingest validation/upsert.
- reconciliation browser visit ≤ browser foreground.
- domain extraction وpublic suffix handling.
- URL privacy modes: domain-only/origin/path/full؛ query/fragment off افتراضيًا.
- app/domain aggregates وcoverage/quality.

**Extension:**

- Chrome وEdge identity.
- tabs/windows focus listeners.
- checkpoint ≤60s وonActivated/onUpdated/onRemoved/onSuspend.
- durable outbox/retry/cap.
- chrome.idle reconciliation signal.
- authenticated Agent bridge.
- enterprise install documentation/policy templates.

**Agent:** browser bridge يربط session/device/employee والسياسة وحالة idle.

**Frontend:**

- Applications table/chart.
- Websites domains ثم expandable URLs/titles.
- active/idle/focused columns.
- current tab live card.
- extension health/coverage warning.

**APIs:** employee applications/websites، domain/app rollups، current context.

**Tests:** rapid switching، multiple windows، minimize، browser close/crash، service worker eviction،
Agent restart، incognito off، query redaction، YouTube/SPA title updates، offline queue، coverage arithmetic.

**Exit Gate:** focused tab totals reconcile مع browser foreground ±1%، ولا يفقد tab طويل بلا switch.

### P07 — ملف الموظف والـTimeline الموحد

**الهدف:** صفحة واحدة سريعة تجيب: متصل؟ يعمل منذ متى؟ على ماذا الآن؟ ماذا فعل خلال اليوم؟

**الاعتماد:** P04 وP06 وP03 للوسائط.

**Backend:**

- overview query مجمعة، لا N+1.
- timeline API typed segments + overlays.
- current context من presence.
- KPIs بتعريف/version/quality.
- cursor/windowed loading للtimeline.

**Frontend layout:**

1. Header: employee، department/role، state since، current app/window/domain، device selector.
2. Actions: Live View وRemote Support permission-aware.
3. Date/timezone/range selector في URL.
4. KPIs: work/active/idle/productive/activity/first/last/schedule variance.
5. Unified timeline.
6. Tabs: Overview، Timeline، Apps، Websites، Input، Screenshots، Sessions، Incidents، Audit.

**UX/performance:**

- Player في drawer/fullscreen لا صورة ضخمة فوق KPIs.
- virtualization وprogressive loading.
- skeletons ثابتة الحجم.
- no overlapping sticky/fixed.
- 360–1920px و125/150% zoom وRTL/LTR/light/dark.
- URL/object/timer cleanup عند تغيير الموظف 100 مرة.

**Tests:** API aggregate correctness، empty/new/offline/multi-device، permission-hidden data، stale request
abort، visual regression، keyboard accessibility، 24h/10k events render profile.

**Exit Gate:** الصفحة الأولى <1.5s cached/<3s cold، timeline <2s، ومجاميع التبويبات توافق KPIs.

### P08 — Live View وRemote Support عبر WebRTC

**الهدف:** مشاهدة وتحكم منخفض التأخير دون polling frames أو Postgres churn.

**الاعتماد:** P01 auth/audit، P03 media separation، P04 device health.

**Infrastructure:** signaling service، STUN/TURN، TLS، credentials قصيرة، metrics.

**Database:** session metadata/audit/actions/evidence refs فقط.

**Backend:**

- create/authorize/end session.
- viewer/control permission + scope + step-up auth.
- WebSocket signaling وربط agent/admin.
- session TTL/heartbeat/revocation.
- no frames through API/DB.
- typed actions validation وrate limits.

**Agent:**

- WebRTC screen source، adaptive FPS/bitrate/resolution.
- multi-monitor selector وDPI mapping.
- DataChannel sequence/ACK/error.
- mouse move/click/double/right/scroll.
- keyboard down/up/modifiers/shortcuts allowlist.
- optional freeze input/elevated actions كصلاحيات منفصلة وبعد قرار.
- visible indicator، session owner/reason، emergency stop.
- reconnect/ICE restart/TURN fallback.

**Frontend:**

- player canvas/video responsive.
- connection/quality/latency/FPS indicators.
- monitor/quality/fullscreen controls.
- view-only افتراضي ثم control mode.
- واضحة عند offline/unsupported/permission revoked.
- لا زر يبدو فعالًا قبل channel ready.

**Security:** signed typed action، session-bound nonce، TTL، replay prevention، audit لكل action،
clipboard/file transfer off افتراضيًا، لا shell.

**Tests:** WebRTC unit/integration، local/LAN/TURN، packet loss/latency، reconnect، two viewers policy،
revocation mid-session، DPI 100/125/150، multi-monitor coordinates، elevated app limits، 30min soak.

**Exit Gate:** first frame p95 <3s، input p95 <500ms good/<1s medium، 8–15 FPS adaptive،
لا media في Postgres، session كاملة في audit.

### P09 — الإنتاجية والجداول والمهام وTime Cards

**الهدف:** تحويل النشاط الصحيح إلى تصنيفات ومقاييس قابلة للتفسير حسب دور الموظف.

**الاعتماد:** P02 وP05 وP06.

**Database:** productivity profiles/tree/versions/categories/rules/classifications، work schedules، tasks.

**Backend:**

- parent/child inheritance.
- exact/regex/category matching بأولوية ثابتة.
- role/department-specific classification.
- unclassified queue.
- retroactive reclassification async مع progress/cancel.
- productive/unproductive/unclassified/custom metrics.
- scheduled vs actual، late/early/absent/day off.
- wages/cost optional ومفصول بصلاحية.

**Frontend:**

- profile tree/editor/categories.
- unclassified bulk workflow.
- rule preview يبين أمثلة التطابق.
- Time Cards day/week وmanual correction audited.
- productivity breakdown وexplanation، لا ranking عقابي افتراضيًا.

**APIs:** productivity profiles/categories/classify/reclassify، schedules، tasks، time cards.

**Tests:** precedence/inheritance، regex safety، same domain different role، historical version، job retry،
DST/schedule، multi-device، zero-work average exclusion، manual correction audit.

**Exit Gate:** كل KPI يرجع للsegments وclassification ruleset version، وإعادة التصنيف deterministic.

### P10 — Dashboards والتقارير والـExports

**الهدف:** تقديم البيانات في لوحات سريعة وقابلة للتخصيص دون تحميل raw events.

**الاعتماد:** P07 وP09، وP03 للexports.

**Preset dashboards:** Overview، Productivity، Apps & Websites، Live، Time Cards، Audit، Agent Health،
ثم File/Email/AI عند وجود بياناتها.

**Backend:**

- metric registry: key/type/unit/allowed dimensions/filters/permissions.
- query service يستخدم aggregates.
- dashboard/tab/widget definitions versioned.
- chart/grid response contracts.
- async CSV/PDF/export jobs، signed download، scheduling.
- query cost/time range limits وcache invalidation.

**Frontend:**

- create/clone/pin/set-home dashboards.
- tabs وchart/grid/built-in widgets.
- move/resize/expand/edit/remove.
- global/widget filters وdrill-down.
- grid sorting/grouping/summing/pagination.
- saved views وempty/no-access states.
- printable/export layouts.

**APIs:** dashboards/widgets/reports/exports/schedules.

**Tests:** metric permission leakage، same metric across views، large range async، CSV escaping/injection،
PDF RTL، export revoked، cache tenant keys، widget layout responsive، 20 concurrent dashboard loads.

**Exit Gate:** 90% من الاستخدام اليومي من اللوحة، p95 ضمن gate، ومجاميع Dashboard=Employee Report.

### P11 — Shared Lists والسياسات والقواعد والتنبيهات والحوادث

**الهدف:** اكتشاف أحداث وسلوكيات في الوقت المناسب وربطها بدليل وتحقيق قابل للتدقيق.

**الاعتماد:** P01 وP05 وP06 وP09.

**Database:** immutable policy/rule/list versions، incidents/evidence/actions/comments/tags.

**Backend:**

- shared list text/regex/CIDR + CSV import + usage references.
- safe regex timeout/size أو RE2-compatible engine.
- rule AST versioned: conditions/groups/operators/schedule/scope/risk/actions.
- types: Activity ثم Schedule ثم Content metadata.
- operators contains/equals/regex/glob/list وAND/OR/NOT.
- streaming evaluation + historical replay نفس المحرك.
- threshold/dedupe/cooldown/risk accumulation.
- actions أولًا Notify/Warn/Record incident.
- incident lifecycle open/acknowledged/investigating/resolved/dismissed.

**Agent:** local enforcement فقط للactions المعتمدة التي تحتاج زمنًا لحظيًا، مع policy version وaudit.

**Frontend:**

- policy/rule wizard: General، Scope، Type، Conditions، Schedule، Risk، Actions، Review.
- human-readable rule summary.
- match preview/replay قبل enable.
- incidents list/detail/evidence/player/comments/status.
- alert inbox وdedupe visualization.

**APIs:** shared lists، policies، rules، preview/replay، incidents، comments/evidence.

**Tests:** كل operator/logic، regex abuse، list version، event replay parity، duplicate/out-of-order،
threshold windows، timezone schedule، disabled rule، permission، action idempotency، false-positive fixtures.

**Exit Gate:** real-time latency <5s للأحداث المتصلة، replay مطابق، لا duplicate incidents، كل alert مفسر.

### P12 — القنوات المتقدمة وDLP

**الهدف:** إضافة قنوات enterprise واحدة تلو الأخرى دون خلطها بالنواة أو توسيع الخصوصية ضمنيًا.

**الاعتماد:** P03 وP05 وP11، وADR لكل قناة حساسة.

نفذ كل channel كـmini-phase مستقلة بهذا الترتيب المقترح:

1. File metadata: access/copy/write/rename/move/delete/upload/download/drive/path/cloud.
2. Print metadata: printer/document/pages.
3. Network metadata: process/remote host/port/bytes؛ لا TLS content.
4. Camera usage metadata: app/device/start/end، لا video.
5. Email metadata: client/from/to/domain/subject classification/attachment metadata بعد redaction.
6. AI usage metadata: tool/model/title/attachment/risk؛ prompts/responses off.
7. OCR بعد privacy approval وredaction.
8. IM/social/meetings metadata حسب platform support.
9. Audio فقط بعد Go/No-Go.

لكل channel:

- capability matrix Windows/macOS/Linux.
- profile settings/schedule/allow-deny.
- event schema/version/size/privacy class.
- collector + outbox + ingest + store + aggregate + report + rule criteria.
- permission وretention وexport controls.
- health/unsupported UI.
- benchmark CPU/RAM/network/storage.
- privacy proof tests وfixtures غير حساسة.

**Exit Gate:** لا channel تُعلن Done قبل vertical slice واختبار جهاز حقيقي وretention/permission.

### P13 — SSO/Directory/API/Webhooks/SIEM

**الهدف:** إدارة مؤسسية وتكامل خارجي آمن وقابل للتدقيق.

**الاعتماد:** P01 وP04 وP10 وP11.

**Backend:**

- SAML/OIDC SSO وMFA/step-up.
- SCIM 2.0 أولًا، ثم Entra/LDAP connectors عند الحاجة.
- one-way sync، immutable external ID، mappings، include/exclude، dry-run/diff.
- API tokens scoped/expiring/rotatable.
- webhooks signed، retry/backoff/dead-letter/replay protection.
- SIEM event schemas وdelivery health.

**Frontend:**

- integration catalog/status/connect/test/disconnect.
- directory mapping/filter/dry-run/sync history/errors.
- token create-once display/scopes/last used/revoke.
- webhook delivery logs/test/resend.
- SSO domain/config/metadata/certificate rotation UI.

**Tests:** duplicate directory identities، rename/domain change، dry run، partial sync، token scope، webhook
signature/retry/order، SSO replay/clock skew/cert rotation، audit لكل تغيير.

**Exit Gate:** directory sync لا يصنع duplicates، وكل integration لها health/history/recovery path.

### P14 — Production hardening، الحزم، النشر والتشغيل

**الهدف:** تحويل النظام من feature-complete إلى قابل للتشغيل الفعلي والدعم والترقية.

**الاعتماد:** كل Phase مطلوبة للإصدار المحدد.

**Backend/Infra:**

- migrations deploy order وbackward compatibility.
- autoscaling/load tests وDB pool sizing.
- Redis/object storage/TURN monitoring.
- backups + restore drills + RPO/RTO.
- retention/legal hold/data export/delete.
- metrics/logs/traces/alerts/SLOs/runbooks.
- secret manager وkey rotation وdependency/container scanning.
- staging منفصل وproduction change management.

**Agent release:**

- Windows code signing وinstaller/uninstaller.
- stable/canary/pinned channels.
- signed update manifest/packages.
- staged rollout، pause، rollback، update failure diagnostics.
- Windows 10/11 standard/admin، lock/sleep/RDP/multi-monitor/DPI.
- AV/EDR compatibility guide.
- visible app/service status وIT removal path.

**Frontend:**

- CSP/security headers، Sentry redaction، source-map policy.
- accessibility/RTL/responsive audit.
- browser support matrix.
- no secrets/internal errors in client.

**Testing:**

- 24h/7d soak حسب المكون.
- load tenants/employees/events/viewers.
- chaos network/storage/Redis/DB restart.
- restore drill.
- OWASP auth/API checks وcross-tenant pentest.
- upgrade من آخر production schema/agent.
- rollback without data loss.

**Exit Gate:** signed Windows build، staged update، green SLO/load/security/restore evidence، runbooks مكتملة.

---

## 14. Monitoring Profile channel specification

عند بناء محرر الـprofile، استخدم سجل القنوات التالي. كل قناة لها `enabled`, `schedule`,
`retention`, `capabilities`, `privacy`, `allowlist/denylist` حيث ينطبق:

| Channel | المستوى | أهم الإعدادات |
|---|---|---|
| Applications | Core | title/process، idle threshold، include/exclude، console metadata منفصل |
| Websites | Core | URL privacy، private mode، include/exclude domains/apps، focused metrics |
| Input | Core | key/mouse/click/scroll counts؛ لا content |
| OS State | Core | lock/sleep/screensaver/offline grace |
| Screen | Core بعد P03 | interval/FPS/quality/scaling/locked/event-only/blackout/retention |
| Offline Buffer | Core | max bytes/hours، upload window، retry/backoff |
| Files | Enterprise | operations/paths/drives/cloud، metadata first |
| Printing | Enterprise | printer/doc/pages/limits، no document copy default |
| Network | Enterprise | process/host/port/bytes، no MITM default |
| Email | High sensitivity | metadata first، body/attachment content approval only |
| IM/Social/Meetings | High sensitivity | metadata first، platform-specific |
| Geolocation | High sensitivity | schedule/threshold/location mapping، company device only |
| Audio | Restricted | explicit approval/indicator/retention |
| OCR | Restricted | language/redaction/index/retention |
| Camera Usage | Metadata | app/device/duration، no recording |
| Registry/Event Log | Security | allowlisted events/keys only |
| AI Usage | Enterprise | tool/model/file metadata/risk؛ content off default |

كل setting غير مدعوم على جهاز يجب أن يعود في resolved policy كـ`unsupported` مع السبب، لا
يتجاهله بصمت ولا يظهره UI كمطبق.

---

## 15. Rule Engine specification

### 15.1 أنواع القواعد

- Activity.
- Schedule.
- Content Sharing/DLP metadata.

### 15.2 مصادر Activity

- webpages: URL/title/browser/query policy/private flag/time totals.
- applications: name/title/process/args/elevated/time/OS.
- files: operation/path/source/drive/cloud/upload/download metadata.
- printing: printer/document/pages.
- network: process/host/port/bytes/IP.
- email/IM: metadata وcontent فقط إذا approved.
- OCR: detected class/text hash أو redacted snippet حسب policy.
- camera usage.
- registry/Windows event log.
- AI usage metadata.
- input counts/anomaly، لا typed text.

### 15.3 Schedule criteria

- starts late/early.
- leaves early/late.
- absent.
- works on day off.
- idle longer than threshold.
- login outside hours/from network/location غير متوقعة.
- daily/scheduled work threshold.

### 15.4 Operators

- equals/not equals.
- contains/not contains.
- starts/ends with.
- regex safe.
- glob/globstar.
- in/not in shared list.
- numeric greater/less/between.
- duration threshold.
- AND/OR/NOT nested groups بعمق محدود.

### 15.5 Actions

**مسموحة أولًا:** Notify، Warn، Create Incident، Tag، Start bounded incident recording، Webhook.

**بعد approval:** Block specific operation، Lock session، Redirect، Switch Task.

**ممنوعة:** arbitrary command/shell، التقاط credentials، عقوبة آلية بلا مراجعة.

---

## 16. معايير الأداء والـSLO

| المقياس | الهدف الأولي |
|---|---:|
| Agent normal CPU avg | أقل من 3–5% على الجهاز المرجعي |
| Agent normal RAM | أقل من 100MB هدفًا |
| Agent live CPU avg | أقل من 12% |
| Telemetry online freshness p95 | أقل من 10s |
| Presence freshness p95 | أقل من 5s |
| Overview API cached p95 | أقل من 1.5s |
| Overview API cold p95 | أقل من 3s |
| Timeline first render | أقل من 2s لـ24h |
| Live first frame p95 | أقل من 3s |
| Remote input good-network p95 | أقل من 500ms |
| Remote input medium-network p95 | أقل من 1s |
| Live FPS | 8–15 adaptive، حد أدنى 3–5 degraded |
| Dropped durable events | صفر في offline/retry soak |
| Duplicate durable events | صفر بعد idempotency |
| Cross-tenant leakage | صفر دائمًا |

لا تقل “سريع” أو “خفيف” دون baseline/after benchmark بأمر وبيئة وأرقام.

---

## 17. مصفوفة الاختبارات الإلزامية

### 17.1 Backend

- pure unit tests للمنطق.
- store tests على Postgres حقيقي/معزول.
- handler tests auth/validation/errors.
- race tests.
- tenant isolation لكل query.
- migrations fresh/upgrade.
- property/fuzz للparsers/rules/time ranges.

### 17.2 Agent Rust

- state machines/outbox/policy resolution.
- OS mapper abstractions.
- no typed-content privacy tests.
- retry/backpressure/disk cap.
- serialization compatibility.
- Windows integration/manual matrix حيث APIs لا تُحاكى بدقة.

### 17.3 Extension

- tab/window state machine.
- service worker death/recovery.
- durable outbox/retry.
- close/suspend/rapid switches.
- incognito/privacy URL transformation.
- Agent unavailable/restart.

### 17.4 Frontend

- component behavior.
- API mocking/error/loading/empty/stale.
- permission variants.
- i18n parity وRTL direction.
- visual snapshots responsive/light/dark/RTL.
- accessibility keyboard/focus/dialog.
- memory/timer/object URL cleanup.

### 17.5 E2E

```text
Agent/Extension event
→ local durable outbox
→ backend ingest
→ Postgres/object storage
→ aggregation/rule
→ API
→ employee/dashboard/incident UI
```

اختبر online، offline، duplicate، out-of-order، policy disabled، permission denied، retention.

### 17.6 Windows acceptance matrix

- Windows 10/11 x64.
- standard/admin user.
- single/multi monitor.
- 100/125/150% DPI.
- lock/unlock، sleep/wake، logoff/user switch.
- RDP حيث مدعوم.
- Chrome/Edge.
- elevated foreground application.
- network offline/slow/loss/high latency.
- install/startup/update/rollback/uninstall/service restart.
- 8h ثم 24h soak.

---

## 18. قواعد UX التفصيلية

- النتيجة المهمة تظهر فوق fold: الحالة الحالية، التطبيق الحالي، وقت اليوم.
- لا تعرض screenshot كبيرة قبل KPIs.
- لا تجعل المدير يذهب إلى Devices لمعرفة employee current state.
- كل KPI له tooltip: التعريف، الفترة، timezone، quality.
- كل chart يسمح بالوصول إلى rows التي كوّنته.
- كل row في activity/incident يفتح Player في نفس timestamp.
- no data يختلف عن no permission وعن collector unsupported وعن device offline.
- stale presence يظهر “آخر تحديث منذ…” ولا يظهر green للأبد.
- الإجراءات الخطرة لها confirmation يذكر الجهاز والموظف والأثر.
- التصدير لا يجمد الصفحة؛ job center يعرض الحالة والخطأ والانتهاء.
- RTL لا يعكس timeline الزمني بطريقة تربك الوقت؛ اختبر اتجاه المحور صراحة.
- toast لا يحمل الخطأ الوحيد؛ الخطأ يبقى inline عند الحقل/القسم.
- لا infinite spinner؛ timeout/retry/help path.

---

## 19. المراقبة التشغيلية والـSystem Health

أنشئ metrics ولوحات وتنبيهات لـ:

- agents online/idle/offline/missing.
- heartbeat age.
- applied vs desired policy version.
- Agent/extension version distribution.
- collector permission/capability failures.
- local queue depth/oldest age/disk use.
- ingest accepted/duplicate/rejected/limited.
- clock skew.
- browser coverage/unattributed time.
- screenshot/media upload failures.
- DB pool/query p95/locks/storage/WAL.
- object storage error/orphans/capacity.
- WebSocket connections/reconnects.
- WebRTC connect time/FPS/RTT/loss/TURN usage.
- rule evaluation latency/queue/duplicates.
- export/retention/directory/webhook job failures.

كل alert له runbook: كيف نثبت السبب، ما الآمن فعله، ومتى نصعّد.

---

## 20. سير العمل داخل كل Phase

نفذ الخطوات التالية دون تخطي:

1. **Discovery:** اقرأ الكود والschema والاختبارات، واربط المتطلب بالمسارات الحالية.
2. **Baseline:** شغّل الاختبارات والقياسات قبل التعديل.
3. **Design note:** اكتب القرار والعقود والمخاطر وrollback.
4. **Database:** migration + constraints + indexes + store tests.
5. **Backend:** domain/service/store/handler + auth + errors + metrics.
6. **Agent/Extension:** durable collection/policy/compatibility إن انطبق.
7. **Frontend:** route/API/types/UI/i18n/accessibility/responsive.
8. **Integration:** شغّل المسار الحقيقي end-to-end.
9. **Performance/Security:** قس gates وافحص privacy/tenant/rate limits.
10. **Regression:** الاختبارات الكاملة بقدر معقول، build/typecheck/lint/fmt.
11. **Audit:** راجع diff سطرًا سطرًا و`git diff --check`.
12. **Docs:** حدّث STATUS/roadmap/API/env/runbook بما حدث فعلًا.

لا تنشئ mock UI وتعتبرها feature. الـvertical slice لا تكتمل دون بيانات حقيقية من المصدر
إلى التخزين إلى API إلى الشاشة واختبار يثبتها.

---

## 21. Definition of Done العام

الميزة `DONE` فقط إذا:

- migration تعمل على DB جديدة وقديمة.
- Backend يطبق tenant/RBAC/validation/idempotency.
- Agent/Extension يتعافى من offline/restart حيث ينطبق.
- Frontend يعالج loading/empty/error/stale/no-permission/unsupported.
- العربية والإنجليزية والتصميم الحالي وresponsive تعمل.
- unit + integration + E2E المناسبة ناجحة.
- performance gate مقاس، لا متوقع.
- privacy/security tests ناجحة.
- observability وrunbook موجودان للمسار الإنتاجي.
- docs وenv examples محدثة بلا secrets.
- لا TODO جوهري مخفي وراء زر ظاهر.
- لا بيانات تجريبية تظهر كأنها production.
- لم تُكسر feature سابقة أو API بلا migration/deprecation plan.

حالات الحالة المسموحة:

- `NOT STARTED`
- `IN PROGRESS`
- `READY FOR TEST`
- `BLOCKED` مع دليل واحتياج محدد
- `DONE`

لا تستخدم `DONE` لمجرد نجاح unit tests إذا بقي Windows real-device أو E2E.

---

## 22. قالب تقرير التسليم لكل مرحلة

```text
النتيجة:
- ماذا أصبح يعمل فعليًا للمستخدم؟

النطاق المنفذ:
- DB:
- Backend:
- Agent:
- Extension:
- Frontend:
- API:
- Infra:

العقود/القرارات:
- event/API/schema changes
- compatibility/rollback

الاختبارات:
- الأمر — passed/failed/skipped
- Windows/manual evidence إن وجد

القياسات:
- baseline
- after
- acceptance gate

الأمان والخصوصية:
- tenant/RBAC/audit
- data captured/not captured
- retention/redaction

الملفات الجوهرية:
- روابط محلية مع أرقام أسطر

المتبقي:
- بنود محددة وسببها واعتمادها

الحالة:
- Phase/Feature = READY FOR TEST أو DONE أو BLOCKED
```

لا تقل “كل شيء تمام” دون الأوامر والأرقام. لا ترفع إلى `main` أو تنشر إلى production أو
تغير external systems إلا إذا طلب المستخدم ذلك صراحة.

---

## 23. المهمة الحالية

ابدأ الآن بالمرحلة:

```text
CURRENT_PHASE = AUTO
```

إذا كانت AUTO، حدد أول exit gate غير محققة من الكود والاختبارات. اذكرها للمستخدم، ثم نفذ
أصغر vertical slice كاملة تقرّبها من الإغلاق. استمر في العمل الآمن داخل النطاق حتى تصبح
المرحلة `READY FOR TEST` أو `DONE`، أو يظهر blocker حقيقي لا يمكن حله دون صلاحية/جهاز/
قرار منتج. لا تستبدل العمل بتقرير فقط عندما يكون المستخدم قد طلب التنفيذ.

---

## 24. خريطة الملفات والموديولات المقترحة

هذه خريطة اتجاهية لتوزيع المسؤوليات. لا تنقل كل الملفات دفعة واحدة؛ أنشئ أو انقل الموديول
عندما تنفذ الـvertical slice الخاصة به، مع الحفاظ على imports وtests والتوافق.

### 24.1 Backend Go

```text
apps/backend/
├── cmd/server/                 # composition root فقط
├── internal/
│   ├── auth/                   # password/JWT/refresh/MFA/device credentials
│   ├── tenant/                 # tenant context + scope enforcement
│   ├── domain/                 # models/value objects، بلا Gin/pgx
│   ├── handlers/               # HTTP/WS adapters
│   │   ├── auth.go
│   │   ├── employees.go
│   │   ├── devices.go
│   │   ├── reports.go
│   │   ├── profiles.go
│   │   ├── productivity.go
│   │   ├── policies.go
│   │   ├── incidents.go
│   │   ├── media.go
│   │   ├── live.go
│   │   ├── exports.go
│   │   └── system.go
│   ├── services/               # use cases/transactions
│   ├── store/                  # pgx SQL + tenant-scoped persistence
│   ├── activity/               # state/time normalization and metrics
│   ├── monitoring/             # profile resolution and policy documents
│   ├── productivity/           # classification and reclassification
│   ├── rules/                  # AST/compiler/evaluator/replay/dedupe
│   ├── incidents/              # lifecycle and evidence
│   ├── media/                  # object store, thumbnails, retention
│   ├── realtime/               # presence, WS, signaling sessions
│   ├── audit/                  # append-only audit writer/query
│   ├── jobs/                   # durable jobs/workers/retry/idempotency
│   ├── notifications/          # email/in-app/webhooks
│   ├── integrations/           # SSO/SCIM/Entra/LDAP/SIEM
│   ├── middleware/             # auth/request-id/rate-limit/logging/recovery
│   ├── config/                 # typed env validation
│   ├── observability/          # metrics/traces/log helpers
│   ├── db/migrations/
│   └── server/                 # route registration/lifecycle
└── tests/                      # integration fixtures only إذا لزم
```

قواعد الربط:

- `handlers` لا تستدعي SQL مباشرة.
- `activity/productivity/rules` تكون pure بقدر الإمكان وتُختبر دون DB.
- `store` لا يعرف Gin ولا يبني response DTOs.
- `services` هي مكان transaction boundaries وRBAC use-case checks.
- كل dependency خارجية interface عند حدود `media/realtime/notifications/integrations`.
- لا تنشئ package عام اسمه `utils` تتحول إليه كل المسؤوليات.

### 24.2 Web Admin React

```text
apps/web-admin/src/
├── app/
│   ├── router.tsx
│   ├── providers.tsx
│   ├── permissions.ts
│   └── error-boundary.tsx
├── api/
│   ├── client.ts
│   ├── endpoints/
│   ├── schemas/
│   └── types.ts
├── auth/
├── features/
│   ├── employees/
│   │   ├── pages/
│   │   ├── components/
│   │   ├── queries/
│   │   └── model/
│   ├── devices/
│   ├── timeline/
│   ├── applications/
│   ├── websites/
│   ├── screenshots/
│   ├── live/
│   ├── remote-support/
│   ├── monitoring-profiles/
│   ├── productivity/
│   ├── dashboards/
│   ├── reports/
│   ├── policies/
│   ├── incidents/
│   ├── audit/
│   ├── integrations/
│   └── system-health/
├── components/
│   ├── ui/                     # design-system primitives
│   ├── charts/
│   ├── tables/
│   ├── filters/
│   └── media/
├── hooks/
├── i18n/locales/
├── styles/
└── test/
```

لا تنفذ إعادة هيكلة كاملة قبل feature. عند لمس صفحة قديمة، استخرج فقط ما يخدم boundary
الحالية. shared component لا يصبح عامًا إلا بعد وجود استخدامين حقيقيين على الأقل.

### 24.3 Employee Detail component tree

```text
EmployeeDetailPage
├── EmployeeIdentityHeader
│   ├── PresenceBadge
│   ├── CurrentContext
│   ├── DeviceSelector
│   └── EmployeeActions
├── DateRangeToolbar
├── EmployeeKpiGrid
│   └── MetricCard × N
├── UnifiedTimeline
│   ├── TimelineAxis
│   ├── ActivitySegments
│   ├── StateOverlay
│   ├── InputHeatmap
│   ├── ScreenshotMarkers
│   └── IncidentMarkers
├── EmployeeReportTabs
│   ├── OverviewPanel
│   ├── ApplicationsPanel
│   ├── WebsitesPanel
│   ├── InputPanel
│   ├── ScreenshotsPanel
│   ├── SessionsPanel
│   └── IncidentsPanel
└── SessionPlayerDrawer
```

كل panel يحصل على range/device/timezone من page state واحدة. لا يحتفظ كل tab بفترة مختلفة
بلا قصد، ولا يعيد حساب KPI من rows الخاصة به.

### 24.4 Desktop Agent Rust/Tauri

```text
apps/desktop/src-tauri/src/
├── platform/
│   ├── windows/                # Win32/WTS/power/input/window/display
│   └── macos/                  # TCC/workspace/accessibility
├── trackers/
│   ├── applications.rs
│   ├── input_counts.rs
│   ├── os_state.rs
│   ├── screenshots.rs
│   └── browser_bridge.rs
├── activity/
│   ├── state_machine.rs
│   └── segments.rs
├── policy/
│   ├── model.rs
│   ├── resolver.rs
│   ├── scheduler.rs
│   └── cache.rs
├── storage/
│   ├── migrations.rs
│   ├── outbox.rs
│   └── media_queue.rs
├── sync/
│   ├── client.rs
│   ├── worker.rs
│   ├── presence.rs
│   └── health.rs
├── realtime/
│   ├── websocket.rs
│   ├── signaling.rs
│   ├── webrtc.rs
│   └── remote_input.rs
├── security/
│   ├── credentials.rs
│   └── signature.rs
├── capabilities.rs
├── diagnostics.rs
└── main.rs
```

- `platform` يعيد domain events ولا يكتب DB مباشرة.
- `trackers` لا يعرف HTTP.
- `storage` هو مصدر durable truth قبل ACK الخادم.
- `realtime` منفصل عن batch sync؛ فشل live لا يوقف telemetry.
- remote input types enum/versioned، لا JSON حر يتحول مباشرة إلى OS call.

### 24.5 Browser Extension MV3

```text
apps/extension/
├── manifest.json
├── background/
│   └── service-worker.ts
├── lib/
│   ├── visit-state-machine.ts
│   ├── url-privacy.ts
│   ├── outbox.ts
│   ├── retry.ts
│   ├── browser-id.ts
│   ├── agent-bridge.ts
│   └── health.ts
├── options/
└── tests/
```

`service-worker.ts` يربط listeners فقط. منطق state/outbox/privacy pure وقابل للاختبار.

### 24.6 Infrastructure

```text
infra/
├── docker-compose.yml          # local DB/Redis/S3/coturn عند الحاجة
├── railway/                    # service/env/deploy notes
├── migrations/
├── monitoring/
│   ├── dashboards/
│   └── alerts/
└── runbooks/
    ├── agent-offline.md
    ├── ingest-lag.md
    ├── media-storage.md
    ├── live-connectivity.md
    ├── database-restore.md
    └── failed-deployment.md
```

لا تضع production secret أو private certificate في المستودع.

---

## 25. أمثلة العقود الأساسية

الأمثلة التالية تثبت معنى البيانات، وليست إذنًا لكسر API القائمة دفعة واحدة. وثق أي اختلاف
ضروري، واكتب compatibility tests.

### 25.1 Employee Overview

```json
{
  "data": {
    "employee": {
      "id": "uuid",
      "display_name": "Employee Name",
      "email": "employee@company.test",
      "department": {"id": "uuid", "name": "Engineering"},
      "job_role": {"id": "uuid", "name": "Developer"}
    },
    "presence": {
      "state": "active",
      "state_since": "RFC3339",
      "last_seen_at": "RFC3339",
      "stale": false,
      "device": {"id": "uuid", "name": "WORKSTATION-01"},
      "current_context": {
        "application": "Google Chrome",
        "window_title": "Project dashboard",
        "domain": "example.test",
        "url_visibility": "domain_only"
      }
    },
    "metrics": {
      "work_seconds": 21600,
      "active_seconds": 18000,
      "idle_seconds": 3600,
      "productive_seconds": 14400,
      "activity_percent": 72.4,
      "first_seen_at": "RFC3339",
      "last_seen_at": "RFC3339",
      "definition_version": 1,
      "quality": "complete"
    }
  },
  "meta": {
    "timezone": "Africa/Cairo",
    "range": {"from": "RFC3339", "to": "RFC3339"},
    "generated_at": "RFC3339",
    "request_id": "uuid"
  }
}
```

### 25.2 Unified Timeline

```json
{
  "data": {
    "segments": [
      {
        "id": "uuid",
        "kind": "activity",
        "start": "RFC3339",
        "end": "RFC3339",
        "wall_state": "active",
        "application": {"name": "Visual Studio Code", "process": "Code.exe"},
        "window_title": "main.go",
        "browser": null,
        "classification": {
          "category": "Development",
          "productivity": "productive",
          "ruleset_version": "uuid"
        },
        "input": {"keys": 42, "clicks": 8, "scrolls": 3},
        "quality": "complete",
        "source": "agent"
      }
    ],
    "markers": [
      {"kind": "screenshot", "at": "RFC3339", "ref_id": "uuid"},
      {"kind": "incident", "at": "RFC3339", "ref_id": "uuid", "severity": 70}
    ]
  },
  "meta": {
    "next_cursor": null,
    "timezone": "Africa/Cairo",
    "definition_version": 1
  }
}
```

قواعد timeline:

- `end > start`.
- لا يرسل screenshot bytes.
- لا يرسل typed characters.
- markers references فقط؛ الوصول للدليل endpoint مصرح منفصل.
- context nullable عند locked/sleeping/offline.

### 25.3 Device Health

```json
{
  "data": {
    "device_id": "uuid",
    "status": "degraded",
    "last_heartbeat_at": "RFC3339",
    "agent": {"version": "1.5.2", "channel": "stable", "update": "current"},
    "policy": {"desired": "uuid", "applied": "uuid", "status": "applied"},
    "clock_skew_seconds": 2,
    "outbox": {"pending_events": 12, "oldest_age_seconds": 30, "disk_bytes": 1048576},
    "collectors": {
      "applications": {"status": "ok"},
      "os_state": {"status": "ok"},
      "screen": {"status": "permission_required", "code": "screen_permission_missing"},
      "browser": {
        "status": "degraded",
        "extension_version": "1.2.0",
        "last_checkpoint_at": "RFC3339"
      }
    },
    "capabilities": {
      "live_view": true,
      "remote_control": true,
      "audio": false,
      "reconstructed_video": false
    }
  }
}
```

### 25.4 Monitoring Profile

```json
{
  "name": "Office Windows Standard",
  "parent_id": null,
  "priority": 100,
  "scope": {
    "include": [{"type": "department", "id": "uuid"}],
    "exclude": [{"type": "employee", "id": "uuid"}]
  },
  "timezone": "Africa/Cairo",
  "schedule": {
    "days": [1, 2, 3, 4, 5],
    "ranges": [{"start": "09:00", "end": "17:00"}]
  },
  "channels": {
    "applications": {"enabled": true, "capture_window_title": true},
    "websites": {
      "enabled": true,
      "url_visibility": "origin_path",
      "capture_query": false,
      "capture_fragment": false,
      "incognito": "disabled"
    },
    "input": {"enabled": true, "counts_only": true},
    "screen": {
      "enabled": true,
      "interval_seconds": 300,
      "quality": "balanced",
      "record_locked": false,
      "blackout_rules": []
    }
  }
}
```

الخادم يرفض `input.counts_only=false` دائمًا؛ ليست setting قابلة للفتح. profile response
يعيد version/status/validation/capability warnings وresolved preview.

### 25.5 Browser Visit Event

```json
{
  "schema_version": 1,
  "client_uuid": "uuid",
  "event_type": "browser.visit",
  "occurred_at": "RFC3339",
  "ended_at": "RFC3339",
  "payload": {
    "browser": "edge",
    "window_id": "opaque",
    "tab_id": "opaque",
    "domain": "example.test",
    "origin": "https://example.test",
    "path": "/projects",
    "url_hash": "sha256",
    "title": "Projects",
    "focused": true,
    "incognito": false,
    "privacy_mode": "origin_path"
  }
}
```

لا ترسل query/fragment عندما السياسة لا تسمح. `tab_id/window_id` scoped للbrowser session
وليستا identifier دائمًا عبر الأجهزة.

### 25.6 Live/Remote Session

طلب الإنشاء:

```json
{
  "device_id": "uuid",
  "mode": "view|control",
  "reason": "Support request #1234",
  "monitor_id": "primary",
  "quality": "auto",
  "idempotency_key": "uuid"
}
```

الرد:

```json
{
  "data": {
    "id": "uuid",
    "status": "connecting",
    "mode": "control",
    "expires_at": "RFC3339",
    "signaling_url": "wss://...",
    "ice_servers": [{"urls": ["turns:..."], "username": "short-lived", "credential": "ephemeral"}],
    "audit_id": "uuid",
    "device_capabilities": {"multi_monitor": true, "remote_control": true}
  }
}
```

remote action على DataChannel:

```json
{
  "v": 1,
  "session_id": "uuid",
  "seq": 55,
  "nonce": "random",
  "expires_at_ms": 1788170000000,
  "type": "mouse_scroll",
  "payload": {"delta_x": 0, "delta_y": -480}
}
```

Agent يرد `ack|rejected|failed` مع `seq` وcode. لا يوجد action type اسمه `command` أو
payload يحتوي shell text.

### 25.7 Productivity Rule

```json
{
  "profile_id": "uuid",
  "name": "Development tools",
  "priority": 200,
  "match": {
    "type": "any",
    "conditions": [
      {"field": "application.name", "operator": "equals", "value": "Visual Studio Code"},
      {"field": "website.domain", "operator": "in_list", "list_id": "uuid"}
    ]
  },
  "result": {
    "productivity": "productive",
    "category_id": "uuid"
  }
}
```

### 25.8 Behavior Rule

```json
{
  "policy_id": "uuid",
  "name": "Large upload to unapproved storage",
  "enabled": false,
  "scope": {"include": [{"type": "department", "id": "uuid"}], "exclude": []},
  "schedule": {"timezone": "Africa/Cairo", "always": true},
  "event_types": ["file.upload"],
  "condition": {
    "op": "and",
    "children": [
      {"field": "file.size_bytes", "operator": "greater_than", "value": 52428800},
      {"field": "destination.domain", "operator": "not_in_list", "list_id": "uuid"}
    ]
  },
  "risk": {"severity": 70},
  "threshold": {"count": 1, "window_seconds": 3600, "cooldown_seconds": 3600},
  "actions": [
    {"type": "notify", "recipients": [{"type": "role", "value": "investigator"}]},
    {"type": "create_incident"}
  ]
}
```

الحفظ الأول يكون disabled حتى ينجح preview/replay أو يؤكد المسؤول التجاوز مع audit.

### 25.9 Incident

```json
{
  "data": {
    "id": "uuid",
    "status": "investigating",
    "severity": 70,
    "risk_score": 70,
    "employee_id": "uuid",
    "device_id": "uuid",
    "rule": {"id": "uuid", "version_id": "uuid", "name": "Rule name"},
    "detected_at": "RFC3339",
    "summary": "Generated from structured fields, no secret content",
    "evidence": [
      {"type": "timeline_range", "from": "RFC3339", "to": "RFC3339"},
      {"type": "screenshot", "ref_id": "uuid", "access": "permission_required"}
    ],
    "assignee": null,
    "resolution": null
  }
}
```

### 25.10 Batch Ingest Result

```json
{
  "data": {
    "accepted": 97,
    "duplicates": 2,
    "rejected": 1,
    "results": [
      {"index": 0, "status": "accepted"},
      {"index": 98, "status": "duplicate"},
      {"index": 99, "status": "rejected", "code": "event_time_invalid"}
    ],
    "next_sync_after_ms": 5000,
    "policy_version": "uuid"
  }
}
```

لا تجعل فشل event واحد يلغي batch كاملًا إلا إذا envelope/auth/compression نفسها فاسدة.

---

## 26. مصفوفة تتبع الـFeatures إلى المراحل والطبقات

| Feature group | Phase | DB | Backend | Agent/Extension | Frontend | API | يعتمد على |
|---|---|:---:|:---:|:---:|:---:|:---:|---|
| Auth/MFA/device enrollment | P01 | ✓ | ✓ | Agent | ✓ | ✓ | P00 |
| Tenant isolation/rate limits | P01 | ✓ | ✓ | — | state only | ✓ | P00 |
| Audit foundation | P01 | ✓ | ✓ | metadata | viewer | ✓ | P00 |
| Active/idle/lock/sleep/offline | P02 | ✓ | ✓ | Agent | diagnostic ثم P07 | ✓ | P01 |
| Apps/windows/input counts | P02 | ✓ | ✓ | Agent | P07 | ✓ | P01 |
| Screenshots/object storage | P03 | ✓ metadata | ✓ | Agent | ✓ | ✓ | P01 |
| Retention/legal hold | P03/P14 | ✓ | ✓ workers | delete queue | admin UI | ✓ | P01 |
| Departments/job roles | P04 | ✓ | ✓ | identity mapping | ✓ | ✓ | P01 |
| Employees/devices/sessions | P04 | ✓ | ✓ | heartbeat | ✓ | ✓ | P02 |
| Agent health/missing agents | P04 | ✓ | ✓ | health | ✓ | ✓ | P02 |
| Monitoring profiles | P05 | ✓ | ✓ | resolver/cache | ✓ | ✓ | P02/P04 |
| Capture schedules | P05 | ✓ | ✓ | scheduler | editor | ✓ | P05 profiles |
| Browser URLs/focus | P06 | ✓ | ✓ | Extension+Agent | ✓ | ✓ | P02/P05 |
| Application/site rollups | P06 | ✓ | ✓ | telemetry | ✓ | ✓ | P02 |
| Employee overview | P07 | aggregates | ✓ | presence | ✓ | ✓ | P04/P06 |
| Unified timeline/player | P07 | ✓ | ✓ | telemetry/media | ✓ | ✓ | P02/P03/P06 |
| Live screen | P08 | metadata | ✓ signaling | Agent WebRTC | ✓ | WS/API | P01/P03/P04 |
| Remote control | P08 | audit | ✓ | Agent DataChannel | ✓ | WS/API | P08 live |
| Productivity profiles | P09 | ✓ | ✓ | — | ✓ | ✓ | P02/P06 |
| Work schedules/time cards | P09 | ✓ | ✓ | task mode optional | ✓ | ✓ | P02/P04 |
| Tasks/wages/cost | P09 | ✓ | ✓ | revealed task UI optional | ✓ | ✓ | schedules |
| Preset dashboards | P10 | aggregates | ✓ | — | ✓ | ✓ | P07/P09 |
| Custom widgets/tabs | P10 | ✓ | ✓ | — | ✓ | ✓ | metric registry |
| Reports/CSV/PDF/video export | P10 | jobs | ✓ workers | media refs | ✓ | ✓ | P03/P07 |
| Shared lists | P11 | ✓ | ✓ | policy subset | ✓ | ✓ | P01 |
| Activity rules | P11 | ✓ | ✓ evaluator | events/actions | ✓ | ✓ | P05/P06 |
| Schedule rules | P11 | ✓ | ✓ evaluator | events | ✓ | ✓ | P09 |
| Alerts/incidents/evidence | P11 | ✓ | ✓ | evidence signal | ✓ | ✓ | rules/P03 |
| File metadata | P12.1 | ✓ | ✓ | Agent | ✓ | ✓ | P05/P11 |
| Print metadata | P12.2 | ✓ | ✓ | Agent | ✓ | ✓ | P05/P11 |
| Network metadata | P12.3 | ✓ | ✓ | Agent | ✓ | ✓ | P05/P11 |
| Camera usage metadata | P12.4 | ✓ | ✓ | Agent | ✓ | ✓ | P05 |
| Email/AI metadata | P12.5/6 | ✓ | ✓ | Agent/browser | ✓ | ✓ | privacy ADR |
| OCR/audio/IM/social | P12.7+ | ✓ | ✓ | platform-specific | ✓ | ✓ | Go/No-Go |
| SSO/SCIM/Entra/LDAP | P13 | ✓ | ✓ | identity mapping | ✓ | ✓ | P01/P04 |
| API tokens/webhooks/SIEM | P13 | ✓ | ✓ | — | ✓ | ✓ | P01/P11 |
| Signed installer/auto-update | P14 | release metadata | manifest | Agent updater | admin status | ✓ | P04 |
| Backups/restore/SLO/runbooks | P14 | ✓ | ✓ | diagnostics | system UI | health | all release scope |

### 26.1 ربط الـDashboards بمصادرها

| Dashboard | المصدر المطلوب | Phase الجاهزية |
|---|---|---|
| Overview | employee/day aggregates + presence + incidents | P10 بعد P07/P09/P11 جزئيًا |
| Live Activity | Redis presence/current context | P08/P10 |
| Applications & Websites | activity/browser aggregates/classification | P06/P09/P10 |
| Productivity | productivity + schedule aggregates | P09/P10 |
| Time Cards | sessions/work schedules/manual edits | P09/P10 |
| Live View | agent presence + WebRTC signaling | P08 |
| Audit | audit events | P01 ثم P10 UI |
| Behavior Alerts | incidents/rules | P11 |
| Agent Health/Missing | heartbeat/health/version/gaps | P04 |
| File/Print/Network | channel events | P12 channel المقابلة |
| Email/AI/OCR/Camera | channel events + privacy permissions | P12 channel المقابلة |

لا تبن Dashboard قبل source contract والaggregate والpermission. يمكن إظهار navigation
feature-flagged فقط في staging، لا صفحة production فارغة توحي أن النظام يجمع بيانات.

### 26.2 ربط الـRules بمصادرها

```text
App/Web Activity Rule  ← P02/P06 events + P05 schedule/profile
Schedule Rule          ← P02 segments + P09 work schedule
File/Print/Network Rule← P12 channel events
Content Metadata Rule  ← P12 approved classifiers
Incident Recording     ← P03 media + P11 action
Notify/Webhook          ← P11 notifications + P13 webhooks
```

أي event schema يتغير يجب أن يشغل rule compatibility/replay tests قبل النشر.

# نهاية البرومبت

---

## طريقة استخدام الملف

للتنفيذ التلقائي من أول نقص حقيقي، اترك `CURRENT_PHASE=AUTO`.

لتحديد مرحلة، غيّرها مثلًا إلى:

```text
CURRENT_PHASE = P08 — WebRTC Live View and Remote Support
```

ولميزة واحدة داخل مرحلة:

```text
CURRENT_PHASE = P06 — Browser URL tracking vertical slice only
```

لا تطلب P10 Dashboards قبل اكتمال P02/P06/P07/P09، ولا P11 Rules قبل event/profile
versioning. خريطة الاعتماد في §10 هي المرجع عند التخطيط والتوازي.
