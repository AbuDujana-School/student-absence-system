import { aggregateClassTimetables } from "../timetable_class_grid.ts";
import { parseTimetableDay } from "../timetable_grid.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("class audit includes every expected class and counts shared lessons once", () => {
  const weekdays = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
  const classes = ["11/1","11/2"];
  const summaries = aggregateClassTimetables([
    {weekday:"الأحد",period:1,cell_status:"teaching",class_sections:["11/1"],subject:"رياضيات",matched_teacher_name:"معلم أ"},
    {weekday:"الأحد",period:1,cell_status:"teaching",class_sections:["11/1"],subject:"رياضيات",matched_teacher_name:"معلم ب"},
    {weekday:"الأحد",period:2,cell_status:"free",class_sections:["11/1"],subject:"فراغ"},
    {weekday:"الأحد",period:3,cell_status:"meeting",class_sections:["11/1"],subject:"اجتماع"},
    {weekday:"الأحد",period:4,cell_status:"activity",class_sections:["11/1"],subject:"نشاط"},
  ],weekdays,7,classes);
  assert(summaries.length===2,"must return all expected classes, including empty ones");
  const first=summaries.find(item=>item.className==="11/1")!;
  const second=summaries.find(item=>item.className==="11/2")!;
  assert(first.teachingCount===2,"shared teaching counts once and occupied activity counts as a lesson");
  assert(first.entries.find(item=>item.period===1)?.coTeachingCount===2,"shared teachers must remain visible");
  assert(first.freePeriods.length===1,"free period must be excluded from teaching count");
  assert(first.meetingPeriods.length===1,"meeting must be excluded from teaching count");
  assert(first.vacancies.length===31,"unassigned class periods must be reported");
  assert(second.vacancies.length===35,"an entirely missing class must still be audited");
});

Deno.test("different subjects assigned to one class period are reported as a conflict", () => {
  const result=aggregateClassTimetables([
    {weekday:"الأحد",period:1,cell_status:"teaching",class_sections:["11/1"],subject:"رياضيات",matched_teacher_name:"معلم أ"},
    {weekday:"الأحد",period:1,cell_status:"teaching",class_sections:["11/1"],subject:"علوم",matched_teacher_name:"معلم ب"},
  ],["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"],7,["11/1"]);
  const first=result[0];
  assert(first.conflicts.length===1,"different subjects in the same slot must be a conflict");
  assert(first.teachingCount===0,"conflicted slots must not be counted as a confirmed lesson");
  assert(first.complete===false,"a conflicted class week is not complete");
});

Deno.test("empty text day is preserved as an empty day with a warning", () => {
  const result=parseTimetableDay("الأحد","");
  assert(result.weekday==="الأحد","weekday should be preserved");
  assert(result.teachers.length===0,"empty source day should not invent teachers");
  assert(result.totalCells===0,"empty source day should not invent cells");
  assert(result.warnings.length>0,"empty source day should create a review warning");
});
