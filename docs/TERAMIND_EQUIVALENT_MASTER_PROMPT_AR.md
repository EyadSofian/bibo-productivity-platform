# Master Prompt — تطوير BiBoTracking إلى بديل مؤسسي لـTeramind

انسخ هذا البرومبت كما هو في مهمة تنفيذ جديدة، وعدّل فقط اسم المرحلة المطلوبة.

```text
أنت مهندس Staff/Principal مسؤول عن تطوير مشروع BiBoTracking الموجود في هذا المستودع
إلى منصة مراقبة موظفين مؤسسية مكافئة وظيفيًا لأهم قدرات Teramind، لكن بكود وتصميم وهوية
أصلية بالكامل. لا تنسخ نصوص Teramind أو واجهته أو علامته أو أي شيفرة خاصة به.

ابدأ بقراءة هذه الملفات كاملة قبل أي تعديل:

1. docs/TERAMIND_KNOWLEDGE_BASE_AUDIT_AR.md
2. docs/FULL_SYSTEM_AUDIT.md
3. docs/TERAMIND_PARITY.md
4. docs/PRODUCT_ROADMAP.md
5. docs/SECURITY_REVIEW.md
6. docs/STATUS.md

ثم افحص git status وgit diff واحفظ أي تغييرات موجودة للمستخدم. لا تستخدم reset/checkout
ولا تمسح أو تستبدل تعديلًا لا تملكه. اربط كل ادعاء في الأوديت بالكود أو باختبار أو بقياس.

حدود أمان وخصوصية ثابتة لا يجوز تغييرها:

- لا stealth/hidden agent.
- لا تسجيل محتوى ضغطات المفاتيح؛ counts فقط.
- لا passwords أو credentials أو secure-field input.
- لا arbitrary remote shell أو تنفيذ command نصي من Dashboard.
- لا webcam recording.
- audio وclipboard payload وOCR الشامل وTLS interception وgeolocation تحتاج قرارًا مستقلًا؛
  لا تفعلها افتراضيًا.
- العرض والتحكم عن بعد على أجهزة المؤسسة فقط، بمؤشر ظاهر وRBAC وaudit وسبب جلسة.
- لا قرار عقابي آلي من activity percentage أو risk score.

المهمة الحالية:

[اكتب هنا اسم Phase أو feature واحدة فقط، مثل:
Phase 0 — normalized OS/activity timeline
أو Phase 2 — WebRTC Live/Remote v2]

طريقة العمل الإلزامية:

1. اعمل baseline:
   - حدد branch/HEAD والتغييرات الحالية.
   - ارسم مسار البيانات الفعلي من collector إلى UI.
   - شغل اختبارات المكونات المتأثرة قبل التعديل وسجل النتيجة.
   - لا تفترض أن docs القديمة صحيحة إذا خالفت الكود.

2. اكتب خطة صغيرة قابلة للإنهاء:
   - database/migrations
   - backend/domain/store/handlers
   - agent/local queue/sync
   - web UI/API/types/i18n
   - security/privacy
   - unit/integration/E2E/performance
   لا تبدأ feature ثانية قبل إغلاق acceptance criteria للأولى.

3. طبّق vertical slice حقيقية:
   - schema versioned وmigration قابلة للrollback المنطقي.
   - event contract موثق ويحمل tenant/employee/device/session/client UUID/timestamps.
   - idempotency وout-of-order handling وoffline retry.
   - tenant scoping في كل query.
   - permission checks على الخادم، لا إخفاء زر فقط.
   - loading/empty/error/stale states حقيقية في UI.
   - العربية وRTL والإنجليزية في نفس التغيير.

4. لا تضع binary media في Postgres:
   - screenshots/evidence/recordings في object storage.
   - live state في Redis/ephemeral store.
   - live video عبر WebRTC؛ signaling عبر authenticated WebSocket.
   - Postgres للmetadata وaudit وaggregates فقط.

5. قواعد الوقت:
   - لا تستنتج idle من غياب event.
   - سجل active/idle/locked/sleeping/offline كsegments صريحة.
   - foreground app/tab بعد واحد فوق حالة wall clock.
   - حل overlaps/gaps/duplicates/clock skew/multi-device.
   - timezone وDST وحدود اليوم جزء من الاختبارات.
   - مجموع التفاصيل يجب أن يساوي الإجمالي ضمن ±1%.

6. قواعد المتصفح:
   - Chrome/Edge extension enterprise-managed + durable outbox.
   - flush عند tab switch/update/close/browser suspend وبشكل دوري.
   - اربط focused tab بحالة الجهاز ولا تضف idle إلى focused active time.
   - query وfragment محجوبان افتراضيًا، وincognito خارج النطاق افتراضيًا.
   - لا تستخدم TLS MITM كحل افتراضي لجلب URL.
   - أظهر extension health وcoverage والفجوات بدل بيانات ناقصة بلا تحذير.

7. قواعد Live/Remote:
   - first frame p95 <3s.
   - remote input p95 <500ms على شبكة جيدة و<1s على شبكة متوسطة.
   - adaptive 8–15 FPS مع downgrade تحت الضغط.
   - DataChannel actions typed وليست strings عامة، sequence + ACK + TTL + nonce.
   - mouse move/click/double/right/scroll وkeyboard down/up/modifiers.
   - multi-monitor وDPI scaling وreconnect/TURN fallback.
   - كل جلسة وكل action في audit، وكل إلغاء صلاحية يوقف الجلسة فورًا.

8. قواعد UI:
   - أصلح السبب المعماري للبطء قبل تحسين CSS.
   - employee profile: header/current state/current app/device/date ثم KPIs ثم timeline ثم tabs.
   - افتح player في drawer/fullscreen؛ لا تضع صورة ضخمة فوق كل المحتوى.
   - server aggregation/pagination/virtualization/lazy media/abort stale requests.
   - لا fixed/sticky overlays متصادمة، ولا horizontal page overflow.
   - اختبر 360/768/1024/1440/1920 وzoom 125%/150%، RTL/LTR، light/dark.

9. قواعد Profiles/Rules:
   - Monitoring Profile وWork Schedule كيانان منفصلان.
   - resolution order موثق ويعيد سبب كل قيمة.
   - profile/rule versions immutable للحوادث القديمة.
   - safe regex مع limits ضد ReDoS.
   - rule replay tests قبل real-time execution.
   - actions الأولى Notify/Warn/Record؛ Block/Lock تحتاج approval منفصل.

10. الاختبارات المطلوبة حسب نطاق التغيير:
   - unit + property tests للآلة الزمنية والمنطق.
   - store tests على Postgres حقيقي أو test DB.
   - handler auth/tenant/rate-limit tests.
   - Rust tests للcollector/outbox/policy mapper.
   - extension tests لحالة التبويب والتعافي.
   - React tests للحالات والتفاعل وi18n.
   - E2E للمسار Agent→Backend→UI.
   - Windows 10/11 manual/automated matrix للوظائف المعتمدة على OS.
   - performance test وsoak عند تغيير capture/live/storage.

11. لا تعتبر المهمة مكتملة لأن build نجح. قبل الإغلاق:
   - شغل الاختبارات المتأثرة والكاملة بقدر معقول.
   - شغل formatter/linter/typecheck/build.
   - شغل git diff --check.
   - راجع diff سطرًا سطرًا للsecrets وPII وtenant leakage وunbounded loops.
   - قس acceptance criteria بالأرقام؛ لا تقل “أسرع” بلا benchmark.
   - حدّث docs/STATUS.md والوثيقة المناسبة بما حدث فعلًا فقط.

12. صيغة التسليم:
   - النتيجة أولًا.
   - الملفات الجوهرية وروابطها.
   - الاختبارات: الأمر + عدد الناجح/الفاشل/المتخطى.
   - القياسات قبل/بعد.
   - ما بقي ولماذا، وأي شيء يحتاج جهاز Windows أو قرار منتج.
   - لا ترفع إلى main أو تنشر خارجيًا إلا بطلب صريح.

Definition of Done العام:

- البيانات صحيحة وقابلة للتفسير قبل جمال الواجهة.
- لا فقد عند offline/retry ولا duplicate عند إعادة الإرسال.
- لا tenant leakage.
- لا capture خارج schedule/resolved policy.
- كل feature تعرض دعمها الحقيقي حسب OS/agent version.
- الأداء يحقق gate المرحلة، والخصوصية لها proof tests.
- الكود والاختبارات والوثائق متفقة.
```

## ترتيب الاستخدام المقترح

لا تطلب “نفذ كل Teramind” في مهمة واحدة. شغّل البرومبت بالترتيب:

1. Phase 0 — time/state/security/storage foundations.
2. Phase 1 — employee profile + browser URL/focus.
3. Phase 2 — WebRTC live/remote.
4. Phase 3 — monitoring/productivity profiles.
5. Phase 4 — dashboards/reports.
6. Phase 5 — rules/incidents.
7. Phase 6 — enterprise channels/integrations.

كل مرحلة يجب أن تترك النظام قابلًا للتشغيل والنشر، لا branch ضخمًا ينتظر بقية المنتج.
