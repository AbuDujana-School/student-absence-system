# Student Affairs secure backend (preview)

This branch contains the first backend stage for the Student Affairs read-only reports feature.

## Current scope
- Separate tables for server-upgraded PIN verifiers, hashed sessions, scoped report permissions, and login throttling.
- A server-only random PIN pepper is generated in Supabase Vault.
- The Edge Function validates the existing PIN verifier on first use, upgrades it into a server-peppered PBKDF2 verifier, and does not overwrite the existing PIN hash/salt fields.
- If the existing PIN hash or salt changes later, the bridge requires the current PIN to match the new source verifier before upgrading again.
- Session tokens are random, stored only as SHA-256 hashes, and expire after eight hours.
- Report reads are filtered server-side by allowed classes and independent attendance/behavior/analytics/print permissions.
- No student, teacher, attendance, behavior, or PIN records were copied into the development project.

## Development project
The migrations and function were applied only to the isolated development project `wawplttrpiinoukpjqqx`. Its existing school data tables remain empty.

## Important limitations
- The current production application still performs its legacy direct Supabase reads/writes. This preview backend does not yet close those legacy Data API paths.
- The production policies must not be tightened until the rest of the app has been migrated to a compatible authenticated backend; doing so prematurely would break attendance, behavior, offline sync, and existing workflows.
- The development project has no real teachers or PIN records, so successful real-user authentication and class-scoped data tests cannot be completed there. Only schema/privilege/deployment checks have been performed.
- This backend is not yet integrated into `index.html`, and is not ready for production.
- Do not merge or deploy to production until the app-wide data access migration and browser tests are complete.

## Deployment
`student-affairs` is configured with `verify_jwt = false` because it uses its own random bearer-session tokens. The function rejects requests without a valid stored session for all actions except PIN login. The service-role key is read only from the Edge Function runtime environment and is never sent to the browser.
