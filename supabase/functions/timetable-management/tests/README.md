# Timetable management verification

## Unit tests

Run from the repository root:

```sh
deno test --no-check supabase/functions/timetable-management/tests
```

The suite uses synthetic names and in-memory fixtures only. It verifies:
- Seven-period completeness and teacher-count validation.
- Normalization of the Islamic subject label.
- Preservation of meeting and unclear states.
- Conservative teacher-name matching.
- Substitution eligibility, including explicit free status, duplicate cells, department scope, and existing assignments.

## Environment boundary

Do not use production teacher, student, PIN, or session data in development tests.
Database integration checks must use disposable synthetic records in the development project and remove them after verification.
