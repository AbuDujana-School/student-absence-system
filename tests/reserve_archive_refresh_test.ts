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


Deno.test("main substitution view requires, saves, and prints the selected absence reason", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  assert(source.includes("window.openSubstitutionAbsenceReasonPicker = function"),"The main substitution view must have access to the shared reason picker");
  assert(html.includes("function requestAbsenceReason(input,onComplete)"),"Selecting an absent teacher must request an absence reason");
  assert(html.includes("absenceReasonsByTeacher.has(name)"),"A reason is required for each selected absent teacher");
  assert(html.includes('absenceReason:absenceReasonsByTeacher.get(item.absentTeacherName)||"-"'),"The chosen reason must be included in the atomic batch-save payload");
  assert(html.includes("absenceReasonsByTeacher.get(name)||storedReason"),"The selected reason must be available to the official PDF when preview rows do not carry it yet");
  assert(source.includes('const ABSENCE_REASON_OPTIONS=["طارئة","مرضية","موعد مستشفى","دورة تدريبية","أخرى"]'),"The picker must retain the five approved absence reasons");
  assert(source.includes('if(choice==="أخرى"&&!custom)'),"The custom reason must be required when «أخرى» is selected");
});

Deno.test("main substitution view allows changing a reason by deselecting and reselecting", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  assert(html.includes("absenceReasonsByTeacher.delete(input.value);"),"Deselecting an absent teacher must clear the previous choice so reselecting opens the picker again");
  assert(html.includes("if(input.checked)requestAbsenceReason(input)"),"Selecting the teacher again must open the reason picker");
  assert(source.includes('reason:String(group?.reason||reasons[reasonKey(group?.absentName)]||"-")'),"The official PDF must prioritize the reason selected in the main substitution view");
});

Deno.test("main substitution absentee list displays the chosen absence reason", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  assert(html.includes("data-subx-absence-reason"),"The absentee card must display its selected absence reason");
  assert(html.includes("reasonLabel.textContent='سبب الغياب: '+String(value)"),"Confirming the modal must update the visible reason label");
});

Deno.test("whole-absence deletion includes completed same-day lessons while group editing excludes them", () => {
  const deleteStart=source.indexOf("window.timetableDailyCancelAbsentDistribution = async function");
  const editStart=source.indexOf("window.timetableDailyOpenArchiveDayEdit = async function(");
  const editEnd=source.indexOf("window.timetableDailyCancelAssignment = async function",editStart);
  const deleteEnd=source.indexOf("window.timetableDailyOpenArchiveEdit = async function",deleteStart);
  assert(deleteStart>=0&&editStart>=0&&editEnd>editStart&&deleteEnd>deleteStart,"Group deletion and group editing handlers must exist");
  const deletion=source.slice(deleteStart,deleteEnd);
  const editing=source.slice(editStart,editEnd);
  assert(deletion.includes('["assigned","confirmed","completed"].includes(item.status)'),"Whole-group deletion must include completed lessons");
  assert(deletion.includes('action:"timetable_substitution_cancel_batch"'),"Whole-group deletion must use the atomic batch cancellation action");
  assert(editing.includes('["assigned","confirmed"].includes(item.status)'),"Group editing must include only active lessons");
  assert(source.includes('const canDeleteGroup=currentRows.length>0&&currentRows.every(item=>item.canDelete===true);'),"Archive group deletion must use the separate same-day delete grant and exclude historical rows");
});


Deno.test("reserve coordinator controls require explicit per-period permissions", () => {
  assert(source.includes("item.canEdit===true"), "The interface must require an explicit edit grant");
  assert(source.includes("item.canDelete===true"), "The interface must require an explicit delete grant");
  assert(source.includes("item.canDelete!==true"), "Individual deletion must not rely on the edit permission");
  assert(!source.includes('date===reserveCurrentMuscatDate()&&savedRows'), "Future-dated assignments must not be hidden by a same-day-only UI condition");
});

Deno.test("main reserve entry point mounts one canonical batch workspace and restores the timetable panel", async () => {
  const integrationStart=source.indexOf("function installMainSubstitutionViewIntegration()");
  const integrationEnd=source.indexOf("installLegacyOtherDepartmentTeacherPicker();",integrationStart);
  assert(integrationStart>=0&&integrationEnd>integrationStart,"Canonical reserve integration must exist");
  const integration=source.slice(integrationStart,integrationEnd);
  assert(integration.includes('canonicalHost.id="substitutionCanonicalWorkspace"'),"The main reserve view must provide one canonical workspace host");
  assert(integration.includes('host.appendChild(panel)'),"The existing batch panel must be mounted instead of creating a duplicate");
  assert(integration.includes("restoreCanonicalPanel()"),"Closing the main view must restore the original timetable panel location");
  assert(integration.includes("__canonicalReserveInitialOpenAttempted"),"If the integration installs after the view becomes visible, it must initialize the canonical panel on that first opening");
  assert(integration.includes('$("timetableSubstitutionPanel")&&window.openSubstitutionView?.__canonicalReserveWrapped'),"First-open initialization must wait until the canonical panel exists so a late DOM mount can be retried");
  assert(integration.includes("return window.openSubstitutionView()"),"The first visible opening must replay the wrapped entry point exactly once");
  assert(integration.includes('window.timetableLoadSubstitutionOptions()'),"Opening the main view must load the batch workflow");
  assert(integration.includes('window.timetableDailyLoadArchive()'),"Opening the main view must refresh current-day assignments");
  assert(integration.includes('window.substitutionLoadStats()'),"The existing reserve statistics view must remain available");
  assert(integration.includes('$("substitutionAbsenteeList")?.closest(".rounded-3xl")'),"The legacy duplicate absentee workflow must be hidden");
  const boot=source.slice(source.indexOf("installMainSubstitutionViewIntegration();",source.indexOf("function installReserveArchiveAutoRefresh()")+1));
  assert(!boot.includes("installHomeReserveArchive();"),"The legacy home archive must not install a second distribution surface");
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  assert(html.includes('const reserveWorkspaceAllowed=isGeneralAdminUser(activeUser)||(activeUser?.type==="teacher"&&activeUser?.permissions?.reserve===true)'),"Reserve-enabled teachers must retain access to the canonical batch panel");
  assert(integration.includes('appAuthSession?.principal?.permissions?.reserve===true'),"A custom authenticated reserve principal must not be blocked by the UI gate when the server session grants reserve permission");
});

Deno.test("canonical batch selection requires and preserves the absence reason", () => {
  const pickerStart=source.indexOf("function installAbsenceReasonPicker()");
  const pickerEnd=source.indexOf("function reserveDutyReasonMarkup",pickerStart);
  assert(pickerStart>=0&&pickerEnd>pickerStart,"The canonical batch absence picker must exist");
  const picker=source.slice(pickerStart,pickerEnd);
  assert(picker.includes('window.timetableDailyAddAbsent'),"The canonical absent-teacher add handler must be wrapped");
  assert(picker.includes("openAbsenceReasonPicker(absentName,value=>"),"Adding a new absent teacher must open the reason picker first");
  assert(picker.includes("if(!value)return;"),"Cancelling the reason picker must not add the absent teacher");
  assert(picker.includes("reserveAbsenceReasons[absentName]=value"),"The selected reason must be stored against the absent teacher");
  assert(picker.includes("original.apply(this,args)"),"The original add action must run only after a reason is selected");
  const saveStart=source.indexOf("window.timetableDailySaveBatch = async function");
  const saveEnd=source.indexOf("window.timetableDailyToggleArchive",saveStart);
  assert(saveStart>=0&&saveEnd>saveStart,"The canonical batch save handler must exist");
  const save=source.slice(saveStart,saveEnd);
  assert(save.includes('absenceReason:(reserveAbsenceReasons[item.absentTeacherName]||"").trim()||"-"'),"Each saved assignment must carry its absent teacher's selected reason");
  assert(save.includes('action:"timetable_substitution_batch_save"'),"The reason must travel through the existing authenticated batch-save action");
});

Deno.test("reserve operational views initialize only when opened", () => {
  const homeStart=source.indexOf("function installHomeReserveArchive()");
  const homeEnd=source.indexOf("function setHomeArchiveStatus",homeStart);
  assert(homeStart>=0&&homeEnd>homeStart,"Home archive installer must exist");
  const home=source.slice(homeStart,homeEnd);
  assert(home.includes('view.classList.contains("hidden")'),"Home archive must not initialize while the reserve view is hidden");

  const boot=source.slice(source.indexOf("installMainSubstitutionViewIntegration();",source.indexOf("function installReserveArchiveAutoRefresh()")+1));
  assert(!boot.includes("reserveDomObserver.observe(document.body"),"Reserve observers must not watch all dashboard mutations");
  assert(!boot.includes('attributes:true,attributeFilter:["class","style"]'),"Reserve code must not observe all dashboard class/style mutations");
  assert(boot.includes("substitutionVisibilityObserver"),"Home reserve initialization must follow its own view visibility");
  assert(boot.includes("substitutionContentObserver"),"Dynamically-created home reserve content must still initialize");
  assert(boot.includes("timetableVisibilityObserver"),"Timetable reserve tools must follow their own panel visibility");
  assert(boot.includes("timetableContentObserver"),"Dynamically-created timetable reserve content must still initialize");


});
