# Student Affairs security and deployment notes

This change adds the Student Affairs reporting feature to the School Abu Dujana application.

## Implemented
- Student Affairs uses a server-side Supabase Edge Function and a separate session store.
- Existing teacher/admin PIN records are verified without overwriting the legacy PIN fields. A successful first verification creates a stronger server-side PBKDF2 verifier.
- Session tokens are random, expire after eight hours, and only their SHA-256 hashes are stored.
- Class-scoped report access is enforced on the server. Unauthorized class requests are rejected.
- Attendance, behavior, combined-print, and analytics modes have separate permission checks.
- Admin permission changes invalidate the affected teacher's existing Student Affairs sessions.
- Login attempts are rate-limited.
- The existing application login is reused; users are not asked for a second PIN.
- The Student Affairs view is integrated into `index.html`.

## Production deployment
The Student Affairs migrations and Edge Function have been applied to the production Supabase project `ylsocrvwqibptuwfzbke`. The frontend preview is configured to use that production function. The school records remain in the existing production tables; no student, teacher, attendance, behavior, or PIN records were copied into the development project or rewritten by these changes.

The three Vault values used by the server-side verifier and legacy compatibility lookup must remain in Supabase Vault. Never copy their values into repository files, frontend code, issue comments, or logs.

## Existing application boundary
The original application continues to use its existing Supabase data access and offline synchronization for its established attendance and behavior workflows. This change does not tighten or replace those existing Data API policies. Do not tighten them as part of this feature: doing so before a separately planned migration of all legacy reads, writes, and offline synchronization would disrupt existing workflows.

The legacy compatibility peppers were historically present in the public client. Moving the new verification path to Vault does not retroactively make those historical values secret. Treat this as a compatibility bridge, and plan a separate credential-rotation/migration review before claiming complete credential secrecy.

## Verification
- GitHub Actions checks inline JavaScript syntax, runs report authorization tests, and type-checks the Edge Function.
- The production preview was opened by the school administrator; Student Affairs loaded and displayed the school records.
- Delegated teacher access, permission revocation, and all print/export combinations should continue to be verified as part of operational acceptance.

## Edge Function configuration
`student-affairs` uses `verify_jwt = false` because it issues its own random bearer-session tokens. Every non-login action validates the token against the hashed server-side session record. The service-role key is read only from the Edge Function runtime environment and is never sent to the browser.
