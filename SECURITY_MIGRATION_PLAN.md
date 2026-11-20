# Security and Synchronization Migration Plan

Updated: 2026-11-20

## Executive status

This document supersedes the older checkpoints below it. It reflects the current main branch, the deployed Supabase functions inspected on 2026-11-20, and the read-only database checks performed during the same review.

The project has made meaningful progress, but the general school-data CRUD migration is not complete.

| Area | Current verified state |
|---|---|
| General app online login | Server-validated PIN login and server-issued app session are wired into the frontend |
| General app session storage | public.app_sessions exists in production and development; stores token digests and is restricted to service-role access |
| Offline login | Legacy browser-side fallback remains for offline use and when the server login endpoint is not available |
| Revision manifest | Applied in production and development; metadata covers the seven school-sync tables and has statement-level revision triggers |
| General data read gateway | app_data_gateway_read exists in student-affairs and is read-only |
| General data writes | Still use direct browser REST/upsert paths |
| General data deletes | Fail closed; delete intents are persisted locally for review and are not automatically executed on the server |
| Production RLS for the seven sync tables | Still permissive for anon; do not tighten until all CRUD and offline paths have server replacements |
| Background polling | Main now polls every 120 seconds; reconnect, pageshow, and visibility restoration still trigger prompt refresh |
| Query-log consumption | No new query_logs investigation was run in this pass; no before/after Log Query GB reduction has yet been measured |

Main commit 3ba55f45936cdb91e8e7fbfd4df1c466407c7707 contains the reviewed query-log and sync optimizations merged on 2026-11-20. GitHub Actions passed the Student Affairs backend suite, timetable suite, and GitHub Pages build/deployment for that commit.

## Safety invariants

- Preserve every existing school, teacher, student, attendance, behavior, duty, timetable, permission, and credential record.
- Do not reset, rewrite, expose, or migrate existing PINs, PIN hashes, salts, or admin PIN verifiers without a separate reviewed migration and explicit approval.
- Do not remove tables or columns, rename school records, or change conflict keys without tests proving equivalent behavior.
- Do not tighten production RLS or revoke anon grants until all dependent reads, writes, deletes, authentication, and offline workflows have been migrated and verified.
- Use synthetic data only for development integration tests. Never use production records as test fixtures.
- Keep the production and development Supabase projects separate. The Cloudflare UI-only preview must never contact the production Supabase project.
- Do not use paid browser services, paid Supabase branches, or any workflow that adds cost. The user declined additional charges.
- Do not automatically execute queued deletes. They remain review-only until a replacement workflow is designed, tested, and explicitly enabled.
- A successful GitHub merge or CI run does not mean a Supabase Edge Function has been deployed. Verify deployed versions separately.

## Current runtime architecture

### General application authentication

The online login path in index.html calls the student-affairs Edge Function with app_login. The server resolves the submitted PIN against the existing credential records, issues an opaque bearer token, and stores only its SHA-256 digest in app_sessions. The frontend stores the bearer token in sessionStorage and validates the current app session through app_session. Logout uses the server-side session path.

Important compatibility boundary:

- When the browser is offline, the app still uses the legacy local PIN fallback.
- When the server endpoint is positively identified as an older endpoint that does not know the action, the legacy fallback remains available for compatibility.
- Other server authentication errors do not silently fall back to local login.
- This means online login is server-validated, but offline compatibility still depends on local credential material.

The current code therefore does not yet eliminate all browser-side credential exposure. The general sync loader still downloads teacher and settings rows directly, and the offline snapshot can still contain locally cached verifier fields. A secure replacement must preserve offline access without returning verifier fields to the browser.

### General school-data synchronization

The seven general sync tables are:

- classes
- students
- teachers
- attendance
- behaviors
- school_settings
- duty_reports

The frontend now uses get_app_sync_manifest to compare per-table revisions before downloading unchanged datasets. The manifest contains metadata only; it does not contain school records. The seven-table manifest and its triggers were verified in both production and development.

The current main branch also:
- Defers protected cloud-table reads until an active user and valid online app session exist.
- Restores local IndexedDB/localStorage state and dirty markers before attempting cloud synchronization.
- Preserves local edits made while a cloud refresh is in flight.
- Blocks uploads when the manifest check fails in a way that makes cloud state untrusted.
- Polls the manifest every 120 seconds while the app is active and visible.
- Retains prompt refresh triggers after network reconnect, pageshow, and visibility restoration.

The loader still reads the school tables through the browser Supabase client when a dataset must be refreshed. In particular, the current fallback/read paths still request teachers with select(*) and school_settings with select(*). The safe read gateway is not yet the general synchronization path.

### Read gateway

student-affairs contains app_data_gateway_read and its policy, scope, validation, and resolver modules. It uses the active general-app session, derives the principal on the server, applies table-specific projections and scopes, and excludes credential-shaped fields from its safe output.

This is a read-only endpoint. There is no complete general-app write or delete handler behind it. Do not infer write capability from policy helpers or action type definitions alone.

### Writes and deletes

saveSystemDataToCloud still writes directly through the browser client and robustUpsert. The existing conflict keys are:

| Table | Conflict key |
|---|---|
| classes | name |
| students | class_name,student_name |
| teachers | name |
| attendance | record_key |
| behaviors | record_key |
| duty_reports | id |
| school_settings | key |

robustUpsert still attempts chunked upsert first and has a row-by-row select/update/insert fallback if the batch upsert fails. That fallback is a query-amplification risk and is race-prone; the replacement should use validated, atomic server-side operations rather than blindly reproducing the fallback.

The failure diagnostics were hardened in main: they no longer log the submitted row or raw database error message, and the failure aggregation stores only table/error-code metadata.

Deletion is intentionally fail-closed:
- queueCloudDelete persists a table/filter intent locally.
- flushPendingDeletes currently returns without executing server deletes.
- The UI reports pending deletions for review rather than claiming that a cloud delete completed.
- Student roster transfer and direct roster-save flows are separate, server-validated operations and must not be conflated with the generic pending-delete queue.

## Data and offline contract to preserve

### Pagination and refresh

- fetchAllPaginated reads ordered ranges of up to 1,000 rows until a short or empty page is returned.
- Preserve filters, pagination, table projections, and per-role scope when moving reads to the server.
- A missing manifest RPC uses a compatibility path; a transient manifest failure must not fan out into seven full-table reads on every poll.
- The localStorage fallback keeps only the latest 14 days of attendance and behavior data. When that fallback is active, those two datasets are deliberately refreshed from the server to avoid silently losing older records from the local view.
- Class and student rosters are coupled: a class revision can require refreshing students as well.

### Dirty sets and snapshots

- IndexedDB and localStorage snapshots preserve the offline database, dirty sets, pending deletion intents, and the last trusted sync manifest.
- A cloud write must not start until at least one local persistence layer confirms the snapshot.
- Each dirty set is cleared only after the corresponding cloud write succeeds and only for the exact frozen upload snapshot.
- Edits made while a network write is in flight must remain dirty for the next sync.
- Offline and reconnect retry behavior must remain explicit and idempotent.

### Permission and merge behavior

- Teacher permission writes merge current server-side permission fields so Student Affairs-owned fields are not overwritten.
- Permission refresh must use the safe permission projection and must never retrieve PIN verifier columns.
- Preserve administrator/teacher/custom-user role precedence and every existing permission boundary.
- Class renames, class removal, student transfers, and roster updates must preserve the existing student-history semantics. Removing a student from a roster must not erase historical attendance or behavior records.

### Credential compatibility

- Existing teacher PIN verifiers are stored on teachers.
- The administrator PIN verifier is stored in school_settings under admin_pin.
- Custom users and the general admin share the existing legacy compatibility path.
- Forced PIN-change flows, administrator PIN changes, teacher PIN resets, duplicate-PIN checks, and offline login must each receive an authenticated server replacement before browser-side verifier reads can be removed.
- Never log PINs, hashes, salts, full teacher rows, or full school-setting payloads.

## Verified database and deployment observations

### Production and development

- Production project: ylsocrvwqibptuwfzbke.
- Development project: wawplttrpiinoukpjqqx.
- Both projects are active and on PostgreSQL 17.
- app_sessions exists in both projects, has RLS enabled, and is restricted to service-role access.
- The revision manifest RPC and seven revision triggers were verified in both projects.
- The seven school-sync tables still have permissive anon access in production. The development project has stricter policies for those tables.
- No production rows, PINs, or credentials were read or changed during this review.

### Edge Function deployment state

The student-affairs function in production and development contains the general app login/session actions and the read gateway. The previously reviewed eight core files matched main at the time of that comparison.

The timetable-management function has not yet been redeployed from the newly merged main code:
- Production deployed version observed: 44.
- Development deployed version observed: 16.
- Both deployed versions differ from the current main source in the authentication/query-reuse files.
- The timetable authorization query-reuse changes are merged and passed isolated CI plus the free UI-only preview smoke test, but the new Edge Function code has not been deployed to either Supabase project.
- Do not deploy it to production as part of this documentation or code-merge work. First reconcile the development function's existing differences, then perform a development-only deployment and authenticated synthetic API tests.

### Supabase advisor observations (2026-11-20)

Production:
- No health advisor findings were returned.
- The security advisor reported 23 tables with RLS enabled and no policies. These are informational deny-by-default/service-role-only patterns and must be reviewed table-by-table rather than automatically “fixed”.
- The advisor reported pg_net installed in public.
- The performance advisor reported 15 unused indexes. Do not drop them without checking workload and retention history.

Development:
- No health advisor findings were returned.
- The security advisor reported 17 RLS-enabled tables without policies; review as deny-by-default patterns.
- The performance advisor reported 14 unused indexes and one multiple-permissive-policy warning on teacher_access SELECT for authenticated users. Consolidation may be considered after confirming policy equivalence.
- Do not remove indexes solely because the advisor labels them unused.

## Remaining work and safe sequence

### Stage 1 — Complete the CRUD inventory

1. Trace every direct sb.from call in index.html and every module-specific direct read/write.
2. Record exact table projections, filters, ordering, conflict keys, row payloads, and authorization conditions.
3. Separate general sync operations from Student Affairs, timetable, attendance, duty, and roster-specific transactions.
4. Identify which local fields are credential verifiers and which are business permissions.
5. Add contract tests for every operation before replacing its transport.

### Stage 2 — Complete the safe read migration

1. Use the server-derived app session for all protected reads.
2. Define a minimal projection for each table and principal type.
3. Never return teachers.pin_hash, teachers.pin_salt, or school_settings.admin_pin.
4. Replace the general sync loader with paginated, scoped gateway reads.
5. Preserve the manifest optimization, 14-day localStorage behavior, and offline snapshots.
6. Test administrator, teacher, custom-user, expired-session, missing-session, and cross-class access boundaries.

### Stage 3 — Implement server-side writes

1. Add explicit, validated write actions for each supported table and operation.
2. Use fixed allow-lists for table names, columns, and conflict keys; never accept arbitrary SQL identifiers from the client.
3. Preserve teacher permission merge semantics.
4. Preserve classes/students coupling and student-history guarantees.
5. Use atomic upsert/update transactions with idempotency protection.
6. Return safe error codes only; never return submitted rows or credential fields in diagnostics.
7. Keep the client dirty set until the server confirms the exact write.

### Stage 4 — Replace generic deletes safely

1. Keep queued deletes review-only while the server replacement is built.
2. Design explicit delete intents for each table, with per-action authorization and exact filter validation.
3. Add idempotency and auditability.
4. Prove that class deletion, student transfer, attendance/behavior history, teacher removal, and duty-report cleanup preserve their current semantics.
5. Only enable server deletion after the review and integration tests pass.

### Stage 5 — Development verification and production cutover

1. Reconcile the deployed development timetable-management function against current main before overwriting it.
2. Deploy to development only, using the complete function dependency set.
3. Run authenticated API tests using synthetic teachers, custom users, permissions, sessions, timetable rows, and cleanup.
4. Compare server responses against the current application contract.
5. Run the complete GitHub test suites and preview smoke test.
6. Prepare rollback instructions and confirm the exact production deployment contents.
7. Obtain explicit approval before production Edge Function deployment or any production RLS/grant change.
8. Tighten production anon access only after all read/write/delete/auth/offline workflows have been migrated and verified.

## Current implementation checkpoint

Completed and merged to main on 2026-11-20:
- Server-side general app online login/session integration already present in the application path.
- Revision-manifest polling and protected startup/sync safeguards.
- Redaction of failed sync row payloads and raw database error messages.
- Two-minute background polling with immediate resume triggers.
- Timetable authorization query reuse, action-scoped permission reads, reuse of preloaded teacher directories, and CORS preflight caching.

Verified:
- Student Affairs backend tests passed on main commit 3ba55f45936cdb91e8e7fbfd4df1c466407c7707.
- Timetable management tests passed on that commit.
- GitHub Pages build/deployment passed on that commit.
- The PR preview smoke test passed for the timetable query-reuse branch.
- No production database data, credentials, grants, or RLS policies were changed by these merged changes.
- No Supabase Edge Function was deployed as part of these merges.
- No query_logs call was made in this pass, so actual Log Query GB before/after remains unmeasured.

## Next implementation unit

Continue with the complete direct-CRUD inventory and the authenticated read/write contract. Do not change production RLS, grants, PIN verifiers, or Supabase function deployments until the development-only API verification and rollback plan are complete.
