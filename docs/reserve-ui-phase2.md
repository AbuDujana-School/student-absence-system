# Reserve distribution — Phase 2 UI unification

## Goal
Provide one consistent reserve-distribution experience without changing the backend authorization model, login/session lifecycle, assignment data, or production deployment.

Working branch: `refactor/reserve-ui-phase2`
Base: `main` at `688591ffb606fb13f1964843666b99e8d1af9c87`

## Initial code audit

The two identified surfaces are not safe to delete as if they were duplicate copies:

1. `#timetableSubstitutionPanel` is the current full distribution workspace. `reserve-workflow.js` installs the three-step distribution UX, absent-teacher search, batch preview, manual substitute selection, draft restore, approval-before-save, other-department selection, and the daily active/archive panels. Its backend actions include `timetable_substitution_batch_preview` and `timetable_substitution_batch_save`.
2. `#substitutionView` is the home/main-menu reserve surface. The same file integrates absence-reason selection into its absent-teacher controls and adds a current-day assignments view with group edit/delete actions. It also contains a cumulative archive panel (historical archive is not a priority for this phase).

The surfaces therefore overlap in purpose but contain distinct behavior. Blindly hiding or deleting either would risk losing absence reasons, current-day edit/delete, or the batch distribution flow.

## Findings and fixes completed on the isolated branch

1. Removed obsolete test assertions that required the retired schoolwide reserve report installer and its deleted permission. The absence-reason, current-day assignment, edit/delete, and view-initialization tests remain.
2. Restored the department coordinator's batch preview/save and active edit actions in the action allowlist. This does not grant schoolwide statistics, archive, reset, or cross-department access.
3. Added a shared department-scope guard for custom coordinator mutations. Single and batch cancellation verify that the absent teacher belongs to the coordinator's department. Custom accounts remain excluded from archive and edit actions; general admins and reserve-enabled teachers retain their existing edit path.
4. Added Deno regression coverage for the capability matrix, department boundaries, and guard placement in each cancellation handler.

The custom coordinator checks are enforced server-side; hiding buttons in the UI is not treated as authorization. The existing general-admin principal resolver and login/session resolution code were not changed. In `session_auth.ts`, only the action allowlist for the already-resolved `custom` principal was extended.

## Phase 2 implementation direction

- Establish one canonical distribution workflow and one source of truth for its state and actions.
- Keep the existing main-menu entry point usable; it should open the canonical workflow rather than maintain a second independent distribution flow.
- Retain the timetable workspace's batch preview, candidate selection, fairness logic, draft handling, review, and explicit save.
- Retain the home surface's absence-reason capture and current-day assignment visibility/edit/delete, but integrate these into the canonical workflow rather than maintaining duplicate distribution controls.
- Historical cumulative archive and PDF are explicitly out of scope for this phase.
- Keep `requirePrincipal`, general-admin login/session resolution, account roles, teacher permission records, and database records unchanged during UI unification. Any further capability change must be separately justified, department-scoped, and covered by regression tests.

## Required regression checks

1. General system administrator can log in and open the reserve workspace.
2. Delegated administrator (including Tester 1) can log in and sees only the tools allowed by the current grants.
3. Each existing reserve-enabled teacher can open the canonical workflow.
4. Ordinary teacher without reserve permission cannot gain distribution controls or invoke privileged backend actions.
5. Absence reason is still required and attached to the correct absent teacher/date.
6. Batch preview still covers all selected absent teachers and their lessons.
7. Manual substitute choices and selected cross-department teachers remain constrained to returned candidates.
8. Draft restore remains actor/date scoped and does not leak between accounts.
9. Save, edit, and cancel still call the existing backend actions; no UI-only permission check is treated as security.
10. Current-day assignments remain visible to the same authorized audience and edit/delete controls continue to follow server-provided `canEdit`/`canDelete`.

## Safety boundary

- No teacher or student records were inserted, updated, or deleted.
- No PIN, credential, `app_sessions` row, general-admin identity path, or session creation logic was changed.
- No Supabase migration, SQL write, Edge Function deployment, production merge, or production publish was performed.
- The new server-side scope checks read the existing teacher directory and active timetable; they do not mutate either.

This branch is separate from Phase 1 permission design and from the historical PDF/archive work. No production code is changed by this audit document. Do not merge or deploy until the unified flow and the login/permission regression suite pass.
