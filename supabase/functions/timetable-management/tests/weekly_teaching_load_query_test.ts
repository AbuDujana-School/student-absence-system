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
    block.includes('.select("matched_teacher_name,weekday,period")'),
    "Weekly workload must select only the teacher, weekday, and period columns",
  );
  assert(
    block.includes('.eq("version_id",activeVersion.id).eq("cell_status","teaching")'),
    "Weekly workload must filter teaching cells at the database",
  );
  assert(
    !block.includes("teacher_source_name") && !block.includes("cell_status,weekday"),
    "Weekly workload must not fetch legacy source names or non-teaching cell statuses",
  );

  const mappingEnd = source.indexOf("const systemTeachersForReserve", end);
  const mapping = source.slice(end, mappingEnd);
  assert(mapping.includes('status:"teaching"'), "Teaching-only rows must retain teaching semantics for fairness scoring");
});
