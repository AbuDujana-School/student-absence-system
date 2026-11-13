# Smart Timetable and Substitution System — Implementation Plan

## Safety boundary

- All work is confined to `feature/smart-substitution-system`.
- `main`, the production Supabase project, production credentials, and live hosting must remain unchanged.
- Do not deploy Edge Functions, apply migrations to production, publish previews, merge, or push changes to `main` without a separate explicit approval.
- Do not place the uploaded workbook or real school data in the repository.
- Existing attendance, behavior, duty, and Student Affairs permissions and workflows must remain unchanged.

## Verified repository baseline

- Repository: `AbuDujana-School/student-absence-system`
- Baseline branch: `main`
- Feature branch: `feature/smart-substitution-system`
- The feature branch was created from `main` and verified identical at creation.
- Frontend entry point: `index.html`
- Existing server-side session and authorization foundation: `supabase/functions/student-affairs/index.ts`
- Existing general application sessions are resolved server-side through the `app_session` action. New timetable/substitution actions must validate the current application session and authorize every read/write on the server; hiding a navigation item is not authorization.

## Workbook inspection — `ورقة1.xlsx`

The workbook contains seven worksheets. The following structure was verified from the uploaded workbook:

| Worksheet | Observed structure | Import purpose |
|---|---|---|
| الحصص | المعلم، الشعب، المجموعة، المادة، المدة، الحصص/الأسبوع، الغرف الدراسية المتاحة، الدورة | Teaching-load / lesson-contract definitions |
| المعلمون | الاسم الكامل، الاختصار، مدرس الفصل، الربط بالمادة، العقد، النوافذ، قيود أخرى، التفريغ | Teacher directory, aliases, and availability constraints |
| الفصول | الشعبة الدراسية، الاختصار، التفريغ، خصائص الفصل والتقسيمات | Class/section directory |
| الغرف الدراسية | الاسم، الاختصار، النوع، الغرفة الرئيسية، التفريغ | Room directory |
| المواد | المادة، الاختصار، الغرف، خصائص المادة، العدد، التفريغ | Subject directory |
| العقود الفصول | الشعب، المعلم، المجموعة، المادة، المدة، الحصص/الأسبوع، الغرف، الدورة | Class-based teaching contracts |
| العقد | المعلم، الشعب، المجموعة، المادة، المدة، الحصص/الأسبوع، الغرف، الدورة، المعلمون المشاركون | Teacher/subject contracts and shared-teacher information |

### Important finding: this workbook does not contain the final weekly placement grid

The inspected worksheets contain lesson contracts, teacher names/abbreviations, class and subject definitions, and teacher unavailability text. The `الحصص` worksheet has no day/period placement columns, and weekday strings were found in the `المعلمون.التفريغ` field as constraints (for example, a weekday followed by period numbers). These are not evidence that a teacher is assigned to teach a class at that time.

Therefore, this exact workbook can support importing the school structure, teacher aliases, lesson contracts, weekly lesson counts, and availability constraints. It cannot, by itself, safely reconstruct the final timetable cells (day + period + class + teacher). The importer must detect this condition and show a clear blocking review state rather than inventing day/period assignments or treating unavailable periods as scheduled lessons.

Before timetable activation, the system needs a workbook/export that actually contains the final day/period placements, or a confirmed way to obtain those placements from the source timetable application. Do not silently infer placements from weekly totals or teacher unavailability.

## Product requirements

### A. Admin timetable import and maintenance

1. Add a dedicated **الجداول والاحتياط** area in the system administration interface.
2. Allow an authorized system administrator to upload an Excel workbook from the interface.
3. Parse workbook contents in an isolated import process; validate file type, size, sheet names, headers, row counts, and cell values.
4. Show a preview before saving: detected sheets, parsed records, missing fields, duplicate rows, unresolved names, ambiguous matches, and whether actual day/period placements exist.
5. Support explicit mapping of teacher names from the workbook to existing system teacher records.
6. Support exact/normalized matching first. A first-name + family-name candidate match may be suggested, but must not be auto-confirmed when it is ambiguous or low-confidence.
7. Keep unmatched source names visible and unlinked. Display any reliably detected subject/department as context; do not invent a teacher record or guess a department.
8. Let the administrator manually resolve each unmatched/ambiguous teacher to an existing teacher, or leave it unresolved.
9. Provide editable timetable records after import: day, period, class/section, subject, teacher link, and any supported group/room fields.
10. Validate edits for missing references and schedule conflicts before activation.
11. Re-import must be previewed and idempotent. Never append duplicates or overwrite an active timetable without an explicit administrator confirmation. Preserve an audit trail and the prior active version.

### B. Name matching

- Normalize Arabic orthographic variants, whitespace, tatweel, diacritics, and common `بن/ابن` tokens for comparison only; preserve the original source spelling for review.
- Compare the full name and the source abbreviation/alias against the system teacher directory.
- Use first-token + final-family-token as a candidate-generation signal, not as unconditional proof of identity.
- If multiple teachers share the same normalized first/family pair, require manual selection.
- Never create, rename, or merge teacher accounts as a side effect of timetable import.

### C. Timetable data model — proposed, subject to migration review

Keep imported source versions separate from the active normalized schedule. A possible logical model:

- `timetable_imports`: uploader, upload timestamp, source filename, content hash, parse status, validation summary, and import version.
- `timetable_import_rows`: source sheet/row, raw values, normalized values, row type, validation status, and resolution metadata.
- `timetable_teacher_links`: source teacher name/alias to an existing teacher identity, match method, confidence, and reviewer.
- `timetable_entries`: active schedule cells with weekday, period, class/section, subject, teacher identity, group/room where applicable, and source version.
- `substitution_permissions`: independent access grants for the timetable/substitution module, scoped to department and permitted actions.
- `substitution_assignments`: absence date, absent teacher, period, class/section, replacement teacher, assigning principal, status, and audit timestamps.

These are design names, not approved production schema. Inspect existing migrations and database constraints before implementing any migration. Prefer additive, reversible migrations and test them only against an isolated development database.

### D. Substitution workflow

1. The authorized department coordinator selects the absent teacher and date.
2. The system lists that teacher's scheduled lessons for that date.
3. Each lesson is shown as a separate row/card with its class, subject, and period.
4. Each lesson has an independent candidate list.
5. A candidate is ineligible if they have a scheduled lesson or another substitution in the same period, are unavailable, or violate an explicitly approved limit.
6. Default candidate scope is the absent teacher's department. Cross-department candidates appear only after the coordinator explicitly expands the scope.
7. Candidate ranking may consider current-day/week/month substitution load, but fairness affects ranking only; it never overrides availability or conflict checks.
8. The coordinator can change any choice before one explicit save/confirm action.
9. Incomplete lessons remain visibly unresolved; do not imply that the whole day has been covered.
10. Persist the complete assignment audit record and expose department-scoped reports; cross-school consolidated reports are restricted to the system administrator or explicitly delegated users.

### E. Independent authorization

- The system administrator grants a separate timetable/substitution permission.
- Existing attendance, behavior, duty, and Student Affairs permissions are not modified or reused as a proxy.
- Every API action checks the current server-validated application principal and the relevant department scope.
- Unauthorized principals must receive 401/403 from the server even if they call an endpoint directly.
- The client only renders permitted navigation/actions after loading the server-authoritative permission result.
- Do not rely on localStorage flags, hidden elements, or client-side role checks as security boundaries.

## Implementation sequence and acceptance gates

1. **Workbook contract and parser tests** — complete format inventory, safe parsing, Arabic normalization, duplicate detection, name-match confidence, and explicit detection of missing final placements.
2. **Additive schema design and isolated migration tests** — verify keys, uniqueness, foreign keys, audit fields, and access policies without touching production.
3. **Server API and authorization** — session validation, admin import/activation actions, department-scoped reads/writes, and negative authorization tests.
4. **Admin import/review UI** — upload, preview, unresolved names, manual matching, edit grid, validation, versioning, and activation.
5. **Substitution engine** — per-period availability, conflict prevention, department scope, cross-department expansion, fairness ranking, and batch confirmation.
6. **Reports and audit** — scoped history, admin consolidated report, print/share controls only after permission checks.
7. **Regression and security testing** — verify existing attendance, behavior, duty, Student Affairs, reports, login, offline sync, and teacher permissions remain unchanged.
8. **User acceptance** — only after the user reviews the complete test evidence may a separate request be made to merge or deploy.

## Current status

- [x] Create isolated feature branch from `main`.
- [x] Verify branch exists and is identical to `main` at creation.
- [x] Inspect the uploaded workbook's seven worksheets and identify the absence of final day/period placements.
- [x] Inspect the current server-side session/authorization entry points.
- [ ] Complete parser contract and representative workbook fixtures (synthetic data only).
- [x] Add an isolated, database-independent substitution eligibility policy and synthetic test cases for blank cells, occupied cells, duplicate substitution assignments, department scope, and cancelled assignments.
- [x] Run a Node.js 22 TypeScript-stripping smoke check of the availability policy (5 assertions passed). The repository's Deno test runner is not installed in the working environment, so the committed Deno test file has not yet been executed.
- [ ] Implement importer, schedule editor, permissions, and substitution workflow.
- [ ] Run automated and manual regression/security tests.
- [ ] Obtain explicit user approval before any merge or deployment.


## Clarification from the school: use this exact workbook as the only upload source

The school confirmed that the seven-sheet workbook `ورقة1.xlsx` is the exact workbook that must be uploaded through the admin dashboard; no second final-placement export is expected.

This changes the import design: the importer must treat the workbook as a timetable-construction input, not as a pre-populated weekly placement grid. It must build a fixed, repeatable timetable-generation workflow from the workbook's contracts and constraints, then allow the administrator to review and edit the generated schedule.

### Confirmed workbook semantics and constraints to preserve

- `الحصص`, `العقود الفصول`, and `العقد` describe teaching contracts, class/group, subject, duration, weekly lesson count, cycle, and room constraints. These records are not already assigned to weekdays and periods.
- `المعلمون` contains the teacher's full source name in column B and an abbreviation/short name in column C. Use column C as an explicit alias when matching to the existing school teacher directory, in addition to normalized full-name matching.
- The teacher `التفريغ` column contains weekday/period expressions, such as `الأحد: 1, 4-6; الأربعاء: 5-7; الخميس: 4-7`. Parse these expressions into structured weekday-period constraints, preserving the raw source text.
- The workbook also contains class, room, and subject `التفريغ` fields. Parse them through the same constraint pipeline, but do not assume their precise meaning until the school timetable software's semantics are verified.
- The workbook includes additional constraint fields such as teacher `مدرس الفصل`, `الربط بالمادة`, `النوافذ`, `MWD`, `EXH`, `DAYS`, and `<a,b>`; retain these fields in the import model rather than discarding unfamiliar columns.

### Fixed timetable reconstruction workflow

1. Import all seven sheets and preserve source sheet/row/cell references.
2. Normalize and reconcile teacher full names, teacher abbreviations, classes, subjects, rooms, and contract/group references.
3. Convert weekly lesson counts and durations into required lesson units. Handle double periods and group splits according to the source contract fields.
4. Parse all weekday/period restrictions and room/class restrictions into typed constraints.
5. Build a weekly timetable-generation problem for the school's actual teaching days and periods. Do not hard-code a guessed school week or number of periods; derive it from valid workbook constraints where possible and expose a small admin configuration step where it cannot be established safely.
6. Use a deterministic constraint solver with a fixed seed/tie-break order so repeated runs with unchanged input and settings produce the same proposed timetable. The solver must enforce teacher, class, room, group, duration, weekly-load, and availability constraints; report infeasible contracts rather than silently dropping or moving them.
7. Produce a **proposed generated timetable**, not an asserted copy of the source timetable. Show every scheduled lesson by weekday, period, class, subject, and teacher.
8. Give the administrator a full editable timetable grid and an exception list for unresolved names, missing constraints, unscheduled lessons, double-bookings, and impossible combinations.
9. Require administrator review and explicit activation before the generated timetable becomes the source of truth for substitution availability.
10. Keep solver version, input workbook hash, configuration, seed, run timestamp, warnings, manual edits, and activated version in the audit history. Re-running generation must not overwrite manual edits or an active version without explicit confirmation.

### Critical semantic validation before solver implementation

The word `التفريغ` may mean unavailable periods, released periods, or a specific timetable-software constraint. Do not invert its meaning based on the label alone. Build a preview showing each parsed restriction and ask the administrator to confirm the interpretation before the first generation. Likewise, validate the meaning of MWD/EXH/DAYS/`<a,b>`, the school's actual weekday/period structure, and the contract cycle/duration fields against the source timetable application or a confirmed sample.

### Acceptance rule

A generated schedule is acceptable only if:
- every required weekly lesson unit is scheduled exactly as contracted, or explicitly reported as unresolved;
- no teacher, class, group, or room conflict exists;
- all confirmed availability and duration constraints are obeyed;
- all ambiguous source data is surfaced for review;
- an administrator can edit and validate every placement before activation.

No timetable-generation output may be used for substitution assignments until it has passed these checks and been activated by the administrator.


## Confirmed substitution availability rule (school clarification — 2026-11-13)

The school explicitly confirmed how availability is read from the teacher timetable grid:

- A blank teacher cell for a weekday and period means the teacher has no scheduled class and is available to be considered for substitution.
- A cell containing a class/section (for example, `11 أول`) means the teacher is teaching and is ineligible for substitution in that period.
- Availability must be evaluated against the active, administrator-approved timetable, not inferred from weekly lesson totals or from the teacher `التفريغ` text field.
- When an absent teacher and weekday are selected, list only that teacher's scheduled lessons for that day. Each lesson has its own period-specific candidate list.
- By default, candidates must belong to the absent teacher's department and have a blank timetable cell in that exact period.
- A teacher already assigned to another substitution in the same weekday/period is also ineligible.
- Teachers from other departments are excluded unless the coordinator explicitly enables cross-department selection.
- Candidate availability is a hard eligibility rule. Fairness/load may be used later to order eligible candidates only; it cannot make a busy teacher eligible.
- The source workbook contains contracts and constraints rather than a pre-filled day/period grid. The timetable construction/review stage must therefore produce the explicit weekly grid first. Blank cells in that approved grid then represent availability exactly as described above.
- The meaning of the separate source `التفريغ` constraint fields and the remaining solver codes still requires validation; this clarification does not reinterpret those fields.

### First isolated implementation slice

A pure, database-independent substitution policy module and synthetic tests are added before UI/database integration. It provides:
- absent-teacher lessons for a selected weekday, ordered by period;
- period-specific candidate filtering using the active timetable;
- strict same-department default scope;
- exclusion of occupied teachers and teachers already assigned in the same period;
- explicit opt-in for cross-department candidates.


## New admin interface requirement: "استيراد الجدول" and teacher-by-teacher review

The school clarified the expected workflow and presentation for the import area:

1. Inside **الجداول والاحتياط**, provide a clearly named feature/section **استيراد الجدول**.
2. The administrator uploads the Excel workbook in this section.
3. After parsing, display the imported schedule data below the upload area as a browsable list of **all teachers** found in the workbook, not merely a success message or aggregate import summary.
4. Each teacher row/card shows the teacher's name and a clear **عرض الجدول** action. Opening it displays that teacher's schedule in a weekly day/period layout, with each lesson showing its class/section and any available subject/group/room details.
5. Provide a per-teacher **تعديل** action. The administrator can edit an existing lesson, add a missing lesson, and remove an incorrect lesson. Changes must be validated and saved as a new reviewed revision, with who/when audit information.
6. The edit view must make the weekday and period explicit. It must not let the administrator accidentally create a teacher/class/room/group double-booking. Show validation errors before saving.
7. Show import provenance and state: source workbook/version, last import, whether the teacher's data is linked to an existing system teacher, and whether the displayed schedule is draft, reviewed, or active.
8. Imported rows and manually added/edited rows must remain distinguishable in the audit history. A subsequent re-import must show a diff and must not silently erase administrator edits.
9. The administrator can review teachers one by one, and should also have a school-wide overview/search/filter so that a large teacher list remains usable on mobile and desktop.

### Important data-integrity condition

The inspected `ورقة1.xlsx` contains teacher/lesson contracts, class, subject, duration, weekly lesson counts, and constraints, but the inspection did not find explicit weekday + period placements in its lesson rows. Therefore, the interface must not fabricate a weekly grid from contract totals. The import screen must:
- display all imported teacher/contract information immediately, grouped by teacher, so the administrator can inspect what was extracted;
- if the workbook actually contains a day/period placement field in a later validated format, render those placements in the weekly timetable grid;
- if day/period placements are absent (as in the inspected workbook), clearly label the grouped records as **بيانات الحصص المستوردة — بانتظار توزيع الأيام والحصص**, and provide the timetable-generation/review workflow as a separate stage before showing a real weekly grid;
- after the administrator creates or approves day/period placements, show the full editable weekly timetable for every teacher, including blank cells which are subsequently used to determine substitution availability.

This requirement does not change the confirmed rule that a blank cell in the approved weekly timetable means available for substitution and a populated cell means busy.

## تنفيذ استيراد ملف Excel — المرحلة الأولى

تمت إضافة محلل مستقل للملف في `supabase/functions/student-affairs/timetable_import.ts` مع اختبارات في `timetable_import_test.ts`.

- يستقبل المحلل أوراق العمل بصيغة صفوف SheetJS، ويحتفظ بالقيم الخام وأرقام الصفوف ومصدر كل سجل.
- يتعرف على الأوراق السبع: الحصص، الفصول، الغرف الدراسية، المواد، المعلمون، العقود الفصول، العقد.
- يستخرج بيانات الحصص والعقود من الأوراق الثلاث ذات الصلة، ويجمع سجلات المعلم تحت اسمه، مع إبقاء مصدر كل سجل مستقلاً حتى لا تختلط سجلات العقود المتشابهة.
- يحفظ صفوف ورقة المعلمين كاملة، بما فيها حقول MWD وEXH وDAYS و<a,b> والتفريغ، دون تفسيرها أو إسقاطها.
- يطابق الأسماء بعد تطبيع اختلافات الهمزات والتشكيل والمسافات، ويُبقي غير المطابق والملتبس ظاهراً للمراجعة.
- لا ينشئ أياماً أو حصصاً من عدد الحصص الأسبوعية. لا تُعتبر السجلات placements إلا إذا احتوى السجل صراحةً على اليوم ورقم الحصة.

### فحص الملف المرفوع

أظهر الفحص المحلي للملف `ورقة1.xlsx` وجود الأوراق السبع، وبها 69 اسماً فعلياً في دليل المعلمين، و322 صفاً غير فارغ في ورقة الحصص، و455 في العقد، و362 في العقود الفصول. لم تظهر أعمدة صريحة لليوم أو رقم الحصة في أي من أوراق الحصص/العقود الثلاث؛ لذلك يجب أن تكون حالة العرض الأولي «بيانات الحصص المستوردة — بانتظار توزيع الأيام والحصص»، لا شبكة أسبوعية.

### ما لم يُنفذ بعد

هذه المرحلة هي طبقة التحليل فقط. لم تُربط بعد بواجهة الرفع أو التخزين الدائم أو سجل الإصدارات أو التعديلات أو صلاحية الجداول المستقلة. كما لم تُشغّل اختبارات Deno لأن Deno غير متاح في بيئة التنفيذ الحالية. لا يوجد أي تغيير على `main` ولا نشر أو اتصال بقاعدة الإنتاج.

## تنفيذ واجهة استيراد الجدول والمعاينة الآمنة — المرحلة الثانية

أضيفت واجهة أولية داخل لوحة تحكم مدير النظام باسم **الجداول والاحتياط**، وبداخلها قسم **استيراد الجدول**.

### ما تنفذه الواجهة الآن
- اختيار ملف Excel بصيغ XLSX وXLS.
- قراءة أوراق العمل بواسطة SheetJS، وإزالة الصفوف والخلايا الفارغة الناتجة عن تنسيق Excel قبل إرسال البيانات.
- إرسال بيانات الأوراق إلى Edge Function مع رمز جلسة التطبيق الحالي.
- عرض اسم الملف ووقت المعاينة ومنفذها وأسماء الأوراق.
- عرض أعداد المعلمين وسجلات الحصص والعقود والبيانات المرجعية والتوزيعات الأسبوعية الصريحة.
- عرض قائمة المعلمين المستخرجين، مع البحث بالاسم، وحالة مطابقة كل اسم مع دليل المعلمين في النظام.
- فتح أي معلم لعرض سجلاته المستخرجة من أوراق الحصص والعقد والعقود الفصول، مع إظهار الورقة ورقم الصف والشعبة والمادة والمجموعة والمدة وعدد الحصص الأسبوعية والغرف.
- إظهار التحذير بوضوح عند غياب بيانات اليوم ورقم الحصة، وعدم إنشاء شبكة أسبوعية وهمية.

### الحماية
- أضيف الإجراء `timetable_preview` إلى Edge Function.
- لا يقبل الإجراء إلا جلسة تطبيق صالحة، ويتحقق مجدداً من الحساب الحالي في قاعدة البيانات، ويشترط أن يكون نوع الحساب `admin`.
- لا يعتمد على إخفاء زر الواجهة وحده، ولا يغيّر صلاحيات الغياب أو السلوك أو المناوبة أو شؤون الطلبة.
- يضع الإجراء حدوداً لعدد أوراق العمل والصفوف والخلايا قبل التحليل.
- تتم المطابقة على دليل المعلمين الذي يقرأه الخادم، لا على أسماء يرسلها المتصفح باعتبارها موثوقة.

### فحص بنية ملف Excel المرفق
الفحص التفصيلي باستخدام القيم الفعلية أكد:
- المعلمون: 69 اسماً، وكل اسم له اختصار في الدليل.
- الحصص: 322 سجل تفصيلي.
- العقد: 69 صف عنوان/معلم و385 سجل تفصيلي تابعاً لها.
- العقود الفصول: 35 صف عنوان/شعبة و327 سجلاً تفصيلياً تابعاً لها.
- الفصول: 35 سجلاً، الغرف الدراسية: 28، المواد: 31.
- بعد حذف الخلايا والصفوف الفارغة الناتجة عن التنسيق، يبلغ حجم البيانات المرسلة نحو 1,310 صفوف و10,603 خلايا، وهو ضمن حدود المعاينة المحددة في الإجراء.

### حدود المرحلة الثانية عند إغلاقها
كانت المعاينة في هذه المرحلة مؤقتة للعرض فقط. تم تجاوز حدود الحفظ والتعديل وسجل التدقيق في المرحلة الثالثة أدناه. بقيت مقارنة إعادة الاستيراد، واعتماد الجدول الأسبوعي، وتوزيع placements، والنشر خارج نطاق هذه المرحلة.

## تنفيذ الحفظ الدائم وتعديل مسودات الجدول — المرحلة الثالثة

تمت إضافة migration مستقلة باسم `20261113120000_timetable_import_store.sql`، ولم تُطبّق على أي مشروع Supabase فعلي.

### بنية التخزين
- `timetable_imports`: نسخة الاستيراد، اسم الملف، المنفذ، الحالة، الملخص، وأوراق المصدر.
- `timetable_import_teachers`: أسماء المعلمين المستخرجة، المطابقة، والأسماء المختصرة.
- `timetable_import_records`: كل سجل حصة، مع ورقته ورقم صفه، ونسخة مصدر ثابتة `source_data` وبيانات حالية قابلة للتعديل `record_data`.
- `timetable_import_audit`: سجل من أضاف أو عدّل أو حذف، مع القيم قبل التغيير وبعده.

كل الجداول مفعّل عليها RLS ولا تمنح أدوار المتصفح `anon` و`authenticated` صلاحية مباشرة. الوصول عبر Edge Function بعد التحقق من جلسة مدير النظام، وباستخدام `service_role` على الخادم فقط.

### وظائف المسودة
- حفظ الاستيراد كنسخة `draft` بعد إعادة تحليل الملف على الخادم؛ لا يثق الخادم بنتيجة تحليل يرسلها المتصفح.
- عرض النسخ المحفوظة وفتح نسخة محددة.
- تعديل سجل، إضافة سجل يدوي، أو حذف سجل من المسودة.
- حفظ بيانات المصدر الأصلية منفصلة عن التعديلات حتى لا تضيع القيم المستوردة.
- تسجيل عمليات التعديل والإضافة والحذف في سجل التدقيق.
- عند إدخال اليوم ورقم الحصة، يتحقق الخادم من تعارض المعلم والشعبة/المجموعة والغرفة. كما يشترط إدخال اليوم ورقم الحصة معاً، ويتحقق من أيام الدراسة.
- تتحدث حالة وجود توزيعات أسبوعية صريحة بعد التعديل، ولا تتحول بيانات عدد الحصص الأسبوعية إلى توزيع تلقائي.

### الاختبارات المعزولة
أُضيفت اختبارات GitHub Actions تعمل على فرع التطوير:
- اختبار PostgreSQL 16 محلي معزول لتطبيق migration والتحقق من RLS والصلاحيات.
- اختبار إنشاء نسخة استيراد، وتعديل سجل مع الاحتفاظ بالمصدر، والإضافة والحذف وسجل التدقيق، ورفض تعارض المعلم.
- اختبار محلّل Excel واختبارات أهلية الاحتياط.
- فحص صياغة JavaScript المضمنة في `index.html` وفحص TypeScript عبر Deno.

نتيجة تشغيل CI على commit `bde94524dd779647454eaec0395c018209503ba7`: نجح الاختباران، بما فيهما اختبار PostgreSQL المعزول واختبارات Deno. كان التشغيل الأول قد كشف خللاً في تطبيع عناوين الأعمدة العربية؛ تم إصلاحه، ثم نجحت الاختبارات في التشغيل اللاحق. توجد تعديلات إضافية بعد هذا التشغيل على حفظ بيانات المصدر أثناء التعديل، وهي بانتظار نتيجة CI الخاصة بها.

### ما لم يُنجز بعد
- لا يوجد اعتماد أو تفعيل لجدول أسبوعي، ولا توزيع تلقائي.
- إعادة الاستيراد ومقارنة الفروقات بين نسختين لم تُنفّذ بعد.
- صلاحية مستقلة للمستخدمين غير المديرين لم تُضف بعد؛ تبقى الخاصية محصورة بمدير النظام العام حتى اعتماد نموذج الصلاحيات المستقل.
- لم يتم نشر Edge Function أو تطبيق migration على Supabase، ولم تُجرَ أي كتابة على قاعدة الإنتاج.
- لا دمج إلى `main` ولا نشر.

### ربط القسم/التخصص بدليل المعلمين

أثناء تجهيز أساس الاحتياط، تمت مراجعة بنية المعلم الحالية في النظام: التصنيف محفوظ في `teachers.permissions.category`. لذلك أصبح محلّل الاستيراد ينقل تصنيف المعلم المطابق من النظام إلى سجل الاستيراد، ويحفظه في النسخة المسودة ويعرضه في تفاصيل المعلم. يمكن استخدام قيمة التصنيف هذه كمعرّف نطاق القسم عند بناء قائمة بدلاء القسم نفسه، دون إنشاء تصنيف جديد أو تعديل بيانات المعلمين الأصلية.

### صلاحية مستقلة لمنظومة الجداول والاحتياط

تمت إضافة جدول `timetable_access_permissions` المستقل، ويتيح لمدير النظام العام تفعيل أو إلغاء دخول كل معلم أو مستخدم مخصص إلى المنظومة. لا يُخزّن هذا الخيار ضمن صلاحيات الغياب أو السلوك أو المناوبة، ولا يغيّرها.

- مدير النظام العام يمتلك الوصول تلقائياً.
- المعلم أو المستخدم المخصص لا يظهر له تبويب الجداول إلا بعد منح الصلاحية.
- الخادم يعيد التحقق من الصلاحية في كل طلب للمعاينة والحفظ وفتح النسخ والتعديل والحذف؛ إخفاء التبويب ليس وسيلة الحماية الوحيدة.
- إدارة المنح والإلغاء متاحة لمدير النظام العام فقط.
- تمت إضافة فحوص RLS والمنح الخاصة بجدول الصلاحيات إلى اختبار PostgreSQL المعزول.


## Manual timetable-owner assignment — implemented

The school clarified that a workbook teacher label may be a placeholder or ambiguous short name (for example, `س فيزياء`). The importer must preserve that source label and its lesson/contract rows without inventing a system identity.

The draft review now supports an explicit **تبديل مالك الجدول** action for each imported teacher group:
- The source name and all imported records remain unchanged and visible.
- The administrator can select an existing teacher account from the live system teacher directory, or leave the owner unresolved for later.
- The selected system teacher and department are stored separately from the workbook source name.
- Unresolved or ambiguous entries remain marked **مالك غير محدد** until manually assigned.
- Reassignment is restricted to a saved draft, validated server-side against an existing teacher account, and recorded in the timetable audit log with before/after owner values.
- Duplicate source names are rejected for reassignment until their ambiguity is resolved.
- No teacher account is created, renamed, merged, or deleted by this operation.

### Verification

- Added an isolated PostgreSQL migration test for assigning an unresolved source label to a registered teacher, clearing the assignment again, and checking the audit history.
- Extended the workflow to apply the additive owner-reassignment migration in the isolated test database.
- Fixed an escaped-whitespace regular expression in Arabic name tokenization that caused the detailed-name disambiguation test to fail.
- GitHub Actions on the feature branch passed both jobs: inline JavaScript syntax and policy/type tests; isolated PostgreSQL migration, RLS, timetable persistence, and owner reassignment tests.
- This remains development-only. No migration was applied to the school's Supabase project, no Edge Function was deployed, and `main` was not changed.

## School-confirmed teacher identity corrections — 2026-11-13

The school explicitly confirmed these identity links for timetable import:

- Workbook label **س فيزياء** belongs to the existing system teacher **محمد البشير**.
- **محمد جمعة ناصر السعدي** is the Arabic teacher stored in the system as **محمد جمعة الساعدي**.
- **محمد عبدالله حمود الساعدي** is the life-skills teacher stored in the system as **محمد عبدالله الساعدي** (department: مواد المهارات الحياتية).
- The short alias **محمد السعدي** by itself is shared and must never identify either teacher automatically; records containing only that alias remain unresolved for manual review.

The parser now applies the three confirmed links only when the detailed source name matches and exactly one existing system teacher matches the confirmed target. It does not create, rename, merge, or modify teacher accounts. A regression test covers all three confirmed links and verifies that the shared short alias remains ambiguous.
