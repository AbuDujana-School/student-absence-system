const source = await Deno.readTextFile(new URL("../index.ts", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve weekly workload fetches once and filters teaching cells for scoring", () => {
  const start = source.indexOf("const [directory,dayCells,weeklyLoad,pointsLedger,periodTimings]");
  const end = source.indexOf("const weeklyQuotaByTeacher", start);
  assert(start >= 0 && end > start, "Reserve candidate workload query block must exist");
  const block = source.slice(start, end);

  assert(
    block.includes('.select("matched_teacher_name,teacher_source_name,cell_status,weekday,period")'),
    "Weekly workload must select teacher identity, status, weekday, and period for the shared workload read",
  );
  assert(
    block.includes('.eq("version_id",activeVersion.id).order("id")'),
    "Weekly workload must use one version-scoped read for both teaching load and active-teacher eligibility",
  );
  assert(
    !block.includes('.eq("cell_status","teaching")'),
    "The shared workload read must not filter out cells needed by the other timetable checks",
  );

  const mappingEnd = source.indexOf("const actorDirectoryEntry", end);
  const mapping = source.slice(end, mappingEnd);
  assert(
    mapping.includes("status:cell.cell_status"),
    "Workload scoring must retain the actual cell status",
  );
  assert(
    mapping.includes('.filter((cell:any)=>cell.cell_status==="teaching")'),
    "Only teaching cells may contribute to weekly workload and active-teacher eligibility",
  );
  const activeNamesStart = mapping.indexOf("const activeTeachingTeacherNames");
  const activeNames = mapping.slice(activeNamesStart);
  assert(
    activeNames.includes("resolveTimetableTeacherName(cell.matched_teacher_name,cell.teacher_source_name,systemTeachersForReserve)"),
    "Active teacher eligibility must retain source-name fallback for legacy/unmatched timetable rows",
  );
});