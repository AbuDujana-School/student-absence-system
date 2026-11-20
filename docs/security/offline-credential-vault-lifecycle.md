# Offline credential vault lifecycle and security gates

## Status

Design contract only. The vault is not connected to the school application. This document does not authorize changing teacher/admin login, PIN verification, app sessions, local school data, cloud synchronization, database policies, grants, or production deployments.

## Security invariants

1. A vault entry is bound to one principal (type and exact account name), one browser origin/profile, and a bounded expiry.
2. The stored AES-GCM key is non-extractable and the key plus ciphertext are written in one IndexedDB transaction. The current prototype uses one envelope slot; saving another principal replaces that slot.
3. The browser must never receive a reusable PIN verifier from the credential gateway as the final architecture. Encrypting a PIN hash in IndexedDB does not make it safe from malicious same-origin JavaScript or XSS.
4. This prototype does not implement or alter offline PIN login. Before integration, the school workflow must explicitly decide how the existing teacher login behavior (including any supported offline PIN use) is preserved. No existing login path may be removed, frozen, or changed without an equivalent replacement that has passed preview testing and is explicitly approved.
5. A failed, missing, corrupt, expired, or mismatched vault must fail closed. It must not silently fall back to a broad credential snapshot or weaker legacy verifier path.
6. Local attendance, behavior, roster, and pending-change data are separate from this credential vault. Clearing credentials must not delete school records or dirty/pending school data.

## Required lifecycle

### Enrollment

- Create/update the vault only after a successful online app_login and successful app-session establishment.
- Bind the entry to the server-confirmed principal and a server-issued credential/session epoch.
- The final integrated vault must not persist PIN hash, PIN salt, admin PIN verifier, or a reusable bearer credential. The current generic prototype can encrypt arbitrary snapshot objects and synthetic unit fixtures include verifier-shaped fields; that is not approval to connect real credential snapshots to this vault.
- Do not enable enrollment until the server can issue and validate a device-scoped offline restoration capability and the UI can use it without changing the existing login path.

### Offline continuation

- Permit only restoration of the same principal's previously established device session.
- Do not connect this prototype to the login flow. Existing online and offline teacher login behavior remains untouched until a safe, equivalent replacement is implemented and accepted.
- Enforce the eight-hour maximum lifetime in the current prototype; shorter server-issued expiries take precedence.
- Explain in product behavior that offline revocation cannot be learned immediately while disconnected. The maximum offline exposure window must be explicitly accepted before rollout.

### PIN rotation, disablement, and revocation

- A successful PIN rotation or account disablement must advance a server-controlled credential epoch and revoke prior app sessions.
- On the next reconnect, compare the vault epoch with the server's current epoch before loading cloud data or syncing pending changes.
- On mismatch, clear the credential vault and require the normal online authentication flow.
- A disconnected device cannot receive immediate revocation. The current eight-hour TTL is a hard upper bound, not a claim of instantaneous revocation.

### Logout and account switching

- Explicit user logout clears the vault key and envelope.
- Closing/reloading the app or losing connectivity is not an explicit logout and must not silently clear a still-valid continuation entry.
- The current store has one envelope slot. Switching principals must replace the entry atomically; a prior principal must not be restorable through a different principal's UI state.
- A future multi-account design requires separate, explicit principal partitions and tests proving no cross-account disclosure. Do not infer account identity from a user-editable display label alone.

### Browser profile reset and storage failure

- Clearing site data, losing the IndexedDB key, browser profile reset, or structured-clone failure invalidates the vault.
- Do not attempt to reconstruct a key from localStorage, source code, a hard-coded secret, or a server-delivered PIN verifier.
- Return to normal online login; retain independent local school data and pending changes unless the user explicitly chooses to clear them.

### Reconnect and synchronization

- Revalidate the app session, principal, credential epoch, permissions, and server-side scope before any cloud read or write.
- Preserve the existing revision/manifest checks, frozen dirty snapshots, pagination, retry behavior, and atomic gateway writes.
- A failed credential revalidation must stop cloud synchronization but must not discard local pending school changes.

## Platform limitations

A non-extractable WebCrypto key stored by IndexedDB is protected from straightforward key export and is scoped to the browser origin/profile. It is not a hardware-backed key and does not protect against malicious same-origin JavaScript, XSS, a compromised browser, or malware running with access to the profile. IndexedDB can be deleted by the browser or user.

## Acceptance gates before integration

- Document the current teacher login contract, including any supported offline PIN behavior, and preserve it. If a replacement is needed, it must provide equivalent behavior without exposing reusable PIN verifiers and must pass preview tests before the existing path can be changed.
- Implement the server-issued device/session capability and credential epoch.
- Test online login, existing-session restore, explicit logout, temporary app close, PIN rotation, account disablement, expiry, profile reset, multi-account switching, reconnect, and revoked-session behavior in a real browser.
- Test admin, teacher, and custom roles without changing their permissions or class scopes.
- Test pending attendance/behavior edits, roster changes, duty reports, student transfers, pagination, manifest/revision checks, and reconnect retries.
- Run the full isolated CI suite and deployed preview checks against synthetic data only.
- Prepare a separately reviewed production cutover and rollback plan. No RLS/grant changes or production deployment are authorized by this prototype.
