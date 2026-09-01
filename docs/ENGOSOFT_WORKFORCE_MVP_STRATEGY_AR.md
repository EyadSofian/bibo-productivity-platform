# استراتيجية Engosoft Workforce — من النسخة الحالية إلى MVP مؤسسي

**آخر تحديث:** 2026-09-01  
**مصدر التنفيذ التفصيلي:** [`TERAMIND_FULL_STACK_IMPLEMENTATION_PROMPT_AR.md`](TERAMIND_FULL_STACK_IMPLEMENTATION_PROMPT_AR.md)  
**تحليل المنتج المرجعي:** [`TERAMIND_KNOWLEDGE_BASE_AUDIT_AR.md`](TERAMIND_KNOWLEDGE_BASE_AUDIT_AR.md)

## 1. القرار التنفيذي

اسم المنتج الظاهر للمستخدم هو **Engosoft Workforce**. المشروع لا ينسخ Teramind بصريًا أو
برمجيًا؛ الهدف هو تكافؤ وظيفي مدروس بهوية Engosoft وكود مستقل.

لا يمكن أن تعني كلمة MVP «كل ما بنته Teramind عبر سنوات» و«صفر أخطاء» في الوقت نفسه.
التعريف القابل للتسليم هو:

1. **MVP Core:** المراقبة اليومية التي يحتاجها المدير فعلًا، من Agent إلى Dashboard، مع
   إثباتات واختبارات على Windows حقيقي.
2. **MVP Control:** سياسات وجدولة وصلاحيات وتقارير وتنبيهات تجعل المنتج قابلًا للتشغيل داخل شركة.
3. **Enterprise Parity:** DLP والقنوات المتقدمة والتكاملات والتحليلات، تضاف على موجات ولا
   تُعرض في production قبل اكتمال عقودها ومصادرها.

الوعود المطلقة مثل «لا يوجد bug في أي سطر» غير قابلة للإثبات. البديل المهني هو بوابات إصدار
مقيسة: اختبارات، SLO، مصفوفة Windows، فحص أمني، مراقبة إنتاجية وrollback.

## 2. الهوية البصرية المعتمدة

مرجع العلامة هو الشعار المقدم وهوية [الموقع الرسمي لإنجوسوفت](https://engosoft.com/).
الواجهة الإدارية ليست نسخة من الموقع التعليمي؛ هي امتداد مؤسسي أكثر كثافة ووضوحًا.

| Token | القيمة | الاستخدام |
|---|---:|---|
| Engosoft Navy | `#061B35` | Sidebar، hero، surfaces عالية الأهمية |
| Engosoft Blue | `#086BE8` | Primary actions، active navigation، links |
| Blue 600 | `#0056C7` | hover/pressed والنص الأزرق عالي التباين |
| Sky | `#48A5FF` | visualization accents وlive transport |
| Paper | `#F3F7FC` | خلفية workspace |
| Panel | `#FFFFFF` | cards/tables/dialogs |
| Active Mint | `#29C98F` | online/active فقط |
| Idle Amber | `#F5AD3D` | idle/warning فقط |
| Danger | semantic red | incident/error/destructive فقط |

قواعد ثابتة:

- اسم `BiBoTracking` لا يظهر في واجهة المدير. يبقى الاسم التقني مؤقتًا في installer/updater
  حتى migration منفصلة تمنع كسر التحديثات وهوية الأجهزة المثبتة.
- الشعار مصدره `EngosoftBrand.tsx`، والتوكنز مصدرها `theme.css`.
- أيقونات line موحدة 20/24px؛ لا emoji ولا icon styles مختلطة.
- العربية RTL والإنجليزية LTR لهما نفس hierarchy، لكن محور الوقت يظل LTR.
- الأزرق هو العلامة وليس status؛ active أخضر، idle amber، offline رمادي.

## 3. حالة المنتج الآن

| الوحدة | الحالة | الدليل الحالي | البوابة المتبقية |
|---|---|---|---|
| Auth + tenants | موجود | login/business isolation/RBAC core | MFA/SSO للمؤسسة |
| Employees | موجود | roster + profile + reports | server pagination وsaved views |
| Devices | Ready for test | inventory/heartbeat/version/pause/archive | اختبار fleet متعدد الأجهزة |
| Monitoring profiles | Core موجود | inheritance/schedule/timezone/assignment | policy push فوري وE2E مُحزّم |
| App/window activity | موجود | foreground app/title/duration | classification + categories |
| Browser URLs | موجود | MV3 extension + durable sync | enterprise deployment/coverage health |
| Input activity | موجود | counts فقط لكل دقيقة | proof suite يمنع content capture دائمًا |
| Screenshots | موجود | schedule/gallery/retention core | object storage وتحمّل production |
| Playback/timeline | موجود | unified timeline + synchronized evidence | incidents track/export clips |
| Presence/current work | موجود | heartbeat/current app/resources | Redis عند multi-replica |
| Live view | Ready for device test | transient frames + push + HTTPS fallback | Windows latency/CPU/network SLO |
| Remote assistance | Ready for device test | typed mouse/keyboard protocol + expiry | قياس live على جهاز الإنتاج |
| Auto-update | منشور | signed `latest.json` وWindows 1.5.10 | signing reputation/gradual rollout |
| Productivity | جزئي | focus aggregates | profiles/classification/score definitions |
| Reports/exports | جزئي | current employee reports | report hub/saved/scheduled/async jobs |
| Rules/incidents | غير مكتمل | contracts/roadmap only | event engine + dedupe + case workflow |
| Advanced DLP | غير مكتمل | audited requirements only | ADR/channel-by-channel implementation |

## 4. Information architecture النهائية

```text
Engosoft Workforce
├── Overview
│   ├── Team presence
│   ├── Active/idle/offline KPIs
│   ├── Live desk: current app/window + online duration
│   └── Workforce table
├── People
│   ├── Employee profile
│   ├── Unified timeline
│   ├── Apps & windows
│   ├── Websites & URLs
│   ├── Input volume
│   ├── Screenshots & playback
│   └── Incidents & annotations
├── Devices
│   ├── Agent health/version/permissions
│   ├── Desired vs applied policy
│   ├── Queue/sync/clock skew
│   └── Live/remote entry point
├── Live
│   ├── Connected devices grid
│   ├── Read-only live view
│   └── Authorized remote support sessions
├── Activity
│   ├── Applications
│   ├── Websites
│   ├── Attendance/time cards
│   └── Productivity classification
├── Evidence
│   ├── Screenshot search
│   ├── Playback
│   ├── Tags
│   └── Evidence exports
├── Rules & Incidents
│   ├── Behavior policies
│   ├── Alerts
│   ├── Cases
│   └── Review/audit trail
├── Reports
│   ├── Report catalog
│   ├── Saved filters
│   ├── Schedules
│   └── Export job center
├── Configuration
│   ├── Monitoring profiles
│   ├── Productivity profiles
│   ├── Shared lists
│   └── Retention/privacy
├── Organization
│   ├── Departments/roles
│   ├── Schedules/locations
│   └── Access control
└── System
    ├── Agent health/missing agents
    ├── Integrations/API/webhooks
    ├── Audit log
    └── Storage/jobs/SLO
```

لا يظهر route لمجرد ملء القائمة. الوحدة غير المكتملة تكون خلف feature flag في staging.

## 5. موجات التنفيذ

### Wave 0 — تثبيت الإصدار الحالي

- Windows 1.5.10 من رابط Railway الثابت والـversioned.
- اختبار جهاز Windows فعلي: install، login، heartbeat، URLs، screenshots، update، uninstall.
- قياس أول live frame، FPS، CPU، RAM، bandwidth، reconnect وremote input latency.
- إغلاق أي P0 قبل توسيع سطح المنتج.

**Exit gate:** جلسة عمل ساعتين على جهاز حقيقي دون crash، فقد أحداث غير مفسر أو queue متنامية.

### Wave 1 — Engosoft shell وDashboard foundation

- تطبيق الهوية الحالية على login/shell/overview/favicon/title.
- فصل navigation إلى المساحات الموضحة أعلاه مع feature flags.
- global search/date/timezone/notifications، permission-aware navigation.
- منع overflow/overlay في 360/390/768/1024/1440px وRTL/LTR.

**Exit gate:** visual regression + axe + no horizontal document overflow + جميع routes قابلة للوحة المفاتيح.

### Wave 2 — Employee 360 وActivity truth

- API موحد لـemployee overview بدل حساب KPIs في React.
- current app/window/domain/URL ووقت كل tab/session بدقة.
- active/idle/locked/sleep/offline segmentation مع timezone صريحة.
- communication evidence يفرق بين «التطبيق مفتوح»، «يوجد input»، و«حدث مؤكد من API».

**Exit gate:** مجموع أجزاء اليوم يطابق اليوم ضمن tolerance معلنة ولا يوجد double counting.

### Wave 3 — Live v2 وRemote Support

- WebRTC media عند جاهزية البنية؛ SSE/HTTPS fallback يبقى آمنًا.
- WebSocket/typed data channel للتحكم، sequence/ack/backpressure.
- جلسة قصيرة العمر، سبب، نطاق، RBAC، audit، مؤشر ظاهر على الجهاز.
- Redis presence/signaling قبل تشغيل أكثر من backend replica، وTURN للاتصالات المقيدة.

**Exit gate:** p95 first frame <3s، input echo <250ms على الشبكة المرجعية، CPU <12% في live.

### Wave 4 — Profiles، schedules وProductivity

- monitoring profile versioning/effective time/policy delivery/ack.
- work schedules منفصلة عن capture schedules.
- app/site categories وproductive/unproductive/neutral حسب role/department.
- time cards والتعديلات اليدوية مع audit.

**Exit gate:** agent يطبّق نفس policy التي تعرضها اللوحة ويعمل rollback للإصدار السابق.

### Wave 5 — Reports، rules وIncidents

- server-side report queries/pagination، saved views، async CSV/JSON/PDF jobs.
- rules versioned + dry-run/replay/dedupe/cooldown.
- incident lifecycle: open/assigned/in-review/resolved/false-positive.
- evidence snapshot، immutable audit، notification/webhook.

**Exit gate:** إعادة تشغيل worker لا تكرر alert/action، وكل رقم report قابل للتتبع إلى rows مصدر.

### Wave 6 — Enterprise integrations

- MFA/SSO/SCIM/Entra/LDAP حسب الأولوية.
- scoped API tokens، webhooks موقعة، SIEM export.
- storage/retention/data residency/backups/restore drills.
- billing/seat/license إذا أصبح المنتج متعدد العملاء تجاريًا.

### Wave 7 — Advanced capture/DLP

تنفذ قناة واحدة في كل مرة بعد ADR: file metadata، print metadata، network metadata، email
metadata، content classification، OCR أو غيرها. لا تخلط ثماني قنوات في PR واحد.

## 6. حدود المنتج الثابتة

مسموح: Agent مرئي على جهاز شركة، Windows service لا يوقفه المستخدم القياسي، URL/app/window
time، input counts، screenshots/playback، live view، وremote support بسياسة الشركة ومؤشر واضح.

غير داخل المنتج: stealth agent، تسجيل النص المكتوب أو كلمات المرور، webcam خفي، arbitrary
PowerShell/shell، TLS interception عام، أو عقوبة آلية اعتمادًا على input volume وحده.

Email/IM body، audio، OCR شامل، clipboard payload، camera، geolocation، kernel drivers
والإجراءات الآلية الحاجبة تحتاج ADR وGo/No-Go منفصلين قبل أي كود.

## 7. بوابات الجودة الإلزامية

| المجال | الحد الأدنى قبل merge |
|---|---|
| Go | `go test ./...` + `go test -race ./...` + `go vet ./...` |
| Rust | `cargo test` + `cargo fmt --check` + Clippy `-D warnings` |
| Web | Vitest + typecheck + production build |
| Extension | Vitest + build + MV3 validation |
| Database | migration up على DB قديمة وجديدة + tenant isolation tests |
| Security | auth/RBAC/rate/idempotency/privacy regression |
| UI | Arabic/English، light/dark، keyboard، 360–1440px، screenshot review |
| Windows | clean install/upgrade/restart/service/offline/update/uninstall |
| Performance | baseline + after + p50/p95 + hardware/network description |
| Delivery | health check + smoke + logs/metrics + rollback |

## 8. Definition of Done للـMVP Core

- المدير ينشئ موظفًا ويربط جهازًا ويطبق profile دون تدخل في قاعدة البيانات.
- Agent Windows يبدأ مع النظام ويظل قابلًا للإدارة من IT، ويعمل offline ثم يزامن بلا تكرار.
- الملف يعرض ما هو مفتوح الآن، URL/app/window، وقت active/idle/offline، input counts،
  screenshots وplayback لنفس الفترة الزمنية.
- URLs تُجمع من extension المدارة، وتعرض coverage/unsupported بدل إخفاء النقص.
- live view وremote support يجتازان مصفوفة Windows وSLO الفعلية.
- retention وblackout وRBAC وtenant isolation وaudit تعمل end-to-end.
- dashboard لا يحسب أرقامًا مختلفة عن report لنفس filters/timezone.
- updater ينتقل من الإصدار السابق إلى الحالي ويعيد تشغيل الخدمة دون إعادة تثبيت يدوي.
- جميع الاختبارات والـbuild والـaudit والـsmoke production خضراء، والـrollback مجرّب.

## 9. طريقة التنفيذ اليومية

استخدم البرومبت الكامل في
[`TERAMIND_FULL_STACK_IMPLEMENTATION_PROMPT_AR.md`](TERAMIND_FULL_STACK_IMPLEMENTATION_PROMPT_AR.md)
مع `CURRENT_PHASE=AUTO`، أو عيّن Wave/Phase واحدة. في كل دورة:

1. اكتشف أول exit gate فاشلة من الكود والاختبارات.
2. نفذ vertical slice واحدة من collector إلى UI.
3. قس قبل/بعد، واختبر الفشل والتعافي لا happy path فقط.
4. راجع diff والأمان والأداء والترجمة والـresponsive.
5. حدّث `STATUS.md` بالدليل والنتائج والمتبقي الحقيقي.
6. لا تنتقل للوحدة التالية قبل إغلاق البوابة أو توثيق blocker خارجي محدد.

