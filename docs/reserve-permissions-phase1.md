# Reserve distribution — Phase 1 permission design

## Scope and safety

This phase documents and prepares a least-privilege permission model for the reserve-distribution workflow. It does not change production permissions, database rows, stored assignments, points, audit records, or deployed functions.

Working branch: `refactor/reserve-permissions-phase1`

## Current authorization facts verified in code

1. `permissions.admin === true` on a teacher identity is elevated to `principal.type === "admin"` in `session_auth.ts`. This is broad delegated administrator authority for timetable-management actions, not a reserve-only role.
2. `permissions.reserve === true` is loaded from the current teacher record and is the main grant for teacher reserve actions.
3. `canUseTimetableAction` gives reserve-enabled teachers preview, departments, save, cancel, batch save/cancel, statistics, archive, update, batch update, reset options and reset actions.
4. Archive access has a second check: admin, reserve-enabled teacher, or explicit `timetable_access_permissions` grant. Therefore reserve permission itself currently includes archive access; the separate timetable grant can also permit archive-only reads.
5. Schoolwide reserve statistics have a separate `timetable_reserve_stats_access` grant. This grant is intentionally read-only for `timetable_substitution_stats`.
6. Custom principals have a narrower hard-coded set: preview, save, cancel and batch cancel. They do not receive the full teacher reserve action set.
7. The `admin_reserve_access` setting is an additional global gate for all `timetable_substitution_*` actions by admin principals.
8. Frontend tools are conditionally installed using local session/permission flags, but the backend is the actual enforcement boundary and must remain authoritative.

## Current database snapshot (read-only)

- Teacher accounts with `permissions.reserve=true`: 12.
- Teacher accounts with `permissions.admin=true`: 2; both currently also have `reserve=true`.
- `timetable_access_permissions`: 81 teacher rows, 0 enabled.
- `timetable_reserve_stats_access`: no rows returned in the current snapshot.
- No database rows were changed during this inspection.

## Main design risks

- `admin` is a broad privilege escalation and is not suitable as a substitute for a reserve coordinator role.
- The single `reserve` bit bundles multiple distinct capabilities: planning, saving, editing, cancelling, cross-department selection, archive access, statistics, and reset operations.
- Reset operations are particularly sensitive and should not automatically follow from ordinary reserve-distribution access.
- The custom-principal path does not align with the teacher-principal path, which makes grants harder to reason about.
- UI visibility and backend authorization are implemented separately; every UI control must be checked against the corresponding server action.

## Proposed capability model for review

| Capability | System administrator | Reserve coordinator | Archive viewer | Statistics viewer |
|---|---:|---:|---:|---:|
| Open reserve workspace | Yes | Yes | Optional read-only | Optional read-only |
| Preview distribution | Yes | Yes | No | No |
| Save distribution | Yes | Yes | No | No |
| Edit / cancel assignments | Yes | Yes, subject to time policy | No | No |
| Select supporting departments | Yes | Yes, subject to policy | No | No |
| Read reserve archive | Yes | Yes | Yes | No |
| Schoolwide reserve statistics | Yes | Optional separate grant | No | Yes |
| Reset one subject/day | Yes | Explicit separate grant recommended | No | No |
| Reset all active reserve records | Yes, admin-only | No | No | No |
| Manage reserve permissions | Yes | No | No | No |
| Manage timetable access | Yes | No | No | No |

## Recommended implementation sequence

1. Keep the existing `admin` and `reserve` semantics backward-compatible while introducing explicit capability helpers and tests.
2. Split ordinary reserve coordination from destructive reset permissions. Do not silently grant reset access to every current reserve coordinator.
3. Make archive viewing a clearly named capability rather than an accidental side effect of the general reserve grant; preserve existing authorized users during migration.
4. Keep schoolwide statistics as a separate read-only capability.
5. Keep cross-department support tied to reserve coordination and enforce it on the server.
6. Ensure custom accounts use the same capability policy as teacher accounts, with explicitly assigned capabilities.
7. Align frontend visibility with server decisions, but never rely on frontend checks for security.
8. Add regression tests for admin, delegated admin, reserve coordinator, archive-only viewer, stats-only viewer, ordinary teacher, and custom account.

## Decisions needed before changing live behavior

- Should all 12 existing reserve-enabled accounts retain the ability to edit and cancel assignments?
- Should any reserve coordinator be allowed to reset a subject/day, or should that be admin-only?
- Should reserve coordinators continue to see the schoolwide archive, or only their own department's records?
- Should cross-department support remain available to every reserve coordinator?
- Which custom accounts, if any, should receive reserve capabilities?

No authorization behavior or live permission grant is changed by this document.
