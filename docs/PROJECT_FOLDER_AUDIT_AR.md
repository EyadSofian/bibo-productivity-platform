# خريطة فولدرات مشروع BiBoTracking

تاريخ المراجعة: 2026-09-07

## مصدر العمل المعتمد

`/Users/eyad/tracking/video-first-integration`

- الفرع: `work/video-first-integration`
- آخر إصدار كود: `1.5.15`
- يحتوي إصلاح استمرارية تسجيل Windows في `1.5.14`.
- يحتوي LiveKit والتسجيل وPlayback وربط الحدث بلحظة الفيديو.
- يحتوي موديول Tasks وربط جلسة العمل بالأدلة والتحليل العادل.
- يحتوي migrations حتى `00023_tasks.sql`.
- نجحت عليه اختبارات Go وRust والويب وبناء واجهتي الويب وسطح المكتب.

## النسخ المرجعية القديمة

### `/Users/eyad/tracking/bibo-emplooyee-tracking`

- فرع `main` عند commit `96332fa`.
- إصدار سطح المكتب `1.5.10`.
- يحتوي مسودة قديمة وغير مرتبة من بداية نقل الفيديو.
- لا يحتوي migrations 21 و22 و23، ولا التسجيل النهائي، ولا Tasks.
- ملف `.env` محلي يظل في مكانه ولا يُنقل ولا يُضاف إلى Git.

### `/Users/eyad/tracking/windows-update-review/tracking`

- فرع `feat/video-first-media-windows` عند commit `9cce5fc`.
- إصدار سطح المكتب `1.5.1`.
- نسخة مراجعة Windows الأولى؛ حل محلها المصدر المعتمد.

### `/Users/eyad/Downloads/tracking.zip`

- يحتوي 32,138 عنصرًا تحت فولدر `tracking`.
- مصدره فرع `feat/video-first-media-windows`.
- إصدار سطح المكتب داخله `1.5.1`، ولذلك هو نسخة الإدخال الأصلية وليس مصدر
  الإصدار الحالي.

## ملفات الإصدارات والاختبار

- `/Users/eyad/tracking/deliverables`: نسخ التسليم المنشورة من 1.5.11 إلى
  1.5.14 ونسخ الرجوع. ليست مصدر كود.
- `/Users/eyad/tracking/release-1.5.12-final`: نواتج تثبيت 1.5.12 فقط.
- `/Users/eyad/tracking/windows-update-review`: أدوات ومخرجات مراجعة Windows.
- `/Users/eyad/tracking/video-first-integration-test-db`: قاعدة PostgreSQL
  مؤقتة لاختبارات التكامل المحلية.

## قاعدة العمل

أي تعديل أو build أو نشر جديد يبدأ من `video-first-integration`. تُستخدم باقي
الفولدرات كأرشيف وأدلة اختبار فقط، ولا تُدمج منها ملفات تلقائيًا حتى لا يعود
الكود إلى إصدار أقدم.

