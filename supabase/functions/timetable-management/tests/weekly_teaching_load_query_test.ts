const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve weekly workload reads only matched teaching cells and required columns", () => {
  const start = source.indexOf("const [directory,dayCells,weeklyLoad,pointsLedger]");
  const end = source.indexOf("const weeklyQuotaByTeacher", start);
  assert(start >= 0 && end > start, "Reserve candidate workload query block must exist");
  const block = source.slice(start, end);

  assert(
    block.includes('.select("matched_teacher_name,teacher_source_name,weekday,period")'),
    "Weekly workload must select only the teacher identity, weekday, and period columns needed for scoring",
  );
  assert(
    block.includes('.eq("version_id",activeVersion.id).eq("cell_status","teaching")'),
    "Weekly workload must filter teaching cells at the database",
  );
  assert(
    !block.includes("cell_status,weekday"),
    "Weekly workload must not select the status column or fetch non-teaching cell rows",
  );

  const mappingEnd = source.indexOf("const actorDirectoryEntry", end);
  const mapping = source.slice(end, mappingEnd);
  assert(mapping.includes('status:"teaching"'), "Teaching-only rows must retain teaching semantics for fairness scoring");
  const activeNamesStart = mapping.indexOf("const activeTeachingTeacherNames");
  const activeNames = mapping.slice(activeNamesStart);
  assert(
    activeNames.includes("resolveTimetableTeacherName(cell.matched_teacher_name,cell.teacher_source_name,systemTeachersForReserve)"),
    "Active teacher eligibility must retain source-name fallback for legacy/unmatched timetable rows",
  );
  assert(
    !activeNames.includes('cell.cell_status'),
    "The active-teacher resolver must not read cell_status because the database query filters it out",
  );
});
