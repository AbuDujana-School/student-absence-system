import {
  selectTeacherTimetableCells,
  TEACHER_TIMETABLE_FALLBACK_FILTER,
  type TeacherTimetableCell,
} from "../teacher_timetable_cells.ts";

type Cell = TeacherTimetableCell & { id: number };

function resolve(cell: Cell): string | null {
  const stored = String(cell.matched_teacher_name || "");
  if (stored === "Teacher B") return "Teacher B";
  if (stored === "Teacher A") return "Teacher A";
  if (cell.teacher_source_name === "Legacy A") return "Teacher A";
  return null;
}

Deno.test("fallback query includes NULL name, NULL status, and unresolved statuses", () => {
  for (const clause of [
    "matched_teacher_name.is.null",
    "match_status.is.null",
    "match_status.neq.matched",
  ]) {
    if (!TEACHER_TIMETABLE_FALLBACK_FILTER.split(",").includes(clause)) {
      throw new Error("Missing fallback filter clause: " + clause);
    }
  }
});

Deno.test("exact-name rows are returned once even when also present in fallback", () => {
  const exact: Cell = { id: 1, matched_teacher_name: "Teacher A", teacher_source_name: "Teacher A" };
  const duplicate: Cell = { id: 1, matched_teacher_name: "Teacher A", teacher_source_name: "Teacher A" };
  const result = selectTeacherTimetableCells([exact], [duplicate], "Teacher A", resolve);
  if (result.length !== 1 || result[0].id !== 1) {
    throw new Error("Exact-name fallback row was duplicated");
  }
});

Deno.test("NULL matched name resolves through the legacy source name", () => {
  const legacy: Cell = { id: 2, matched_teacher_name: null, teacher_source_name: "Legacy A" };
  const result = selectTeacherTimetableCells([], [legacy], "Teacher A", resolve);
  if (result.length !== 1 || result[0].id !== 2) {
    throw new Error("Resolvable NULL-name legacy row was lost");
  }
});

Deno.test("unresolved and other-teacher rows are not leaked into the requested teacher result", () => {
  const other: Cell = { id: 3, matched_teacher_name: "Teacher B", teacher_source_name: "Teacher B" };
  const unknown: Cell = { id: 4, matched_teacher_name: null, teacher_source_name: "Unknown Person" };
  const result = selectTeacherTimetableCells([], [other, unknown], "Teacher A", resolve);
  if (result.length !== 0) {
    throw new Error("Fallback returned a row belonging to another or unknown teacher");
  }
});

Deno.test("legacy source can recover a row with an obsolete non-canonical stored name", () => {
  const legacy: Cell = { id: 5, matched_teacher_name: "Old Alias", teacher_source_name: "Legacy A" };
  const result = selectTeacherTimetableCells([], [legacy], "Teacher A", resolve);
  if (result.length !== 1 || result[0].id !== 5) {
    throw new Error("Legacy source-name fallback did not recover the row");
  }
});
