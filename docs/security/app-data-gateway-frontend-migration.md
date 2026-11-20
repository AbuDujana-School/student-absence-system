# Frontend migration contract for the authenticated app-data gateway

## Scope and safety boundary

This document records the frontend migration requirements discovered in the current browser application. It is a migration plan, not an authorization to change login behavior or production security settings. Do not merge this gateway or alter production RLS/grants until all preview browser tests and the separate cutover/rollback review pass.

The existing teacher/admin login experience, including any supported offline continuation behavior, is a protected compatibility requirement. A gateway migration must not freeze, remove, or silently change it. No frontend integration is considered complete while the browser still uses direct PostgREST for school data.

## Current direct PostgREST surface

The current browser bundle has a small number of direct call sites, but two generic helpers fan out to all seven school tables:

- `fetchAllPaginated(tableName, selectCols, pageSize)` performs paginated direct reads.
- `robustUpsert(table, rows, onConflictCols, chunkSize)` performs direct upserts.
- Direct `school_settings` writes handle `admin_pin`, `custom_categories`, and `duty_module`.
- A compatibility fallback in `refreshActiveUserPermissions()` directly reads `teachers(role,permissions)` when the gateway action is explicitly unavailable.

The cloud loader currently reads these projections:

| Table | Current projection | Migration concern |
|---|---|---|
| classes | name | preserve full pagination and empty/incomplete roster safeguards |
| students | class_name, student_name | preserve class grouping, sorting, transfers and pending local edits |
| teachers | name, role, pin_hash, pin_salt, permissions, must_change_pin | verifier fields must not be returned to general browser data reads |
| attendance | record_key, class_name, teacher_name, period, records, updated_at | preserve date/class scope and record ownership |
| behaviors | record_key, class_name, teacher_name, period, records, updated_at | preserve date/class scope and record ownership |
| school_settings | key, value | split allowlisted non-secret settings from administrator PIN material |
| duty_reports | id, date_str, day_num, period, class_name, subject, teacher_name, reported_by, status, reviewed_by, reviewed_at, created_at | teacher submission and administrator review require different server actions |

The gateway's general read/write projection is not a drop-in replacement for the current loader: the loader currently expects PIN verifier columns in the teachers result and reads the administrator PIN from school_settings. Do not remove those fields until a reviewed replacement preserves all supported login and recovery workflows without sending reusable verifiers to the browser.

## Required browser gateway adapter

Implement one authenticated request adapter around the existing app session:

- Reads: call `app_data_gateway_read` with explicit table, page limit/offset, and date filters where applicable. Accumulate pages until the server returns fewer than the requested page size; reject malformed pages and repeated/non-advancing cursors.
- Writes: call `app_data_gateway_write` with bounded batches and server-owned conflict keys. Never accept a client-provided table projection, principal, class scope, or conflict target as authorization.
- Manifest: keep the existing revision/manifest request and only refresh changed tables. Preserve the current compatibility behavior when the manifest endpoint is genuinely unavailable; do not fan out repeated full-table reads on transient errors.
- Session: require the current app-session token for online reads and writes. An expired/denied session must not fall back to anonymous direct REST.
- Legacy compatibility: a fallback is allowed only for an explicit unknown-action/old-deployment response during a controlled rollout. It must never bypass HTTP 401/403, expired sessions, scope denials, or a valid gateway response with zero rows.

## Permission and scope alignment gate

Before frontend cutover, document and test the distinct permission domains end-to-end. The server scope resolver reads Student Affairs grants such as `can_read_attendance` and `can_read_behavior`; the generic app-data policy also evaluates the teacher-profile permissions `attendance` and `behavior`. These names are not automatically equivalent: one set controls Student Affairs reporting grants/scopes, while the other controls the ordinary attendance/behavior feature permissions. Do not merge or substitute these booleans without a product-level permission matrix and tests proving the intended combinations.

Test at least:
- administrator;
- teacher with normal timetable-derived class scope;
- teacher with explicit attendance/behavior grants;
- teacher with a custom class grant;
- custom user with explicit permissions;
- disabled, deleted, or role-changed principal;
- cross-class and cross-teacher read/write denial.

## Special actions that must not be forced through generic upsert

### PIN and credentials

- Generic data reads must not expose `pin_hash`, `pin_salt`, or the administrator PIN verifier.
- The current credential snapshot handler still returns verifier material for the offline-login contract. It is not acceptable as the final design and must not be treated as solved by encrypting the same reusable verifier in IndexedDB.
- Preserve the existing login contract until an equivalent device-scoped replacement has passed browser preview tests and is explicitly approved. Do not disable existing offline teacher login as an intermediate step.

### Duty reports

- A teacher's `submitDutyReport()` path currently submits reports and can remove/revise the teacher's own pending report. The generic gateway currently permits duty-report writes only to administrators, so moving this UI directly to generic upsert would break the teacher workflow.
- Add a dedicated teacher-submit action. The server must derive `reported_by`, teacher identity, allowed class scope, date/period eligibility and initial status; reject client attempts to set review fields or impersonate another teacher.
- Add separate administrator actions for reviewing/changing report status and review metadata.
- Preserve the existing no-missing-teacher/clean-report behavior and the local pending queue. Any removal/correction workflow needs an explicit server action; generic delete remains denied.

### School settings

- `admin_pin` must use a dedicated restricted credential/PIN action, not generic `school_settings` read or write.
- `custom_categories` and `duty_module` need narrowly allowlisted settings actions and administrator-only writes.
- Confirm which roles may read duty configuration before migrating; do not accidentally make duty settings administrator-only if the existing UI grants a non-admin read.

## Offline and synchronization invariants

The migration must preserve all of the following:

1. Restore the local IndexedDB school snapshot before network refresh.
2. Keep dirty sets and frozen upload snapshots; edits made during an in-flight request must remain dirty.
3. Clear dirty keys only after confirmed server success and only when the current local value still matches the uploaded snapshot.
4. Preserve revision/manifest checks and the current fail-closed behavior on transient manifest failure.
5. Preserve pagination, class/date filtering, sorting, local student-transfer safeguards, and roster coupling.
6. Preserve reconnect retries and never discard pending local attendance, behavior, roster, or duty changes after a failed gateway request.
7. Keep queued deletions visible and non-executing until a separately reviewed deletion workflow exists.
8. Do not let credential-vault clear/logout operations delete local school data or pending school edits.

## Preview acceptance suite before merge

Run real-browser tests against the deployed preview Edge Function and synthetic data for:

- administrator, teacher, and custom-user login and permissions;
- every table read, including multi-page pagination and unchanged/changed manifest behavior;
- attendance/behavior writes, frozen dirty snapshots, concurrent edits, retries, and cross-scope denial;
- teacher roster edits and custom account management without leaking PIN verifiers;
- student roster save, transfer, and recovery;
- teacher duty report submit/correct and administrator review;
- settings reads/writes and restricted PIN rotation;
- offline local restore, online reconnect, expired/revoked session, and failed network behavior;
- existing teacher PIN login behavior remains unchanged throughout the preview migration.

Use synthetic records only. Capture before/after network request counts and payload sizes to verify that the migration does not reintroduce repeated full-table reads or credential disclosure.

## Cutover gate

Only after all preview tests pass: review production schema and grants separately; prepare a timed, reversible cutover with exact rollback SQL and a tested emergency login path; then obtain explicit approval before any production RLS/grant or Edge Function change. A passing backend CI suite alone is not sufficient.
