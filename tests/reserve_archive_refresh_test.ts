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

  assert(auto.includes("const mutationActions=new Set(["), "A single explicit mutation allowlist must control reserve archive refresh");
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
  assert(auto.includes("const reserveMutation=mutationActions.has(action)"), "Only allowlisted mutations may trigger the reserve archive refresh path");
  assert(auto.includes("if(reserveMutation)refreshDailyArchiveInBackground()"), "Archive refresh must run only after a successful mutation without blocking the original request");
  assert(source.includes('appAuthRequest({action:"timetable_substitution_archive_access"},token).then(result=>'), "Archive permission must be checked before the archive UI loads");
  assert(source.includes('if(result?.canView===true)installHomeReserveArchive()'), "The archive UI must load only after the server grants archive access");
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
  assert(source.includes("function openAbsenceReasonPicker(absentName,onConfirm,initialValue)"),"The original premium absence reason modal must be restored in the reserve workflow");
  assert(source.includes("window.openSubstitutionAbsenceReasonPicker = function(absentName,currentValue,onConfirm)"),"All reserve flows must use the restored modal entry point");
  assert(!html.includes("subxReasonPopup"),"The unwanted compact second modal must be removed from the application page");
  assert(source.includes("const reasonPresentation="),"The restored modal must retain its illustrated reason choices and guidance");
  assert(source.includes('const value=choice==="أخرى"?(custom?"أخرى: "+custom:"أخرى"):choice;'),"The custom reason may be entered or left empty when «أخرى» is selected");
  assert(html.includes("absenceReasonsByTeacher.has(name)"),"A reason is required for each selected absent teacher");
  assert(html.includes('absenceReason:absenceReasonsByTeacher.get(item.absentTeacherName)||"-"'),"The chosen reason must be included in the atomic batch-save payload");
  assert(html.includes("absenceReasonsByTeacher.get(name)||storedReason"),"The selected reason must be available to the official PDF when preview rows do not carry it yet");
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

Deno.test("main reserve entry point keeps legacy panels hidden and defers edit/archive reads to their visible tabs", async () => {
  const integrationStart=source.indexOf("function installMainSubstitutionViewIntegration()");
  const integrationEnd=source.indexOf("installLegacyOtherDepartmentTeacherPicker();",integrationStart);
  assert(integrationStart>=0&&integrationEnd>integrationStart,"Canonical reserve integration must exist");
  const integration=source.slice(integrationStart,integrationEnd);
  assert(integration.includes('panel.classList.add("hidden")'),"The legacy timetable panel must remain hidden as a compatibility engine");
  assert(integration.includes('$("timetableDailyActivePanel")?.classList.add("hidden")'),"The old active edit panel must remain hidden behind the single day-card list");
  assert(integration.includes('$("timetableDailyArchivePanel")?.classList.add("hidden")'),"The old archive panel must remain hidden behind the unified archive renderer");
  assert(!integration.includes("editHost.appendChild(activePanel)")&&!integration.includes("archiveHost.appendChild(archivePanel)"),"The old panels must not create a competing second edit/archive path");
  assert(integration.includes("ttAdminReserveTools")&&integration.includes("ttDepartmentReserveTools"),"Existing admin and department archive controls must remain mounted in the archive host");
  assert(integration.includes("restoreCanonicalPanel()"),"Closing the view must keep the compatibility engine hidden");
  assert(integration.includes('dashboardCard.addEventListener("click"'),"The visible dashboard card remains the explicit reserve entry point");
  assert(!integration.includes("__canonicalReserveInitialOpenAttempted"),"Visibility observers must never auto-open the reserve workspace during unrelated view startup");
  assert(!integration.includes("return window.openSubstitutionView()"),"The integration must not replay the reserve opener merely because the view is visible");
  assert(integration.includes("await window.substitutionLoadAbsentees()"),"The explicit dashboard entry must still load the absentee workflow");
  assert(integration.includes("window.substitutionLoadAbsentees()"),"Opening the workspace must load the new distribution interface");
  assert(!integration.includes('startBackgroundLoad(window.timetableDailyLoadArchive'),"Archive/edit reads must not run before the corresponding view is opened");
  assert(integration.includes('startBackgroundLoad(window.substitutionLoadStats'),"Authorized accounts must retain statistics loading without blocking the workspace");
  assert(integration.includes("__reserveDateSyncWrapped"),"The new date picker must synchronize the legacy edit engine before refreshing");
  assert(integration.includes("if(isCustomCoordinator)root.querySelector('[data-subx-tab=\"daily\"]')?.click()"),"A scoped custom coordinator must be returned to the daily tab");
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


Deno.test("custom coordinator remains scoped and defers edit/archive/statistics reads", () => {
  const start=source.indexOf("function installMainSubstitutionViewIntegration()");
  const end=source.indexOf("installLegacyOtherDepartmentTeacherPicker();",start);
  assert(start>=0&&end>start,"Canonical reserve integration must be present");
  const integration=source.slice(start,end);
  assert(integration.includes('const isCustomCoordinator=reservePrincipal?.type==="custom"'),"The UI must identify the server-authenticated custom coordinator principal");
  assert(integration.includes('$("substitutionStatsPanel")?.classList.toggle("hidden",isCustomCoordinator)'),"Custom coordinators must not see the school statistics panel");
  assert(integration.includes('root.querySelector(\'[data-subx-tab="archive"]\')?.classList.toggle("hidden",isCustomCoordinator)'),"Custom coordinators must not see the archive tab");
  const openStart=integration.indexOf("try{",integration.indexOf("const isCustomCoordinator="));
  const openEnd=integration.indexOf("finally{",openStart);
  const openBlock=integration.slice(openStart,openEnd);
  assert(openBlock.includes("if(!isCustomCoordinator)"),"Statistics loading must be gated for custom coordinators");
  assert(openBlock.includes("substitutionLoadAbsentees"),"Custom coordinators must retain the scoped operational preview workflow");
  assert(!openBlock.includes("timetableDailyLoadArchive"),"Edit/archive reads must be deferred until an authorized tab is opened");
  assert(openBlock.includes("substitutionLoadStats"),"Authorized non-custom accounts must retain statistics loading");
  assert(!integration.slice(integration.indexOf("const canExpand="),integration.indexOf(";",integration.indexOf("const canExpand="))).includes('reservePrincipal?.type==="custom"'),"Custom coordinators must never receive cross-department controls");
});

Deno.test("daily and cumulative reserve archive reads are single-flight", () => {
  assert(source.includes("let reserveDailyArchiveLoadPromise = null;"), "Daily archive loader must expose one shared in-flight request");
  assert(source.includes("let reserveCumulativeArchiveLoadPromise = null;"), "Cumulative archive loader must expose one shared in-flight request");
  const dailyStart=source.indexOf("window.timetableDailyLoadArchive = function ()");
  const dailyEnd=source.indexOf("window.timetableDailyPrintArchiveRange",dailyStart);
  const cumulativeStart=source.indexOf("window.substitutionLoadCumulativeArchive = function()");
  const cumulativeEnd=source.indexOf("function setHomeTodayStatus",cumulativeStart);
  assert(dailyStart>=0&&dailyEnd>dailyStart,"Daily archive loader must exist");
  assert(cumulativeStart>=0&&cumulativeEnd>cumulativeStart,"Cumulative archive loader must exist");
  const daily=source.slice(dailyStart,dailyEnd);
  const cumulative=source.slice(cumulativeStart,cumulativeEnd);
  assert(daily.includes("reserveDailyArchiveLoadKey===requestKey"), "Concurrent daily archive refreshes for the same range must reuse the pending request");
  assert(daily.includes("finally{reserveDailyArchiveLoadPromise=null;reserveDailyArchiveLoadKey=null;}"), "Daily archive request lock and key must always release");
  assert(cumulative.includes("reserveCumulativeArchiveLoadKey===requestKey"), "Concurrent cumulative archive refreshes for the same range must reuse the pending request");
  assert(cumulative.includes("finally{reserveCumulativeArchiveLoadPromise=null;reserveCumulativeArchiveLoadKey=null;}"), "Cumulative archive request lock and key must always release");
  assert(daily.includes("Array.isArray(response.archive)?response.archive:[]"), "Daily archive must validate the response shape");
  assert(cumulative.includes("Array.isArray(response.archive)?response.archive:[]"), "Cumulative archive must validate the response shape");
});


Deno.test("reserve archive locks are assigned before validation and always release", () => {
  const dailyStart=source.indexOf("window.timetableDailyLoadArchive = function ()");
  const dailyEnd=source.indexOf("window.timetableDailyPrintArchiveRange",dailyStart);
  const cumulativeStart=source.indexOf("window.substitutionLoadCumulativeArchive = function()");
  const cumulativeEnd=source.indexOf("function setHomeTodayStatus",cumulativeStart);
  const daily=source.slice(dailyStart,dailyEnd);
  const cumulative=source.slice(cumulativeStart,cumulativeEnd);
  assert(daily.includes("reserveDailyArchiveLoadPromise=Promise.resolve().then(async()=>{"), "Daily loader must defer work until after the shared promise is assigned");
  assert(cumulative.includes("reserveCumulativeArchiveLoadPromise=Promise.resolve().then(async()=>{"), "Cumulative loader must defer work until after the shared promise is assigned");
  assert(cumulative.indexOf("try{") < cumulative.indexOf('if(!from||!to||from>to)'), "Invalid cumulative dates must pass through finally and release the lock");
  assert(daily.indexOf("try{") < daily.indexOf("host.innerHTML="), "Daily UI failures must also pass through finally and release the lock");
});


Deno.test("reserve archive reloads queue when the selected date range changes", () => {
  const dailyStart=source.indexOf("window.timetableDailyLoadArchive = function ()");
  const dailyEnd=source.indexOf("window.timetableDailyPrintArchiveRange",dailyStart);
  const cumulativeStart=source.indexOf("window.substitutionLoadCumulativeArchive = function()");
  const cumulativeEnd=source.indexOf("function setHomeTodayStatus",cumulativeStart);
  const daily=source.slice(dailyStart,dailyEnd);
  const cumulative=source.slice(cumulativeStart,cumulativeEnd);
  assert(daily.includes("if(reserveDailyArchiveLoadKey===requestKey)return reserveDailyArchiveLoadPromise;"), "Daily reads with the same range should share a request");
  assert(daily.includes("return reserveDailyArchiveLoadPromise.then(()=>window.timetableDailyLoadArchive());"), "Daily reads with a changed range must queue a fresh request");
  assert(daily.includes('if(($("timetableDailyArchiveFrom")?.value||"")!==from||($("timetableDailyArchiveTo")?.value||"")!==to)return false;'), "Daily reads must not render stale results after the range changes");
  assert(cumulative.includes("if(reserveCumulativeArchiveLoadKey===requestKey)return reserveCumulativeArchiveLoadPromise;"), "Cumulative reads with the same range should share a request");
  assert(cumulative.includes("return reserveCumulativeArchiveLoadPromise.then(()=>window.substitutionLoadCumulativeArchive());"), "Cumulative reads with a changed range must queue a fresh request");
  assert(cumulative.includes('if(($("substitutionArchiveFrom")?.value||"")!==from||($("substitutionArchiveTo")?.value||"")!==to)return false;'), "Cumulative reads must not render stale results after the range changes");
});

Deno.test("the four-section reserve workspace shows daily teaching load and preserves one A4 page per archived day", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  assert(html.includes("const dailyCount=Number(option.dailyTeachingCount)"),"Each substitute candidate must show the number of teaching periods scheduled that day");
  assert(!html.includes("لديه '+row.dailyTeachingCount+' حصص تدريس اليوم"),"The WhatsApp message must follow the requested format without appending daily teaching-load details");
  for(const tab of ["daily","edit","archive","stats"]){
    assert(html.includes('data-subx-tab="'+tab+'"'),"The workspace must expose the "+tab+" section");
  }
  assert(source.includes("sort((a,b)=>b[0].localeCompare(a[0]))"),"Archive dates must be ordered newest first");
  assert(source.includes('undefined,{singlePage:true}'),"The official archive PDF must create one A4 page for each day containing actual records");
  assert(source.includes('filter(item=>item.status!=="cancelled"&&item.assignmentDate)'),"Cancelled or undated rows must not create empty archive print pages");
});


Deno.test("daily and cumulative reserve archive requests time out and release their locks", () => {
  assert(source.includes("function reserveArchiveRequestWithTimeout(request, timeoutMs = 30000)"), "Archive requests must have a bounded wait");
  assert(source.includes("Promise.race([request, timeout])"), "A stalled archive request must not block the loader forever");
  assert(source.includes("if (timeoutId !== null) clearTimeout(timeoutId);"), "Archive timeout timers must be cleared after settlement");
  const dailyStart=source.indexOf("window.timetableDailyLoadArchive = function ()");
  const dailyEnd=source.indexOf("window.timetableDailyPrintArchiveRange",dailyStart);
  const cumulativeStart=source.indexOf("window.substitutionLoadCumulativeArchive = function()");
  const cumulativeEnd=source.indexOf("function setHomeTodayStatus",cumulativeStart);
  const daily=source.slice(dailyStart,dailyEnd);
  const cumulative=source.slice(cumulativeStart,cumulativeEnd);
  assert(daily.includes("await reserveArchiveRequestWithTimeout(appAuthRequest("), "Daily archive reads must use the bounded request helper");
  assert(cumulative.includes("await reserveArchiveRequestWithTimeout(appAuthRequest("), "Cumulative archive reads must use the bounded request helper");
  assert(daily.includes("finally{reserveDailyArchiveLoadPromise=null;reserveDailyArchiveLoadKey=null;}"), "Daily lock must release after a timeout");
  assert(cumulative.includes("finally{reserveCumulativeArchiveLoadPromise=null;reserveCumulativeArchiveLoadKey=null;}"), "Cumulative lock must release after a timeout");
});


Deno.test("reserve date navigation is attached to the visible canonical Muscat date picker", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  assert(!html.includes("shortcuts.className='subx-date-shortcuts'"),"The legacy inline shortcut row must not duplicate the canonical date navigation");
  assert(source.includes('const distributionDate=$("substitutionDate");'),"The quick navigation must target the visible canonical date picker");
  assert(source.includes('nav.id="subxCanonicalDateQuickNav"'),"The quick navigation must be mounted in the visible reserve date card");
  assert(source.includes('nav.setAttribute("aria-label","التنقل السريع بين تواريخ الاحتياط")'),"The visible quick navigation must have an accessible label");
  assert(source.includes('".tt-premium-date-nav{display:flex'),"The visible date navigation must receive layout styling outside the hidden compatibility panel");
  assert(!source.includes("ttPremiumDateQuickNav"),"The hidden compatibility panel must not create a second date navigation");
  assert(!source.includes('data-date-offset="-1"'), "The canonical date navigation must not include yesterday");
  assert(source.includes('data-date-offset="0"'), "The canonical date navigation must include today");
  assert(source.includes('data-date-offset="1"'), "The canonical date navigation must include tomorrow");
  assert(!source.includes("date.min=today"),"Historical reserve dates must remain selectable");
  assert(source.includes("if(!date.value){date.value=reserveCurrentMuscatDate();"),"The legacy date should default to Muscat today only when empty");
});


Deno.test("reserve edit tab lists active days and enters editing only from each absent-teacher row", async () => {
  const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
  assert(html.includes("r.canEdit===true&&['assigned','confirmed'].includes(String(r.status||''))"), "The edit tab must hide expired or non-editable assignments");
  assert(html.includes("window.timetableDailyRegisterExternalAssignments(allRows)"), "The edit list cache must be hydrated from the authenticated archive response");
  assert(!html.includes("data-open-edit-day"), "The detached whole-day editor entry point must be removed from the edit tab");
  const editStart=html.indexOf("if(isEditMount){");
  const archiveStart=html.indexOf("host.innerHTML=[...groups.entries()]",editStart);
  assert(editStart>=0&&archiveStart>editStart, "The edit-tab renderer must be present");
  const editTab=html.slice(editStart,archiveStart);
  assert(editTab.includes("data-edit-absent-day")&&editTab.includes("data-edit-absent-name"), "Each absent teacher must retain its own date and identity on the edit action");
  assert(editTab.includes("const opener=window.subxOpenSavedReserveReview")&&editTab.includes("void opener(button.dataset.editAbsentDay,button.dataset.editAbsentName)"), "Each teacher's edit action must open the canonical saved-review page");
  assert(!editTab.includes("window.timetableDailyOpenArchiveDayEdit"), "The edit tab must not expose the detached edit workspace");
  assert(html.includes("const dateFrom=isEditMount?today:from.value"), "The edit list must query only today and future dates, independently of archive date filters");
});

Deno.test("saved reserve day editor uses live server candidates and the existing atomic save and official PDF paths", () => {
  const previewStart = source.indexOf("async function fetchArchivePreview");
  const previewEnd = source.indexOf("window.timetableDailyRenderArchive", previewStart);
  const preview = source.slice(previewStart, previewEnd);
  assert(preview.includes("forEdit:true"), "Saved edits must ask the server for candidates after the lesson's new-assignment cutoff");
  const editorStart = source.indexOf("window.timetableDailyOpenArchiveDayEdit = async function(date,absentTeacherName)");
  const editorEnd = source.indexOf("window.timetableDailyCancelAssignment = async function (assignmentId)", editorStart);
  const editor = source.slice(editorStart, editorEnd);
  assert(editorStart >= 0 && editorEnd > editorStart, "The saved-day editor must exist as one complete function");
  assert(editor.includes("editTeacherDirectory"), "The other-teachers search must use the server-filtered active teacher directory");
  assert(editor.includes("occupiedPeriods"), "Other teachers must show their live occupied periods");
  assert(editor.includes("data-choice") && editor.includes("data-change"), "Choosing a substitute must collapse the choices and retain a Change action");
  assert(editor.includes('expanded:!String(x.substituteTeacherName||"").trim()'), "Unassigned lessons must open their candidate list while saved lessons stay collapsed");
  assert(editor.includes('data-edit-lesson="') && editor.includes("scrollIntoView({behavior:\"smooth\",block:\"center\"})"), "Choosing a substitute must move smoothly to the next lesson");
  assert(editor.includes("data-other-choice"), "The other-teachers search must allow a scoped substitute selection");
  assert(editor.includes('action:"timetable_substitution_update_batch"'), "Saving must use the existing authenticated atomic batch update");
  assert(editor.includes("window.timetableDailyPrintArchiveRange"), "PDF must use the official A4 reserve report renderer");
  assert(!editor.includes("prompt("), "The redesigned day editor must not use legacy prompt-based editing");
  assert(!editor.includes("allSchoolTeachers"), "The editor must not use a hard-coded or mock teacher directory");
});


Deno.test("per-teacher reserve editing belongs in the edit tab, not in either archive", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  const editStart=html.indexOf("if(isEditMount){");
  const archiveStart=html.indexOf("host.innerHTML=[...groups.entries()]",editStart);
  assert(editStart>=0&&archiveStart>editStart,"The dedicated edit-tab renderer must exist");
  const editTab=html.slice(editStart,archiveStart);
  assert(editTab.includes("subx-edit-open-absent"),"Each absent-teacher row in the edit tab must expose its own edit action");
  assert(editTab.includes("data-edit-absent-day")&&editTab.includes("data-edit-absent-name"),"The edit action must retain the exact date and absent-teacher identity");
  assert(editTab.includes("const opener=window.subxOpenSavedReserveReview"),"The edit row must open the canonical saved-distribution review screen");
  assert(editTab.includes("void opener(button.dataset.editAbsentDay,button.dataset.editAbsentName)"),"The action must load only this absent teacher into the review screen");
  assert(editTab.includes("subx-edit-delete-group")&&editTab.includes("data-delete-edit-day"),"The existing per-teacher delete action must remain available");
  assert(!editTab.includes("window.timetableDailyOpenArchiveDayEdit"),"The edit-tab action must not launch the detached candidate-picker workspace");
  assert(!source.includes("data-tt-edit-group-date"),"The daily archive must not receive the new group edit action");
  assert(!source.includes("data-home-edit-group-date"),"The cumulative archive must not receive the new group edit action");

  const legacyStart=source.indexOf("window.timetableDailyOpenArchiveDayEdit = async function(date,absentTeacherName)");
  const legacyEnd=source.indexOf("window.timetableDailyCancelAssignment = async function",legacyStart);
  assert(legacyStart>=0&&legacyEnd>legacyStart,"The compatibility editor must remain available to older in-app callers");
  const legacy=source.slice(legacyStart,legacyEnd);
  assert(legacy.includes('action:"timetable_substitution_update_batch"'),"The compatibility editor must keep its authenticated atomic update action");
});

Deno.test("per-teacher edit opens the canonical saved review and updates original assignment rows", async () => {
  const html=await Deno.readTextFile(new URL("../index.html",import.meta.url));
  const fetchStart=html.indexOf("async function fetchSavedReserveReviewState(date,absentTeacherName)");
  const openStart=html.indexOf("window.subxOpenSavedReserveReview=async function(date,absentTeacherName)");
  const openEnd=html.indexOf("async function saveSavedReserveReviewChanges()",openStart);
  assert(fetchStart>=0&&openStart>fetchStart&&openEnd>openStart,"The saved-review loader and route must be available to the edit-tab action");
  const loader=html.slice(fetchStart,openEnd);
  assert(loader.includes("timetable_substitution_archive")&&loader.includes("timetable_substitution_preview"),"Saved records and live substitute candidates must be fetched from the authenticated server");
  assert(loader.includes("forEdit:true"),"Candidate choices must use the server's edit-window rules");
  assert(loader.includes("window.subxNavigateToScreen('smart',true)"),"The edit action must return to the original distribution review screen");
  assert(loader.includes("renderPlan()"),"The saved distribution must use the original review renderer");
  assert(loader.includes("candidateOptions:[currentOption,...candidates"),"The already-selected substitute must remain visible alongside eligible alternatives");

  const saveStart=html.indexOf("async function saveSavedReserveReviewChanges()");
  const saveEnd=html.indexOf("window.substitutionSavePlan=async function()",saveStart);
  assert(saveStart>=0&&saveEnd>saveStart,"The saved review must have its own save handler");
  const save=html.slice(saveStart,saveEnd);
  assert(save.includes("timetable_substitution_update_batch"),"Changes must use the existing atomic update endpoint");
  assert(save.includes("assignmentId:String(item.id||item.assignmentId)"),"Changes must target the original assignment identifiers");
  assert(!save.includes("timetable_substitution_batch_save"),"Saved-review changes must never create duplicate assignments");
  assert(html.includes("window.subxNavigateToScreen=function(name,push)"),"The canonical screen adapter must expose in-app navigation to review");
});
