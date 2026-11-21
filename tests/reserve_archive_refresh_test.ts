const source = await Deno.readTextFile(new URL("../reserve-workflow.js", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve archive refresh is centralized and mutation-only", () => {
  const legacyStart = source.indexOf("function installLegacyOtherDepartmentTeacherPicker()");
  const homeStart = source.indexOf("function installHomeReserveArchive()", legacyStart);
  const autoStart = source.indexOf("function installReserveArchiveAutoRefresh()");
  assert(legacyStart >= 0 && homeStart > legacyStart && autoStart > homeStart, "Reserve request wrappers must exist in the expected order");

  const legacy = source.slice(legacyStart, homeStart);
  const auto = source.slice(autoStart);
  assert(!legacy.includes("substitutionLoadCumulativeArchive()"), "The legacy request wrapper must not duplicate cumulative archive reads");

  assert(auto.includes("const reserveMutationActions=new Set(["), "A single explicit mutation allowlist must control reserve archive refresh");
  for (const action of [
    "timetable_substitution_batch_save",
    "timetable_substitution_save",
    "timetable_substitution_update",
    "timetable_substitution_update_batch",
    "timetable_substitution_cancel",
    "timetable_substitution_cancel_batch",
  ]) {
    assert(auto.includes('"'+action+'"'), "Archive refresh must follow mutation: " + action);
  }
  for (const readOnlyAction of [
    "timetable_substitution_preview",
    "timetable_substitution_batch_preview",
    "timetable_substitution_departments",
    "timetable_substitution_reset_options",
    "timetable_substitution_archive",
    "timetable_substitution_stats",
  ]) {
    assert(!auto.includes('"'+readOnlyAction+'"'), "Read-only action must not trigger mutation archive refresh: " + readOnlyAction);
  }
  assert(auto.includes("const reserveAction=reserveMutationActions.has(action)"), "Only allowlisted mutations may trigger the reserve archive refresh path");
  assert(auto.includes('action==="timetable_substitution_archive_access"&&result?.canView===true'), "Authorized archive opening must still load the archive");
});


Deno.test("home reserve archive handles non-school days without an uncaught error or server read", () => {
  const start = source.indexOf("window.substitutionLoadHomeTodayAssignments = async function()");
  const end = source.indexOf("window.substitutionRenderHomeTodayAssignments", start);
  assert(start >= 0 && end > start, "Home-today reserve loader must exist");
  const loader = source.slice(start, end);
  const weekendGuard = loader.indexOf('validationMessage.includes("الاحتياط متاح لأيام الدراسة من الأحد إلى الخميس فقط.")');
  const weekendReturn = loader.indexOf("return false;", weekendGuard);
  const tokenRead = loader.indexOf("const token=", weekendGuard);
  assert(weekendGuard >= 0 && weekendReturn > weekendGuard, "Weekend validation must be handled as a normal empty-day state");
  assert(tokenRead > weekendReturn, "Weekend handling must return before reading a session token or calling Supabase");
  assert(loader.includes("لا توجد تكليفات احتياط في أيام العطلة الأسبوعية."), "The home panel must show a clear weekend message");
});


Deno.test("schoolwide reserve report groups all departments by day in newest-first order", () => {
  const start=source.indexOf("function schoolwideReserveReportBuildDays(rows){");
  const end=source.indexOf("\n  function schoolwideReserveReportRender()",start);
  assert(start>=0&&end>start,"Schoolwide reserve report grouping function must exist");
  const factory=new Function(source.slice(start,end)+"; return schoolwideReserveReportBuildDays;") as
    () => (rows: Record<string,unknown>[]) => Array<{date:string;groups:Array<{absentName:string;rows:Array<{period:number}>}>}>;
  const build=factory();
  const days=build([
    {assignmentDate:"2026-11-20",weekday:"الخميس",absentTeacherName:"أحمد",absentTeacherDepartment:"لغة عربية",period:4,substituteTeacherName:"سالم"},
    {assignmentDate:"2026-11-20",weekday:"الخميس",absentTeacherName:"خالد",absentTeacherDepartment:"تربية إسلامية",period:2,substituteTeacherName:"علي"},
    {assignmentDate:"2026-11-20",weekday:"الخميس",absentTeacherName:"أحمد",absentTeacherDepartment:"لغة عربية",period:1,substituteTeacherName:"ناصر"},
    {assignmentDate:"2026-11-21",weekday:"الجمعة",absentTeacherName:"أحمد",absentTeacherDepartment:"لغة عربية",period:3,substituteTeacherName:"سالم"},
  ]);
  assert(days.length===2,"Every date with assignments must produce one report page group");
  assert(days[0].date==="2026-11-21"&&days[1].date==="2026-11-20","Report days must be newest first");
  assert(days[1].groups.length===2,"Different absent teachers and departments on one day must share that day's report");
  assert(days[1].groups.some(group=>group.absentName==="أحمد – لغة عربية"),"The absent teacher label must include the department");
  assert(days[1].groups.some(group=>group.absentName==="خالد – تربية إسلامية"),"All departments must be represented");
  const arabic=days[1].groups.find(group=>group.absentName==="أحمد – لغة عربية");
  assert(arabic?.rows.map(row=>row.period).join(",")==="1,4","Lessons within each absent-teacher group must be sorted by period");
});

Deno.test("schoolwide reserve report uses one official page per day and a dedicated teacher grant", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  assert(html.includes('id="reserveDistributionReportPanel"'),"The reserve report panel must live inside the main reports section");
  assert(html.includes('id="perm_p_reportSubstitutionDistribution"'),"Teacher permissions must include the reserve report checkbox");
  assert(source.includes('action:"timetable_substitution_report"'),"The report must read from the dedicated schoolwide report action");
  assert(source.includes('const options={singlePage:true,title:"توزيع الاحتياط"}'),"The official print template must create a single page for each day");
  assert(source.includes("window.printSchoolwideReserveDistributionReport(schoolwideReserveReportDays)"),"The date-grouped report must use the official schoolwide printer");
  assert(source.includes("wrappedSave.__reserveDistributionWrapped"),"Teacher permission saving must preserve the dedicated report grant");
  assert(source.includes("wrappedSwitch.__reserveDistributionWrapped"),"The reports tab must open for teachers with the dedicated reserve-report grant");
});

Deno.test("whole-absence deletion includes completed same-day lessons while group editing excludes them", () => {
  const deleteStart=source.indexOf("window.timetableDailyCancelAbsentDistribution = async function");
  const editStart=source.indexOf("window.timetableDailyOpenArchiveDayEdit = async function(");
  assert(deleteStart>=0&&editStart>deleteStart,"Group deletion and group editing handlers must exist");
  const deletion=source.slice(deleteStart,editStart);
  const editing=source.slice(editStart,source.indexOf("window.timetableDailyOpenArchiveEdit",editStart));
  assert(deletion.includes('["assigned","confirmed","completed"].includes(item.status)'),"Whole-group deletion must include completed lessons");
  assert(deletion.includes('action:"timetable_substitution_cancel_batch"'),"Whole-group deletion must use the atomic batch cancellation action");
  assert(editing.includes('["assigned","confirmed"].includes(item.status)'),"Group editing must include only active lessons");
});
