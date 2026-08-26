# STATUS — أين وصلنا

**آخر تحديث:** 2026-08-26
**الفرع:** `productivity-platform` (مدفوع بالكامل إلى `origin`)
**آخر commit:** `792da1a` — *docs(browser): record the desktop and dashboard work; F4 is code-complete*
**آخر CI run:** [32997059827](https://github.com/EyadSofian/bibo-productivity-platform/actions/runs/32997059827) — **success** (كل الـ jobs خضراء ما عدا الـ audit الاستشاري)

> هذا الملف هو نقطة الدخول السريعة. التفاصيل الكاملة في
> [`IMPLEMENTATION_TASKS.md`](IMPLEMENTATION_TASKS.md) (الملف الرئيسي) و
> [`PRODUCT_ROADMAP.md`](PRODUCT_ROADMAP.md) و [`../BASELINE_TEST_REPORT.md`](../BASELINE_TEST_REPORT.md).

---

## 1. الخلاصة في سطرين

مرحلة التخطيط (Phase 0) **انتهت بالكامل**: الستة مستندات مطلوبة موجودة، و 39 feature
متفصّلة لدرجة إن مهندس تاني يقدر يكمل من غير أسئلة. من الـ 39 feature، **اتنين شُغل
عليهم فعليًا** (F1 و F4)، و **37 لسه `NOT STARTED`**.

الأهم اللي اتغيّر مؤخرًا: **البلوكر الأساسي B-1 اتحل** — Go و Rust و Postgres اتثبتوا
محليًا من غير صلاحيات admin، فالكود اللي كان "مكتوب بس ما اتجمّعش" بقى دلوقتي
**مُجمّع ومُختبر فعلًا**، و CI بيشتغل على macOS و Windows.

---

## 2. حالة الـ 39 feature

| الحالة | العدد | الـ features |
|---|---|---|
| `IN PROGRESS` | 2 | F1 (Baseline stability)، F4 (Browser monitoring) |
| `BLOCKED` فعليًا | 1 | F2 (Windows) — محتاج هاردوير |
| `NOT STARTED` | 36 | كل الباقي |
| `DONE` | 0 | — |

**تقدّم المهام التفصيلية:** 39 مهمة مقفولة من 954 (≈ 4%).
الرقم ده مضلّل لتحت: أغلب الشغل الحقيقي لحد دلوقتي كان بنية تحتية (CI، test harness،
toolchain) مش مهام مرقّمة.

---

## 3. اللي اتعمل فعليًا وأشتغل

### F1 — Baseline stability · `IN PROGRESS`

| العنصر | الحالة |
|---|---|
| إصلاح تضارب البورت `:8080` / `:8090` (defect D-1) | ✅ متحقق منه end-to-end |
| CI بـ 5 jobs (backend / monitor / frontend / desktop / security) | ✅ **شغال وأخضر** |
| Rust يُجمَّع ويُختبر على **macOS و Windows** في CI | ✅ — أول تحقق حقيقي لويندوز |
| `/healthz` يفحص قاعدة البيانات فعلًا (D-11) | ✅ مُجمّع + 4 tests |
| Go test harness مع Postgres (`internal/testutil`) | ✅ مُجمّع ويشتغل |
| Vitest في `web-admin` — 13 tests | ✅ كلها ناجحة |
| حارس manifest للإضافة (privacy posture) | ✅ + 6 حالات regression سلبية |
| `JWT_SECRET` guidance في `.env.example` | ✅ |

### F4 — Browser monitoring · `IN PROGRESS` (code-complete)

ده كان الـ defect المُبلَّغ عنه أصلًا: `"browser_visit": []` رغم استخدام Chrome.

| العنصر | الحالة |
|---|---|
| إعادة كتابة الإضافة إلى `lib/` نقي وقابل للاختبار (B-5) | ✅ **62 test ناجحة** |
| checkpoint كل 60 ثانية — تبويب مفتوح يسجّل وقته (D-2) | ✅ |
| outbox دائم في `storage.local` قبل أي إرسال (D-3) | ✅ سعة 500، أقدم-أولًا |
| إغلاق التبويب يُنهي ويُفرغ (D-6) | ✅ اتصاد بيه بج حقيقي أثناء التطوير |
| `chrome.idle` يوقف العدّاد بعد 60 ث (D-7) | ✅ |
| تمييز Edge / Opera / Vivaldi / Brave / Firefox / Safari (D-14) | ✅ |
| `domain` حقل من الدرجة الأولى، مُشتق server-side + migration `00010` | ✅ |
| **إعادة الإرسال ما بقتش تكرّر** — upsert على `client_uuid` | ✅ من غير schema bump |
| **Batch ingest** — 50 لكل request بدل واحدة | ✅ سقف 200 |
| التحقق من صحة `client_uuid` قبل الإدخال | ✅ يمنع رفض دفعة كاملة |
| لوحة المواقع مجمّعة بالنطاق | ✅ 15 test + تحقق بصري في متصفح |
| اختبارات Rust | ✅ **43** (كانت 27)، clippy نظيف |

---

## 4. اللي لسه ناقص في F4 (قبل ما نقول DONE)

- [ ] المصفوفة اليدوية الكاملة: تبديل تبويبات · نوافذ متعددة · incognito · YouTube ·
      GitHub · متصفح مصغّر · متصفح مقفول · جهاز خامل · تبديل سريع
- [ ] **مراقبة تبويب واحد 30 دقيقة من غير تبديل — لازم صفوف تظهر** (اختبار D-2 الحاسم)
- [ ] Chrome و Edge الاتنين متحقق منهم على المصفوفة الكاملة
- [ ] `GET /api/v1/employees/{id}/websites` بـ rollup و pagination
- [ ] اختبار تكامل: Extension → desktop → SQLite → backend → report
- [ ] تدوير ingest token عند بدء التطبيق وكشفه على loopback فقط
- [ ] أداء: 500 تبديل تبويب · تفريغ outbox بـ 1000 زيارة مُخزّنة

---

## 5. البلوكرات

| # | الوصف | الحالة |
|---|---|---|
| **B-1** | لا Go/Rust/Postgres على جهاز التطوير | ✅ **اتحل** — Go 1.27، Rust 1.98، Postgres 16.9 في `~/.local` بدون admin. Docker وHomebrew طلعوا غير ضروريين |
| **B-2** | لا جهاز ويندوز | ⚠️ **مُخفّف جزئيًا** — CI بيجمّع ويختبر Rust على `windows-latest`. المصفوفة اليدوية لسه محتاجة هاردوير حقيقي |
| **B-3** | لا CI في المستودع | ✅ **اتحل** — 5 jobs، متحقق إنها بتجري خضراء |
| **B-4** | لا بيانات اختبار أو بيئة مبذورة | ❌ مفتوح — يعتمد على مولّد بيانات F30 |
| **B-5** | منطق الإضافة غير قابل للاستخراج للاختبار | ✅ **اتحل** — 62 test |

---

## 6. مشكلة أمنية مفتوحة (شغل متوقف في المنتصف)

الـ job الاستشاري `Dependency audit` بيفشل على ثغرتين قابلتين للوصول في Go:

| # | الحزمة | الحالي | المُصلَح فيه | التقييم |
|---|---|---|---|---|
| `GO-2026-5970` | `golang.org/x/text` | v0.37.0 | v0.39.0 | لسه ما اتفحصش بالتفصيل |
| `GO-2026-5004` | `github.com/jackc/pgx/v5` | v5.7.1 | v5.9.2 | **غير قابل للاستغلال هنا** — الثغرة في مُنقّي SQL الخاص بالـ simple protocol، والمشروع بيستخدم الـ extended protocol الافتراضي |

**⚠️ حالة الشغل: نصف مُطبَّقة وغير مُجمّعة.**
`apps/backend/go.mod` و `go.sum` فيهم تعديلات غير مُلتزَمة: `go.mod` بيقول `pgx v5.9.2`
بس `go.sum` لسه شايل **النسختين** (5.7.1 و 5.9.2) و `puddle` ما اتحدّثش. لازم
`go mod tidy` قبل أي حاجة تانية، وترقية `x/text` لسه ما بدأتش.

**نتيجة جانبية مهمة:** لأن `govulncheck` بيفشل، خطوتَي `cargo audit` و `pnpm audit`
**بيتخطّوا خالص** — يعني مفيش تدقيق تبعيات على Rust ولا JS دلوقتي.

---

## 7. الخطوة الجاية الموصى بها

1. **إنهاء ترقية التبعيات** (نص ساعة): `go get golang.org/x/text@v0.39.0` +
   `go mod tidy` في `apps/backend`، تشغيل `go build ./... && go test ./...` محليًا
   (البيئة بقت قادرة دلوقتي)، commit، والتأكد إن الـ audit job بقى أخضر — عشان
   `cargo audit` و `pnpm audit` يجروا لأول مرة.
2. **قفل F4 يدويًا** — خصوصًا اختبار الـ 30 دقيقة على تبويب واحد. ده اللي يخلّي F4
   `READY FOR TEST` ثم `DONE`.
3. بعدها الترتيب من [`IMPLEMENTATION_TASKS.md`](IMPLEMENTATION_TASKS.md):
   **F37** (release process — رخيص) ← **F33** (privacy safeguards) ← **F5** (Activity
   engine، الأساس اللي كل الحسابات فوقه).

> **قاعدة الالتزام:** مفيش feature تتعلّم `DONE` قبل ما الـ Definition of Done بتاعتها
> تتحقق بالكامل. F1 و F4 الاتنين لسه `IN PROGRESS` لأن التحقق اليدوي ناقص.

---

## 8. حالة الاختبارات الحالية

| المكوّن | العدد | الحالة |
|---|---|---|
| Rust (desktop agent) | 43 | ✅ ناجحة، clippy نظيف |
| Extension (Vitest) | 62 | ✅ ناجحة، تشمل integration بـ fake Chrome |
| web-admin (Vitest) | 13 | ✅ ناجحة |
| Go (backend) | store + auth + obs + healthz | ✅ مُجمّعة وتجري في CI مع Postgres |
| `rollup.ts` (websites panel) | 15 | ✅ ناجحة |
| اختبارات تكامل end-to-end | 0 | ❌ لسه |
| اختبارات أداء | 0 | ❌ لسه (F30) |

---

## 9. اللي لسه ما اتلمسش خالص

كل حاجة بعد F5: محرّك التصنيف (F6)، الأدوار (F7)، درجات الإنتاجية/التركيز/الكفاءة
(F8–F10)، اللوحات (F11–F13)، تخزين اللقطات في object storage (F14)، الـ playback
(F15)، الحضور المباشر (F16)، الشاشة المباشرة (F17)، محرّك القواعد والتنبيهات
(F18–F19)، التقارير (F20)، `/api/v1` (F21)، الـ webhooks (F22)، تحليلات AI-ready
(F23)، تقوية المصادقة والصلاحيات وسجل التدقيق (F24–F26)، الاحتفاظ بالبيانات (F27)،
أداء قاعدة البيانات (F28)، المهام الخلفية (F29)، وكل جاهزية الإنتاج (F30–F39).

مفيش **CHANGELOG.md** لحد دلوقتي — ده جزء من F37.
