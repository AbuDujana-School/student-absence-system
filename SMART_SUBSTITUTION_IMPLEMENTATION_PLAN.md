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
- [ ] Complete parser contract and representative test fixtures (synthetic data only).
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
