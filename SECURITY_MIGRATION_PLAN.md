# Database Access Security Migration Plan

## Scope and safety boundary

This document records a read-only audit and a staged migration plan. It does not change the live database, database rows, grants, RLS policies, Supabase configuration, deployment settings, or production application.

**Hard constraints**
- Preserve every existing row and every existing table/column.
- No destructive SQL, table recreation, bulk rewrite, PIN reset, or credential migration without a separate reviewed plan and explicit approval.
- Keep the production branch and production URL unchanged.
- Build and verify replacements on the feature branch first.
- Do not revoke the current direct-access grants until every dependent workflow has been migrated and tested.

## Audited application paths

The current frontend initializes a Supabase browser client using the public anon key and directly accesses these tables:

| Table | Frontend operations found | Data sensitivity / concern |
|---|---|---|
| classes | paginated select, upsert, delete | school structure |
| students | paginated select, upsert, delete | student names and class membership |
| teachers | full select, upsert, select permissions, delete | teacher names, roles, permissions, PIN hash and salt |
| attendance | full select, upsert, delete | student attendance records |
| behaviors | full select, upsert, delete | student behavior records |
| school_settings | full select, upsert | includes admin PIN verifier and system settings |
| duty_reports | paginated select, upsert, delete | staff/duty records |

The direct operations are centralized partly in generic helpers:
- `fetchAllPaginated`
- `robustUpsert` (including select/update/insert fallback)
- `queueCloudDelete`
- `flushPendingDeletes`

Additional direct reads/writes exist for teacher permission preservation, permission refresh, and settings persistence.

The frontend currently loads teacher rows with `*`, including PIN verifier fields, and the general login path validates PINs in the browser against locally loaded teacher/custom-user records. These are priority migration targets.

## Existing backend capabilities

The `student-affairs` Edge Function already has server-side actions for login/session handling, permission retrieval and saving, reports, competition, team supervision, and analytics. This is a useful foundation for the Student Affairs area, but it is not yet a complete backend for the whole school application.

The current frontend's general application data synchronization is separate from the Student Affairs API and still uses direct browser-to-database access.

## Database metadata audit (read-only)

The public schema currently contains the application tables listed below:
- attendance
- behaviors
- classes
- competition_weekly_results
- duty_reports
- school_settings
- student_affairs_credentials
- student_affairs_login_attempts
- student_affairs_permissions
- student_affairs_sessions
- students
- teachers

Relevant existing structures include:
- `teachers.pin_hash`, `teachers.pin_salt`, `teachers.permissions`, `teachers.role`
- `school_settings(key, value)`
- `student_affairs_credentials`, `student_affairs_permissions`, and `student_affairs_sessions`
- attendance/behavior records stored in `records` JSONB with date, class, period, teacher and update timestamp columns.

Read-only metadata inspection found anon table grants and permissive RLS policies with `USING true` / `WITH CHECK true` on the seven tables used by the general frontend data sync: classes, students, teachers, attendance, behaviors, school_settings, and duty_reports. These permissions are currently required by the direct-access design; changing them before migration would risk breaking the application.

No application rows were selected or exported during this audit. No database writes or policy changes were made.

## Staged migration

### Stage 1 — Inventory and contract tests
1. Map every frontend caller to the seven direct-access tables and document exact read/write/delete behavior.
2. Record current row identity keys, conflict keys, ordering, pagination, offline queue semantics, and merge behavior.
3. Add tests for PIN login, permission refresh, teacher management, student management, attendance, behaviors, duty reports, settings, offline restore, queued deletes, and sync conflict handling.
4. Do not change database policy or production data.

### Stage 2 — Server-side identity
1. Implement a server-validated general application session.
2. Verify PINs on the server using the existing verifier format and existing pepper functions; do not reset or rewrite credentials.
3. Return only the minimum profile and permission fields needed by the browser. Never return PIN hashes or salts.
4. Keep the existing Student Affairs session path compatible until a reviewed consolidation plan exists.
5. Add rate limiting, session expiry, logout/revocation, and server-side authorization checks.

### Stage 3 — Read APIs
1. Add authenticated, permission-aware read endpoints for classes, students, teacher directory/profile, attendance, behaviors, settings, and duty reports.
2. Avoid returning secrets in teacher/settings responses.
3. Preserve pagination, filters, and offline fallback behavior.
4. Verify that unauthorized users cannot obtain data by calling endpoints directly.

### Stage 4 — Write APIs
1. Add validated server-side upsert/update/delete operations, with per-action authorization.
2. Preserve current conflict keys and merge rules.
3. Make retry behavior idempotent so offline queue replay cannot duplicate or unexpectedly remove records.
4. Keep a server audit trail for privileged changes where feasible without altering existing business records.

### Stage 5 — Dual verification, then cutover
1. Run integration tests against a non-production test environment with synthetic records only.
2. Compare read results and write outcomes without modifying production data.
3. Run full workflow tests for every user role and each school module.
4. Deploy backend and frontend changes to preview only.
5. Obtain explicit approval before any production cutover.
6. Only after successful cutover and verification, prepare a separate reviewed SQL migration to remove public/anon direct access. Keep a tested rollback path.

## Current status

- Read-only source and schema inventory: completed for the primary general-app load/save/auth paths; detailed endpoint-by-endpoint inventory remains in progress.
- Added a standalone general-app authentication policy module and unit tests on this feature branch only. These tests establish PIN format, principal projection, credential-field exclusion, token format, and expiry behavior; they do not yet authenticate users or change runtime behavior.
- Direct frontend database access: confirmed.
- General login validates credentials in the browser: confirmed.
- Existing Student Affairs backend: partial coverage only.
- Database rows changed: **none**.
- RLS policies or grants changed: **none**.
- Production deployment changed: **none**.
- Production URL changed: **none**.

## Next implementation unit

Begin with Stage 1 tests and the server-side identity design. Do not modify RLS, grants, tables, columns, or existing credentials as part of that work.
