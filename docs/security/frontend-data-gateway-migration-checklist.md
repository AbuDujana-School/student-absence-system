# Frontend data-gateway migration and production-safety checklist

## Current staged migration status

### Stage 1 implemented in the PR branch

- Administrator reads for `classes`, `students`, `attendance`, `behaviors`, and `duty_reports` use `app_data_gateway_read` with bounded 500-row pages and a verified session/principal match.
- Administrator writes for the same five non-credential tables use `app_data_gateway_write`. The client requires the gateway's confirmed saved-row count to equal the chunk size before the caller can clear dirty keys.
- Browser validation runs locally in GitHub Actions with Playwright Chromium. All Supabase traffic is intercepted; fixtures are synthetic `QA_ONLY_*` data. No real backend is contacted.
- Admin gateway reads/writes, teacher/custom compatibility paths, pagination/manifest behavior, and timetable access are covered in the isolated browser regression.

### Why teacher/custom table migration is still gated

- The existing UI normalizes missing teacher `permissions.attendance` and `permissions.behavior` to `true`, while the gateway policy currently requires strict `=== true`. Migrating before matching this default would deny some existing teachers.
- The UI's generic teacher/custom attendance permission does not itself encode class scope. The gateway derives scope from the active timetable and explicit school-affairs grants. A custom account with an attendance/behavior permission but no timetable or applicable class grant could lose access if moved now.
- Therefore teacher/custom attendance and behavior reads/writes remain on the established path until a server-side compatibility resolver is proven against synthetic legacy/new permission fixtures and exact class-scope cases. Do not broaden access to all classes as a shortcut.
- Teacher roster and `school_settings` remain excluded because the former still supplies the existing offline PIN-login contract and the latter contains the administrator PIN verifier. Their replacement needs a dedicated credential lifecycle and explicit key-level settings actions.


## Current source audit

Audited the PR #329 frontend source at the current branch head. This document is a migration plan only; it does not change runtime behavior.

The frontend still has direct PostgREST access in these locations:

- `fetchAllPaginated` reads `classes`, `students`, `teachers`, `attendance`, `behaviors`, `school_settings`, and `duty_reports`.
- The `teachers` projection still requests `pin_hash` and `pin_salt`.
- `school_settings` still requests `key,value`, so privileged values must be filtered before they reach a client.
- `robustUpsert` still writes directly with `sb.from(table).upsert(...)`.
- Specialized direct settings writes remain for `admin_pin`, `custom_categories`, and `duty_module`.
- A legacy permission fallback still queries `teachers` directly.
- Duty-report submission and deletion still mutate local duty state and enqueue cloud operations.

## Non-negotiable migration invariants

1. Do not change the current teacher/admin/custom login contract, PIN verification, retry/lockout behavior, existing offline PIN login behavior, or session restoration until an equivalent replacement is implemented and passes preview tests.
2. Do not expose PIN hashes, salts, admin PIN verifiers, bearer tokens, or other reusable credential material to the browser through the final gateway contract.
3. Do not change production RLS policies, grants, records, PIN values, or deployed Edge Functions as part of frontend migration.
4. Do not clear local school data, dirty snapshots, pending edits, queued deletes, or local revision/manifest state during credential changes or failed sync.
5. Cloud reads and writes require a valid server-authenticated application session and server-derived principal/scope. Client-provided role, class, teacher name, and permissions are not authorization evidence.
6. Preserve current pagination, conflict keys, atomic batch behavior, revision/manifest validation, retry/backoff, and dirty-key clearing only after confirmed server success.

## Read migration matrix

| Data | Existing behavior | Gateway requirement |
|---|---|---|
| classes | Full paginated read | Return only permitted class metadata; preserve stable sorting and class scope |
| students | Full paginated read | Enforce server-derived class scope; preserve class/name identity and transfer behavior |
| teachers | Reads roster plus PIN verifier fields | Return no hash/salt fields. The current policy's self-only teacher projection is insufficient for existing authorized screens: the UI uses the full teacher directory for session-registration/teacher-activity statistics, category deletion checks, duty-day/category helpers, and teacher management. Add a narrowly projected directory action gated by server-verified `permissions.teachers` (or admin); ordinary teachers must receive only their own profile. Do not widen the generic teachers-table policy to all teachers. |
| attendance | Full paginated records | Enforce class/date scope; preserve record keys, period, teacher attribution, and update revision |
| behaviors | Full paginated records | Enforce behavior permission and class/date scope independently of attendance permission |
| school_settings | Reads all key/value rows | Explicit allowlist by role and key; never return admin PIN verifier; preserve duty/custom-category behavior where authorized |
| duty_reports | Reads report rows | Separate teacher submission/read scope from manager review/update scope; do not assume all non-admin users are equivalent |

## Write migration matrix

- Classes: preserve canonical class keys and the existing conflict target.
- Teachers: preserve account names, role, permissions, and must-change-PIN semantics. PIN changes must use the dedicated server-side credential action, never a generic table upsert.
- Students: preserve class/name identity, transfers, and any dependent attendance/behavior mapping.
- Attendance and behaviors: preserve atomic chunks, record keys, local dirty snapshots, timestamps, and server-side class scope.
- Settings: use explicit key-specific actions for admin PIN rotation, custom categories, and duty module settings. Do not expose generic writes to protected keys.
- Duty reports: teacher submission must be a dedicated action that derives reporter identity and authorization window from the authenticated session and server-side schedule. Managers alone may review/change status. Do not allow client-supplied `reported_by`, `teacher_name`, `reviewed_by`, or status transitions to grant authority.
- Deletes: current queue is deliberately fail-closed. Do not silently enable generic delete. Design and test each delete/transfer workflow explicitly before changing this.

## Permission compatibility gate

The backend resolver currently derives attendance/behavior access using grant keys such as `can_read_attendance` and `can_read_behavior`, while policy logic also checks permission fields such as `permissions.attendance` and `permissions.behavior`. Before UI migration, add explicit tests proving that existing authorized teacher/custom accounts retain access and unauthorized accounts remain denied. Do not rename or reinterpret permission keys without a compatibility mapping based on actual production-shaped synthetic fixtures.

## Required browser preview matrix

Use synthetic preview data only. Run each case for admin, teacher, and custom accounts where applicable:

- Login online, restore an existing secure session, and preserve the existing offline login/restore contract.
- Initial load, no-change manifest refresh, changed manifest refresh, pagination beyond one page, and transient manifest/network failure.
- Attendance and behavior reads with separate grants, cross-class denial, date filtering, and empty datasets.
- Teacher roster/profile/permissions without verifier material; PIN change and must-change-PIN flow.
- Student create/update/transfer, attendance save, behavior save, and concurrent dirty edits.
- Duty teacher submit, unauthorized submit denial, manager review, and protected duty-module settings.
- Custom-category read/write restrictions and admin-only settings.
- Offline edit, app close/reopen, reconnect, retry, failed batch, and preservation of all pending dirty snapshots.
- Logout, account switching, revoked/expired session, and failed credential revalidation without loss of local school data.
- Verify no browser network request directly reads or writes the seven protected tables after the migration.

## Cutover and rollback

- Keep PR #329 and PR #330 as drafts until all UI and browser preview gates pass.
- Review the complete frontend diff and run syntax checks plus role-based browser tests before merge.
- Stage backend deployment separately from production RLS/grant tightening.
- Record pre-cutover policy/grant state and prepare a tested rollback that restores the prior application path without modifying school records.
- Tighten production policies/grants only in a separately approved, monitored cutover after the gateway-backed frontend is live and verified.


### Stage 2 — teacher/custom attendance and behavior reads

- Teacher and custom accounts now route only `attendance` and `behaviors` reads through the authenticated gateway. The request requires an unexpired session whose server-issued principal type and name exactly match the active account.
- Teacher permission normalization now matches the existing UI: attendance/behavior are enabled unless explicitly `false`. Custom accounts remain explicit opt-in and are not default-granted.
- Class filters continue to come only from server-side timetable assignments and explicit Student Affairs grants. A valid account with no server-derived class scope receives an empty page, not an unscoped query or a sync-stopping authorization error.
- Teacher/custom reads for classes, students, duty reports, teacher roster, and settings remain on the compatibility path. Teacher/custom writes remain unchanged pending row-ownership and offline retry tests.
- Isolated Chromium coverage now checks administrator reads, teacher attendance reads, custom behavior reads, and verifies the two migrated tables do not fall back to direct PostgREST reads for those roles.
