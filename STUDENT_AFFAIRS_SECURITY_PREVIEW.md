# Student Affairs secure backend (preview)

This branch contains a development-only backend foundation for the Student Affairs read-only reports feature.

## Changes in this preview
- Separate tables for server-upgraded PIN verifiers, hashed sessions, scoped report permissions, and login throttling.
- New verifier pepper is generated in Supabase Vault and is not embedded in the Edge Function.
- Existing PIN hashes are checked server-side during first-use migration; successful verification creates a stronger server-peppered PBKDF2 verifier without overwriting the legacy teacher/admin PIN fields.
- Legacy compatibility peppers are fetched only through a service-role-only Vault RPC. Their values must be provisioned in Vault in the isolated development project before first-use migration can work.
- Important: the legacy peppers were previously shipped in the public client. Moving them to Vault prevents further hardcoding in the new Edge Function, but does not make the old values secret retroactively. Treat this only as a compatibility bridge; a later PIN rotation/migration policy is required before claiming full credential secrecy.
- Session tokens are random, stored only as SHA-256 hashes, and expire after eight hours.
- Report access is filtered server-side by allowed classes. A request containing any unauthorized class is rejected rather than silently widened or partially honored.
- Print modes are independently enforced by the server:
  - `print_attendance` requires attendance read + attendance print.
  - `print_behavior` requires behavior read + behavior print.
  - `print_combined` requires both read permissions + combined print permission.
  - `analytics` requires analytics permission and returns aggregate counts only.
- Changing a teacher's permissions invalidates that teacher's active sessions so stale privileges cannot remain in use.
- Automated Deno tests cover report-mode authorization combinations.

## Required development setup
The migration `20261109073300_student_affairs_legacy_pepper_vault_lookup.sql` creates a service-role-only function that reads two compatibility values from Vault. Before testing first-use PIN migration, provision these Vault secret names in the isolated development project only:
- `student_affairs_legacy_app_pepper`
- `student_affairs_legacy_sha_pepper`

Use the corresponding legacy values from the historical client source as a temporary compatibility bridge. Do not put those values into repository files, migrations, frontend code, or logs. The function intentionally fails closed if the Vault values are missing.

Run the policy tests with Deno:
```sh
deno test supabase/functions/student-affairs/report_policy_test.ts
```

## Development project and data safety
Migrations and Edge Function deployment are restricted to the isolated development project `wawplttrpiinoukpjqqx`. It must remain empty of real school records. No student, teacher, attendance, behavior, or PIN records were copied from production.

## Important limitations
- The original application still performs legacy direct Supabase reads/writes. This backend preview does not yet close those Data API paths.
- Production policies must not be tightened until all application reads/writes and offline synchronization have been migrated to an authenticated backend and tested; doing so prematurely would break existing workflows.
- The development project has no real teacher/PIN records, so end-to-end authentication, credential migration, and class-scoped data tests require synthetic test fixtures or a separately approved test dataset.
- This backend is not integrated into `index.html`, and is not ready for production.
- Do not merge to the production branch or deploy to production until the complete application migration, browser tests, and security review are complete.

## Deployment configuration
`student-affairs` uses `verify_jwt = false` because it issues its own random bearer-session tokens. Every non-login action validates the token against the hashed server-side session record. The service-role key is read only from the Edge Function runtime environment and is never sent to the browser.
