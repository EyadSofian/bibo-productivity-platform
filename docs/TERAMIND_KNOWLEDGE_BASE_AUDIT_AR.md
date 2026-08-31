# أوديت قاعدة معرفة Teramind وخطة بناء منتج مكافئ وظيفيًا

**تاريخ المراجعة:** 2026-08-31  
**المصدر:** قاعدة المعرفة الرسمية لـ Teramind  
**نطاق الفهرسة:** 343 مقالة من 11 مجموعة، تم تنزيل نسخ Markdown مؤقتة منها وفحصها دون أخطاء  
**المشروع المقارن:** BiBoTracking، الفرع `main` عند `44a8713` مع احتساب تغييرات شجرة العمل الحالية  
**حالة هذا المستند:** مرجع المنتج والهندسة للانتقال من نموذج أولي إلى منصة مراقبة موظفين مؤسسية

> هذا تحليل للوظائف والسلوك المعلن في الوثائق العامة، وليس وصولًا إلى كود Teramind أو
> بنيته الداخلية غير المنشورة. الهدف هو **تكافؤ القدرات** بتصميم وكود وواجهة أصلية، لا
> نسخ العلامة التجارية أو النصوص أو الشكل أو الشيفرة الخاصة بهم.

---

## 1. الخلاصة التنفيذية

Teramind ليس تطبيق لقطات شاشة. هو نظام يتكون من خمس طبقات مترابطة:

1. **Agent على جهاز الموظف** يجمع الأحداث، يطبق جدول المراقبة، وينفذ بعض السياسات.
2. **قناة نقل واتصال لحظي** ترفع القياسات وتدير حالة الاتصال والعرض المباشر.
3. **طبقة أحداث وتخزين وتحليل** تحوّل القياسات الخام إلى وقت عمل، خمول، إنتاجية، مخاطر وحوادث.
4. **محرك إعدادات وسياسات** يحدد ماذا يُجمع، متى، من أي موظف أو جهاز، وماذا يحدث عند المخالفة.
5. **لوحة إدارة وتحقيق** تحتوي على dashboards وتقارير، ملف موظف، Session Player، صلاحيات وتصدير.

النسخة الحالية من BiBoTracking تغطي جزءًا مفيدًا من الطبقات الأولى: التطبيقات والنوافذ،
عداد ضغطات المفاتيح، بيانات المتصفح عند وجود الإضافة، اللقطات، الأجهزة، الحضور اللحظي،
ملفات مراقبة أساسية، الأقسام والوظائف، وعرض/تحكم أولي. لكنها لا تملك بعد طبقة الأحداث
الموحّدة ومحرك الإنتاجية والسياسات والبث منخفض التأخير اللذين يجعلان البيانات قابلة للاعتماد.

القرار الهندسي الصحيح ليس إضافة عشرات التبويبات فورًا. الترتيب الصحيح هو:

1. إصلاح نموذج الوقت والحالات والهوية.
2. نقل البث والتحكم من polling وصور داخل Postgres إلى WebRTC/WebSocket.
3. إنشاء Monitoring Profiles مجدولة وذات نطاق واضح.
4. إنشاء ملف موظف موحّد مبني على Timeline واحد.
5. إضافة Productivity Profiles ثم Dashboards ثم Rules/Alerts.
6. إضافة قنوات DLP المتقدمة على مراحل وبعد قرار خصوصية وقانوني مستقل لكل قناة.

أحدث إصدار موثق وقت الأوديت هو **26.33.3 بتاريخ 2026-08-17**، ويضيف شاشة الأجهزة/
المستخدمين الذين توقفوا عن إرسال البيانات، مؤشر الحالة اللحظية، وتحسينات على الجداول
والتصنيف؛ ما يؤكد أن “اكتشاف فجوة المراقبة” نفسه ميزة منتج، وليس مجرد صفحة دعم.

---

## 2. المنهج وحدود الدقة

### 2.1 ما تمت مراجعته

- دليل الواجهة والـDashboards والموظفين والأجهزة وSession Player.
- Monitoring Profiles وProductivity Profiles وAccess Control وShared Lists.
- Behavior Policies بأنواع Activity وContent Sharing وSchedule وكل الإجراءات.
- إعدادات الخادم والوكلاء والمصادقة وAD/LDAP/Entra وOCR والبريد والتوطين.
- Agent specifications، الفروق بين Windows/macOS/Linux، التحديث والحماية والإزالة.
- Cloud/On-Premises/Private Cloud، الأمان والتشفير والاحتفاظ والنسخ الاحتياطي.
- أسئلة الإنتاجية والخمول والمتوسطات والمكتب/خارج المكتب.
- Release notes حتى 2026-08-17 وميزات NextGen وTeraCat وInsights.
- أدلة المشكلات الشائعة؛ لأنها تكشف القيود التشغيلية التي لا تظهر في صفحة المزايا.

### 2.2 ما لا يمكن استخلاصه من قاعدة المعرفة

- كود Teramind أو مخطط قاعدة بياناته الحقيقي.
- البروتوكول الداخلي الكامل، codecs، queue topology أو قواعد autoscaling.
- دقة خوارزميات التصنيف وUEBA أو بيانات تدريبها.
- أرقام latency/SLA فعلية لكل مسار ما لم تنشرها الشركة.
- عقود API كاملة لكل إصدار؛ تحتاج مراجعة API docs منفصلة عند بدء التكامل.

لذلك كل ما يلي مصنف ضمن واحد من ثلاثة أنواع: **موثق رسميًا**، **استنتاج هندسي**، أو
**اقتراح لبنية BiBoTracking**. لا يتم تقديم الاستنتاج على أنه حقيقة داخلية عن Teramind.

---

## 3. قاموس المنتج

| المصطلح | المقصود |
|---|---|
| Employee | هوية الشخص داخل المؤسسة، وقد ترتبط بأكثر من جهاز أو جلسة |
| Computer / Device | جهاز أو endpoint عليه Agent، وقد يستخدمه أكثر من موظف |
| Agent | برنامج سطح المكتب الذي يجمع القياسات ويطبق السياسات المسموحة |
| Session | دخول موظف إلى جهاز خلال فترة متصلة أو شبه متصلة |
| Activity event | تطبيق/نافذة/موقع/إدخال/ملف/حالة نظام خلال وقت محدد |
| Monitoring Profile | سياسة تحدد قنوات الجمع وجدولها وإعداداتها ونطاقها |
| Productivity Profile | قواعد تصنيف التطبيقات والمواقع إلى productive/unproductive/custom |
| Behavior Policy | حاوية قواعد سلوكية تستهدف موظفين/أجهزة/أقسامًا |
| Rule | شروط + نافذة زمنية + شدة خطر + إجراءات عند التطابق |
| Incident | تطابق موثق لقاعدة مع أدلته وسجل التعامل معه |
| Snapshot | لقطة ثابتة منفصلة |
| Session Recording | تسلسل زمني للشاشة والأحداث يمكن تشغيله والتحقيق فيه |
| Live View | مشاهدة حالة/شاشة الجهاز الآن |
| Remote Support | جلسة تحكم في جهاز مؤسسي بصلاحية وتسجيل ومؤشر ظاهر |

التمييز بين Employee وDevice وSession أساسي. جمعهم في كيان واحد ينتج أخطاء عند تبديل
المستخدمين، RDP، جهاز مشترك، أو استخدام الموظف جهازين في نفس الوقت.

---

## 4. خريطة المنتج الكاملة

```text
Organization
├── Employees ── Departments ── Positions ── Tasks ── Locations
├── Computers / Agents / Sessions
├── Monitoring Profiles (what + when + scope)
├── Productivity Profiles (classification)
├── Behavior Policies
│   ├── Activity Rules
│   ├── Content Sharing Rules
│   └── Schedule Rules
├── Shared Lists (text / regex / networks)
├── Access Control (subjects → permissions → resources → targets)
└── Settings / Auth / Directory / Storage / Integrations

Telemetry
├── Apps + windows + commands
├── Websites + tabs + URLs
├── Input volume + idle + OS state
├── Screens + OCR + camera metadata
├── Files + print + clipboard classification
├── Email + IM + meetings + social
├── Network + registry + Windows events
└── AI usage metadata/content controls

Experience
├── Preset and custom dashboards
├── Employee and computer profiles
├── Session Player + Live View + Remote Support
├── Alerts / Incidents / Investigations
├── Exports / Scheduled reports / API / Webhooks
└── Audit / Health / Missing agents / Retention
```

---

## 5. البنية المعمارية المستخلصة والهدف المقترح

### 5.1 بنية Teramind المعلنة

الوثائق تصف ثلاثة مكونات أساسية: Agent وServer وDashboard. الوكيل يستخدم APIs نظام
التشغيل، ومرشحات ملفات/شبكة لبعض القنوات، ويحتفظ ببيانات محلية عند انقطاع الاتصال. الخادم
يستقبل ويحلل ويخزن، واللوحة تدير الإعدادات والتحقيق. النقل يكون مشفرًا، بينما بعض الميزات
مثل الصوت أو فلاتر DLP لها متطلبات منافذ/تعريفات إضافية.

أنماط النشر:

- Cloud مُدار.
- On-Premises على بنية العميل.
- Private Cloud في AWS أو Azure.
- عقد متعددة وتوسيع أفقي في النشر الكبير.

### 5.2 البنية المستهدفة لـBiBoTracking

```text
Windows Agent
  ├─ collectors: app/window, input counts, OS state, browser bridge, screen
  ├─ local policy resolver + local SQLite outbox
  ├─ event normalizer + privacy redaction
  ├─ gRPC/HTTPS batch telemetry
  └─ WebSocket control + WebRTC media/data channels
             │
             ▼
API Gateway / Auth / Tenant Guard / Rate Limits
             │
   ┌─────────┼───────────┬───────────────┐
   ▼         ▼           ▼               ▼
Ingest     Presence    Signaling       Rule Engine
Workers    + Redis     (WS/WebRTC)     + Actions
   │         │           │               │
   ▼         ▼           ▼               ▼
Postgres   Redis       TURN/STUN       Alerts/Jobs
metadata   ephemeral   no DB frames    Audit
   │
   ├─ object storage: screenshots, evidence, exports
   ├─ analytics aggregates: minute/hour/day
   └─ retention + legal hold + deletion jobs
```

قواعد غير قابلة للتفاوض:

- لا تُحفظ إطارات البث الحي في Postgres.
- الحالة اللحظية ephemeral في Redis؛ الدليل التاريخي فقط هو الذي يُخزن.
- كل event يحمل tenant/employee/device/session/source/client UUID ووقت الجهاز والاستلام.
- كل أمر تحكم موقّع، محدود النوع، له TTL، nonce وaudit؛ لا shell عام.
- سياسات الجمع تصل للوكيل بإصدار وhash وeffective time، وتظل قابلة للتدقيق.
- المتصفح يرفع focused tab فقط، ولا يجمع كلمات المرور أو محتوى الحقول السرية.

---

## 6. الأدوار والصلاحيات

### 6.1 الأدوار الموثقة

| الدور | النطاق العام |
|---|---|
| Administrator | إدارة وتشغيل وتقارير وتسجيلات وفق سياسات الوصول |
| Infrastructure Administrator | إعدادات وبنية ووكلاء، دون حق تلقائي في مشاهدة التسجيلات |
| Operational Administrator | تشغيل يومي وتقارير/موظفون ضمن ما تمنحه Access Control |
| Employee | استخدام Agent المكشوف، وقد يُسمح له برؤية بياناته فقط |

Teramind لا يعتمد على role ثابت وحده؛ Access Control يضيف قواعد دقيقة:

```text
Subjects (employees/departments)
    → Permission (View / Play / Configure)
    → Resources (reports, recordings, configuration areas)
    → Targets (employees, departments, computers)
```

### 6.2 النموذج المطلوب لدينا

| صلاحية | مثال |
|---|---|
| `employees.view` | عرض القائمة والملف الأساسي |
| `activity.view` | رؤية نشاط التطبيقات/المواقع |
| `screenshots.view` | رؤية اللقطات فقط |
| `recordings.play` | تشغيل التسجيل التاريخي |
| `live_view.start` | فتح بث حي |
| `remote_support.control` | إرسال mouse/keyboard actions |
| `remote_support.elevated` | أوامر نظام allowlisted بعد step-up auth |
| `policies.configure` | تعديل ملفات المراقبة والقواعد |
| `exports.create` | إنشاء تصدير |
| `audit.view` | مشاهدة سجل الإدارة والتحقيق |
| `sensitive_content.view` | رؤية دليل مصنف حساسًا بعد سبب وصول |

يجب تقييد كل صلاحية أيضًا بـscope: المؤسسة، قسم، موظفون محددون أو أجهزة محددة. مشاهدة
الشاشة ليست نتيجة تلقائية لكون المستخدم Admin.

### 6.3 ضوابط جلسة التحكم

- جهاز مملوك للمؤسسة وسياسة مكتوبة ومعلنة.
- مؤشر مرئي دائم أثناء المشاهدة/التحكم.
- سبب الجلسة، صاحب الطلب، وقت البداية والنهاية، وكل action في audit log.
- step-up authentication للجلسات الحساسة.
- إمكانية حصر التحكم في فريق الدعم لا المدير المباشر.
- لا انتظار قبول لحظي إذا كانت سياسة الشركة المعلنة تسمح بالدعم غير التفاعلي، لكن لا يجوز
  أن يصبح الوكيل مخفيًا أو غير قابل للرؤية والإيقاف وفق السياسة القانونية المحلية.

---

## 7. واجهة الإدارة والملاحة

### 7.1 قدرات الواجهة العامة

- بحث عام وبحث داخل الجداول.
- فلاتر زمنية وموظفين/أقسام/أجهزة ومواقع.
- Light/Dark وكثافة عرض ولغة/اتجاه.
- حفظ فلاتر، pin/exclude، drill-down من الرسم إلى البيانات.
- notifications وissues ومركز تصدير.
- قوائم سياقية للصفوف، تجميع أعمدة، sorting، sum وbatch actions.
- URL deep links تحفظ حالة التحقيق والفلاتر.

### 7.2 Dashboards الجاهزة

| Dashboard | وظيفته |
|---|---|
| Overview / Live Activity Overview | الحالة العامة، المتصلون، التنبيهات والنشاط الآن |
| AI Usage | استخدام أدوات الذكاء الاصطناعي، المحادثات/النماذج/المرفقات وفق السياسة |
| Agentic AI | تتبع CLI/agents والأدوات والملفات المرتبطة بها |
| AI Data Exfiltration | مخاطر رفع ملفات أو نص حساس لأدوات AI |
| All Events | مستعرض موحد لكل الأحداث |
| Applications & Websites | المدة، التركيز، التصنيف والتجميع حسب app/site/category |
| Audit | نشاط المديرين وتغييرات الإعدادات والوصول للأدلة |
| Behavior Alerts | الحوادث، الخطر، الحالة، القاعدة والموظف |
| Camera Usage | فتح الكاميرا والتطبيق والمدة، وليس فيديو webcam افتراضيًا |
| Console Commands | أوامر shell/PowerShell حسب دعم المنصة والسياسة |
| Emails | بيانات البريد والمرفقات والمصادر/الوجهات حسب القناة |
| File Events | عمليات الملفات والمسارات والأجهزة/السحابة |
| Geolocation | آخر/مسار الموقع والخريطة والمكتب/خارجه |
| Instant Messages | الرسائل/المرفقات المدعومة والتحقيق في المحادثة |
| Keystrokes | نشاط الإدخال والتطبيق/الموقع؛ **لدينا counts فقط** |
| Live View | Live Users، Live Player، Snapshots، Live Montage |
| Login Sessions | الجلسات والمصدر والجهاز والتوقيت |
| OCR | نتائج النص الظاهر على الشاشة وربطها بالفيديو |
| Printing | الطابعة، المستند، الصفحات ونسخة الدليل إذا سمحت السياسة |
| Productivity | KPIs، trends، comparison، apps/sites، employee highlights |
| Searches | استعلامات البحث المدعومة |
| Social Media | نشاط الشبكات المدعوم |
| Time Cards | يوم/أسبوع، الحضور، الوقت والمهام |
| Web File Events | upload/download، URL، اسم/حجم الملف والعميل |

### 7.3 Custom Dashboards

- إنشاء ونسخ وتثبيت وجعل Dashboard هي الصفحة الرئيسية.
- Tabs مستقلة.
- Chart widgets وGrid widgets وspecial widgets.
- built-in widgets: المتصلون، اللقطات، montage، إصدارات الوكلاء، الأجهزة offline، insights.
- resize/move/expand/clone/remove.
- فلاتر على مستوى الصفحة أو widget.
- drill-down سريع من جزء الرسم.
- تصدير CSV/PDF وتسليم مجدول.
- توليد widget بالذكاء الاصطناعي ميزة حديثة، ويجب ألا تسبق قاموس metrics ثابتًا ومختبرًا.

---

## 8. الموظفون والأجهزة والجلسات

### 8.1 قائمة الموظفين

- الاسم، البريد/اسم الدخول، القسم، الوظيفة، الحالة، آخر نشاط، الترخيص.
- إنشاء فردي، import، bulk edit، archive/restore.
- تشغيل/إيقاف المراقبة، lock/unlock وفق الصلاحية، تعيين profiles.
- فلاتر وبحث وتحديد متعدد.

### 8.2 بيانات ملف الموظف

- Personal: الاسم وبيانات التواصل والهوية التنظيمية.
- Account: اسم الدخول، الدور، السماح بدخول Dashboard، الحالة، المهمة الافتراضية.
- Attributes: حقول directory/مخصصة.
- Monitoring: monitoring/productivity profiles وcustom override.
- Department، position/job role، wage/rate، location، tasks.

### 8.3 تقارير الموظف

- Activity.
- Session Log.
- Time Worked.
- Alerts/Incidents.
- Snapshots/Playback.
- Browser/URLs.
- Emails.
- File Transfers.
- Printing.
- Input activity.

كل صف نشاط يجب أن يفتح التوقيت نفسه في Session Player، لا صفحة عامة منفصلة.

### 8.4 صفحة الجهاز

- hostname/label، OS/build/architecture، agent type/version، IP، آخر اتصال.
- الموظفون/الجلسات الحالية والسابقة.
- monitoring enabled، profile resolved، update state، permissions/health.
- activity log، alert، snapshot، montage، IP history، file/email data.
- archive/restore وremote update.
- Missing Users/Computers عندما يتجاوز الغياب threshold مختلفًا لكل نوع.

### 8.5 العلاقات الصحيحة

```text
Employee 1 ──* LoginSession *──1 Device
Employee 1 ──* MonitoringAssignment *──1 Profile
Device   1 ──* MonitoringAssignment *──1 Profile
Session  1 ──* ActivitySegment / InputBucket / BrowserVisit / OSState
```

هذا يسمح بموظف على جهازين، جهاز مشترك، RDP، وتحليلات per-user أو per-device دون خلط.

---

## 9. Session Player والعرض الحي

### 9.1 ما يقدمه Teramind

- Live وHistory.
- خط زمني موحد للشاشة والأنشطة والتنبيهات والعلامات.
- multi-monitor وvirtual desktops.
- zoom وسرعة تشغيل والانتقال لتوقيت محدد.
- قائمة events/alerts/tags بجوار التسجيل.
- remote control وfreeze input وCtrl+Alt+Del حسب النظام والصلاحية.
- صوت إذا كانت القناة مفعلة.
- export لفترة محددة مع speed/FPS/mute، وإنشاء غير متزامن.
- استرجاع التسجيل المؤرشف.
- Standard Video، وعلى macOS Reconstructed Video بحدود واضحة.

### 9.2 Standard مقابل Reconstructed

Reconstructed Video يعيد بناء واجهة رمادية تقريبية من بيانات Accessibility بدل صور الشاشة.
ميزته تقليل الحجم وزيادة الخصوصية، لكن لا يعرض الصور/PDF بدقة، وقد لا يعمل جيدًا مع Electron،
ولا يصلح لكل snapshot/export. هو مسار مستقل، وليس بديلًا سحريًا لتسجيل الشاشة.

### 9.3 مشكلة BiBoTracking الحالية

الأوديت المحلي قاس الآتي:

- “Live capture” العادي إطار كل 20 ثانية تقريبًا، وأول إطار قد يصل إلى 19 ثانية.
- remote-assist يرفع نحو 1.1 FPS فقط.
- الوكيل ينتظر polling/heartbeat لمعرفة الطلب.
- الإطار الحي يمر عبر `bytea` في Postgres، مولدًا TOAST/WAL بلا قيمة تاريخية.
- التحكم لا يغطي scroll، modifier combinations، mouse move semantics وacknowledgement كاملًا.

هذه أسباب البطء والثقل التي ظهرت في تجربة المستخدم؛ ليست مشكلة CSS وحدها.

### 9.4 التصميم المستهدف

| المسار | التقنية | الاحتفاظ |
|---|---|---|
| Presence/state | WebSocket + Redis TTL | ملخص تاريخي فقط |
| Live video | WebRTC VP8/H.264/AV1 حسب التوافق | لا حفظ افتراضي |
| Remote input | WebRTC DataChannel، sequence + ACK | audit metadata |
| Signaling | Authenticated WebSocket | logs قصيرة |
| TURN | coturn/managed TURN | network metrics فقط |
| Historical evidence | chunked media/object storage | retention policy |
| Snapshots | object storage + signed URLs | حسب profile |

### 9.5 معايير القبول

- أول frame أقل من 3 ثوانٍ p95.
- latency أقل من 500ms p95 على اتصال جيد، وأقل من ثانية على اتصال متوسط.
- 8–15 FPS للوضع العادي، 3–5 FPS عند ضعف الشبكة، adjustable quality.
- لا يزيد Agent CPU المتوسط عن 5% أثناء المراقبة و12% أثناء live على جهاز مرجعي.
- لا يزيد live memory على 150MB على الجهاز المرجعي.
- reconnect خلال 5 ثوانٍ مع ICE restart.
- دعم mouse move/click/double/right/scroll وkeyboard down/up/modifiers وclipboard **disabled افتراضيًا**.
- multi-monitor switch وscaling ودقة pointer صحيحة مع DPI.
- كل command له ACK/error ويظهر في audit.

---

## 10. Monitoring Profiles: كل قنوات الجمع

الـprofile في Teramind يربط إعدادات بأفراد وأجهزة وأقسام وDirectory groups. يوجد default،
clone/archive، custom override لكل موظف، وجدول عام أو جدول مستقل لمعظم القنوات.

| القناة | البيانات/الإعدادات المعلنة | قرارنا |
|---|---|---|
| Screen Recording | schedule، FPS 1–4، color/gray، scaling، locked sessions، event-only، async upload، retention، app/site allow/deny، blackout | نبنيها بعد object storage وWebRTC؛ blackout policy أولًا |
| Reconstructed Video | إعادة بناء macOS من Accessibility | لاحقًا، macOS فقط، بحث مستقل |
| Applications | app، window title، duration، focused/idle، console commands، allow/deny | أساسي؛ commands metadata وبصلاحية منفصلة |
| Websites | URL/title/browser/private mode policy، active/idle/focused، allow/deny، URL/IP/domain/content filters | أساسي؛ extension + native bridge، private mode disabled افتراضيًا |
| Social Media | posts/comments/edits في المصادر المدعومة | P3، يتغير بسرعة وتكلفته عالية |
| Emails | metadata/content/attachments/meetings/ignore lists | metadata أولًا؛ content يحتاج DLP/legal decision |
| Online Meetings | app/call metadata والصوت عند الدعم | metadata P2، audio قرار مستقل |
| Instant Messaging | app/contact/direction/body/attachments | metadata أولًا؛ المحتوى عالي الحساسية |
| Keystrokes | counts/content/special keys/clipboard/password switches في Teramind | **counts فقط؛ لا أحرف ولا passwords ولا secure fields** |
| Files | access/copy/write/rename/move/delete/upload/download، path/drive/share/cloud/RDP | P1 metadata؛ لا نسخ محتوى الملف افتراضيًا |
| Printing | printer/doc/pages/limits/document evidence | P2 metadata؛ document copy optional/high risk |
| Geolocation | coordinates/dwell/location mapping | P3 وأجهزة الشركة فقط، schedule واضح |
| Audio | input/output/app/bitrate | Go/no-go مستقل؛ off افتراضيًا ومؤشر ظاهر |
| OCR | languages، start date، indexing captured screens | P3؛ server-side jobs، redact ثم index |
| Camera Usage | فتح الكاميرا والتطبيق والوقت | metadata فقط؛ لا webcam recording |
| Offline Recording | local buffer by time/size، retry after reconnect | أساسي؛ encrypted capped outbox |
| OS State | lock/sleep/screensaver | P0 لأنه شرط لحساب الوقت الصحيح |
| Registry | Windows registry events | P3 security channel فقط |
| Network | process/local/remote IP/port/bytes، SSL options | metadata P2؛ لا TLS MITM افتراضيًا |
| AI Usage | tool/model/conversation/file metadata/content | metadata/risk P2؛ prompt content قرار DLP مستقل |

### 10.1 الجدولة

كل channel policy يجب أن يحتوي على:

```text
timezone
days_of_week
time_ranges[]
effective_from / effective_to
pause_on_holiday
scope include/exclude
priority
version
```

الـmonitoring schedule ليس هو work schedule. الأول يقول “متى نجمع”، والثاني يقول “متى
كان مفترضًا أن يعمل الموظف”. يجب أن يظلا كيانين منفصلين.

### 10.2 حل التعارض

الترتيب المقترح من الأعلى للأدنى:

1. employee explicit override.
2. device explicit override.
3. job role.
4. department.
5. company default.

وعند تساوي المستوى: deny/privacy restriction يفوز، ثم أعلى priority، ثم أحدث version.
الـAPI يجب أن يعيد `resolved_profile` مع سبب كل قيمة حتى لا تصبح الإعدادات صندوقًا أسود.

---

## 11. قياسات النشاط والإنتاجية

### 11.1 التعريفات الموثقة

- النافذة/التبويب الأمامي المركّز فقط يحتسب focused.
- Active يعني وجود keyboard/mouse activity خلال العتبة.
- Idle يبدأ بعد تجاوز idle threshold؛ إذا كانت العتبة 10 دقائق والتوقف 15، فالخمول 5.
- Work Time هو active + idle ضمن جلسة العمل، مع اختلافات حسب نوع agent/task mode.
- Session Time قد يشمل وقت القفل حسب السياق.
- Productive/Unproductive/Unclassified ينتج من التصنيف، وكل منها ينقسم active/idle.
- Activity % يحسب في buckets قصيرة؛ الوثائق تشير إلى 5 دقائق.
- المتوسطات تجمع metric في أيام العمل ذات بيانات وتقسم على عدد الأيام التي بها work > 0؛
  الأيام الصفرية لا تدخل المتوسط.
- المنطقة الزمنية المحلية حاسمة لحدود اليوم.
- جهازان متزامنان قد يجعلان aggregate session time يتجاوز 24 ساعة؛ يجب عرض طريقة التجميع.

### 11.2 النموذج الذي يجب بناؤه

```text
Wall-clock state: offline | sleeping | locked | idle | active
Focus dimension: app/window/browser tab
Classification: productive | unproductive | unclassified | custom category
Location: office | remote | unknown
Schedule: scheduled | off-schedule | holiday
```

لا يجوز اشتقاق الخمول من “عدم وجود row”. يجب تسجيل transitions صريحة، وإغلاق segment
عند app switch أو lock/sleep/disconnect أو policy stop.

### 11.3 المعادلات المقترحة

```text
active_time = Σ segments(state=active)
idle_time = Σ segments(state=idle)
work_time = active_time + allowed_idle_time
focused_time(x) = Σ segments(foreground=x AND state in active|idle)
productive_time = Σ focused segments(class=productive)
activity_pct(bucket) = normalized(keys + clicks + scroll/mouse activity, bucket duration)
utilization_pct = work_time / scheduled_time
focus_pct = top-work-context uninterrupted active time / active_time
```

معامل activity يجب أن يكون configurable ومعلنًا؛ لا نستخدمه كـ“تقييم موظف” وحده. عدد
ضغطات المفاتيح ليس جودة عمل، والعمل في قراءة/اجتماع قد يكون منتجًا مع إدخال قليل.

### 11.4 المكتب/خارج المكتب

Teramind يستخدم geolocation وnetwork access points مع أولوية لهوية الشبكة. لدينا يقترح:

1. managed network BSSID/MAC fingerprint.
2. SSID مع تحذير spoofing.
3. CIDR/VPN egress.
4. GPS إذا كان جهاز شركة والسياسة تسمح.
5. unknown عند التضارب بدل نتيجة زائفة.

---

## 12. Productivity Profiles والتصنيف

- profile tree: parent/child inheritance.
- default profile.
- assignment لموظف/قسم.
- نفس الموقع يمكن أن يكون productive للمبيعات وunproductive لفريق آخر.
- قواعد exact app/domain، regex، وcategory.
- custom categories وألوان.
- شاشة Unclassified Apps/Domains للعمل المتراكم.
- bulk classification.
- retroactive reclassification لفترة محدودة مع background job وإصدار classification.
- TeraCat الحديث يصنف معنى URL/app بدل الاعتماد فقط على قائمة domains ثابتة.

التصميم المقترح:

```text
classification_rule(id, profile_id, match_type, pattern, category_id, priority)
activity_classification(event_id, rule_id, category_id, ruleset_version, classified_at)
```

نحتفظ بـruleset_version حتى يمكن إعادة الحساب دون فقد تفسير التقرير القديم. التصنيف الآلي
يبدأ suggestion مع confidence؛ لا يتحول إلى rule دائم دون مراجعة Admin.

---

## 13. Behavior Policies ومحرك القواعد

### 13.1 بنية القاعدة

```text
Policy
  ├─ scope include/exclude
  ├─ Rule type
  ├─ schedule/timezone
  ├─ condition groups
  ├─ risk severity 0..100
  ├─ tags
  ├─ actions
  └─ thresholds hourly/daily/monthly
```

العمليات المنطقية الموثقة تشمل contains، equals، regex، glob/globstar، shared-list match،
AND بين criteria، OR بين values/blocks/types، وAND NOT/OR NOT للمحتوى.

### 13.2 Activity Rules

| المصدر | أمثلة criteria |
|---|---|
| Webpages | URL، title، browser، query argument، private mode، active/idle/focused، daily totals |
| Applications | name، caption، command/args، elevated، time metrics، OS version |
| OCR | screen text + application |
| Input | count/special key/app/URL؛ **نستبعد typed text** |
| Files | operation، program، path/source، drive، share، cloud، RDP، upload/download name/URL/size/client |
| Emails | subject، from/to/cc، direction، client، size، attachment metadata؛ body حساس |
| IM | app/contact/direction وmetadata؛ body حساس |
| Browser plugins | browser، plugin، permissions |
| Printing | document، printer، pages |
| Network | app، host، port، bytes، local IP |
| Registry | key/name/value/program |
| Camera | camera/application/use event |
| Windows Event Log | event ID/source |

### 13.3 Content Sharing / DLP Rules

- Data content: text patterns وpredefined sensitive types.
- Clipboard origin/destination.
- File origin/properties.
- PII/financial/health/source-code-like classifiers.
- Email/IM/files/uploads/AI tools.
- strictness/frequency thresholds.

في منتجنا نبدأ بـmetadata وhash/classification محلي، ولا نرفع payload الكامل إلا لو policy
صريحة ومرّت privacy review. API keys/passwords تُحجب ولا تتحول إلى مادة تقرير.

### 13.4 Schedule Rules

- daily/scheduled work.
- early/late start/end.
- absence أو work on day off.
- login خارج الساعات أو من IP غير متوقع.
- idle threshold.

### 13.5 الإجراءات

| الإجراء المعلن | قرار التنفيذ |
|---|---|
| Notify | نعم: email/in-app/webhook مع dedupe |
| Warn | نعم: رسالة واضحة للموظف وفق السياسة |
| Block | لاحقًا لقنوات محددة وبعد driver/security review |
| Lock User | لا يكون افتراضيًا؛ إجراء شديد مع approval وbreak-glass |
| Redirect | للويب فقط وبقواعد واضحة، P3 |
| Switch Task | عند بناء task/time tracking |
| Record incident | نعم، pre/post evidence buffer محدود ومعلن |
| Command | **لا shell عام**؛ فقط أوامر signed allowlist إن تم اعتمادها |

### 13.6 دورة الحادث

```text
detected → open → acknowledged → investigating → resolved / dismissed
```

كل incident يحتفظ بالقاعدة وإصدارها، الأدلة، severity، من شاهد/صدّر/عدل، التعليقات، وسبب
الإغلاق. تغيير القاعدة لاحقًا لا يغير تفسير الحادث القديم.

---

## 14. Shared Lists

الأنواع الأساسية:

- Text values.
- Regular expressions.
- Networks/CIDR.

الوظائف: إنشاء، تعديل، clone، حذف، CSV import، استخدام من قواعد متعددة. الوثائق تذكر
حدودًا للسحابة تصل إلى عشرات الآلاف من العناصر. لدينا يجب أن نضيف validation، preview
للتطابق، versioning، usage references، واختبار regex ضد ReDoS قبل الحفظ.

---

## 15. Settings والتكاملات

### 15.1 إعدادات النظام

| القسم | المحتوى |
|---|---|
| SMTP | خادم البريد واختبار الإرسال |
| Alerts | license/digest/thresholds/templates/recipients |
| Access Tokens | إنشاء token ونطاق صلاحياته وانتهاؤه |
| Authentication | password، 2FA، SSO، LDAP، confirmation، dashboard IP allowlist |
| Active Directory | LDAP sync، mappings، log ومعالجة duplicates |
| OCR | حالة الخدمة واللغات والتنبيهات |
| Agents | defaults، task، recording management، update/removal protection |
| Security | hostname/SSL/session duration/export/diagnostics |
| Locale | timezone/language/date/currency |
| Server | ports/nodes/security/restart-required settings |
| Login Screen | branding ونص الدخول |

### 15.2 Entra/Directory

- sync اتجاه واحد.
- تشغيل مجدول يوميًا أو manual.
- include/exclude filters مرتبة؛ first match مهم.
- attribute mapping وnormalize/regex/template.
- create/update/disable behavior للمستخدمين.
- تعيين department/position من attributes.

المطلوب لدينا: SCIM 2.0 أولًا إن أمكن، ثم Entra/Google Workspace/LDAP connectors، مع dry
run وdiff قبل التطبيق وimmutable external ID لمنع duplicates.

### 15.3 API/Exports/BI

- API tokens وصلاحيات.
- export للبيانات والتسجيلات والتقارير.
- scheduled CSV/PDF delivery.
- async video/report jobs مع status/download.
- BI filters/widgets.
- webhooks/SIEM مطلوبان لمنتج مؤسسي حتى لو لم يكونا مركز الواجهة الحالية.

كل export يجب أن يحمل watermark اختياريًا، سبب التصدير، expiry، audit، ويفشل إذا سحبت
صلاحية المصدر قبل اكتماله.

---

## 16. دعم الأنظمة والوكلاء

### 16.1 الأنظمة المعلنة

- Windows 10+ وWindows Server 2016+ هو المسار الأغنى.
- macOS 12.7.6+ مع permissions وقيود عدة.
- Linux حديث (Ubuntu/Debian/RHEL حسب الإصدار الموثق) مع مصفوفة قدرات أضيق.
- بيئات RDP/Citrix/VMware/terminal servers مدعومة وفق السيناريو والإصدار.

المواصفات المنشورة تقريبية: 30–50MB RAM، 1–3% CPU، و10–20KB/s upstream في النشاط
العادي، لكن الشاشة والصوت يغيران الاستهلاك بقوة.

### 16.2 مصفوفة مختصرة

| القناة | Windows | macOS | Linux |
|---|---|---|---|
| Apps | كامل | غالبًا، دون console commands | متاح |
| Websites | كامل | غالبًا مع قيود private/content/IP | غالبًا مع قيود browser/package |
| AI Usage | مدعوم | مدعوم جزئيًا حسب الأداة | مدعوم حسب الأداة |
| Email | كامل نسبيًا | web/new Outlook فقط | webmail محدود |
| Social/Meetings/IM | كامل نسبيًا | غير مدعوم كقناة غنية | غير مدعوم كقناة غنية |
| Input | كامل في Teramind | قيود special/clipboard | واسع مع قيود password fields |
| Files | كامل | Users/external/SMB وبعض cloud | واسع مع قيود upload/download settings |
| Screen | كامل | قيود خيارات + reconstructed | جزئي ولا remote control |
| Audio | مدعوم | غير مدعوم | غير مدعوم |
| OCR | مدعوم | مدعوم | غير مدعوم |
| Remote control | مدعوم | مدعوم وفق permissions | غير مدعوم |
| OS state/offline | واسع | واسع مع قيود | محدود |

### 16.3 Agent modes

Teramind يعلن Revealed وStandard وStealth. **BiBoTracking لا يبني Stealth** ولا يحاول
إخفاء البرنامج أو جعله غير قابل للاكتشاف. يمكن تشغيله كخدمة Windows ليبدأ مع الجهاز
ويقاوم الإغلاق العرضي بصلاحيات نظام وسياسة IT، لكن مع اسم واضح، شاشة حالة، وثائق إزالة
للإدارة، وسجل تدقيق.

### 16.4 التحديث

- signed installer.
- update manifest موقّع.
- channels: stable/canary/pinned.
- staged rollout ونسبة أجهزة.
- health/rollback.
- agent reports desired/current version.
- لا يحتاج الموظف تنزيل البرنامج يدويًا لكل تحديث بعد تركيب updater موثوق مرة واحدة.

---

## 17. الأمان والاحتفاظ والامتثال

الوثائق تعلن تشفيرًا أثناء النقل وفي التخزين، least privilege، logging، Support PIN،
وشهادات/ضوابط امتثال متعددة. مدد الاحتفاظ المعلنة للسحابة تختلف حسب نوع البيانات والباقـة؛
تذكر الوثائق الحديثة تقريبًا 6 أشهر للوسائط و18 شهرًا للtelemetry مع خيارات تمديد.

### 17.1 المطلوب لدينا

- TLS 1.2+ وmTLS اختياري للوكلاء المؤسسيين.
- envelope encryption وKMS للوسائط.
- tenant isolation في كل query + اختبارات cross-tenant.
- short-lived signed media URLs.
- encryption للـSQLite outbox وDPAPI على Windows.
- secrets في secret manager، لا `.env` في image.
- audit append-only أو tamper-evident.
- retention per channel + legal hold + deletion certificate.
- GDPR delete/export by employee.
- region/data residency strategy.
- support access مؤقت، بسبب، MFA، وموافقة مسؤول العميل.
- backup + restore drill، لا مجرد وجود backup.

### 17.2 حدود الخصوصية الثابتة

- لا التقاط محتوى ضغطات المفاتيح.
- لا passwords أو secure-field input.
- لا stealth agent.
- لا arbitrary remote shell.
- لا webcam video.
- لا audio افتراضيًا.
- لا TLS interception عام.
- لا استخدام activity percentage وحده للعقوبة أو القرارات الآلية.
- كل قناة حساسة لها disclosure، schedule، scope، retention وصلاحية مستقلة.

### 17.3 الخبايا التشغيلية التي كشفتها مقالات الدعم

قائمة الـfeatures وحدها تعطي صورة مضللة؛ عدد كبير من مقالات القاعدة مخصص لفشل الوكيل
أو نقص البيانات. هذه الحالات يجب أن تصبح diagnostics داخل المنتج، لا تذاكر دعم يدوية:

| الحالة | السبب المحتمل | ما يجب أن يفعله منتجنا |
|---|---|---|
| موظف/device اختفى | Agent توقف/أزيل، جهاز offline، license أو identity mismatch | Missing Agents dashboard + threshold + alert + آخر IP/version/error |
| الجهاز online ولا توجد أحداث | monitoring/profile schedule أو collector permission أو queue stuck | health payload لكل collector وresolved policy وإحصاء queue |
| URLs غير ظاهرة | extension غائبة، browser unsupported، proxy/cert، service worker توقف | extension health/version/last checkpoint وcoverage % ورسالة إصلاح |
| تسجيل الشاشة مفقود | OS permission، locked session، unsupported display/session | permission matrix وtest capture محلي وسبب صريح لكل gap |
| Agent لا يتصل | firewall/proxy/DNS/ports/certificate | connectivity self-test بأسماء الوجهات ونتيجة TLS لا مجرد “offline” |
| صفحات لا تفتح | web proxy أو IPv6 أو certificate pinning | لا نفعل interception افتراضيًا؛ bypass/diagnostic واضح |
| الصوت ناقص | source/app/bitrate/permission/القناة غير مدعومة | capability negotiation وpreview/test input |
| duplicate users | directory domain/name mapping تغير أو external ID غير ثابت | immutable external ID + sync dry-run + merge workflow |
| تخزين امتلأ | recording retention/FPS/color/audio/OCR | capacity forecast وwatermark alerts وauto-retention jobs |
| update فشل | agent protected، AV/EDR، reboot، package/signature | staged rollout + machine-readable failure + rollback |
| macOS feature ناقصة | TCC/Accessibility/Screen Recording أو platform limitation | permissions page مرتبطة بالfeature ولا تعرض Supported زائفًا |
| وقت خاطئ | agent/server clock، timezone، DST | server receipt + device monotonic/session clock + skew alert |

### 17.4 طبقة التشغيل التجاري والإداري

قاعدة المعرفة تغطي أيضًا الترخيص والفوترة والحساب، وهي ليست قلب المراقبة لكنها جزء من
المنتج الكامل:

- seat allocation حسب الموظفين المراقبين، مع licensed/unlicensed state.
- إعادة استخدام المقعد عند archive/disable وفق قواعد واضحة.
- تنبيه قبل تجاوز الرخصة وعدم إسقاط البيانات بصمت.
- My Account للفواتير والاشتراك والتجديد والـlicense key.
- Cloud region/data residency واختيار نموذج النشر.
- support workflow وSLA وSupport PIN ووصول مؤقت.
- software lifecycle وإصدارات مدعومة وسياسة patching.

بالنسبة لنسختنا الذاتية الاستضافة يمكن تأجيل billing، لكن license/plan capabilities يجب ألا
تنتشر كـ`if` داخل الواجهة؛ تستخدم entitlement service واحدة وfeature flags مدققة.

### 17.5 Insights وactivity-falsification

Insights في الوثائق الحالية **Beta**، ويجمع feed لحوادث تحليلية منها أنماط activity
falsification مثل key pressing أو mouse movement غير الطبيعي. لا ينبغي استخدام نتيجة كهذه
لعقوبة آلية. إذا بُنيت لدينا، تكون signal تفسيرية مع confidence، evidence window، ومراجعة
بشرية، مع اختبار false positives لأدوات accessibility والماوسات الماكرو وبرامج الاختبار.

---

## 18. مقارنة المشروع الحالي

### 18.1 الموجود فعليًا

| المجال | الحالة |
|---|---|
| Auth/business onboarding | موجود |
| Employees roster/details | موجود جزئيًا |
| Departments/job roles/assignments | موجود |
| Device inventory/presence/archive/monitoring toggle | موجود |
| Apps/window activity | موجود، يحتاج normalized timeline |
| Aggregate input counts | موجود؛ وهو الحد الصحيح للخصوصية |
| Browser extension/visits | موجود جزئيًا؛ يحتاج URL/focus/idle reliability وdeployment |
| Screenshots/gallery/playback | موجود جزئيًا |
| OS states | قيد التطوير في شجرة العمل الحالية |
| Monitoring profiles | core موجود لأربع قنوات؛ الجدولة/الوراثة/معظم القنوات ناقصة |
| Live capture | موجود لكنه polling وبطيء |
| Remote assist | موجود أوليًا، ناقص media/input protocol قوي |
| Arabic/RTL and multiple locales | موجود |
| Railway deployment | موجود للويب/backend، وليس بديلًا لخدمات media/object storage |

### 18.2 فجوات الأساس

| الفجوة | الأثر | الأولوية |
|---|---|---|
| لا timeline موحد active/idle/locked/sleep/offline | أرقام الوقت والخمول غير موثوقة | P0 |
| live frames بطيئة وتستخدم DB | تجربة ثقيلة وتكلفة/WAL | P0 |
| لا ingest backpressure/rate controls كاملة | خطر إسقاط/إغراق | P0 |
| rate limiting كان قابلًا لتزوير XFF | auth abuse؛ إصلاح موجود قيد العمل | P0 |
| browser events ناقصة أو تعتمد على extension غير موزعة | URLs/focused time غير كامل | P0 |
| لا RBAC/Access Control دقيق للتسجيل والتحكم | خطر خصوصية وأمان | P0 |
| لا object storage/retention jobs مكتملة | نمو DB وصعوبة حذف/أرشفة | P0 |
| لا productivity profiles/classifier | لا productive/unproductive موثوق | P1 |
| لا rule/incident engine | لا سياسات لحظية أو تحقيق | P1 |
| لا custom/preset dashboards كاملة | المنتج يبدو بيانات خام | P1 |
| لا signed agent auto-update production flow | كل تحديث يدوي وخطر supply chain | P1 |

### 18.3 مصفوفة التكافؤ

| مجموعة القدرات | Have | Partial | Missing | Excluded |
|---|:---:|:---:|:---:|:---:|
| Employee/device inventory | ✓ |  |  |  |
| App/window tracking |  | ✓ |  |  |
| Browser URL/tab/focus |  | ✓ |  |  |
| Input volume | ✓ |  |  | typed content |
| OS state/time engine |  | ✓ |  |  |
| Screenshots/history |  | ✓ |  |  |
| Live/remote control |  | ✓ |  | stealth control |
| Monitoring profiles |  | ✓ |  |  |
| Productivity profiles |  |  | ✓ |  |
| Dashboards/widget builder |  |  | ✓ | copied UI |
| Rules/alerts/incidents |  |  | ✓ | shell action |
| File/email/network/print |  |  | ✓ | payload by default |
| OCR/AI usage/geolocation |  |  | ✓ | webcam recording |
| Access control/audit |  | ✓ |  |  |
| Exports/API/webhooks |  | ✓ |  |  |
| Directory/SSO/SCIM |  |  | ✓ |  |
| Retention/legal hold |  | ✓ |  |  |
| Signed auto-update |  | ✓ |  |  |

---

## 19. صفحة الموظف المستهدفة

### 19.1 Header ثابت وخفيف

- avatar/name/email/department/role.
- online/active/idle/locked/offline + “منذ”.
- current app + current window/domain.
- device/session selector.
- Live View وRemote Support كأزرار permission-aware.
- date/timezone selector محفوظ في URL.

### 19.2 KPI row

- Work time.
- Active time.
- Idle time.
- Productive time وProductivity %.
- Activity % مع tooltip للمعادلة.
- First seen / last seen.
- schedule variance.

### 19.3 Timeline موحد

كل segment يعرض اللون حسب app/category والحالة. Overlay اختياري للinput intensity،
screenshots، alerts، lock/sleep، URLs، ومكان العمل. النقر يفتح side panel أو player على
نفس التوقيت. لا ننشئ timeline منفصلًا لكل tab ثم تختلف المجاميع.

### 19.4 التبويبات

1. Overview.
2. Timeline.
3. Apps & Windows.
4. Websites & URLs.
5. Input Activity.
6. Screenshots / Playback.
7. Sessions & OS State.
8. Alerts / Incidents.
9. Files / Email / Print عند تفعيلها.
10. Audit / Access history للمخولين فقط.

### 19.5 علاج مشاكل UI الحالية

- max content width مرن، مع grid لا يقل عن 280px للبطاقة.
- لا بطاقة live ضخمة فوق KPIs؛ player يفتح في drawer/fullscreen.
- sticky header داخل الصفحة، وليس عناصر fixed تتراكب مع sidebar.
- tabs horizontal scroll على العرض الضيق.
- skeletons بدل فراغ/قفزة layout.
- virtualization للجداول والtimeline.
- الصور thumbnails ثم lazy full image.
- abort requests عند تغيير التاريخ/الموظف.
- object URLs تُلغى عند الاستبدال/unmount.
- RTL عبر logical properties؛ لا نسخ CSS منفصلة.
- اختبار 360/768/1024/1440/1920 وzoom 125%/150%.

---

## 20. تتبع URLs بدون الاعتماد على إدخال الموظف للرابط

لا توجد طريقة موثوقة وعامة للحصول على URL الكامل من كل متصفح عبر active-window title فقط.
المسار الصحيح:

1. Chrome/Edge extension مُدارة عبر enterprise policy.
2. extension تراقب `tabs.onActivated/onUpdated/windows.onFocusChanged`.
3. ترسل checkpoint كل 30–60 ثانية وعند switch/close/suspend.
4. outbox في `chrome.storage.local` ثم loopback Native Messaging/HTTPS إلى Agent.
5. Agent يربط tab focus بحالة النظام؛ idle time لا يضاف إلى focused duration.
6. يرفع start/end/domain/full URL/title/browser/profile/incognito flag حسب السياسة.
7. full URL قابل للتقليل إلى origin/path أو domain-only؛ query/fragment محجوبان افتراضيًا.
8. incognito خارج النطاق افتراضيًا.

Fallback بدون extension يعطي app/title/domain أحيانًا عبر Accessibility/UI Automation، لكنه
هش ولا يكفي لبناء تقرير دقيق. اعتراض TLS/proxy ليس الحل الافتراضي لأنه يسبب مشاكل شهادات
وcertificate pinning ويرفع المخاطر القانونية والأمنية.

معيار الصحة:

```text
Σ focused browser tab durations <= browser foreground duration <= active+idle session time
```

ونسبة الأحداث غير المنسوبة يجب أن تظهر metric في System Health، لا أن تختفي.

---

## 21. نموذج البيانات المقترح

### 21.1 غلاف الحدث

```json
{
  "schema_version": 1,
  "event_id": "uuid",
  "tenant_id": "uuid",
  "employee_id": "uuid|null",
  "device_id": "uuid",
  "session_id": "uuid",
  "event_type": "app.focus",
  "occurred_at": "RFC3339Nano",
  "ended_at": "RFC3339Nano|null",
  "received_at": "server time",
  "timezone_offset_min": 120,
  "policy_version": "uuid",
  "source": "agent|extension|server",
  "client_uuid": "uuid",
  "payload": {}
}
```

### 21.2 الجداول الأساسية

- `employees`, `devices`, `login_sessions`.
- `monitoring_profiles`, `monitoring_profile_versions`, `assignments`, `channel_schedules`.
- `productivity_profiles`, `categories`, `classification_rules`, `event_classifications`.
- `activity_segments`, `browser_visits`, `input_buckets`, `os_state_segments`.
- `media_objects`, `screenshots`, `recording_chunks`.
- `policies`, `rules`, `rule_versions`, `shared_lists`, `shared_list_versions`.
- `incidents`, `incident_evidence`, `incident_actions`, `incident_comments`.
- `presence_current` في Redis و`presence_history` المختصر في Postgres.
- `audit_events`, `export_jobs`, `retention_jobs`, `agent_health`.
- aggregates: `employee_minute`, `employee_hour`, `employee_day`, `app_day`, `domain_day`.

### 21.3 فهارس وقيود

- unique `(tenant_id, client_uuid)` لكل stream.
- indexes على `(tenant_id, employee_id, occurred_at)` وdevice/session equivalents.
- partitioning شهري للأحداث الكبيرة.
- range constraints تمنع negative/overlapping durations حيث يمكن.
- media binary خارج Postgres.
- RLS أو tenant guard واختبارات إلزامية لكل store method.

---

## 22. API المطلوب

```text
/api/v1/employees
/api/v1/employees/{id}/overview
/api/v1/employees/{id}/timeline
/api/v1/employees/{id}/applications
/api/v1/employees/{id}/websites
/api/v1/employees/{id}/input
/api/v1/employees/{id}/sessions
/api/v1/employees/{id}/screenshots
/api/v1/employees/{id}/incidents

/api/v1/devices
/api/v1/devices/{id}/health
/api/v1/devices/{id}/desired-policy
/api/v1/devices/{id}/updates

/api/v1/monitoring-profiles
/api/v1/productivity-profiles
/api/v1/policies
/api/v1/rules
/api/v1/shared-lists
/api/v1/access-control

/api/v1/live/sessions
/api/v1/live/sessions/{id}/signal
/api/v1/remote-support/sessions/{id}/actions
/api/v1/exports
/api/v1/audit
/api/v1/system/health
```

كل list endpoint يدعم cursor pagination وserver-side filter/sort. لا ترسل raw events كاملة
للDashboard إذا كان المطلوب aggregate؛ هذا سبب مباشر للبطء.

---

## 23. خطة التنفيذ المرحلية

### Phase 0 — تصحيح الأساس، 2–3 أسابيع

- إكمال OS state segments وnormalization.
- إصلاح proxy trust/rate limits وingest rate/backpressure.
- نقل screenshots/recordings إلى object storage.
- فصل live frames عن Postgres.
- تثبيت تعريف metrics/timezone/DST.
- RBAC أولي لـview screenshots/live/control/export.
- health metrics للagent gaps، queue age، browser coverage.

**الخروج:** أرقام الوقت تجمع بشكل صحيح ±1%، وcross-tenant/security tests خضراء.

### Phase 1 — ملف الموظف والـURL، 3–4 أسابيع

- browser event contract وextension enterprise deployment.
- focused URL duration + idle reconciliation.
- employee overview/timeline/apps/websites/session tabs.
- responsive/RTL/overlay performance pass.
- aggregates per minute/hour/day.

**الخروج:** يمكن للمسؤول معرفة هل الموظف على الجهاز، ماذا فتح الآن، وكل app/tab ومدة التركيز.

### Phase 2 — Live/Remote v2، 4–6 أسابيع

- WebSocket presence/signaling.
- WebRTC stream + TURN.
- DataChannel actions + ACK.
- multi-monitor/DPI/quality/reconnect.
- audit/step-up/session policy.
- Windows 10/11 real-device soak and network shaping tests.

**الخروج:** أول frame <3s وlatency <1s p95؛ لا DB frame churn.

### Phase 3 — Profiles/Productivity، 4 أسابيع

- full monitoring schedule/resolution/versioning.
- productivity tree/categories/unclassified/bulk/retroactive.
- work schedules/holidays/locations.
- productivity KPIs مع explainability.

**الخروج:** كل رقم في Dashboard يمكن تتبعه إلى segments وruleset version.

### Phase 4 — Dashboards/Reports، 4–6 أسابيع

- preset Overview/Productivity/Apps & Websites/Live/Time Cards/Audit.
- custom tabs/widgets/filters/drill-down.
- scheduled exports وreport jobs.
- comparison/baselines بدون تحويلها إلى حكم آلي.

**الخروج:** 90% من الاستخدام اليومي لا يحتاج تصدير يدوي أو SQL.

### Phase 5 — Rules/Incidents، 5–7 أسابيع

- shared lists + safe regex.
- Activity وSchedule rules أولًا.
- notify/warn/record actions.
- incident lifecycle/player links/audit.
- DLP metadata rules بعد ذلك.

**الخروج:** rule latency أقل من 5s للأحداث اللحظية، no duplicate alerts، replay tests حتمية.

### Phase 6 — Enterprise، مستمر

- SSO/SCIM/Entra/LDAP.
- webhooks/SIEM/API governance.
- email/file/print/network channels.
- OCR/AI/geolocation حسب العقود والاحتياج.
- private cloud/on-prem، multi-node، disaster recovery.

---

## 24. استراتيجية الاختبار والأوديت

### 24.1 Unit/Property tests

- state machine: active→idle→lock→sleep→offline→active.
- overlaps/gaps/out-of-order/duplicates/clock skew.
- midnight وDST وtimezone change.
- policy resolution/conflict/version.
- productivity classification precedence.
- rule boolean logic وthreshold/dedupe.
- pointer scaling وkeyboard modifier mapping.

### 24.2 Integration tests

- extension → Agent → outbox → backend → aggregate → UI.
- offline 8 ساعات ثم sync تدريجي بلا duplicate.
- policy update أثناء انقطاع الجهاز.
- live connect/reconnect/TURN fallback.
- access revoked أثناء export/live session.
- retention deletes DB reference + object atomically/idempotently.

### 24.3 Windows matrix

- Windows 10 و11، standard/admin user.
- single/multi monitor، 100/125/150% DPI.
- lock/unlock، sleep/wake، user switch، RDP.
- Chrome/Edge، incognito policy، browser crash.
- elevated foreground app.
- slow/high-latency/lossy/offline network.
- install/update/rollback/uninstall/service restart.
- 8h و24h soak.

### 24.4 Performance gates

| المقياس | الهدف |
|---|---:|
| Normal agent CPU avg | <3–5% |
| Normal RAM | <100MB هدف أولي |
| Live CPU avg | <12% على المرجع |
| Event sync p95 | <10s online |
| Presence freshness | <5s |
| Dashboard overview p95 | <1.5s cached، <3s cold |
| Timeline first render | <2s لـ24 ساعة |
| Live first frame p95 | <3s |
| Remote input p95 | <500ms جيد، <1s متوسط |
| Dropped events | 0 في soak/offline recovery |
| Tenant leakage tests | 0 دائمًا |

### 24.5 UI quality gates

- Playwright visual snapshots LTR/RTL وlight/dark.
- no horizontal page overflow على المقاسات المستهدفة.
- no fixed/sticky overlap.
- keyboard navigation/focus order/dialog trapping.
- WCAG contrast وlabels.
- 10k rows و24h timeline profiling.
- no object URL/timer/subscription leaks بعد 100 employee switches.

---

## 25. قرارات المنتج التي تحتاج موافقة منفصلة

هذه ليست “features عادية” ويجب ألا تدخل خلسة داخل sprint:

1. تسجيل الصوت.
2. محتوى البريد/الرسائل لا metadata فقط.
3. clipboard payload.
4. OCR شامل لكل شاشة.
5. TLS interception/network driver.
6. تعطيل USB/Wi-Fi/Bluetooth أو منع الطباعة.
7. geolocation خارج ساعات العمل.
8. lock/block actions الآلية.
9. التقاط AI prompts/responses كاملة.
10. reconstructed accessibility recording.

لكل واحدة: use case، owner، legal basis، employee disclosure، supported OS، retention،
false-positive cost، incident response، ودليل تعطيل/حذف.

---

## 26. ما لن ننسخه

- اسم/شعار/نصوص/صور/واجهة Teramind.
- stealth/hidden agent.
- password وcredential capture.
- typed-key content.
- shell command مفتوح من Dashboard.
- webcam recording.
- نموذج تقييم يساوي “كثرة الكتابة = أداء أفضل”.
- وعود دعم متساوية لكل نظام بينما الوكيل لا ينفذها.

سننسخ **الفكرة الوظيفية المجردة**: profiles، timelines، productivity classification،
rules، incidents، live support، access control، dashboards، exports وhealth؛ ثم ننفذها
بتصميم وهوية وكود واختبارات خاصة بنا.

---

## 27. المصادر الرسمية الأساسية

- [Teramind Knowledge Base](https://knowledge.teramind.co/en/)
- [Main Interface](https://knowledge.teramind.co/en/articles/11868478-main-interface)
- [Dashboards](https://knowledge.teramind.co/en/articles/11868894-dashboards)
- [Employees](https://knowledge.teramind.co/en/articles/11873119-employees)
- [Computers](https://knowledge.teramind.co/en/articles/11873514-computers)
- [Session Player](https://knowledge.teramind.co/en/articles/11873821-session-player)
- [Monitoring Profiles](https://knowledge.teramind.co/en/articles/11883526-configurations-monitoring-profiles)
- [Productivity Profiles](https://knowledge.teramind.co/en/articles/11883708-configurations-productivity-profiles)
- [Access Control](https://knowledge.teramind.co/en/articles/11883003-configurations-access-control)
- [Behavior Policies](https://knowledge.teramind.co/en/articles/11882979-configurations-behavior-policies)
- [Shared Lists](https://knowledge.teramind.co/en/articles/11882962-configurations-shared-lists)
- [Common Rule Elements](https://knowledge.teramind.co/en/articles/11974860-understanding-common-rule-elements)
- [Schedule Rules](https://knowledge.teramind.co/en/articles/11974875-schedule-rules-what-schedule-violations-can-you-detect-windows)
- [Activity Rules](https://knowledge.teramind.co/en/articles/11974884-activity-rules-what-activities-can-you-detect-windows-mac)
- [Content Sharing Rules](https://knowledge.teramind.co/en/articles/11974984-content-sharing-rules-what-contents-trigger-the-rules)
- [Rule Actions](https://knowledge.teramind.co/en/articles/11975039-defining-rule-actions)
- [Productivity Metrics](https://knowledge.teramind.co/en/articles/11903996-productivity-metrics-faq-how-is-work-time-idle-time-activity-percentage-productive-time-unproductive-time-total-time-determined)
- [Idle Time](https://knowledge.teramind.co/en/articles/12636958-how-can-i-defining-and-analyze-employee-idle-time-in-teramind)
- [Average Metrics](https://knowledge.teramind.co/en/articles/13784396-how-teramind-calculates-averages-avg-active-time-avg-productive-time-etc)
- [Office/Out-of-Office Detection](https://knowledge.teramind.co/en/articles/16306660-how-in-office-out-of-office-detection-works-in-teramind)
- [Agent Architecture](https://knowledge.teramind.co/en/articles/13366708-how-does-teramind-work-architecture)
- [Agent Specifications](https://knowledge.teramind.co/en/articles/11906389-teramind-agent-specifications-and-supported-platforms)
- [Windows/macOS/Linux Feature Matrix](https://knowledge.teramind.co/en/articles/15262363-what-features-are-supported-in-windows-mac-and-linux)
- [Deployment Models](https://knowledge.teramind.co/en/articles/12637131-what-is-the-difference-between-teramind-cloud-teramind-on-premises-and-teramind-private-cloud-azure-aws)
- [Cloud Security](https://knowledge.teramind.co/en/articles/12637287-how-secure-is-the-data-teramind-collects-and-stores-in-the-cloud)
- [Data Retention](https://knowledge.teramind.co/en/articles/13439004-what-is-your-data-retention-policy-how-long-is-my-data-kept-how-can-i-export-my-data)
- [Integrations](https://knowledge.teramind.co/en/articles/15519260-system-integrations)
- [Microsoft Entra ID](https://knowledge.teramind.co/en/articles/15067671-system-integrations-microsoft-entra-id-directories)
- [Insights](https://knowledge.teramind.co/en/articles/13616098-insights)
- [Reconstructed Video](https://knowledge.teramind.co/en/articles/15818234-what-is-reconstructed-video-and-how-to-use-it)
- [TeraCat Categorization](https://knowledge.teramind.co/en/articles/15423862-announcing-teracat-a-new-app-web-categorization-engine)
- [Release 26.33.3](https://knowledge.teramind.co/en/articles/16529612-release-26-33-3-2026-08-17)

---

## 28. Definition of Done للنسخة المكافئة الأولى

لا نعلن “نسخة Teramind” عندما تتشابه الصفحات. نعلن النسخة المؤسسية الأولى فقط عندما:

- Windows agent مُوقّع، يحدث نفسه، ويعمل 24 ساعة بلا فقد أحداث.
- الوقت active/idle/lock/sleep/offline متسق ومختبر.
- URLs والتبويبات وfocused time موثوقة على Chrome وEdge.
- ملف الموظف يعطي current state وتاريخًا موحدًا ومجاميع قابلة للتفسير.
- live يبدأ <3s والتحكم <1s p95 ولا يخزن frames في Postgres.
- profiles schedules/scopes/resolution تعمل end-to-end.
- productivity classification وunclassified workflow يعملان.
- RBAC/audit/retention موجودة قبل توسيع المحتوى الحساس.
- alerts/incidents تربط القاعدة بالدليل وSession Player.
- اختبارات Windows الحقيقية، الأداء، الأمان، RTL/responsive كلها ناجحة.
- كل شاشة تعرض Unsupported/Unavailable بوضوح حسب OS وagent version بدل زر وهمي.

هذا هو الخط الفاصل بين demo به لقطات وتحكم، ومنصة مراقبة موظفين يمكن تشغيلها فعليًا.
