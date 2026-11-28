/* Reserve workflow enhancement: whole-day matching, staged edits, archive and A4 report. */
(function () {
  "use strict";
  let reserveBatchPreview = null;
  let reserveDraftAssignments = [];
  let reserveDraftApproved = new Set();
  let reserveLastAbsentSignature = "";
  let reserveReasons = Object.create(null);
  let reserveAbsenceReasons = Object.create(null);
  let reserveManualChoices = Object.create(null);
  let reserveDraftScope = "";
  let reserveOtherDepartmentId = "";
  let reserveOtherDepartmentIds = [];
  let reserveOtherDepartments = [];
  let reserveOtherDepartmentsLoaded = false;
  let reserveActorDepartmentName = "";
  let reserveSelectedOtherTeacherNames = new Set();
  let reserveDraftRestoreChecked = false;
  let reserveArchive = [];
  // Keep the dashboard cumulative archive separate from the daily timetable archive.
  let reserveCumulativeArchive = [];
  let reserveHomeToday = [];
  let reserveHomeTodayLoadPromise = null;
  // Single-flight guards: save/cancel handlers and the mutation refresh hook can
  // request the same archive at nearly the same time. Never render competing copies.
  let reserveDailyArchiveLoadPromise = null;
  let reserveDailyArchiveLoadKey = null;
  let reserveCumulativeArchiveLoadPromise = null;
  let reserveCumulativeArchiveLoadKey = null;
  // Bound archive waits so a stalled request cannot leave the loader locked forever.
  function reserveArchiveRequestWithTimeout(request, timeoutMs = 30000) {
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("استغرق تحميل سجل الاحتياط وقتاً أطول من المتوقع. اضغط تحديث للمحاولة مجدداً.")), timeoutMs);
    });
    return Promise.race([request, timeout]).finally(() => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    });
  }
  const DRAFT_STORAGE_KEY="abu-dujana-reserve-draft-v1";
  function currentActorName(){return String(appAuthSession?.principal?.name||"").trim();}
  function clearStoredDraft(){try{localStorage.removeItem(DRAFT_STORAGE_KEY);}catch{}}
  function persistStoredDraft(){
    try{
      const actor=currentActorName();if(!actor)return;
      const {date,weekday}=timetableSubstitutionGetDate();
      localStorage.setItem(DRAFT_STORAGE_KEY,JSON.stringify({actor,date,weekday,savedAt:Date.now(),
        absentTeachers:[...timetableDailyAbsentTeachers],manualChoices:reserveManualChoices,reasons:reserveReasons,absenceReasons:reserveAbsenceReasons,approvedAbsentTeachers:[...reserveDraftApproved],includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherDepartmentIds:(selectedOtherDepartmentIds().length?selectedOtherDepartmentIds():reserveOtherDepartmentIds),otherTeacherNames:[...reserveSelectedOtherTeacherNames]}));
    }catch{}
  }
  function restoreStoredDraft(){
    if(reserveDraftRestoreChecked)return false;
    try{
      const actor=currentActorName();if(!actor)return false;
      reserveDraftRestoreChecked=true;
      const raw=localStorage.getItem(DRAFT_STORAGE_KEY);if(!raw)return false;
      const saved=JSON.parse(raw),current=timetableSubstitutionGetDate();
      if(saved.actor!==actor||saved.date!==current.date||saved.weekday!==current.weekday||
         !Number.isFinite(saved.savedAt)||Date.now()-saved.savedAt>8*60*60*1000){clearStoredDraft();return false;}
      if(!Array.isArray(saved.absentTeachers)||!saved.absentTeachers.length)return false;
      timetableDailyAbsentTeachers=[...new Set(saved.absentTeachers.map(String).filter(Boolean))];
      reserveLastAbsentSignature=timetableDailyAbsentTeachers.join("\u0000");
      const otherToggle=$("timetableSubstitutionOtherDepartments");
      if(otherToggle)otherToggle.checked=saved.includeOtherDepartments===true;
      const otherDepartmentSelect=$("timetableDailyOtherDepartmentSelect");
      if(saved.otherDepartmentId)reserveOtherDepartmentId=String(saved.otherDepartmentId);
      reserveOtherDepartmentIds=Array.isArray(saved.otherDepartmentIds)?saved.otherDepartmentIds.map(String):saved.otherDepartmentId?[String(saved.otherDepartmentId)]:[];
      reserveSelectedOtherTeacherNames=new Set(Array.isArray(saved.otherTeacherNames)?saved.otherTeacherNames.map(String):[]);
      if(otherDepartmentSelect){const savedIds=Array.isArray(saved.otherDepartmentIds)?saved.otherDepartmentIds.map(String):saved.otherDepartmentId?[String(saved.otherDepartmentId)]:[];Array.from(otherDepartmentSelect.options).forEach(option=>option.selected=savedIds.includes(option.value));}
      const otherButton=$("timetableDailyOtherDepartmentsButton");
      if(otherButton)otherButton.innerHTML=otherToggle?.checked
        ?'<i class="fa-solid fa-chevron-up ml-1"></i> إغلاق الأقسام المساندة'
        :'<i class="fa-solid fa-people-group ml-1"></i> استعارة معلمين من أقسام أخرى';
      reserveManualChoices=Object.assign(Object.create(null),saved.manualChoices||{});
      reserveDraftApproved=new Set(Array.isArray(saved.approvedAbsentTeachers)?saved.approvedAbsentTeachers.filter(name=>timetableDailyAbsentTeachers.includes(name)):[]);
      reserveReasons=Object.assign(Object.create(null),saved.reasons||{});
      reserveAbsenceReasons=Object.assign(Object.create(null),saved.absenceReasons||{});
      reserveDraftScope=currentDraftScope();
      if(typeof timetableDailyRenderTags==="function")timetableDailyRenderTags();
      status("استُعيدت مسودة الاحتياط غير المحفوظة من هذا الجهاز. راجعها قبل الاعتماد.","info");
      return true;
    }catch{return false;}
  }
  const draftKey = (name, period) => String(name) + "\u0000" + Number(period);
  const reserveReasonKey = (name, period) => String(name) + "::" + Number(period);
  function currentDraftScope() {
    try { const value=timetableSubstitutionGetDate(); return [value.date,value.weekday,includeOthers()?"other:"+selectedOtherDepartmentIds().join(","):"department"].join("|"); }
    catch { return ""; }
  }
  function currentPlanRows(response) {
    const planned=(response.assignments||[]).map(item=>{
      const draft=reserveDraftAssignments.find(row=>row.absentTeacherName===item.absentTeacherName&&Number(row.period)===Number(item.period));
      return {...item,substituteTeacherName:draft?draft.substituteTeacherName:item.substituteTeacherName};
    });
    return {planned,saved:response.existingAssignments||[],missing:response.unassigned||[]};
  }
  function hasTriple(periods, target) {
    const occupied=new Set((periods||[]).map(Number)); occupied.add(Number(target));
    for(let start=Math.max(1,Number(target)-2);start<=Number(target);start++)
      if(occupied.has(start)&&occupied.has(start+1)&&occupied.has(start+2))return true;
    return false;
  }
  const $ = id => document.getElementById(id);
  const esc = value => typeof timetableEsc === "function" ? timetableEsc(value) : String(value ?? "");
  const status = (message, kind) => timetableSubstitutionSetStatus(message, kind || "info");
  const includeOthers = () => $("timetableSubstitutionOtherDepartments")?.checked === true;
  const selectedOtherDepartmentIds = () => {const select=$("timetableDailyOtherDepartmentSelect");if(select&&select.options.length)return Array.from(select.selectedOptions||[]).map(option=>String(option.value||"").trim()).filter(Boolean);return [...reserveOtherDepartmentIds];};
  const selectedOtherDepartmentId = () => selectedOtherDepartmentIds()[0] || String(reserveOtherDepartmentId||"").trim();
  function updateBatchSaveVisibility(){
    const button=$("timetableDailySaveBatchButton");
    if(!button)return;
    const planned=reserveBatchPreview?.assignments||[],missing=reserveBatchPreview?.unassigned||[];
    const required=[...new Set([...planned,...missing].map(item=>String(item.absentTeacherName||"")).filter(Boolean))];
    const readyToSave=required.length>0&&required.every(name=>reserveDraftApproved.has(name));
    const hasSaved=(reserveBatchPreview?.existingAssignments||[]).length>0;
    const reportsReady=readyToSave||(required.length===0&&hasSaved);
    button.classList.toggle("hidden",!readyToSave);
    button.disabled=!readyToSave||timetableDailyBusy;
    document.querySelectorAll("#timetableSubstitutionPanel button[onclick*=timetableDailyPrintReport],#timetableSubstitutionPanel button[onclick*=timetableDailyShareWhatsApp]").forEach(control=>control.classList.toggle("hidden",!reportsReady));
  }
  function renderOtherDepartmentOptions() {
    const host=$("timetableDailyOtherDepartmentChoices"),select=$("timetableDailyOtherDepartmentSelect");
    if(!host||!select)return;
    const selected=new Set(selectedOtherDepartmentIds());
    host.innerHTML=reserveOtherDepartments.length?reserveOtherDepartments.map((department,index)=>
      '<label class="tt-department-card flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">'+
      '<input type="checkbox" class="h-5 w-5 accent-indigo-600" data-other-department-id="'+esc(department.id)+'"'+(selected.has(String(department.id))?" checked":"")+'>'+
      '<span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-700"><i class="fa-solid fa-book-open"></i></span>'+
      '<span class="min-w-0"><strong class="block text-xs font-black text-slate-800">'+esc(department.name)+'</strong><small class="mt-1 block text-[10px] text-slate-500">'+(Array.isArray(department.teachers)?department.teachers.length:0)+' معلم متاح في الجدول</small></span></label>'
    ).join(""):'<p class="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">لا توجد تخصصات مساندة متاحة حالياً.</p>';
    host.querySelectorAll("[data-other-department-id]").forEach(input=>input.addEventListener("change",()=>{
      const option=Array.from(select.options).find(item=>item.value===input.dataset.otherDepartmentId);
      if(option)option.selected=input.checked;
      select.dispatchEvent(new Event("change",{bubbles:true}));
    }));
  }
  function renderOtherDepartmentTeachers() {
    const host=$("timetableDailyOtherTeacherChoices"), add=$("timetableDailyAddOtherTeachersButton");
    if(!host)return;
    const selectedIds=selectedOtherDepartmentIds();
    const departments=reserveOtherDepartments.filter(item=>selectedIds.includes(String(item.id)));
    const uniqueNames=new Set();
    const groups=departments.map(department=>{
      const teachers=[...(Array.isArray(department.teachers)?department.teachers:[])]
        .filter(teacher=>teacher?.name&&!uniqueNames.has(String(teacher.name))&&uniqueNames.add(String(teacher.name)));
      const names=teachers.map(teacher=>String(teacher.name));
      const selectedCount=names.filter(name=>reserveSelectedOtherTeacherNames.has(name)).length;
      return '<section class="rounded-2xl border border-indigo-100 bg-white p-3 shadow-sm" data-other-department-group="'+esc(department.id)+'">'+
        '<div class="mb-3 flex flex-wrap items-center justify-between gap-2">'+
          '<div class="flex min-w-0 items-center gap-2"><span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-700"><i class="fa-solid fa-book-open"></i></span><div class="min-w-0"><strong class="block text-sm font-black text-slate-900">'+esc(department.name)+'</strong><small class="text-[11px] text-slate-500">'+teachers.length+' معلم متاح · '+selectedCount+' محدد</small></div></div>'+
          '<div class="flex shrink-0 gap-2"><button type="button" data-select-all-department="'+esc(department.id)+'" class="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-black text-indigo-800">تحديد الكل</button><button type="button" data-clear-department="'+esc(department.id)+'" class="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">إلغاء الكل</button></div>'+
        '</div>'+
        (teachers.length?'<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">'+teachers.map(teacher=>{
          const name=String(teacher.name);
          return '<label class="tt-other-teacher-card flex min-h-[3.5rem] cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm font-bold transition hover:border-indigo-300 hover:bg-indigo-50/50"><input type="checkbox" class="h-6 w-6 shrink-0 accent-indigo-600" data-other-teacher-name="'+esc(name)+'"'+(reserveSelectedOtherTeacherNames.has(name)?" checked":"")+'><span class="min-w-0"><strong class="block text-slate-800">'+esc(name)+'</strong><small class="mt-1 block text-[10px] font-medium text-indigo-600">'+esc(department.name)+'</small></span></label>';
        }).join("")+'</div>':'<p class="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">لا يوجد معلمون مؤهلون في هذا القسم ضمن الجدول النشط.</p>')+
      '</section>';
    });
    host.innerHTML=groups.length?groups.join(""):'<p class="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">حدد قسماً أو أكثر لعرض المعلمين المتاحين.</p>';
    host.querySelectorAll("[data-select-all-department]").forEach(button=>button.addEventListener("click",()=>{
      const id=String(button.dataset.selectAllDepartment||"");
      const department=departments.find(item=>String(item.id)===id);
      (department?.teachers||[]).forEach(teacher=>{if(teacher?.name)reserveSelectedOtherTeacherNames.add(String(teacher.name));});
      renderOtherDepartmentTeachers();
    }));
    host.querySelectorAll("[data-clear-department]").forEach(button=>button.addEventListener("click",()=>{
      const id=String(button.dataset.clearDepartment||"");
      const department=departments.find(item=>String(item.id)===id);
      (department?.teachers||[]).forEach(teacher=>reserveSelectedOtherTeacherNames.delete(String(teacher.name)));
      renderOtherDepartmentTeachers();
    }));
    host.querySelectorAll("[data-other-teacher-name]").forEach(input=>input.addEventListener("change",()=>{
      const name=String(input.dataset.otherTeacherName||"");
      if(input.checked)reserveSelectedOtherTeacherNames.add(name);else reserveSelectedOtherTeacherNames.delete(name);
      if(add)add.disabled=!host.querySelector("[data-other-teacher-name]:checked");
      const section=input.closest("[data-other-department-group]");
      const department=departments.find(item=>String(item.id)===String(section?.dataset.otherDepartmentGroup||""));
      if(section&&department){
        const names=(department.teachers||[]).map(teacher=>String(teacher.name));
        const count=names.filter(value=>reserveSelectedOtherTeacherNames.has(value)).length;
        const caption=section.querySelector("small");
        if(caption)caption.textContent=names.length+" معلم متاح · "+count+" محدد";
      }
    }));
    if(add)add.disabled=!host.querySelector("[data-other-teacher-name]:checked");
  }
  async function loadOtherDepartments() {
    if(reserveOtherDepartmentsLoaded)return;
    const token=appAuthSession?.token||readAppAuthToken();
    const result=await appAuthRequest({action:"timetable_substitution_departments"},token);
    const select=$("timetableDailyOtherDepartmentSelect");
    if(!select)return;
    reserveOtherDepartmentsLoaded=true;
    reserveActorDepartmentName=String(result.actorDepartmentName||"").trim();
    const localTitle=document.querySelector(".tt-reserve-local-card .tt-reserve-choice-copy strong");
    if(localTitle&&reserveActorDepartmentName)localTitle.textContent="التوزيع لمعلمي قسم "+reserveActorDepartmentName;
    reserveOtherDepartments=Array.isArray(result.departments)?result.departments:[];
    const currentIds=selectedOtherDepartmentIds();
    const current=currentIds.length?currentIds:(reserveOtherDepartmentId?[reserveOtherDepartmentId]:[]);
    select.innerHTML=reserveOtherDepartments.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join("");
    Array.from(select.options).forEach(option=>option.selected=current.includes(option.value));
    reserveOtherDepartmentIds=[...current];
    reserveOtherDepartmentId=selectedOtherDepartmentIds()[0]||"";
    renderOtherDepartmentOptions();
    renderOtherDepartmentTeachers();
  }
  function reserveCurrentMuscatDate(){
    return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  }
  const ABSENCE_REASON_OPTIONS=["طارئة","موعد مستشفى","مرضية","أخرى","دورة تدريبية"];
  // One illustrated reason picker is shared by both reserve flows; «أخرى» remains valid without extra text.
  function openAbsenceReasonPicker(absentName,onConfirm,initialValue){
    const old=document.getElementById("timetableDailyAbsenceReasonModal");if(old)old.remove();
    const current=String(initialValue!==undefined?initialValue:(reserveAbsenceReasons[absentName]||""));
    const normalizedCurrent=current==="إجازة مرضية"?"مرضية":current;
    const selected=ABSENCE_REASON_OPTIONS.includes(normalizedCurrent)?normalizedCurrent:(current.startsWith("أخرى:")?"أخرى":"");
    const customValue=current.startsWith("أخرى:")?current.slice(5).trim():"";
    const modal=document.createElement("div");modal.id="timetableDailyAbsenceReasonModal";
    modal.className="fixed inset-0 z-[100000] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm";
    const reasonPresentation={
      "طارئة":{label:"طارئة",icon:"fa-bolt",hint:"حالة طارئة"},
      "موعد مستشفى":{label:"موعد مستشفى",icon:"fa-hospital",hint:"موعد طبي أو مراجعة مستشفى"},
      "مرضية":{label:"إجازة مرضية",icon:"fa-kit-medical",hint:"إجازة أو عذر مرضي"},
      "أخرى":{label:"أخرى",icon:"fa-pen-to-square",hint:"يمكنك كتابة التفاصيل أو تركها فارغة"},
      "دورة تدريبية":{label:"دورة تدريبية",icon:"fa-chalkboard-user",hint:"مشاركة في دورة أو تدريب معتمد"}
    };
    modal.innerHTML='<section class="w-full max-w-lg space-y-5 rounded-[1.6rem] border border-slate-200 bg-white p-5 shadow-2xl sm:p-6" dir="rtl">'+
      '<div class="flex items-center gap-3"><span class="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-rose-50 text-rose-600 text-xl"><i class="fa-solid fa-clipboard-question"></i></span><div><h3 class="text-lg font-black text-slate-900">سبب غياب '+esc(absentName)+'</h3><p class="mt-1 text-xs text-slate-500">اختر السبب المناسب للانتقال إلى اقتراح البدلاء.</p></div></div>'+
      '<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">'+ABSENCE_REASON_OPTIONS.map(reason=>{const item=reasonPresentation[reason];return '<label class="tt-absence-reason-option flex min-h-[5.2rem] cursor-pointer items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-sm font-bold text-slate-800 transition"><input class="sr-only" type="radio" name="ttAbsenceReasonChoice" value="'+esc(reason)+'" '+(selected===reason?"checked":"")+'><span class="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 text-lg"><i class="fa-solid '+item.icon+'"></i></span><span class="min-w-0"><strong class="block text-sm font-black">'+esc(item.label||reason)+'</strong><small class="mt-1 block text-[10px] font-medium text-slate-500">'+item.hint+'</small></span></label>'}).join("")+'</div>'+
      '<label id="ttAbsenceReasonOtherWrap" class="'+(selected==="أخرى"?"":"hidden")+' block text-xs font-bold text-slate-700">اكتب سبب الغياب<textarea id="ttAbsenceReasonOther" rows="2" maxlength="500" class="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm" placeholder="اكتب سبب الغياب بالتفصيل...">'+esc(customValue)+'</textarea></label>'+
      '<p id="ttAbsenceReasonError" class="hidden rounded-lg bg-rose-50 p-2 text-xs font-bold text-rose-700"></p>'+
      '<div class="flex justify-end gap-2"><button type="button" data-absence-reason-cancel class="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700">إلغاء</button><button type="button" data-absence-reason-confirm class="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-black text-white">موافق</button></div></section>';
    document.body.appendChild(modal);
    modal.querySelectorAll('input[name="ttAbsenceReasonChoice"]').forEach(radio=>radio.addEventListener("change",()=>{
      modal.querySelector("#ttAbsenceReasonOtherWrap")?.classList.toggle("hidden",radio.value!=="أخرى");
      if(radio.value==="أخرى")modal.querySelector("#ttAbsenceReasonOther")?.focus();
    }));
    let settled=false;
    const cancel=()=>{if(settled)return;settled=true;modal.remove();if(typeof onConfirm==="function")onConfirm(null);};
    modal.querySelector("[data-absence-reason-cancel]")?.addEventListener("click",cancel);
    modal.addEventListener("click",event=>{if(event.target===modal)cancel();});
    modal.querySelector("[data-absence-reason-confirm]")?.addEventListener("click",()=>{
      const choice=modal.querySelector('input[name="ttAbsenceReasonChoice"]:checked')?.value||"";
      const custom=String(modal.querySelector("#ttAbsenceReasonOther")?.value||"").trim();
      const error=modal.querySelector("#ttAbsenceReasonError");
      if(!choice){error.textContent="اختر سبب الغياب أولاً.";error.classList.remove("hidden");return;}
      const value=choice==="أخرى"?(custom?"أخرى: "+custom:"أخرى"):choice;
      if(settled)return;settled=true;modal.remove();onConfirm(value);
    });
  }
  window.openSubstitutionAbsenceReasonPicker = function(absentName,currentValue,onConfirm){
    openAbsenceReasonPicker(absentName,function(value){
      if(typeof onConfirm==="function")onConfirm(value);
    },String(currentValue||""));
  };
  
function reasonControlMarkup(absentName, absenceReason, allowEdit=true) {
    const value=String(absenceReason||"").trim();
    const edit=allowEdit?'<button type="button" data-tt-edit-absence-reason="'+esc(absentName)+'" class="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-800">تغيير السبب</button>':"";
    return '<div class="flex flex-wrap items-center gap-2 text-[10px] font-black text-slate-600"><span>سبب الغياب: '+esc(value||"لم يحدد")+'</span>'+edit+'</div>';
  }
  function installAbsenceReasonPicker(){
    const handlerNames=Object.getOwnPropertyNames(window).filter(name=>
      /^timetableDaily.*(?:Add|Select|Choose|Toggle).*Absent|^timetableDaily.*Absent.*(?:Add|Select|Choose|Toggle)/i.test(name)&&typeof window[name]==="function");
    if(typeof window.timetableDailyAddAbsent==="function"&&!handlerNames.includes("timetableDailyAddAbsent"))handlerNames.push("timetableDailyAddAbsent");
    let installed=false;
    handlerNames.forEach(handlerName=>{
      const original=window[handlerName];
      if(typeof original!=="function"||original.__reserveAbsenceReasonWrapped)return;
      const wrapped=function(...args){
        const absentName=args.map(value=>typeof value==="string"?value:String(value?.name||"").trim())
          .find(value=>value&&value.length<=160&&!timetableDailyAbsentTeachers.includes(value));
        if(!absentName)return original.apply(this,args);
        const selectedDate=timetableSubstitutionGetDate().date;
        const existing=[...(reserveArchive||[]),...(reserveCumulativeArchive||[]),...(reserveHomeToday||[]),...(reserveBatchPreview?.existingAssignments||[])]
          .find(row=>row.absentTeacherName===absentName&&row.assignmentDate===selectedDate&&row.status!=="cancelled"&&row.absenceReason&&row.absenceReason!=="-");
        if(existing){reserveAbsenceReasons[absentName]=existing.absenceReason;persistStoredDraft();return original.apply(this,args);}
        openAbsenceReasonPicker(absentName,value=>{
          if(!value)return;
          reserveAbsenceReasons[absentName]=value;
          persistStoredDraft();
          try{
            const result=original.apply(this,args);
            Promise.resolve(result).then(()=>{persistStoredDraft();window.timetableDailyRenderLessons?.();});
          }catch(error){delete reserveAbsenceReasons[absentName];status(error?.message||"تعذر إضافة المعلم الغائب.","error");}
        });
      };
      wrapped.__reserveAbsenceReasonWrapped=true;
      wrapped.__reserveAbsenceReasonOriginal=original;
      window[handlerName]=wrapped;
      installed=true;
    });
    return installed;
  }
  function reserveDutyReasonMarkup(absentName, period, reason) {
    const value=String(reason||"").trim(),key=reserveReasonKey(absentName,period);
    return '<label class="mt-2 block text-[10px] font-black text-slate-600">سبب الاحتياط <span class="font-normal text-slate-400">(التكليف المسند للمعلم البديل لهذه الحصة)</span>'+
      '<textarea data-tt-reason="'+esc(key)+'" rows="2" maxlength="500" class="tt-reason mt-1 w-full resize-y" placeholder="مثال: متابعة الصف وتنفيذ الحصة المقررة...">'+esc(value)+'</textarea></label>';
  }
  function installReserveAbsenteeChecklist(panel) {
    const search=$("timetableDailyAbsentSearch");
    if(!panel||!search||search.dataset.reserveChecklistBound==="1")return;
    search.dataset.reserveChecklistBound="1";
    const searchWrap=search.parentElement;
    const host=document.createElement("section");
    host.id="ttReserveAbsenteeChecklist";
    host.className="tt-reserve-absentee-checklist";
    host.setAttribute("aria-label","قائمة المعلمين الغائبين");
    searchWrap?.insertAdjacentElement("afterend",host);
    $("timetableDailySuggestions")?.classList.add("hidden");
    const pending=new Set();
    let busy=false;
    const selectedNames=()=>Array.isArray(timetableDailyAbsentTeachers)?timetableDailyAbsentTeachers:[];
    const normalize=value=>typeof timetableDailyNormalizeName==="function"
      ?timetableDailyNormalizeName(value):String(value||"").trim().toLocaleLowerCase("ar");
    function render(){
      const options=Array.isArray(timetableDailyAbsentOptions)?timetableDailyAbsentOptions:[];
      const query=normalize(search.value);
      const matches=options.filter(name=>!query||normalize(name).includes(query));
      const selected=selectedNames();
      host.innerHTML=
        '<div class="tt-reserve-checklist-heading"><strong>قائمة المعلمين</strong><span>حدد الغائب بالمربع، واضغط الاسم لتحديد السبب أو تعديله</span></div>'+
        (matches.length
          ?'<div class="tt-reserve-checklist-items">'+matches.map(name=>{
            const isSelected=selected.includes(name),isPending=pending.has(name);
            const reason=String(reserveAbsenceReasons[name]||"").trim();
            const reasonLabel=reason==="مرضية"?"إجازة مرضية":reason;
            return '<div class="tt-reserve-absentee-row'+(isSelected?' is-selected':'')+(isPending?' is-pending':'')+'">'+
              '<input type="checkbox" data-tt-check-absent="'+esc(name)+'" aria-label="تحديد غياب '+esc(name)+'" '+((isSelected||isPending)?'checked':'')+(busy?' disabled':'')+'>'+
              '<button type="button" class="tt-reserve-absentee-name" data-tt-open-absence-reason="'+esc(name)+'" '+(busy?'disabled':'')+'>'+esc(name)+'</button>'+
              '<span class="tt-reserve-absentee-reason">'+(isSelected?(reason?esc(reasonLabel):"حدد السبب"):"متاح للتحديد")+'</span>'+
            '</div>';
          }).join("")+'</div>'
          :'<p class="tt-reserve-checklist-empty">'+(options.length?"لا توجد نتائج مطابقة لبحثك.":"اختر التاريخ لتحميل قائمة المعلمين.")+'</p>');
    }
    function addAbsentWithoutReason(name){
      if(pending.has(name)||selectedNames().includes(name))return;
      const handler=window.timetableDailyAddAbsent;
      const add=handler?.__reserveAbsenceReasonOriginal||handler;
      if(typeof add!=="function"){status("تعذر إضافة المعلم الغائب.","error");return;}
      pending.add(name);render();
      Promise.resolve(add.call(window,name)).then(()=>{
        persistStoredDraft();
      }).catch(error=>{
        status(error?.message||"تعذر إضافة المعلم الغائب.","error");
      }).finally(()=>{pending.delete(name);render();});
    }
    function openReason(name,adding){
      const picker=window.openSubstitutionAbsenceReasonPicker;
      if(typeof picker!=="function"){status("تعذر فتح نافذة سبب الغياب. حدّث الصفحة ثم حاول مجدداً.","error");return;}
      if(adding)pending.add(name);
      render();
      picker(name,String(reserveAbsenceReasons[name]||""),value=>{
        if(adding)pending.delete(name);
        if(!value){render();return;}
        reserveAbsenceReasons[name]=value;
        persistStoredDraft();
        if(adding){
          const handler=window.timetableDailyAddAbsent;
          const add=handler?.__reserveAbsenceReasonOriginal||handler;
          if(typeof add!=="function"){delete reserveAbsenceReasons[name];status("تعذر إضافة المعلم الغائب.","error");render();return;}
          Promise.resolve(add.call(window,name)).then(()=>{
            persistStoredDraft();
            render();
          }).catch(error=>{
            delete reserveAbsenceReasons[name];
            status(error?.message||"تعذر إضافة المعلم الغائب.","error");
            render();
          });
        }else{
          window.timetableDailyRenderLessons?.();
          render();
        }
      });
    }
    host.addEventListener("change",event=>{
      const checkbox=event.target?.closest?.("[data-tt-check-absent]");
      if(!checkbox)return;
      const name=checkbox.getAttribute("data-tt-check-absent");
      if(checkbox.checked){
        if(!selectedNames().includes(name))addAbsentWithoutReason(name);
        else render();
      }else if(selectedNames().includes(name)){
        window.timetableDailyRemoveAbsent?.(name);
        render();
      }
    });
    host.addEventListener("click",event=>{
      const button=event.target?.closest?.("[data-tt-open-absence-reason]");
      if(!button)return;
      const name=button.getAttribute("data-tt-open-absence-reason");
      openReason(name,!selectedNames().includes(name));
    });
    search.addEventListener("input",render);
    const wrap=(name,after)=>{
      const original=window[name];
      if(typeof original!=="function"||original.__ttReserveChecklistWrapped)return;
      const wrapped=function(...args){
        const result=original.apply(this,args);
        queueMicrotask(()=>{after?.(args,result);render();});
        return result;
      };
      wrapped.__ttReserveChecklistWrapped=true;
      wrapped.__ttReserveChecklistOriginal=original;
      window[name]=wrapped;
    };
    wrap("timetableDailyRenderTags");
    wrap("timetableDailyFilterAbsentTeachers",()=>{
      $("timetableDailySuggestions")?.classList.add("hidden");
    });
    const originalLoad=window.timetableLoadSubstitutionOptions;
    if(typeof originalLoad==="function"&&!originalLoad.__ttReserveChecklistWrapped){
      const wrappedLoad=async function(...args){
        try{return await originalLoad.apply(this,args);}
        finally{render();}
      };
      wrappedLoad.__ttReserveChecklistWrapped=true;
      wrappedLoad.__ttReserveChecklistOriginal=originalLoad;
      window.timetableLoadSubstitutionOptions=wrappedLoad;
    }
    const originalBusy=window.timetableDailySetBusy;
    if(typeof originalBusy==="function"&&!originalBusy.__ttReserveChecklistWrapped){
      const wrappedBusy=function(disabled,...args){
        busy=disabled===true;
        const result=originalBusy.call(this,disabled,...args);
        render();
        return result;
      };
      wrappedBusy.__ttReserveChecklistWrapped=true;
      wrappedBusy.__ttReserveChecklistOriginal=originalBusy;
      window.timetableDailySetBusy=wrappedBusy;
    }
    if(!document.getElementById("ttReserveAbsenteeChecklistStyles")){
      const style=document.createElement("style");
      style.id="ttReserveAbsenteeChecklistStyles";
      style.textContent=[
        "#ttReserveAbsenteeChecklist{margin-top:.75rem;padding:.8rem;border:1px solid rgba(148,163,184,.24);border-radius:1.15rem;background:rgba(248,250,252,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}",
        "#ttReserveAbsenteeChecklist .tt-reserve-checklist-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.4rem;margin-bottom:.65rem}",
        "#ttReserveAbsenteeChecklist .tt-reserve-checklist-heading strong{font-size:.8rem;font-weight:900;color:#0f172a}",
        "#ttReserveAbsenteeChecklist .tt-reserve-checklist-heading span{font-size:.65rem;color:#64748b}",
        "#ttReserveAbsenteeChecklist .tt-reserve-checklist-items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem;max-height:19rem;overflow:auto;padding:.1rem}",
        "#ttReserveAbsenteeChecklist .tt-reserve-absentee-row{display:grid;grid-template-columns:1.2rem minmax(0,1fr);align-items:center;gap:.35rem .6rem;min-width:0;padding:.65rem .7rem;border:1px solid rgba(148,163,184,.22);border-radius:.9rem;background:rgba(255,255,255,.78);transition:border-color .16s,background .16s,box-shadow .16s}",
        "#ttReserveAbsenteeChecklist .tt-reserve-absentee-row.is-selected{border-color:rgba(16,185,129,.5);background:rgba(236,253,245,.9);box-shadow:0 0 0 1px rgba(16,185,129,.1)}",
        "#ttReserveAbsenteeChecklist .tt-reserve-absentee-row.is-pending{border-style:dashed}",
        "#ttReserveAbsenteeChecklist input[type=checkbox]{width:1.1rem;height:1.1rem;accent-color:#059669;cursor:pointer}",
        "#ttReserveAbsenteeChecklist .tt-reserve-absentee-name{min-width:0;text-align:right;overflow-wrap:anywhere;color:#1e293b;font-size:.75rem;font-weight:900}",
        "#ttReserveAbsenteeChecklist .tt-reserve-absentee-name:hover{color:#047857}",
        "#ttReserveAbsenteeChecklist .tt-reserve-absentee-reason{grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;font-size:.6rem}",
        "#ttReserveAbsenteeChecklist .tt-reserve-checklist-empty{padding:.8rem;text-align:center;color:#64748b;font-size:.72rem}",
        ".dark #ttReserveAbsenteeChecklist{border-color:rgba(71,85,105,.6);background:rgba(15,23,42,.72)}",
        ".dark #ttReserveAbsenteeChecklist .tt-reserve-checklist-heading strong{color:#f1f5f9}",
        ".dark #ttReserveAbsenteeChecklist .tt-reserve-absentee-row{border-color:rgba(71,85,105,.55);background:rgba(30,41,59,.72)}",
        ".dark #ttReserveAbsenteeChecklist .tt-reserve-absentee-row.is-selected{border-color:rgba(52,211,153,.55);background:rgba(6,78,59,.42)}",
        ".dark #ttReserveAbsenteeChecklist .tt-reserve-absentee-name{color:#e2e8f0}",
        "@media(max-width:540px){#ttReserveAbsenteeChecklist .tt-reserve-checklist-items{grid-template-columns:1fr}}"
      ].join("\n");
      document.head.appendChild(style);
    }
    render();
  }
  function installPremiumReserveExperience(panel) {
    if(!panel||panel.dataset.premiumReserveExperience==="1")return;
    panel.dataset.premiumReserveExperience="1";
    const title=panel.querySelector("h3"),intro=title?.parentElement;
    if(intro){
      intro.classList.add("tt-premium-hero");
      const oldSteps=panel.querySelector(".tt-reserve-steps");
      if(oldSteps)oldSteps.outerHTML=
        '<nav class="tt-premium-stepper" aria-label="مراحل توزيع الاحتياط">'+
        '<button type="button" class="tt-premium-step is-active" data-premium-step="1"><span class="tt-premium-step-icon"><i class="fa-regular fa-calendar-days"></i></span><span><b>١ · التاريخ</b><small>حدد يوم الاحتياط</small></span></button>'+
        '<button type="button" class="tt-premium-step" data-premium-step="2"><span class="tt-premium-step-icon"><i class="fa-solid fa-user-check"></i></span><span><b>٢ · الغياب</b><small>اختر المعلمين وأسبابهم</small></span></button>'+
        '<button type="button" class="tt-premium-step" data-premium-step="3"><span class="tt-premium-step-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span><span><b>٣ · البدلاء</b><small>اقتراحات النظام الذكي</small></span></button>'+
        '<button type="button" class="tt-premium-step" data-premium-step="4"><span class="tt-premium-step-icon"><i class="fa-solid fa-clipboard-check"></i></span><span><b>٤ · الاعتماد</b><small>مراجعة ونشر ومشاركة</small></span></button></nav>';
      if(!panel.querySelector(".tt-premium-intro"))intro.insertAdjacentHTML("afterend",'<div class="tt-premium-intro"><span class="tt-premium-spark"><i class="fa-solid fa-wand-magic-sparkles"></i></span><div><strong>مساحة إعداد احتياط متكاملة</strong><p>ابدأ بالتاريخ، ثم حدد الغياب، ودع النظام يقترح التوزيع الأنسب.</p></div></div>');
    }
    let defaultDateInitialized=false;
    const date=$("timetableSubstitutionDate");
    if(date){
      const dateWrap=date.closest("label")||date.parentElement;
      if(dateWrap&&!dateWrap.closest("#ttPremiumDateCard")){
        const card=document.createElement("section");card.id="ttPremiumDateCard";card.className="tt-premium-card tt-premium-date-card";
        card.innerHTML='<div class="tt-premium-card-heading"><span class="tt-premium-icon tt-icon-date"><i class="fa-regular fa-calendar-check"></i></span><div><strong>الخطوة الأولى: اختر تاريخ الاحتياط</strong><small>حدد اليوم الدراسي الذي تريد إعداد التوزيع له</small></div><span class="tt-premium-chip">البداية</span></div>';
        dateWrap.parentNode?.insertBefore(card,dateWrap);card.appendChild(dateWrap);dateWrap.classList.add("tt-premium-date-control");
        if(!date.value){date.value=reserveCurrentMuscatDate();defaultDateInitialized=true;}
      }
    }
    const search=$("timetableDailyAbsentSearch");
    if(search){
      const searchWrap=search.parentElement;search.classList.add("tt-premium-search");search.setAttribute("aria-label","ابحث عن المعلم الغائب");
      const label=searchWrap?.querySelector("label");if(label)label.textContent="ابحث بالاسم ثم اختر المعلم الغائب";
      const tags=$("timetableDailyAbsentTags");if(tags)tags.classList.add("tt-premium-selected-tags");
      if(searchWrap&&!searchWrap.closest("#ttPremiumAbsentCard")){
        const card=document.createElement("section");card.id="ttPremiumAbsentCard";card.className="tt-premium-card tt-premium-absent-card";
        card.innerHTML='<div class="tt-premium-card-heading"><span class="tt-premium-icon tt-icon-absent"><i class="fa-solid fa-user-minus"></i></span><div><strong>الخطوة الثانية: تحديد المعلمين الغائبين</strong><small>يمكنك اختيار أكثر من معلم، وسيُطلب سبب الغياب لكل واحد</small></div></div>';
        searchWrap.parentNode?.insertBefore(card,searchWrap);card.appendChild(searchWrap);if(tags&&tags.parentNode!==card)card.appendChild(tags);
      }
    }
    installReserveAbsenteeChecklist(panel);
    if(defaultDateInitialized)date?.dispatchEvent(new Event("change",{bubbles:true}));
    const toolbar=$("timetableDailySaveBatchButton")?.parentElement;if(toolbar)toolbar.classList.add("tt-premium-toolbar");
    const results=$("timetableSubstitutionResults");if(results)results.classList.add("tt-premium-results");
    const update=()=>{
      const hasDate=!!String(date?.value||"").trim(),hasAbsentees=Array.isArray(timetableDailyAbsentTeachers)&&timetableDailyAbsentTeachers.length>0;
      const hasPlan=!!(reserveBatchPreview&&(reserveBatchPreview.assignments?.length||reserveBatchPreview.unassigned?.length||reserveBatchPreview.existingAssignments?.length));
      const required=[...new Set([...(reserveBatchPreview?.assignments||[]),...(reserveBatchPreview?.unassigned||[])].map(row=>String(row.absentTeacherName||"")).filter(Boolean))];
      const allApproved=required.length>0&&required.every(name=>reserveDraftApproved.has(name));
      const hasSaved=(reserveBatchPreview?.existingAssignments||[]).length>0;
      const workflowComplete=allApproved||(required.length===0&&hasSaved);
      const stage=!hasDate?1:!hasAbsentees?2:!hasPlan?3:workflowComplete?4:3;
      panel.querySelectorAll("[data-premium-step]").forEach(step=>{const n=Number(step.dataset.premiumStep);step.classList.toggle("is-active",n===stage);step.classList.toggle("is-complete",n<stage);});
      $("ttPremiumDateCard")?.classList.toggle("is-complete",hasDate);
      const absentCard=$("ttPremiumAbsentCard");
      if(absentCard){absentCard.hidden=!hasDate;absentCard.classList.toggle("is-current",hasDate);absentCard.classList.toggle("is-complete",hasAbsentees);}
      if(toolbar){toolbar.hidden=!hasAbsentees;toolbar.classList.toggle("tt-premium-toolbar-ready",hasAbsentees);}
      if(results)results.classList.toggle("tt-premium-results-ready",hasAbsentees);
    };
    panel.querySelectorAll("[data-premium-step]").forEach(button=>button.addEventListener("click",()=>{
      const target=Number(button.dataset.premiumStep)===1?$("ttPremiumDateCard"):Number(button.dataset.premiumStep)===2?$("ttPremiumAbsentCard"):Number(button.dataset.premiumStep)===3?toolbar:results;
      if(target&&!target.hidden){target.scrollIntoView({behavior:"smooth",block:"center"});target.querySelector("input,select,button")?.focus?.({preventScroll:true});}
    }));
    date?.addEventListener("change",update);date?.addEventListener("input",update);
    panel.addEventListener("change",event=>{if(event.target?.id==="timetableDailyAbsentSearch"||event.target?.matches?.('[name="substitutionAbsentTeacher"]'))queueMicrotask(update);});
    panel.addEventListener("click",event=>{if(event.target?.closest?.("[data-tt-remove-absent],[data-tt-approve],#timetableDailySaveBatchButton"))queueMicrotask(update);});
    const observer=new MutationObserver(update);if(results)observer.observe(results,{childList:true,subtree:true});const tags=$("timetableDailyAbsentTags");if(tags)observer.observe(tags,{childList:true,subtree:true});update();
  }
  function installReserveEnhancements() {
    const panel = $("timetableSubstitutionPanel");
    if (!panel || panel.dataset.reserveEnhanced === "1") return;
    panel.dataset.reserveEnhanced = "1";
    panel.classList.add("overflow-hidden", "rounded-[1.75rem]", "border", "border-slate-200", "shadow-xl");
    const title = panel.querySelector("h3");
    if (title) {
      title.textContent = "توزيع الاحتياط اليومي";
      title.className = "font-black text-xl text-slate-900 dark:text-white";
      const description = title.parentElement?.querySelector("p");
      if (description) description.textContent = "حدد المعلمين الغائبين، وسيحلل النظام جميع حصصهم معاً ليقترح توزيعاً متوازناً قبل الحفظ.";
      title.parentElement?.classList.add("rounded-2xl", "bg-gradient-to-l", "from-slate-950", "via-slate-900", "to-emerald-950", "p-5", "text-white", "shadow-lg");
      title.parentElement?.insertAdjacentHTML("afterend",
        '<nav class="tt-reserve-steps tt-no-print" aria-label="خطوات توزيع الاحتياط">' +
        '<button type="button" data-reserve-step="1"><span>١</span><strong>تحديد الغياب</strong><small>اختر التاريخ والمعلمين</small></button>' +
        '<button type="button" data-reserve-step="2"><span>٢</span><strong>التوزيع الذكي</strong><small>حلّل جميع الحصص</small></button>' +
        '<button type="button" data-reserve-step="3"><span>٣</span><strong>المراجعة والحفظ</strong><small>راجع البدلاء ثم احفظ</small></button>' +
        '</nav>');
      title.parentElement?.parentElement?.querySelectorAll("[data-reserve-step]").forEach(button=>button.addEventListener("click",()=>{
        const target=button.dataset.reserveStep==="1"?$("timetableDailyAbsentSearch"):
          button.dataset.reserveStep==="2"?panel.querySelector('button[onclick*="timetableDailyAutoAssign"]'):$("timetableSubstitutionResults");
        target?.scrollIntoView({behavior:"smooth",block:"center"});
        if(button.dataset.reserveStep==="1")$("timetableDailyAbsentSearch")?.focus({preventScroll:true});
      }));
    }
    const toolbar = panel.querySelector(".tt-toolbar");
    if (toolbar) {
      toolbar.classList.add("rounded-2xl", "border", "border-slate-200", "bg-slate-50", "p-3", "dark:border-slate-700", "dark:bg-slate-800");
      const auto = toolbar.querySelector('button[onclick*="timetableDailyAutoAssign"]');
      if (auto) auto.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles ml-1"></i> إعداد التوزيع الذكي';
      const print = toolbar.querySelector('button[onclick*="window.print"]');
      if (print) { print.setAttribute("onclick", "timetableDailyPrintReport()"); print.innerHTML = '<i class="fa-solid fa-print ml-1"></i> طباعة A4'; }
      toolbar.insertAdjacentHTML("beforeend",
        '<button type="button" id="timetableDailySaveBatchButton" class="tt-action bg-emerald-700 text-white"><i class="fa-solid fa-floppy-disk ml-1"></i> حفظ التوزيع</button>' +
        '<button type="button" id="timetableDailyArchiveButton" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800"><i class="fa-solid fa-box-archive ml-1"></i> سجل الاحتياط التراكمي</button>');
      $("timetableDailySaveBatchButton")?.classList.add("hidden");
      $("timetableDailySaveBatchButton")?.addEventListener("click", timetableDailySaveBatch);
      $("timetableDailyArchiveButton")?.addEventListener("click", timetableDailyToggleArchive);
    }
    const search = $("timetableDailyAbsentSearch");
    if (search) {
      search.classList.add("rounded-xl", "border-2", "border-slate-200", "bg-white", "p-3");
      search.insertAdjacentHTML("beforebegin", '<label class="mb-2 block text-xs font-black text-slate-700 dark:text-slate-200">١. اختر المعلمين الغائبين</label>');
    }
    const otherLabel = $("timetableSubstitutionOtherDepartments")?.closest("label");
    const otherToggle = $("timetableSubstitutionOtherDepartments");
    if (otherLabel) otherLabel.classList.add("hidden");
    if (otherToggle) otherToggle.removeAttribute("onchange");
    if (toolbar) {
      toolbar.insertAdjacentHTML("beforeend", '<button type="button" id="timetableDailyOtherDepartmentsButton" class="tt-action flex items-center gap-3 rounded-2xl border border-indigo-200 bg-white px-4 py-3 text-indigo-900"><span class="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-lg"><i class="fa-solid fa-people-group"></i></span><span class="text-right"><strong class="block text-sm font-black">استعارة معلمين من أقسام أخرى</strong><small class="mt-1 block text-[10px] font-medium text-indigo-600">اختيار تخصص واحد أو أكثر</small></span></button>');
      $("timetableDailyOtherDepartmentsButton")?.addEventListener("click", async () => {
        const toggle=$("timetableSubstitutionOtherDepartments");
        const button=$("timetableDailyOtherDepartmentsButton");
        const select=$("timetableDailyOtherDepartmentSelect");
        if(!toggle||!button)return;
        if(!toggle.checked){
          toggle.checked=true;button.disabled=true;
          try{
            await loadOtherDepartments();
            $("timetableDailyOtherDepartmentWrap")?.classList.remove("hidden");
            button.innerHTML='<i class="fa-solid fa-chevron-up ml-1"></i> إغلاق الأقسام المساندة';
            if(!selectedOtherDepartmentId()){
              status("اختر القسم المساند أولاً؛ لن تظهر أسماء المعلمين قبل اختيار القسم.","info");
              $("timetableDailyOtherDepartmentChoices")?.querySelector("input")?.focus();return;
            }
            await timetableDailyRefreshAll();
          }catch(error){
            toggle.checked=false;
            if(select){select.value="";select.closest("label")?.classList.add("hidden");}
            reserveOtherDepartmentId="";reserveOtherDepartmentIds=[];
            button.innerHTML='<i class="fa-solid fa-people-group ml-1"></i> استعارة معلمين من أقسام أخرى';
            status(error?.message||"تعذر تحميل الأقسام المساندة. حاول مرة أخرى.","error");
          }finally{button.disabled=false;}
          return;
        }
        toggle.checked=false;
        if(select){select.value="";select.closest("label")?.classList.add("hidden");}
        reserveOtherDepartmentId="";reserveOtherDepartmentIds=[];reserveSelectedOtherTeacherNames=new Set();reserveDraftScope="";
        button.innerHTML='<i class="fa-solid fa-people-group ml-1"></i> استعارة معلمين من أقسام أخرى';
        await timetableDailyRefreshAll();
      });
      const toolbarSelect='<div id="timetableDailyOtherDepartmentWrap" class="hidden min-w-[260px] text-xs font-bold text-slate-700">  <section class="rounded-2xl border border-indigo-100 bg-white p-4">    <div class="mb-3 flex items-center gap-3"><span class="grid h-11 w-11 place-items-center rounded-xl bg-indigo-50 text-indigo-700 text-xl"><i class="fa-solid fa-layer-group"></i></span><div><strong class="block text-sm text-slate-900">اختر التخصصات المساندة</strong><small class="mt-1 block text-[11px] font-medium text-slate-500">يمكنك اختيار أكثر من تخصص في الوقت نفسه</small></div></div>    <div id="timetableDailyOtherDepartmentChoices" class="grid grid-cols-1 gap-2 sm:grid-cols-2"><p class="text-xs text-slate-500">جارٍ تحميل التخصصات...</p></div>    <select id="timetableDailyOtherDepartmentSelect" multiple class="hidden" aria-hidden="true" tabindex="-1"></select>  </section>  <section class="mt-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4">    <div class="mb-3 flex items-center gap-3"><span class="grid h-10 w-10 place-items-center rounded-xl bg-white text-indigo-700 text-lg"><i class="fa-solid fa-users"></i></span><div><strong class="block text-sm text-slate-900">اختر المعلمين من الأقسام المحددة</strong><small class="mt-1 block text-[11px] font-medium text-slate-500">يمكنك تحديد معلم بعينه أو تحديد جميع معلمي القسم</small></div></div>    <div id="timetableDailyOtherTeacherChoices" class="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2"><p class="text-xs text-slate-500">اختر التخصص أولاً لعرض المعلمين.</p></div>    <button type="button" id="timetableDailyAddOtherTeachersButton" class="mt-3 w-full rounded-xl bg-indigo-700 px-4 py-3 text-sm font-black text-white shadow-md disabled:cursor-not-allowed disabled:opacity-50" disabled><i class="fa-solid fa-user-plus ml-1"></i> اعتماد المعلمين المحددين</button>    <p class="mt-2 text-[10px] text-slate-500">اختر معلمًا واحدًا أو أكثر، أو استخدم «تحديد الكل» داخل بطاقة القسم، ثم اعتمد الاختيار لإضافتهم إلى البدلاء.</p>  </section></div>';
      $("timetableDailyOtherDepartmentsButton")?.insertAdjacentHTML("afterend",toolbarSelect);
      const localCard=document.createElement("section");
      localCard.className="tt-reserve-choice-card tt-reserve-local-card";
      localCard.innerHTML='<div class="tt-reserve-choice-art"><i class="fa-solid fa-people-group"></i></div><div class="tt-reserve-choice-copy"><span class="tt-reserve-choice-kicker">المسار الأساسي</span><strong>التوزيع لمعلمي قسمك</strong><small>يعرض النظام قسمك تلقائيًا حسب صلاحيتك، وتبقى قائمة الغائبين ضمن نطاقه.</small></div><button type="button" class="tt-reserve-choice-action">متابعة <i class="fa-solid fa-arrow-left"></i></button>';
      const externalButton=$("timetableDailyOtherDepartmentsButton");
      const externalCard=document.createElement("section");
      externalCard.className="tt-reserve-choice-card tt-reserve-support-card";
      externalCard.innerHTML='<div class="tt-reserve-choice-art"><i class="fa-solid fa-handshake-angle"></i></div><div class="tt-reserve-choice-copy"><span class="tt-reserve-choice-kicker">مسار مساند اختياري</span><strong>الاستعانة بالأقسام الأخرى</strong><small>اختر قسمًا أو أكثر، ثم حدد معلمًا بعينه أو جميع معلمي القسم.</small></div>';
      if(externalButton){externalButton.classList.add("tt-reserve-choice-original");externalCard.appendChild(externalButton);}
      const choiceGrid=document.createElement("div");
      choiceGrid.className="tt-reserve-choice-grid";
      choiceGrid.append(localCard,externalCard);
      const absentCard=$("ttPremiumAbsentCard")||$("timetableDailyAbsentSearch")?.parentElement;
      if(absentCard?.parentNode)absentCard.parentNode.insertBefore(choiceGrid,absentCard);
      localCard.querySelector("button")?.addEventListener("click",async()=>{
        // Resolve the authenticated department only after the coordinator enters this route.
        // This avoids background timetable requests on unrelated school screens.
        try{await loadOtherDepartments();}catch{}
        absentCard?.scrollIntoView({behavior:"smooth",block:"center"});
        $("timetableDailyAbsentSearch")?.focus({preventScroll:true});
      });
      const choiceStyle=document.createElement("style");
      choiceStyle.id="ttReserveChoiceCardsStyles";
      choiceStyle.textContent=[
        ".tt-reserve-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1rem 0 1.2rem}",
        ".tt-reserve-choice-card{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:.9rem;min-width:0;overflow:hidden;padding:1.1rem;border:1px solid rgba(255,255,255,.65);border-radius:1.45rem;box-shadow:0 18px 42px rgba(30,41,59,.13),inset 0 1px 0 rgba(255,255,255,.72);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}",
        ".tt-reserve-local-card{background:linear-gradient(135deg,rgba(14,165,233,.96),rgba(79,70,229,.94) 55%,rgba(124,58,237,.96));color:#fff}",
        ".tt-reserve-support-card{background:linear-gradient(135deg,rgba(16,185,129,.96),rgba(5,150,105,.94) 48%,rgba(13,148,136,.96));color:#fff}",
        ".tt-reserve-choice-art{display:grid;place-items:center;width:3.6rem;height:3.6rem;border:1px solid rgba(255,255,255,.5);border-radius:1.15rem;background:rgba(255,255,255,.2);box-shadow:inset 0 1px 0 rgba(255,255,255,.35);font-size:1.55rem}",
        ".tt-reserve-choice-copy{display:grid;gap:.25rem;min-width:0}.tt-reserve-choice-kicker{font-size:.65rem;font-weight:900;letter-spacing:.04em;color:rgba(255,255,255,.82)}.tt-reserve-choice-copy strong{font-size:1.05rem;font-weight:1000;color:#fff}.tt-reserve-choice-copy small{font-size:.72rem;line-height:1.7;color:rgba(255,255,255,.92)}",
        ".tt-reserve-choice-action{grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:.5rem;min-height:2.8rem;border:1px solid rgba(255,255,255,.5);border-radius:1rem;background:rgba(255,255,255,.18);color:#fff;font-weight:900;transition:background .2s,transform .2s}.tt-reserve-choice-action:hover{background:rgba(255,255,255,.3);transform:translateY(-1px)}",
        ".tt-reserve-choice-original{display:flex!important;grid-column:1/-1;justify-content:center!important;width:100%;min-height:2.8rem;border:1px solid rgba(255,255,255,.48)!important;border-radius:1rem!important;background:rgba(255,255,255,.18)!important;color:#fff!important;font-weight:900}.tt-reserve-choice-original>span:first-child{display:none}.tt-reserve-choice-original small{color:rgba(255,255,255,.85)!important}.tt-reserve-choice-original strong{color:#fff!important}",
        "#timetableDailyOtherDepartmentWrap{grid-column:1/-1;width:100%;min-width:0;margin-top:.25rem}#timetableDailyOtherDepartmentWrap>section{border:1px solid rgba(16,185,129,.24)!important;border-radius:1.25rem!important;background:linear-gradient(145deg,rgba(236,253,245,.96),rgba(240,253,250,.94),rgba(236,254,255,.96))!important;box-shadow:0 12px 30px rgba(5,150,105,.09)}",
        "#timetableDailyOtherDepartmentChoices label{min-height:4rem!important;padding:.8rem!important;border:1px solid rgba(16,185,129,.22)!important;border-radius:1rem!important;background:rgba(255,255,255,.8)!important;box-shadow:0 5px 16px rgba(15,23,42,.05)}#timetableDailyOtherDepartmentChoices input{width:1.45rem;height:1.45rem;accent-color:#059669}",
        "#timetableDailyOtherTeacherChoices{max-height:24rem!important}#timetableDailyOtherTeacherChoices [data-other-department-group]{border-color:rgba(99,102,241,.22)!important;background:linear-gradient(145deg,rgba(255,255,255,.96),rgba(238,242,255,.82))!important;box-shadow:0 8px 22px rgba(79,70,229,.08)}#timetableDailyOtherTeacherChoices input[type=checkbox]{width:1.45rem;height:1.45rem;accent-color:#4f46e5}",
        "#timetableDailyAddOtherTeachersButton{min-height:3.25rem!important;border-radius:1rem!important;background:linear-gradient(100deg,#4338ca,#7c3aed,#db2777)!important;box-shadow:0 10px 24px rgba(124,58,237,.24)!important;font-size:.92rem!important}",
        ".tt-premium-toolbar button[onclick*=timetableDailyAutoAssign]{display:flex!important;align-items:center;justify-content:center;width:100%;min-height:4rem;margin:.5rem 0!important;border:1px solid rgba(255,255,255,.5)!important;border-radius:1.25rem!important;background:linear-gradient(105deg,#7c3aed 0%,#4f46e5 36%,#0ea5e9 72%,#0d9488 100%)!important;color:#fff!important;box-shadow:0 16px 34px rgba(79,70,229,.28),inset 0 1px 0 rgba(255,255,255,.3)!important;font-size:1.05rem!important;font-weight:1000!important;letter-spacing:.01em}",
        ".dark .tt-reserve-choice-card{border-color:rgba(255,255,255,.18);box-shadow:0 18px 42px rgba(0,0,0,.28)}.dark #timetableDailyOtherDepartmentWrap>section{background:linear-gradient(145deg,rgba(6,78,59,.72),rgba(15,23,42,.92))!important}.dark #timetableDailyOtherDepartmentChoices label{background:rgba(15,23,42,.78)!important;color:#f8fafc}",
        "@media(max-width:680px){.tt-reserve-choice-grid{grid-template-columns:1fr;gap:.75rem}.tt-reserve-choice-card{padding:1rem}.tt-reserve-choice-copy strong{font-size:.98rem}}"
      ].join("\n");
      document.head.appendChild(choiceStyle);
      $("timetableDailyOtherDepartmentSelect")?.addEventListener("change",()=>{
        const selectedIds=selectedOtherDepartmentIds();reserveOtherDepartmentIds=[...selectedIds];reserveOtherDepartmentId=selectedIds[0]||"";
        renderOtherDepartmentOptions();
        const eligibleNames=new Set(reserveOtherDepartments.filter(item=>selectedIds.includes(String(item.id))).flatMap(item=>(item.teachers||[]).map(teacher=>String(teacher.name))));
        reserveSelectedOtherTeacherNames=new Set([...reserveSelectedOtherTeacherNames].filter(name=>eligibleNames.has(name)));
        reserveDraftScope="";reserveDraftApproved=new Set();reserveBatchPreview=null;reserveDraftAssignments=[];
        renderOtherDepartmentTeachers();window.timetableDailyRenderLessons();
        status(selectedIds.length?"حدد المعلمين من التخصصات المختارة، ثم اضغط إضافة المعلمين المحددين. يمكنك اختيار أكثر من تخصص.":"أزلت تحديد الأقسام المساندة.","info");
      });
      $("timetableDailyAddOtherTeachersButton")?.addEventListener("click",async()=>{
        const selected=[...document.querySelectorAll("#timetableDailyOtherTeacherChoices [data-other-teacher-name]:checked")].map(input=>String(input.dataset.otherTeacherName||"")).filter(Boolean);
        if(!selected.length){status("حدد معلماً واحداً على الأقل قبل الإضافة.","error");return;}
        reserveSelectedOtherTeacherNames=new Set(selected);reserveOtherDepartmentId=selectedOtherDepartmentId();reserveDraftScope="";reserveDraftApproved=new Set();
        const add=$("timetableDailyAddOtherTeachersButton");if(add)add.disabled=true;
        try{await timetableDailyRefreshAll();status("تمت إضافة "+selected.length+" من المعلمين الذين حددتهم فقط إلى قائمة البدلاء المتاحين.","success");}
        catch(error){status(error?.message||"تعذر تحميل البدلاء المحددين.","error");}
        finally{if(add)add.disabled=false;}
      });
      $("timetableDailyOtherDepartmentSelect")?.closest("label")?.classList.toggle("hidden",!includeOthers());
      if(includeOthers())loadOtherDepartments().then(()=>{$("timetableDailyOtherDepartmentWrap")?.classList.remove("hidden");}).catch(()=>{});
    }
    const results = $("timetableSubstitutionResults");
    if (results) {
      results.insertAdjacentHTML("beforebegin", '<div id="timetableDailySummary" class="grid grid-cols-2 gap-2 sm:grid-cols-4"></div>');
      results.insertAdjacentHTML("afterend",
        '<section id="timetableDailyArchivePanel" class="hidden mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/40">' +
        '<div class="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h4 class="font-black text-sm text-slate-900 dark:text-white">أرشيف الاحتياط</h4><p class="mt-1 text-[10px] text-slate-500">يعرض السجلات ضمن نطاق صلاحيتك، مرتبة من الأحدث إلى الأقدم. كل يوم فعلي في صفحة مستقلة.</p></div></div>' +
        '<div class="grid gap-2 rounded-xl border border-indigo-100 bg-white p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"><label class="text-[10px] font-bold text-slate-600">من تاريخ<input id="timetableDailyArchiveFrom" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label><label class="text-[10px] font-bold text-slate-600">إلى تاريخ<input id="timetableDailyArchiveTo" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label><button type="button" id="timetableDailyArchiveReload" class="tt-action border border-slate-300 bg-white text-slate-800">عرض السجلات</button><button type="button" id="timetableDailyArchivePrint" class="tt-action bg-indigo-700 text-white"><i class="fa-solid fa-print ml-1"></i> طباعة كشف PDF</button></div><div id="timetableDailyArchiveResults" class="space-y-3"></div></section>');
      $("timetableDailyArchivePanel")?.insertAdjacentHTML("afterend",
        '<section id="timetableDailyActivePanel" class="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4"><div class="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h4 class="text-sm font-black text-emerald-950">التكليفات النشطة القابلة للتعديل أو الإلغاء</h4><p class="mt-1 text-[10px] text-emerald-800">تُعرض التكليفات النشطة ضمن الفترة المحددة، وتظهر أدوات التعديل والإلغاء للحصص التي ما زالت ضمن المهلة المعتمدة.</p></div><div class="flex items-center gap-2"><span id="timetableDailyActiveCount" class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-900">0</span><button type="button" id="timetableDailyActiveReload" class="tt-action border border-emerald-300 bg-white text-emerald-900">تحديث سجلات اليوم</button></div></div><div id="timetableDailyActiveResults" class="space-y-2"><p class="text-center text-xs text-slate-500">جارٍ انتظار التحقق من صلاحية الدخول لتحميل سجلات اليوم.</p></div></section>');
      $("timetableDailyArchiveReload")?.addEventListener("click", timetableDailyLoadArchive);
      $("timetableDailyArchivePrint")?.addEventListener("click", timetableDailyPrintArchiveRange);
      $("timetableDailyActiveReload")?.addEventListener("click", timetableDailyLoadArchive);
      try{const today=timetableSubstitutionGetDate().date;const start=new Date(today+"T00:00:00Z");start.setUTCDate(start.getUTCDate()-365);const from=start.toISOString().slice(0,10);const fromInput=$("timetableDailyArchiveFrom"),toInput=$("timetableDailyArchiveTo");if(fromInput&&!fromInput.value)fromInput.value=from;if(toInput&&!toInput.value){const end=new Date(today+"T00:00:00Z");end.setUTCDate(end.getUTCDate()+365);toInput.value=end.toISOString().slice(0,10);}}catch{}
    }
    const style = document.createElement("style");
    style.id = "reserve-workflow-styles";
    style.textContent = [
      "#timetableSubstitutionPanel{isolation:isolate;color:#172033}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-hero{position:relative;overflow:hidden;border-radius:1.5rem!important;background:radial-gradient(circle at 8% 0%,rgba(52,211,153,.22),transparent 36%),linear-gradient(125deg,#0b1830 0%,#102c43 54%,#075c50 100%)!important;color:#fff!important;padding:1.4rem!important;box-shadow:0 18px 42px rgba(15,23,42,.18)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-hero h3{color:#fff!important;font-size:clamp(1.25rem,2vw,1.65rem)!important;letter-spacing:-.02em}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-hero p{color:#d8e9e8!important;font-size:.82rem!important;line-height:1.8}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-stepper{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.7rem;margin:1rem 0 1.15rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step{display:flex;align-items:center;gap:.7rem;min-width:0;width:100%;padding:.85rem .9rem;border:1px solid #dce5ee;border-radius:1.1rem;background:linear-gradient(145deg,#fff,#f7fafc);text-align:right;cursor:pointer;transition:all .2s ease}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step-icon{display:grid;place-items:center;flex:0 0 2.7rem;width:2.7rem;height:2.7rem;border-radius:.9rem;background:#edf2f7;color:#64748b;font-size:1.15rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step b{display:block;color:#334155;font-size:.75rem;font-weight:900}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step small{display:block;margin-top:.18rem;color:#718096;font-size:.62rem;line-height:1.5}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step.is-active{border-color:#0f9f77;background:linear-gradient(145deg,#ecfdf5,#fff);box-shadow:0 8px 22px rgba(16,185,129,.12);transform:translateY(-1px)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step.is-active .tt-premium-step-icon{background:#0f9f77;color:#fff}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step.is-complete .tt-premium-step-icon{background:#dcfce7;color:#047857}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-intro{display:flex;align-items:center;gap:.8rem;margin:.8rem 0 1rem;padding:.9rem 1rem;border:1px solid #dcefe8;border-radius:1rem;background:linear-gradient(110deg,#f0fdf8,#f8fbff)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-spark{display:grid;place-items:center;flex:0 0 2.6rem;height:2.6rem;border-radius:.9rem;background:#d1fae5;color:#047857;font-size:1.1rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-intro strong{display:block;color:#0f3d35;font-size:.82rem;font-weight:900}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-intro p{margin-top:.15rem;color:#64748b;font-size:.68rem}",
      "#timetableDailyAbsenceReasonModal .tt-absence-reason-option:has(input:checked){border-color:#10b981;background:linear-gradient(120deg,#ecfdf5,#fff);box-shadow:0 7px 18px rgba(16,185,129,.12)}",
      "#timetableDailyAbsenceReasonModal .tt-absence-reason-option:has(input:checked)>span:first-of-type{background:#d1fae5;color:#047857}",
      "#timetableDailyAbsenceReasonModal .tt-absence-reason-option:focus-within{outline:3px solid rgba(16,185,129,.2);outline-offset:2px}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card{margin:1rem 0;padding:1.1rem;border:1px solid #dce5ee;border-radius:1.35rem;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.045);transition:border-color .2s,box-shadow .2s}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card.is-current{border-color:#7dd3b0;box-shadow:0 12px 32px rgba(16,185,129,.09)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card.is-complete{border-color:#a7f3d0;background:linear-gradient(130deg,#f0fdf8,#fff)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card-heading{display:flex;align-items:center;gap:.8rem;margin-bottom:.9rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card-heading>div{min-width:0;flex:1}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card-heading strong{display:block;color:#172033;font-size:.92rem;font-weight:900}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card-heading small{display:block;margin-top:.2rem;color:#64748b;font-size:.68rem;line-height:1.6}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-icon{display:grid;place-items:center;flex:0 0 3.2rem;width:3.2rem;height:3.2rem;border-radius:1.05rem;font-size:1.35rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-icon-date{background:#e0f2fe;color:#0369a1}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-icon-absent{background:#fff1f2;color:#be123c}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-chip{padding:.35rem .7rem;border-radius:999px;background:#ecfdf5;color:#047857;font-size:.62rem;font-weight:900}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-date-control{max-width:26rem;padding:.15rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-date-control input{width:100%;min-height:3.2rem;border:1px solid #cbd5e1;border-radius:1rem;background:#f8fafc;padding:.75rem 1rem;font-size:1rem;font-weight:800;color:#0f172a}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card{background:linear-gradient(145deg,rgba(255,255,255,.82),rgba(248,252,255,.72));backdrop-filter:blur(18px) saturate(145%);-webkit-backdrop-filter:blur(18px) saturate(145%);border-color:rgba(203,213,225,.72);box-shadow:0 18px 48px rgba(15,23,42,.075),inset 0 1px 0 rgba(255,255,255,.82)}",
      ".tt-premium-date-nav{display:flex;align-items:center;flex-wrap:wrap;gap:.55rem;margin-top:.8rem}",
      ".tt-premium-date-nav button{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;min-height:2.7rem;padding:.6rem 1rem;border:1px solid rgba(148,163,184,.35);border-radius:.9rem;background:rgba(255,255,255,.72);color:#334155;font-size:.78rem;font-weight:900;transition:transform .18s ease,background .18s ease,border-color .18s ease,box-shadow .18s ease}",
      ".tt-premium-date-nav button:hover{transform:translateY(-2px);border-color:#34d399;background:#ecfdf5;box-shadow:0 8px 18px rgba(16,185,129,.12)}",
      ".tt-premium-date-nav button.is-today{border-color:rgba(16,185,129,.4);background:rgba(236,253,245,.76);color:#047857}",
      ".tt-premium-date-nav button.is-selected{border-color:#10b981;background:linear-gradient(135deg,#059669,#0f766e);color:#fff;box-shadow:0 8px 20px rgba(5,150,105,.2)}",
      ".tt-premium-date-nav .tt-date-nav-hint{margin-inline-start:auto;color:#64748b;font-size:.68rem;font-weight:600}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-toolbar{border-color:rgba(203,213,225,.7);background:linear-gradient(125deg,rgba(248,250,252,.86),rgba(236,253,245,.78));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 12px 32px rgba(15,23,42,.055)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step{background:linear-gradient(145deg,rgba(255,255,255,.9),rgba(245,249,252,.78));backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 8px 22px rgba(15,23,42,.035)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step:hover{transform:translateY(-2px);border-color:#86cdb2;box-shadow:0 12px 24px rgba(15,23,42,.08)}",
      "#timetableSubstitutionPanel button:focus-visible,#timetableSubstitutionPanel input:focus-visible,#timetableSubstitutionPanel select:focus-visible{outline:3px solid rgba(16,185,129,.28);outline-offset:2px}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card{background:linear-gradient(145deg,rgba(20,34,54,.9),rgba(15,23,42,.82));border-color:rgba(71,85,105,.68);backdrop-filter:blur(18px) saturate(135%);-webkit-backdrop-filter:blur(18px) saturate(135%)}",
      ".dark .tt-premium-date-nav button{border-color:#475569;background:rgba(30,41,59,.82);color:#e2e8f0}",
      ".dark .tt-premium-date-nav button:hover{border-color:#34d399;background:#12382f}",
      ".dark .tt-premium-date-nav button.is-today{border-color:#0f766e;background:rgba(6,78,59,.35);color:#a7f3d0}",
      ".dark .tt-premium-date-nav .tt-date-nav-hint{color:#94a3b8}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-search{width:100%;min-height:3.4rem;border:1.5px solid #cbd5e1!important;border-radius:1rem!important;background:#f8fafc!important;padding:.9rem 1rem!important;font-size:1rem!important;font-weight:700}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-selected-tags{display:flex;flex-wrap:wrap;gap:.55rem;margin-top:.8rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-toolbar{display:flex;flex-wrap:wrap;gap:.7rem;padding:1rem;border:1px solid #dce5ee;border-radius:1.25rem;background:linear-gradient(130deg,#f8fafc,#eef7f4)}",
      "#timetableSubstitutionPanel [hidden]{display:none!important}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-toolbar .tt-action{min-height:3rem;border-radius:1rem;padding:.75rem 1rem;font-size:.8rem;font-weight:900;box-shadow:0 4px 10px rgba(15,23,42,.05)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-results{display:none;margin-top:1rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-results.tt-premium-results-ready{display:block}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-department-card{min-height:4.4rem;transition:border-color .15s,background .15s,box-shadow .15s}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-department-card:has(input:checked){border-color:#818cf8;background:linear-gradient(120deg,#eef2ff,#fff);box-shadow:0 5px 14px rgba(99,102,241,.09)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-department-multiselect option{padding:.45rem;border-radius:.45rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-other-teacher-card{transition:border-color .15s,background .15s}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-other-teacher-card:has(input:checked){border-color:#818cf8;background:#eef2ff}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card{border-color:#334155;background:linear-gradient(145deg,#111c2e,#0f172a);box-shadow:0 12px 30px rgba(0,0,0,.18)}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card-heading strong,.dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step b{color:#f1f5f9}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card-heading small,.dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step small{color:#a8b5c7}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step{border-color:#334155;background:linear-gradient(145deg,#172338,#111c2e)}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step.is-active{border-color:#34d399;background:linear-gradient(145deg,#12382f,#172338)}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-intro{border-color:#285348;background:linear-gradient(110deg,#102e2a,#172338)}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-intro strong{color:#d1fae5}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-date-control input,.dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-search{border-color:#475569!important;background:#0f172a!important;color:#f8fafc!important}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-department-card,.dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-other-teacher-card{border-color:#334155;background:#172338}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-department-card strong,.dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-other-teacher-card strong{color:#f1f5f9}",
      ".dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-department-card:has(input:checked),.dark :is(#timetableSubstitutionPanel,#substitutionView) .tt-other-teacher-card:has(input:checked){border-color:#818cf8;background:#24264a}",
      "@media(max-width:700px){:is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-stepper{grid-template-columns:repeat(2,minmax(0,1fr))}:is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step{padding:.7rem}:is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step-icon{flex-basis:2.4rem;width:2.4rem;height:2.4rem}:is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-card{padding:.9rem}}",
      "@media(max-width:420px){:is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-stepper{grid-template-columns:1fr 1fr}:is(#timetableSubstitutionPanel,#substitutionView) .tt-premium-step small{font-size:.55rem}}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-reserve-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.55rem;margin:.2rem 0}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-reserve-steps button{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;align-items:center;column-gap:.55rem;text-align:right;padding:.7rem;border:1px solid #dbe4ed;border-radius:1rem;background:#f8fafc;min-width:0}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-reserve-steps button span{grid-row:1/3;display:grid;place-items:center;width:2rem;height:2rem;border-radius:.7rem;background:#d1fae5;color:#065f46;font-weight:900}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-reserve-steps button strong{font-size:.72rem;color:#0f172a}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-reserve-steps button small{font-size:.58rem;color:#64748b}",
      "@media(max-width:520px){:is(#timetableSubstitutionPanel,#substitutionView) .tt-reserve-steps{grid-template-columns:1fr}:is(#timetableSubstitutionPanel,#substitutionView) .tt-reserve-steps button{grid-template-columns:2rem 1fr;grid-template-rows:auto auto}}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-lesson{border-color:#dbe4ed;background:linear-gradient(135deg,#fff,#f8fafc);box-shadow:0 5px 18px rgba(15,23,42,.045);border-radius:1rem}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-period-indicator{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.38rem;width:max-content;min-width:10.5rem;min-height:6.2rem;padding:1rem 1.45rem;border:2px solid #0f766e;border-radius:1.25rem;background:linear-gradient(145deg,#ecfeff 0%,#cffafe 48%,#ccfbf1 100%);color:#134e4a;box-shadow:0 12px 28px rgba(13,148,136,.2),inset 0 1px 0 rgba(255,255,255,.9)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-period-indicator span{font-size:1rem;font-weight:950;line-height:1.2;letter-spacing:.01em}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-period-indicator strong{font-size:2.65rem;line-height:1;font-weight:1000;font-variant-numeric:tabular-nums}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-period-indicator em{font-size:.85rem;font-style:normal;font-weight:900;line-height:1.2}",
      "@media(max-width:640px){:is(#timetableSubstitutionPanel,#substitutionView) .tt-period-indicator{min-width:9.2rem;min-height:5.8rem;padding:.85rem 1.1rem}:is(#timetableSubstitutionPanel,#substitutionView) .tt-period-indicator strong{font-size:2.35rem}}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-lesson:focus-within{border-color:#60a5fa;box-shadow:0 0 0 3px rgba(59,130,246,.1)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-lesson-choice{min-width:0}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-lesson-choice select{display:block;width:100%;min-width:0;max-width:100%;border:1px solid #cbd5e1;border-radius:.8rem;background:#fff;padding:.7rem;font-size:16px;line-height:1.4}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-lesson{min-width:0}",
      "@media(max-width:640px){:is(#timetableSubstitutionPanel,#substitutionView) .tt-lesson{display:grid;grid-template-columns:minmax(0,1fr);gap:.65rem;padding:.85rem}:is(#timetableSubstitutionPanel,#substitutionView) .tt-lesson-actions{display:flex;flex-wrap:wrap;gap:.4rem}:is(#timetableSubstitutionPanel,#substitutionView) .tt-group-head{padding:.85rem}}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-group{overflow:hidden;border:1px solid #dbe4ed;border-radius:1.25rem;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.04)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-group-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;padding:1rem 1.1rem;background:linear-gradient(90deg,#f8fafc,#ecfdf5)}",
      ":is(#timetableSubstitutionPanel,#substitutionView) .tt-reason{width:100%;min-height:2.6rem;border:1px solid #cbd5e1;border-radius:.8rem;padding:.7rem;background:#fff;color:#0f172a;font-size:.75rem}",
      "#timetableDailySummary .tt-stat{border:1px solid #e2e8f0;border-radius:1rem;background:#f8fafc;padding:.8rem}",
      "#timetableDailySummary .tt-stat strong{display:block;font-size:1.25rem;font-weight:900;color:#0f172a}",
      "#timetableDailyArchiveResults .tt-archive-row{display:grid;grid-template-columns:1fr auto;gap:.75rem;align-items:center;border:1px solid #e2e8f0;border-radius:.9rem;background:#fff;padding:.8rem}",
      "#timetableDailyArchiveResults .tt-archive-row small{color:#64748b}",
      "@media(max-width:768px){:is(#timetableSubstitutionPanel,#substitutionView) .tt-group-head{align-items:stretch}#timetableDailyArchiveResults .tt-archive-row{grid-template-columns:1fr}}",
      "@media print{body.tt-reserve-print-mode *{visibility:hidden!important}body.tt-reserve-print-mode #sec-timetable,body.tt-reserve-print-mode #sec-timetable *{visibility:hidden!important}body.tt-reserve-print-mode #ttReservePrintRoot,body.tt-reserve-print-mode #ttReservePrintRoot *{visibility:visible!important}body.tt-reserve-print-mode #ttReservePrintRoot{display:block!important;position:absolute!important;inset:0!important;width:100%!important;margin:0!important;padding:0!important;background:#fff!important;color:#111!important}@page{size:A4 portrait;margin:10mm}#ttReservePrintRoot{direction:rtl;font-family:'Tajawal',Arial,sans-serif;color:#111;background:#fff}#ttReservePrintRoot .tt-print-header{text-align:center;font-size:10pt;font-weight:800;line-height:1.55;margin-bottom:7mm}#ttReservePrintRoot .tt-print-meta{display:flex;justify-content:space-between;gap:8mm;margin:5mm 0;font-weight:800;font-size:10pt}#ttReservePrintRoot table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9.5pt}#ttReservePrintRoot th,#ttReservePrintRoot td{border:1px solid #333;padding:2.5mm 2mm;text-align:center;vertical-align:middle;overflow-wrap:anywhere}#ttReservePrintRoot th{background:#eef1f4!important;font-weight:900;-webkit-print-color-adjust:exact;print-color-adjust:exact}#ttReservePrintRoot tr{break-inside:avoid;page-break-inside:avoid}#ttReservePrintRoot .tt-print-footer{margin-top:9mm;display:flex;justify-content:space-between;font-size:9pt;font-weight:800}}"
    ].join("\n");
    document.head.appendChild(style);
    updateBatchSaveVisibility();
    installPremiumReserveExperience(panel);
  }
  async function fetchBatchPreview() {
    if(includeOthers()&&!selectedOtherDepartmentIds().length)throw new Error("اختر تخصصاً واحداً على الأقل قبل تحميل أسماء المعلمين.");
    if(includeOthers()&&!reserveSelectedOtherTeacherNames.size)throw new Error("حدد معلماً واحداً على الأقل من القسم المساند واضغط إضافة المعلمين المحددين.");
    const {date, weekday} = timetableSubstitutionGetDate();
    const token = appAuthSession?.token || readAppAuthToken();
    if (!token) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({
      action: "timetable_substitution_batch_preview", weekday, assignmentDate: date,
      absentTeacherNames: [...timetableDailyAbsentTeachers], includeOtherDepartments: includeOthers(), otherDepartmentId:selectedOtherDepartmentId(), otherDepartmentIds:selectedOtherDepartmentIds(), otherTeacherNames:[...reserveSelectedOtherTeacherNames],
      manualAssignments: reserveManualChoices
    }, token);
  }
  window.timetableDailySetBusy = function (disabled) {
    ["timetableSubstitutionDate","timetableDailyAbsentSearch","timetableSubstitutionOtherDepartments"].forEach(id => {
      const control = $(id); if (control) control.disabled = disabled;
    });
    document.querySelectorAll("#timetableDailyAbsentTags [data-tt-remove-absent]").forEach(button => button.disabled = disabled);
    document.querySelectorAll("#timetableSubstitutionPanel button[onclick*=timetableDailyAutoAssign],#timetableSubstitutionPanel button[onclick*=timetableDailySaveBatch],#timetableDailySaveBatchButton,#timetableDailyOtherDepartmentsButton").forEach(button => button.disabled = disabled);
  };
  window.timetableDailyRefreshOne = async function () { return await window.timetableDailyRefreshAll(); };
  window.timetableDailyRefreshAll = async function () {
    if(!timetableDailyAbsentTeachers.length)restoreStoredDraft();
    if (!timetableDailyAbsentTeachers.length) {
      reserveBatchPreview = null; reserveDraftAssignments = []; reserveManualChoices=Object.create(null); reserveDraftApproved=new Set(); reserveLastAbsentSignature=""; reserveDraftScope=""; window.timetableDailyRenderLessons(); return;
    }
    const absentSignature=timetableDailyAbsentTeachers.join("\u0000");
    if(reserveLastAbsentSignature&&reserveLastAbsentSignature!==absentSignature)reserveDraftApproved=new Set();
    reserveLastAbsentSignature=absentSignature;
    const scope=currentDraftScope();
    if(reserveDraftScope&&reserveDraftScope!==scope){reserveManualChoices=Object.create(null);reserveDraftApproved=new Set();}
    reserveDraftScope=scope;
    try {
      reserveBatchPreview = await fetchBatchPreview();
      if (reserveBatchPreview.active === false) throw new Error("لا يوجد جدول أسبوعي نشط لتوزيع الاحتياط.");
      reserveDraftAssignments = (reserveBatchPreview.assignments || []).map(item => {
        const key=draftKey(item.absentTeacherName,item.period),manual=reserveManualChoices[key];
        const candidates=item.candidateOptions||[];
        const validManual=manual&&candidates.some(candidate=>candidate.teacherName===manual);
        if(manual&&!validManual)delete reserveManualChoices[key];
        return {absentTeacherName:item.absentTeacherName,substituteTeacherName:validManual?manual:item.substituteTeacherName,period:Number(item.period),candidateOptions:candidates,createsThreeConsecutive:item.createsThreeConsecutive===true};
      });
      window.timetableDailyRenderLessons(); persistStoredDraft(); return reserveBatchPreview;
    } catch (error) {
      reserveBatchPreview = {error:error?.message || "تعذر تحليل حصص الاحتياط."};
      reserveDraftAssignments = []; window.timetableDailyRenderLessons();
      status(error?.message || "تعذر تحليل جميع الحصص دفعة واحدة.", "error"); throw error;
    }
  };
  window.timetableDailyRemoveAbsent = async function (name) {
    if (timetableDailyBusy) return;
    timetableDailyAbsentTeachers = timetableDailyAbsentTeachers.filter(item => item !== name);
    reserveDraftApproved.delete(name);
    delete reserveReasons[name];
    Object.keys(reserveManualChoices).filter(key=>key.startsWith(String(name)+"\u0000")).forEach(key=>delete reserveManualChoices[key]);
    delete reserveAbsenceReasons[name];
    timetableDailyRenderTags(); await window.timetableDailyRefreshAll();
  };
  window.timetableDailyRenderLessons = function () {
    const host = $("timetableSubstitutionResults"), summary = $("timetableDailySummary");
    if (!host) return;
    if (reserveBatchPreview?.error) {
      host.innerHTML = '<div class="rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-bold text-red-700">' + esc(reserveBatchPreview.error) + "</div>";
      if (summary) summary.innerHTML = ""; updateBatchSaveVisibility(); return;
    }
    if (!timetableDailyAbsentTeachers.length) {
      host.innerHTML = '<div class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500"><i class="fa-solid fa-user-plus mb-2 block text-2xl text-slate-400"></i>ابحث عن المعلم الغائب ثم أضفه إلى القائمة.</div>';
      if (summary) summary.innerHTML = ""; updateBatchSaveVisibility(); return;
    }
    const planned = reserveBatchPreview?.assignments || [], missing = reserveBatchPreview?.unassigned || [], saved = reserveBatchPreview?.existingAssignments || [];
    const total = planned.length + missing.length + saved.length;
    if (summary) summary.innerHTML = [
      ["المعلمون الغائبون",timetableDailyAbsentTeachers.length,"fa-users"],["إجمالي الحصص",total,"fa-book-open"],
      ["اقتراحات جاهزة",planned.length,"fa-circle-check"],["تحتاج معالجة",missing.length,"fa-triangle-exclamation"]
    ].map(([label,value,icon]) => '<div class="tt-stat"><span class="text-[10px] font-bold text-slate-500"><i class="fa-solid ' + icon + ' ml-1"></i>' + label + '</span><strong>' + Number(value) + "</strong></div>").join("")+
      '<details class="mt-3 rounded-xl border border-teal-200 bg-teal-50/70 p-3"><summary class="cursor-pointer text-xs font-black text-teal-900">عدالة التوزيع واحتساب النقاط</summary><div class="mt-2 space-y-1 text-[10px] leading-6 text-slate-700"><p><strong>المعادلة:</strong> الرصيد التراكمي + (وزن الحصة × معامل النصاب) + غرامة التتالي + غرامة الاحتياط اليومي − أفضلية رصيد التعويض.</p><p><strong>أوزان الحصص:</strong> 1 و2 = 1 · 3 و4 = 1.5 · 6 = 2.5 · 5 = 3 · 7 = 4 · 8 = 5.</p><p><strong>معامل النصاب:</strong> حصتان أو أقل = 1 · 3 = 1.25 · 4 = 1.6 · 5 فأكثر = مستبعد تلقائياً إلا عند انعدام البدائل.</p><p><strong>غرامات التنظيم:</strong> 3 متتالية = +15 · 4 فأكثر = +50 · احتياط سابق اليوم = +10. لا تضاف هذه الغرامات إلى الرصيد الفعلي عند الاعتماد.</p><p><strong>القاعدة:</strong> الأقل في درجة الترشيح هو الأوفر حظاً. الغياب الطارئ يمنح رصيد تعويض +2 يتناقص بمقدار نقطة عند تغطية زميل لاحقاً.</p></div></details>';
    const activeAbsentName=timetableDailyAbsentTeachers.find(name=>
      !reserveDraftApproved.has(name)&&(
        planned.some(item=>item.absentTeacherName===name)||missing.some(item=>item.absentTeacherName===name)
      )
    )||"";
    host.innerHTML = timetableDailyAbsentTeachers.map(absentName => {
      const rows = [
        ...planned.filter(item=>item.absentTeacherName===absentName).map(item=>({...item,kind:"planned"})),
        ...missing.filter(item=>item.absentTeacherName===absentName).map(item=>({...item,kind:"missing"})),
        ...saved.filter(item=>item.absentTeacherName===absentName).map(item=>({...item,kind:"saved"}))
      ].sort((a,b)=>Number(a.period)-Number(b.period));
      if (!rows.length) return "";
      const pendingRows=rows.filter(item=>item.kind!=="saved");
      const approved=reserveDraftApproved.has(absentName);
      if(pendingRows.length&&approved){
        return '<section class="tt-group border border-emerald-200 bg-emerald-50"><div class="flex items-center justify-between gap-2 p-3"><div><div class="text-[10px] font-black text-emerald-700">تم اعتماد المعلم</div><strong class="text-xs text-slate-900">'+esc(absentName)+'</strong><div class="text-[10px] text-emerald-700">'+pendingRows.length+' حصة ضمن مسودة اليوم</div></div><button type="button" data-tt-approve="'+esc(absentName)+'" class="tt-action border border-emerald-300 bg-white text-emerald-800">مراجعة التوزيع</button></div></section>';
      }
      if(pendingRows.length&&absentName!==activeAbsentName)return "";
      if(!pendingRows.length){
        const savedRows=rows.filter(item=>item.kind==="saved");
        const date=String(savedRows[0]?.assignmentDate||timetableSubstitutionGetDate().date);
        const canDelete=savedRows.length>0&&savedRows.every(item=>item.canDelete===true);
        const canEdit=savedRows.length>0&&savedRows.every(item=>item.canEdit===true&&["assigned","confirmed"].includes(item.status));
        const savedReason=String(savedRows.find(item=>item.absenceReason&&item.absenceReason!=="-")?.absenceReason||reserveAbsenceReasons[absentName]||"");
        const actions=(canEdit||canDelete)?'<div class="mt-3 flex flex-wrap gap-2">'+(canEdit?'<button type="button" data-tt-edit-saved-group="'+esc(absentName)+'" data-tt-saved-date="'+esc(date)+'" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800">تعديل التوزيع</button>':"")+(canDelete?'<button type="button" data-tt-delete-saved-group="'+esc(absentName)+'" data-tt-saved-date="'+esc(date)+'" class="tt-action border border-rose-200 bg-rose-50 text-rose-700">حذف الغياب والاحتياط بالكامل</button>':"")+'</div>':'<span class="mt-2 block text-[10px] text-slate-500">انتهت مهلة الحصة أو أن السجل للقراءة فقط.</span>';
        return '<section class="tt-group border border-emerald-200 bg-emerald-50 p-3"><div class="flex flex-wrap items-center justify-between gap-2"><div><div class="text-[10px] font-black text-emerald-700">تم حفظ التوزيع</div><strong class="text-xs text-slate-900">'+esc(absentName)+'</strong><div class="text-[10px] text-emerald-700">'+savedRows.length+' حصص محفوظة</div><div class="mt-1 text-[10px] text-amber-800">سبب الغياب: '+esc(savedReason||"—")+'</div></div>'+actions+'</div></section>';
      }
      const savedAbsenceReason=saved.find(item=>item.absentTeacherName===absentName&&item.absenceReason&&item.absenceReason!=="-")?.absenceReason||"";
      if(savedAbsenceReason)reserveAbsenceReasons[absentName]=savedAbsenceReason;
      const absenceReason=savedAbsenceReason||reserveAbsenceReasons[absentName]||"";
      const savedRows=rows.filter(item=>item.kind==="saved");
      const savedGroupDate=String(savedRows[0]?.assignmentDate||timetableSubstitutionGetDate().date);
      const canDeleteSavedGroup=savedRows.length>0&&savedRows.every(item=>item.canDelete===true);
      const canEditSavedGroup=savedRows.length>0&&savedRows.every(item=>item.canEdit===true&&["assigned","confirmed"].includes(item.status));
      const mixedSavedActions=pendingRows.length&&(canDeleteSavedGroup||canEditSavedGroup)?'<div class="flex flex-wrap gap-2">'+(canEditSavedGroup?'<button type="button" data-tt-edit-saved-group="'+esc(absentName)+'" data-tt-saved-date="'+esc(savedGroupDate)+'" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800">تعديل التوزيع</button>':"")+(canDeleteSavedGroup?'<button type="button" data-tt-delete-saved-group="'+esc(absentName)+'" data-tt-saved-date="'+esc(savedGroupDate)+'" class="tt-action border border-rose-200 bg-rose-50 text-rose-700">حذف الغياب والاحتياط بالكامل</button>':"")+'</div>':"";
      const cards = rows.map(item => {
        const draft = reserveDraftAssignments.find(row=>row.absentTeacherName===absentName&&Number(row.period)===Number(item.period));
        const reserveKey=reserveReasonKey(absentName,item.period);
        const savedDutyReason=String(item.reason||"").trim();
        if(reserveReasons[reserveKey]===undefined&&savedDutyReason&&savedDutyReason!=="-")reserveReasons[reserveKey]=savedDutyReason;
        const dutyReason=reserveReasons[reserveKey]??savedDutyReason;
        let choice="", action="";
        if (item.kind==="saved") {
          const state=item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":item.status==="cancelled"?"ملغى":"محفوظ";
          choice='<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-800"><div>البديل المحفوظ: '+esc(item.substituteTeacherName)+' · '+state+'</div><div class="mt-1 text-[10px] font-normal">سبب الغياب: '+esc(item.absenceReason||"-")+'</div><div class="mt-1 text-[10px] font-normal">سبب الاحتياط: '+esc(item.reason||"-")+'</div></div>';
          const editButton=item.canEdit===true&&["assigned","confirmed"].includes(item.status)&&item.id?'<button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-edit="'+esc(item.id)+'">تعديل</button>':"";
          const deleteButton=item.canDelete===true&&["assigned","confirmed","completed"].includes(item.status)&&item.id?'<button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-delete="'+esc(item.id)+'">حذف</button>':"";
          action=editButton||deleteButton?'<div class="flex flex-wrap gap-1">'+editButton+deleteButton+'</div>':(item.canEdit===false&&item.canDelete!==true?'<span class="text-[10px] text-slate-400">انتهى يوم التوزيع · للقراءة فقط</span>':'<span class="text-[10px] text-slate-400">'+state+'</span>');
        } else {
          const candidates=item.candidateOptions||[];
          const options=candidates.map(candidate=>{const occupied=(Array.isArray(candidate.occupiedPeriods)?candidate.occupiedPeriods:[]).map(Number).filter(period=>Number.isInteger(period)&&period>0).sort((a,b)=>a-b);const periodText=occupied.length?occupied.map(period=>new Intl.NumberFormat("ar").format(period)).join("، "):"—";return '<option value="'+esc(candidate.teacherName)+'" '+(draft?.substituteTeacherName===candidate.teacherName?"selected":"")+'>'+esc(candidate.teacherName)+' · أولوية '+Number(candidate.candidateScore||0).toFixed(2)+' · الرصيد '+Number(candidate.pointsBalance||0).toFixed(2)+' · الحصص '+periodText+'</option>';}).join("");
          const selectedCandidate=candidates.find(candidate=>candidate.teacherName===draft?.substituteTeacherName)||candidates[0];
          const transparency=candidates.length?'<details class="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3"><summary class="cursor-pointer text-[10px] font-black text-slate-700">شفافية ترتيب المرشحين ('+candidates.length+')</summary><div class="mt-2 space-y-2">'+candidates.map((candidate,index)=>'<article class="rounded-lg border border-slate-200 bg-white p-2 text-[10px]"><div class="flex flex-wrap items-center justify-between gap-2"><strong>'+new Intl.NumberFormat("ar").format(index+1)+'. '+esc(candidate.teacherName)+'</strong><strong>درجة الترشيح: '+Number(candidate.candidateScore||0).toFixed(2)+'</strong></div><div class="mt-1 text-slate-600">الرصيد التراكمي: '+Number(candidate.pointsBalance||0).toFixed(2)+' · نصاب اليوم: '+Number(candidate.dailyTeachingCount||0)+' · احتياط اليوم: '+Number(candidate.dailySubstitutionCount||0)+'</div><div class="mt-1 font-bold text-slate-700">'+esc(candidate.streakStatus||"متاح بسلاسة")+' · جهد الحصة: '+Number(candidate.effortPoints||0).toFixed(2)+'</div><div class="mt-1 text-slate-500">'+(Array.isArray(candidate.reasons)?candidate.reasons.map(esc).join(" · "):"")+'</div></article>').join("")+'</div></details>':'';
          choice=candidates.length?'<label class="block"><span class="mb-1 block text-[10px] font-bold text-slate-500">أفضل البدلاء المتاحين لهذه الحصة، مرتبين حسب أقل درجة ترشيح</span><select data-tt-substitute data-absent="'+esc(absentName)+'" data-period="'+Number(item.period)+'"><option value="">اختر البديل</option>'+options+'</select></label>'+transparency:(item.blockReason==="daily_limit"?'<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">يوجد '+Number(item.blockedCandidateCount||0)+' من المعلمين لديهم فراغ مؤكد، لكنهم بلغوا الحد الأعلى المسموح: حصتان احتياط في اليوم. لم يتجاوز النظام هذا الحد حفاظاً على العدالة.</div>':item.blockReason==="period_passed"?'<div class="rounded-xl border border-slate-300 bg-slate-100 p-3 text-xs text-slate-700">انتهى وقت هذه الحصة؛ لا يمكن إضافة تكليف احتياط لها بعد انتهاء موعدها.</div>':item.blockReason==="period_capacity"?'<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">المعلمون المتاحون لهذه الفترة خُصصوا لتغطية حصص غياب أخرى في الفترة نفسها؛ لا يمكن تكليف المعلم بحصتين متزامنتين.</div>':'<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">لا يوجد معلم متاح بفراغ مؤكد لهذه الحصة.</div>');
          if(draft?.createsThreeConsecutive||item.createsThreeConsecutive)choice+='<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-[10px] font-bold text-amber-800">تنبيه: هذا الاختيار يكوّن ثلاث حصص متتالية أو أكثر.</div>';
          action='<span class="text-[10px] text-slate-500">'+(draft?"مقترح قابل للتعديل":"لا يوجد اقتراح")+"</span>";
        }
        return '<article class="tt-lesson"><div class="tt-lesson-main"><div class="tt-period-indicator" aria-label="الحصة '+esc(item.period)+'"><span>الحصة الحالية</span><strong>'+new Intl.NumberFormat("ar").format(Number(item.period))+'</strong><em>'+esc(item.className||"الشعبة غير محددة")+'</em></div><div class="mt-2 text-xs font-black text-slate-800">'+esc(item.subject||"المادة غير محددة")+'</div></div><div class="tt-lesson-choice">'+choice+(item.kind!=="saved"?reserveDutyReasonMarkup(absentName,item.period,dutyReason):"")+'</div><div class="tt-lesson-actions">'+action+"</div></article>";
      }).join("");
      const approvalControl=pendingRows.length
        ? '<div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 p-3"><span class="text-[10px] font-bold '+(approved?'text-emerald-700':'text-slate-500')+'">'+(approved?'تم اعتماد توزيع هذا المعلم ضمن مسودة اليوم':'راجع الحصص والبدلاء ثم اعتمد هذا المعلم')+'</span><button type="button" data-tt-approve="'+esc(absentName)+'" class="tt-action '+(approved?'border border-emerald-300 bg-emerald-50 text-emerald-800':'bg-indigo-700 text-white')+'">'+(approved?'إلغاء الاعتماد للمراجعة':'اعتماد توزيع هذا المعلم')+'</button></div>'
        : '<div class="border-t border-slate-200 bg-emerald-50 p-3 text-[10px] font-bold text-emerald-700">لا توجد تكليفات جديدة لهذا المعلم؛ الحصص الظاهرة محفوظة مسبقاً.</div>';
      return '<section class="tt-group"><div class="tt-group-head"><div><div class="text-[10px] font-black text-emerald-700">المعلم الغائب</div><h4 class="mt-1 text-sm font-black text-slate-900">'+esc(absentName)+'</h4><div class="mt-1 text-[10px] text-slate-500">'+rows.length+' حصة · '+rows.filter(x=>x.kind==="saved").length+' محفوظة · '+rows.filter(x=>x.kind==="planned").length+' مقترحة</div></div><div class="flex flex-wrap items-center gap-2">'+mixedSavedActions+reasonControlMarkup(absentName,absenceReason,!savedRows.length)+'</div></div><div class="space-y-2 p-3 sm:p-4">'+cards+'</div>'+approvalControl+'</section>';
    }).join("") || '<div class="rounded-xl border border-slate-200 p-4 text-xs text-slate-500">لا توجد حصص مطلوبة.</div>';
    host.querySelectorAll("[data-tt-substitute]").forEach(select=>select.addEventListener("change",()=>{
      const item=reserveDraftAssignments.find(row=>row.absentTeacherName===select.dataset.absent&&Number(row.period)===Number(select.dataset.period));
      if(!item)return;
      const chosen=select.value;
      if(chosen){
        const candidate=(item.candidateOptions||[]).find(row=>row.teacherName===chosen);
        const samePeriod=reserveDraftAssignments.some(row=>row!==item&&row.substituteTeacherName===chosen&&Number(row.period)===Number(item.period));
        const alreadyChosen=reserveDraftAssignments.filter(row=>row!==item&&row.substituteTeacherName===chosen).length;
        const dailyCount=Number(candidate?.dailySubstitutionCount||0)+alreadyChosen;
        if(samePeriod||dailyCount>=2){
          select.value=item.substituteTeacherName||"";
          status(samePeriod?"هذا المعلم اختير بالفعل للحصة نفسها. اختر بديلاً آخر.":"سيؤدي هذا الاختيار إلى تجاوز حد حصتين احتياط في اليوم.","error");
          return;
        }
        const otherPeriods=reserveDraftAssignments.filter(row=>row!==item&&row.substituteTeacherName===chosen).map(row=>Number(row.period));
        const triple=hasTriple([...(candidate?.occupiedPeriods||[]),...otherPeriods],item.period);
        item.createsThreeConsecutive=triple;
        item.substituteTeacherName=chosen;
        reserveManualChoices[draftKey(item.absentTeacherName,item.period)]=chosen;
        status(triple?"تم الاختيار، لكن سيؤدي إلى ثلاث حصص متتالية أو أكثر؛ راجع الاختيار قبل الحفظ.":"تم تغيير البديل. احفظ التوزيع بعد مراجعة جميع الحصص.","info");
        persistStoredDraft();
        window.timetableDailyRenderLessons();
        // Re-run the same server-side batch planner so this manual choice updates
        // the virtual allocation and every remaining unapproved lesson suggestion.
        void window.timetableDailyRefreshAll().catch(()=>{});
      }else{
        item.substituteTeacherName="";
        delete reserveManualChoices[draftKey(item.absentTeacherName,item.period)];
        status("أزيل اختيار البديل لهذه الحصة.","info");
      }
    }));
    host.querySelectorAll("[data-tt-approve]").forEach(button=>button.addEventListener("click",()=>{
      const absentName=button.dataset.ttApprove;
      if(reserveDraftApproved.has(absentName)){reserveDraftApproved.delete(absentName);status("أُلغي اعتماد "+absentName+" ويمكنك مراجعة بدائله.","info");}
      else{
        const required=(reserveBatchPreview?.assignments||[]).filter(item=>item.absentTeacherName===absentName);
        const unresolved=required.filter(item=>!reserveDraftAssignments.find(row=>row.absentTeacherName===absentName&&Number(row.period)===Number(item.period))?.substituteTeacherName);
        const missing=(reserveBatchPreview?.unassigned||[]).filter(item=>item.absentTeacherName===absentName);
        if(unresolved.length||missing.length){status("لا يمكن اعتماد "+absentName+" قبل معالجة جميع حصصه غير المغطاة.","error");return;}
        reserveDraftApproved.add(absentName);status("تم اعتماد توزيع "+absentName+" ضمن مسودة اليوم. انتقل إلى المعلم التالي.","success");
      }
      persistStoredDraft();window.timetableDailyRenderLessons();
    }));
    host.querySelectorAll("[data-tt-reason]").forEach(input=>input.addEventListener("input",()=>{
      reserveReasons[input.dataset.ttReason]=input.value.trim();
      persistStoredDraft();
    }));
    host.querySelectorAll("[data-tt-edit-absence-reason]").forEach(button=>button.addEventListener("click",()=>{
      const absentName=button.dataset.ttEditAbsenceReason;
      openAbsenceReasonPicker(absentName,value=>{
          if(!value)return;
          reserveAbsenceReasons[absentName]=value;persistStoredDraft();window.timetableDailyRenderLessons();});
    }));
    host.querySelectorAll("[data-tt-edit-saved-group]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyOpenArchiveDayEdit(button.dataset.ttSavedDate,button.dataset.ttEditSavedGroup)));
    host.querySelectorAll("[data-tt-delete-saved-group]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyCancelAbsentDistribution(button.dataset.ttSavedDate,button.dataset.ttDeleteSavedGroup)));
    host.querySelectorAll("[data-tt-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveEdit(button.dataset.ttEdit)));
    host.querySelectorAll("[data-tt-delete]").forEach(button=>button.addEventListener("click",()=>timetableDailyCancelAssignment(button.dataset.ttDelete)));
    updateBatchSaveVisibility();
  };
  window.timetableDailyAutoAssign = async function () {
    if(timetableDailyBusy)return;
    if(!timetableDailyAbsentTeachers.length){status("أضف معلماً غائباً واحداً على الأقل.","error");return;}
    timetableDailyBusy=true;timetableDailySetBusy(true);
    try{
      reserveManualChoices=Object.create(null);
      reserveDraftApproved=new Set();
      reserveBatchPreview=await fetchBatchPreview();
      if(reserveBatchPreview.active===false)throw new Error("لا يوجد جدول أسبوعي نشط لتوزيع الاحتياط.");
      reserveDraftScope=currentDraftScope();
      reserveDraftAssignments=(reserveBatchPreview.assignments||[]).map(item=>({absentTeacherName:item.absentTeacherName,substituteTeacherName:item.substituteTeacherName,period:Number(item.period),candidateOptions:item.candidateOptions||[]}));
      timetableDailyRenderLessons();
      persistStoredDraft();
      status("قرأ النظام جميع حصص الغياب معاً وأعد أفضل توزيع شامل. راجع البدلاء والأسباب ثم اضغط حفظ التوزيع.","success");
    }catch(error){status(error?.message||"تعذر إعداد التوزيع الذكي.","error");}
    finally{timetableDailyBusy=false;timetableDailySetBusy(false);}
  };
  window.timetableDailySaveBatch = async function () {
    if(timetableDailyBusy)return;
    if(!timetableDailyAbsentTeachers.length){status("اختر المعلمين الغائبين أولاً.","error");return;}
    const required=[...new Set([...(reserveBatchPreview?.assignments||[]),...(reserveBatchPreview?.unassigned||[])].map(item=>String(item.absentTeacherName||"")).filter(Boolean))];
    const unapproved=required.filter(name=>!reserveDraftApproved.has(name));
    if(unapproved.length){status("اعتمد توزيع كل معلم غائب أولاً: "+unapproved.join("، "), "error");return;}
    const unresolved=(reserveBatchPreview?.unassigned||[]);
    if(unresolved.length){status("لا يمكن الحفظ قبل معالجة جميع الحصص التي تحتاج إلى بديل.", "error");return;}
    const assignments=reserveDraftAssignments.filter(item=>item.substituteTeacherName&&reserveDraftApproved.has(item.absentTeacherName)).map(item=>({
      absentTeacherName:item.absentTeacherName,substituteTeacherName:item.substituteTeacherName,period:Number(item.period),
      reserveReason:(reserveReasons[reserveReasonKey(item.absentTeacherName,item.period)]||reserveReasons[item.absentTeacherName]||"").trim()||"-",
      absenceReason:(reserveAbsenceReasons[item.absentTeacherName]||"").trim()||"-"
    }));
    if(!assignments.length){status("لا توجد اقتراحات جاهزة للحفظ. أعد إعداد التوزيع الذكي أو اختر البدلاء يدوياً.","error");return;}
    timetableDailyBusy=true;timetableDailySetBusy(true);
    try{
      const {date,weekday}=timetableSubstitutionGetDate(),token=appAuthSession?.token||readAppAuthToken();
      const result=await appAuthRequest({action:"timetable_substitution_batch_save",weekday,assignmentDate:date,
        absentTeacherNames:[...timetableDailyAbsentTeachers],assignments,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherDepartmentIds:selectedOtherDepartmentIds(),otherTeacherNames:[...reserveSelectedOtherTeacherNames]},token);
      const savedCount=Number(result.assignmentCount||assignments.length);
      // A successful batch-save response is the commit confirmation. Clear the
      // local draft immediately so a later refresh failure cannot invite a duplicate save.
      reserveManualChoices=Object.create(null);
      reserveDraftApproved=new Set();
      clearStoredDraft();
      // Include the exact committed date in the active/edit query, including future dates.
      // The initial archive range normally ends at today and would otherwise hide a future save.
      const archiveFrom=$("timetableDailyArchiveFrom"),archiveTo=$("timetableDailyArchiveTo");
      if(archiveFrom&&(!archiveFrom.value||archiveFrom.value>date)){
        const archiveStart=new Date(date+"T00:00:00Z");
        archiveStart.setUTCDate(archiveStart.getUTCDate()-365);
        archiveFrom.value=archiveStart.toISOString().slice(0,10);
      }
      if(archiveTo&&(!archiveTo.value||archiveTo.value<date))archiveTo.value=date;
      status("تم تأكيد حفظ "+savedCount+" تكليف في الخادم. يجري تحديث العرض والأرشيف...","success");
      try{
        await timetableDailyRefreshAll();
        await timetableDailyLoadArchive();
        if(typeof window.subxLoadEditableAssignments==="function"){
          await window.subxLoadEditableAssignments();
        }
        // If the logged-in coordinator assigned a reserve lesson to themselves, show the daily notice immediately.
        if(typeof window.teacherShowDailySubstitutionWelcome==="function") await window.teacherShowDailySubstitutionWelcome();
        status("تم حفظ "+savedCount+" تكليف وتحديث العرض والأرشيف بنجاح.","success");
      }catch(refreshError){
        status("تم حفظ "+savedCount+" تكليف بنجاح في الخادم، لكن تعذر تحديث العرض أو الأرشيف الآن. حدّث القائمة قبل أي إجراء جديد، ولا تُعد اعتماد التوزيع نفسه.","info");
        console.warn("Reserve batch was committed, but the post-save refresh failed.",refreshError);
      }
    }catch(error){status(error?.message||"تعذر حفظ التوزيع الجماعي؛ لم يصل تأكيد من الخادم.","error");}
    finally{timetableDailyBusy=false;timetableDailySetBusy(false);}
  };
  window.timetableDailyToggleArchive = async function () {
    const panel=$("timetableDailyArchivePanel");if(!panel)return;
    const opening=panel.classList.contains("hidden");panel.classList.toggle("hidden");if(opening)await timetableDailyLoadArchive();
  };
  window.timetableDailyLoadArchive = function () {
    const host=$("timetableDailyArchiveResults");if(!host)return Promise.resolve(false);
    const from=$("timetableDailyArchiveFrom")?.value||"",to=$("timetableDailyArchiveTo")?.value||"";
    const requestKey=from+"|"+to;
    // Reuse the current request only for the same date range. If the user changed
    // the range, queue a fresh read after the old one and never render stale data.
    if(reserveDailyArchiveLoadPromise){
      if(reserveDailyArchiveLoadKey===requestKey)return reserveDailyArchiveLoadPromise;
      return reserveDailyArchiveLoadPromise.then(()=>window.timetableDailyLoadArchive());
    }
    reserveDailyArchiveLoadKey=requestKey;
    reserveDailyArchiveLoadPromise=Promise.resolve().then(async()=>{
      const activeHost=$("timetableDailyActiveResults");
      try{
        host.innerHTML='<div class="p-4 text-center text-xs text-slate-500">جارٍ تحميل الأرشيف...</div>';
        if(activeHost)activeHost.innerHTML='<p class="text-center text-xs text-slate-500">جارٍ تحميل سجلات اليوم...</p>';
        const token=appAuthSession?.token||readAppAuthToken();
        if(!token)throw new Error("سجّل الدخول أولاً لعرض التوزيعات الحالية.");
        if(!from||!to){throw new Error("حدد تاريخ البداية وتاريخ النهاية.");}
        if(from>to){throw new Error("تاريخ البداية يجب أن يسبق تاريخ النهاية أو يساويه.");}
        const response=await reserveArchiveRequestWithTimeout(appAuthRequest({action:"timetable_substitution_archive",dateFrom:from,dateTo:to},token));
        if(($("timetableDailyArchiveFrom")?.value||"")!==from||($("timetableDailyArchiveTo")?.value||"")!==to)return false;
        reserveArchive=Array.isArray(response.archive)?response.archive:[];
        timetableDailyRenderArchive();return true;
      }catch(error){
        const message=error?.message||"تعذر تحميل الأرشيف.";
        host.innerHTML='<div class="rounded-xl bg-red-50 p-3 text-xs text-red-700">'+esc(message)+"</div>";
        if(activeHost)activeHost.innerHTML='<div class="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">'+esc(message)+'</div>';
        return false;
      }finally{reserveDailyArchiveLoadPromise=null;reserveDailyArchiveLoadKey=null;}
    });
    return reserveDailyArchiveLoadPromise;
  };
  window.timetableDailyPrintArchiveRange = function (sourceRecords) {
    const printOptions=arguments[1]||{};
    const records=(Array.isArray(sourceRecords)?sourceRecords:reserveArchive).filter(item=>item.status!=="cancelled"&&item.assignmentDate);
    if(!records.length){status("لا توجد سجلات احتياط غير ملغاة للطباعة في الفترة المحددة.","error");return;}
    const includeDepartment=printOptions?.showDepartment===true,grouped=new Map();
    records.forEach(item=>{const date=String(item.assignmentDate);if(!grouped.has(date))grouped.set(date,[]);grouped.get(date).push(item);});
    // One official A4 sheet per day; preserve all seven approved columns and widths.
    const days=[...grouped.entries()].sort((a,b)=>b[0].localeCompare(a[0])),pageTitle=String(printOptions?.pageTitle||"").trim();
    const pages=days.flatMap(([date,items])=>{
      const byAbsent=new Map();
      items.forEach(item=>{
        const name=String(item.absentTeacherName||"").trim(),departmentName=String(item.departmentName||item.department||"").trim();
        const key=includeDepartment?name+"\\u0000"+departmentName:name;
        if(!byAbsent.has(key)){
          const rawAbsenceReason=String(item.absenceReason||"").trim(),rawReserveReason=String(item.reason||"").trim();
          byAbsent.set(key,{absentName:name,departmentName,absenceReason:rawAbsenceReason==="-"||rawAbsenceReason==="—"?"":rawAbsenceReason,reserveReason:rawReserveReason==="-"||rawReserveReason==="—"?"":rawReserveReason,rows:[]});
        }
        byAbsent.get(key).rows.push({period:item.period,className:item.className,substitute:item.substituteTeacherName||"",reserveReason:String(item.reason||"")});
      });
      const dayGroups=[...byAbsent.values()].sort((a,b)=>a.absentName.localeCompare(b.absentName,"ar"));
      const options={singlePage:true,title:pageTitle,showDepartment:includeDepartment};
      // New archive cards force one official sheet per day; legacy callers retain measured overflow handling.
      if(printOptions?.archiveMode===true)return [reserveOfficialPrintMarkup(dayGroups,date,items[0]?.weekday||"",undefined,options)];
      return reserveOfficialPrintPages(dayGroups,date,items[0]?.weekday||"",undefined,options);
    });
    printOfficialReservePages(pages,undefined,{title:String(printOptions?.documentTitle||pageTitle||"").trim()});
  };
  async function fetchArchivePreview(absentName, date, weekday) {
    const token=appAuthSession?.token||readAppAuthToken();
    if(!token)throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({action:"timetable_substitution_preview",weekday,assignmentDate:date,forEdit:true,
      absentTeacherName:absentName,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherDepartmentIds:selectedOtherDepartmentIds(),otherTeacherNames:[...reserveSelectedOtherTeacherNames]},token);
  }
  window.timetableDailyRenderArchive = function () {
    const host=$("timetableDailyArchiveResults");if(!host)return;
    const activeRecords=(reserveArchive||[]).filter(item=>item.canEdit===true&&["assigned","confirmed"].includes(item.status));
    const activeHost=$("timetableDailyActiveResults"),activeCount=$("timetableDailyActiveCount");
    if(activeCount)activeCount.textContent=String(activeRecords.length);
    if(activeHost){
      activeHost.innerHTML=activeRecords.length?activeRecords.map(item=>
        '<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-white p-3">'+
          '<div><strong class="block text-xs text-slate-900">'+esc(item.absentTeacherName)+' ← '+esc(item.substituteTeacherName)+'</strong>'+
          '<span class="text-[10px] text-slate-600">الحصة '+Number(item.period)+' · '+esc(item.className||"—")+' · '+esc(item.assignmentDate||"")+'</span></div>'+
          '<div class="flex flex-wrap gap-1"><button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-active-edit="'+esc(item.id)+'">تعديل</button>'+
          '<button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-active-delete="'+esc(item.id)+'">حذف</button></div></div>'
      ).join(""):'<div class="rounded-xl border border-dashed border-emerald-200 bg-white p-4 text-center text-xs text-slate-500">لا توجد توزيعات نشطة قابلة للتعديل أو الحذف حالياً.</div>';
      activeHost.querySelectorAll("[data-tt-active-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveEdit(button.dataset.ttActiveEdit)));
      activeHost.querySelectorAll("[data-tt-active-delete]").forEach(button=>button.addEventListener("click",()=>timetableDailyCancelAssignment(button.dataset.ttActiveDelete)));
    }
    if(!reserveArchive.length){
      host.innerHTML='<div class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">لا توجد سجلات احتياط محفوظة ضمن الفترة المحددة.</div>';
      return;
    }
    const grouped=new Map();
    reserveArchive.forEach(item=>{const key=item.assignmentDate||"تاريخ غير محدد";if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(item);});
    const activeTotal=reserveArchive.filter(item=>item.canEdit===true&&["assigned","confirmed"].includes(item.status)).length;
    const archivedTotal=reserveArchive.length-activeTotal;
    host.innerHTML='<div class="mb-3 grid gap-2 sm:grid-cols-2">'+
      '<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><strong class="block text-xs text-emerald-900">توزيعات نشطة قابلة للتعديل والحذف</strong><span class="text-[10px] text-emerald-800">'+activeTotal+' تكليف متاح تعديلها وحذفها حتى نهاية اليوم بتوقيت سلطنة عمان</span></div>'+
      '<div class="rounded-xl border border-slate-200 bg-slate-50 p-3"><strong class="block text-xs text-slate-800">السجل التاريخي للقراءة والطباعة</strong><span class="text-[10px] text-slate-600">'+archivedTotal+' تكليف محفوظ في الأرشيف</span></div></div>'+
      Array.from(grouped.entries()).sort((a,b)=>b[0].localeCompare(a[0])).map(([date,items])=>{
        const byAbsent=new Map();
        items.forEach(item=>{const name=String(item.absentTeacherName||"غير محدد");if(!byAbsent.has(name))byAbsent.set(name,[]);byAbsent.get(name).push(item);});
        const editableItems=items.filter(item=>item.canEdit===true&&["assigned","confirmed"].includes(item.status));
        const dayButton=editableItems.length?'<button type="button" class="tt-action bg-indigo-700 text-white" data-tt-open-day-edit="'+esc(date)+'">تعديل توزيع اليوم ('+editableItems.length+')</button>':"";
        const absentGroups=Array.from(byAbsent.entries()).sort((a,b)=>a[0].localeCompare(b[0],"ar")).map(([absentName,rows])=>{
          rows.sort((a,b)=>Number(a.period)-Number(b.period));
          const currentRows=rows.filter(item=>["assigned","confirmed","completed"].includes(item.status));
          const canDeleteGroup=currentRows.length>0&&currentRows.every(item=>item.canDelete===true);
          const groupDelete=canDeleteGroup?
            '<button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-delete-group-date="'+esc(date)+'" data-tt-delete-group-absent="'+esc(absentName)+'">حذف التوزيع بالكامل ('+rows.length+')</button>':"";
          const rowsMarkup=rows.map(item=>{
            const state=item.status==="cancelled"?"ملغى":item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":"محفوظ";
            const editable=item.canEdit===true&&["assigned","confirmed"].includes(item.status);
            const readOnly=item.canEdit===false&&["assigned","confirmed"].includes(item.status);
            const actions=editable?
              '<div class="flex flex-wrap gap-1"><button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-archive-edit="'+esc(item.id)+'">تعديل</button><button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-delete="'+esc(item.id)+'">حذف</button></div>':
              '<span class="text-[10px] text-slate-400">'+(readOnly?"سجل تاريخي · للقراءة فقط":state)+'</span>';
            return '<div class="tt-archive-row"><div><div class="text-xs font-black text-slate-800">الحصة '+Number(item.period)+' · '+esc(item.className||"—")+' ← '+esc(item.substituteTeacherName||"")+'</div>'+
              '<small>سبب الغياب: '+esc(item.absenceReason||"-")+'</small><small class="block">سبب الاحتياط: '+esc(item.reason||"-")+' · '+state+'</small></div>'+actions+'</div>';
          }).join("");
          return '<section class="rounded-xl border border-slate-200 bg-white p-3"><div class="mb-2 flex flex-wrap items-center justify-between gap-2"><strong class="text-xs font-black text-slate-800">المعلم الغائب: '+esc(absentName)+'</strong>'+groupDelete+'</div><div class="space-y-2">'+rowsMarkup+'</div></section>';
        }).join("");
        return '<details open class="rounded-xl border border-slate-200 bg-white p-3"><summary class="cursor-pointer text-xs font-black text-slate-800">'+esc(date)+' · '+items.length+' تكليف</summary>'+
          '<div class="mt-3 flex justify-end">'+dayButton+'</div><div class="mt-3 space-y-3">'+absentGroups+'</div></details>';
      }).join("");
    host.querySelectorAll("[data-tt-archive-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveEdit(button.dataset.ttArchiveEdit)));
    host.querySelectorAll("[data-tt-delete]").forEach(button=>button.addEventListener("click",()=>timetableDailyCancelAssignment(button.dataset.ttDelete)));
    host.querySelectorAll("[data-tt-open-day-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveDayEdit(button.dataset.ttOpenDayEdit)));
    host.querySelectorAll("[data-tt-delete-group-date]").forEach(button=>button.addEventListener("click",()=>timetableDailyCancelAbsentDistribution(button.dataset.ttDeleteGroupDate,button.dataset.ttDeleteGroupAbsent)));
  };
  // Reclassify saved assignments at the exact Muscat day boundary. The server
  // remains authoritative; this timer only refreshes the active/archive view.
  let reserveMidnightRefreshTimer=null;
  let reserveLastObservedOmanDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  function reserveScheduleMidnightRefresh(){
    if(reserveMidnightRefreshTimer)clearTimeout(reserveMidnightRefreshTimer);
    const today=reserveLastObservedOmanDate.split("-").map(Number);
    const nextMidnightUtc=Date.UTC(today[0],today[1]-1,today[2]+1,0)-4*60*60*1000;
    const delay=Math.max(1000,nextMidnightUtc-Date.now()+1200);
    reserveMidnightRefreshTimer=setTimeout(async()=>{
      const current=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const dayChanged=current!==reserveLastObservedOmanDate;
      reserveLastObservedOmanDate=current;
      if(dayChanged){
        window.dispatchEvent(new CustomEvent("reserve:muscat-day-changed",{detail:{date:current}}));
        try{if(reserveIsDailyArchivePanelVisible())await window.timetableDailyLoadArchive?.();}catch(error){console.warn("Reserve archive midnight refresh failed.",error);}
      }
      reserveScheduleMidnightRefresh();
    },delay);
  }
  function reserveIsDailyArchivePanelVisible(){
    const panel=document.getElementById("timetableDailyArchivePanel");
    return Boolean(panel&&!panel.classList.contains("hidden")&&panel.getClientRects().length);
  }
  function reserveRefreshOmanDayIfChanged(){
    const current=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    if(current===reserveLastObservedOmanDate)return;
    reserveLastObservedOmanDate=current;
    window.dispatchEvent(new CustomEvent("reserve:muscat-day-changed",{detail:{date:current}}));
    if(reserveIsDailyArchivePanelVisible())window.timetableDailyLoadArchive?.();
    reserveScheduleMidnightRefresh();
  }
  if(!window.__reserveOmanDayRefreshBound){
    window.__reserveOmanDayRefreshBound=true;
    window.addEventListener("focus",reserveRefreshOmanDayIfChanged);
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)reserveRefreshOmanDayIfChanged();});
  }
  reserveScheduleMidnightRefresh();

  window.timetableDailyOpenArchiveDayEdit = async function(date,absentTeacherName) {
    const source=[...(reserveBatchPreview?.existingAssignments||[]),...(reserveHomeToday||[]),...(reserveArchive||[]),...(reserveCumulativeArchive||[])];
    const items=source.filter((item,index,all)=>item.assignmentDate===date&&(!absentTeacherName||item.absentTeacherName===absentTeacherName)&&item.canEdit===true&&["assigned","confirmed"].includes(item.status)&&all.findIndex(row=>row.id===item.id)===index).sort((x,y)=>String(x.absentTeacherName||"").localeCompare(String(y.absentTeacherName||""),"ar")||Number(x.period)-Number(y.period));
    if(!items.length){status("لا توجد تكليفات ضمن مهلة التعديل لهذا التاريخ في إصدار الجدول النشط.","error");return;}
    try{
      const names=[...new Set(items.map(x=>x.absentTeacherName))],weekday=items[0].weekday;
      const previews=await Promise.all(names.map(async name=>[name,await fetchArchivePreview(name,date,weekday)]));
      const byAbsent=new Map(previews),state=new Map(items.map(x=>[String(x.id),{sub:String(x.substituteTeacherName||""),reason:String(x.reason||"-"),expanded:!String(x.substituteTeacherName||"").trim()}]));
      const absence=new Map(names.map(n=>[n,String(items.find(x=>x.absentTeacherName===n)?.absenceReason||"-")]));
      const fmt=n=>new Intl.NumberFormat("en-US",{useGrouping:false}).format(Number(n));
      const list=a=>(Array.isArray(a)?a:[]).map(Number).filter(Number.isInteger).sort((x,y)=>x-y).map(fmt).join(", ")||"لا توجد حصص مشغولة";
      const lessonFor=x=>(byAbsent.get(x.absentTeacherName)?.lessons||[]).find(l=>Number(l.period)===Number(x.period))||{};
      const modal=document.createElement("div");modal.id="timetableDailyArchiveDayEditModal";modal.className="reserve-edit-overlay";
      if(!document.getElementById("reserveEditGlassWorkspaceStyles")){
        const style=document.createElement("style");style.id="reserveEditGlassWorkspaceStyles";
        style.textContent=[
          ".reserve-edit-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(7,17,32,.78);backdrop-filter:blur(12px)}",
          ".reserve-edit-shell{width:min(1080px,100%);max-height:95vh;overflow:auto;border:1px solid #fff;border-radius:26px;background:linear-gradient(145deg,#fbfdff,#eff6f9);box-shadow:0 25px 80px #0005;color:#18334a}",
          ".reserve-edit-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 20px;background:linear-gradient(110deg,#091728,#174365 65%,#0e6972);color:white}",
          ".reserve-edit-head h3{font-weight:1000;font-size:21px}.reserve-edit-head small{display:block;margin-top:4px;color:#c9e4eb;font-size:11px}.reserve-edit-close{width:40px;height:40px;border:1px solid #ffffff44;border-radius:13px;background:#ffffff1c;color:#fff;font-size:20px}",
          ".reserve-edit-groups{display:grid;gap:15px;padding:16px}.reserve-edit-group{overflow:hidden;border:1px solid #ffffff;border-radius:22px;background:#ffffffc9;box-shadow:0 10px 30px #1a3b5512}",
          ".reserve-edit-absent{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px;background:linear-gradient(110deg,#11233a,#1c486b 68%,#176b72);color:#fff}.reserve-edit-absent strong{font-size:15px;font-weight:1000}.reserve-edit-absent small{display:block;margin-top:3px;color:#cce5e9;font-size:10px}.reserve-edit-periods{padding:8px 11px;border:1px solid #ffffff30;border-radius:12px;background:#ffffff18;color:#f7d78d;font-size:12px;font-weight:1000}",
          ".reserve-edit-lessons{display:grid;gap:11px;padding:12px}.reserve-edit-lesson{overflow:hidden;border:1px solid #e0ebef;border-radius:18px;background:linear-gradient(145deg,#fff,#f5fafc)}.reserve-edit-lesson-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;border-bottom:1px solid #e6eef1;background:#edf5f7}.reserve-edit-period{padding:8px 12px;border-radius:13px;background:linear-gradient(110deg,#14273e,#16717a);color:#fff;font-size:12px;font-weight:1000}.reserve-edit-class{color:#657d8e;font-size:11px;font-weight:800}",
          ".reserve-edit-body{padding:12px}.reserve-edit-selected{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid #b8e6d4;border-radius:14px;background:#e9f8f1}.reserve-edit-selected strong{display:block;color:#08714f;font-size:13px}.reserve-edit-selected small{display:block;color:#718b84;font-size:10px}",
          ".reserve-edit-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 11px;border:1px solid #d7e5eb;border-radius:11px;background:white;color:#24536b;font-size:10px;font-weight:900}.reserve-edit-candidates{display:grid;gap:7px;margin-top:10px}.reserve-edit-candidate{display:flex;width:100%;align-items:center;justify-content:space-between;gap:9px;padding:10px 11px;border:1px solid #dbe8ed;border-radius:13px;background:#fff;text-align:right}.reserve-edit-candidate:disabled{opacity:.45}.reserve-edit-candidate strong{display:block;color:#28445b;font-size:12px}.reserve-edit-candidate small{display:block;margin-top:3px;color:#748895;font-size:10px}.reserve-edit-candidate em{font-style:normal;color:#29737a;font-size:10px;font-weight:900}",
          ".reserve-edit-extra{margin-top:10px;padding:9px 11px;border:1px solid #e1eaee;border-radius:12px;background:#f8fbfc}.reserve-edit-extra summary{cursor:pointer;color:#60778a;font-size:10px;font-weight:900}.reserve-edit-extra textarea{display:block;width:100%;margin-top:7px;border:1px solid #d8e4e9;border-radius:10px;padding:8px;font-size:11px}",
          ".reserve-edit-actions{position:sticky;bottom:0;z-index:3;display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:8px;padding:12px 16px;border-top:1px solid #dce7eb;background:#f8fcfdef;backdrop-filter:blur(14px)}.reserve-edit-action{min-height:45px;border-radius:14px;color:#fff;font-size:11px;font-weight:1000}.reserve-edit-save{background:linear-gradient(110deg,#078864,#13a184)}.reserve-edit-share{background:linear-gradient(110deg,#14834d,#1aa469)}.reserve-edit-pdf{background:linear-gradient(110deg,#132b45,#236283)}",
          ".reserve-edit-other{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;padding:14px;background:#061526c9;backdrop-filter:blur(8px)}.reserve-edit-other-panel{width:min(600px,100%);max-height:82vh;overflow:auto;border-radius:22px;background:#f8fcfd;padding:15px}.reserve-edit-search{width:100%;margin:12px 0;padding:11px;border:1px solid #d6e4e9;border-radius:12px}.reserve-edit-error{margin:0 16px 12px;padding:10px;border-radius:12px;background:#fff0ef;color:#b42318;font-size:11px;font-weight:800}",
          ".dark .reserve-edit-shell{background:linear-gradient(145deg,#132b3f,#0d1c2b);color:#eef5f8;border-color:#ffffff22}.dark .reserve-edit-group{background:#142d41;border-color:#ffffff1e}.dark .reserve-edit-lesson{background:#193448;border-color:#395569}.dark .reserve-edit-lesson-head{background:#ffffff08;border-color:#395569}.dark .reserve-edit-selected{background:#0b4538;border-color:#1b755b}.dark .reserve-edit-selected strong{color:#83e4bc}.dark .reserve-edit-btn,.dark .reserve-edit-candidate,.dark .reserve-edit-extra{background:#1c394d;border-color:#3a596d;color:#f2f7fa}.dark .reserve-edit-candidate strong{color:#fff}.dark .reserve-edit-candidate small{color:#bfd0d9}.dark .reserve-edit-actions{background:#0d2132;border-color:#395569}.dark .reserve-edit-other-panel{background:#132d41}",
          "@media(max-width:680px){.reserve-edit-overlay{padding:0;align-items:stretch}.reserve-edit-shell{width:100%;max-height:100dvh;min-height:100dvh;border:0;border-radius:0}.reserve-edit-groups{padding:10px}.reserve-edit-absent{align-items:flex-start;flex-direction:column}.reserve-edit-actions{grid-template-columns:1fr;padding:9px 11px}.reserve-edit-action{min-height:42px}}"
        ].join(String.fromCharCode(10));document.head.appendChild(style);
      }
      let otherId="",otherQuery="",saving=false;
      function otherTeachers(){
        const item=items.find(x=>String(x.id)===String(otherId)),host=modal.querySelector("#reserveEditOtherList");if(!host||!item)return;
        const rows=byAbsent.get(item.absentTeacherName)?.editTeacherDirectory||[],query=otherQuery.trim().toLowerCase();
        const filtered=rows.filter(t=>!query||String(t.name||"").toLowerCase().includes(query)||String(t.subject||t.departmentName||"").toLowerCase().includes(query));
        host.innerHTML=filtered.length?filtered.map(t=>{
          const busy=Array.isArray(t.occupiedPeriods)?t.occupiedPeriods.map(Number):[],selected=state.get(String(item.id))?.sub||item.substituteTeacherName,blocked=busy.includes(Number(item.period))&&String(t.name)!==String(selected);
          return '<button type="button" class="reserve-edit-candidate" data-other-choice="'+esc(String(item.id))+'" data-teacher="'+esc(t.name)+'" '+(blocked?'disabled':'')+'><span><strong>'+esc(t.name)+'</strong><small>مشغول: <b dir="ltr">'+esc(list(busy))+'</b></small></span><em>'+(blocked?'مشغول بهذه الحصة':'اختيار')+'</em></button>';
        }).join(""):'<p class="p-4 text-center text-xs text-slate-500">لا توجد نتائج ضمن نطاق صلاحيتك.</p>';
      }
      function draw(){
        const grouped=new Map();items.forEach(x=>{const n=String(x.absentTeacherName||"غير محدد");if(!grouped.has(n))grouped.set(n,[]);grouped.get(n).push(x);});
        const cards=[...grouped.entries()].map(([name,rows])=>{
          const summary=rows.map(x=>Number(x.period)).sort((x,y)=>x-y).map(fmt).join(", ");
          const lessons=rows.map(x=>{
            const id=String(x.id),saved=state.get(id),preview=lessonFor(x),current=saved.sub||x.substituteTeacherName||"لم يحدد",candidates=(preview.candidates||[]).filter(c=>String(c.name)!==String(current));
            const chosen='<div class="reserve-edit-selected"><div><small>البديل المختار</small><strong>'+esc(current)+'</strong></div><button type="button" class="reserve-edit-btn" data-change="'+esc(id)+'"><i class="fa-solid fa-pen"></i> تغيير</button></div>';
            const choices=saved.expanded?'<div class="reserve-edit-candidates"><div class="flex items-center justify-between gap-2"><b class="text-xs text-slate-500">المعلمون المقترحون</b><button type="button" class="reserve-edit-btn" data-other="'+esc(id)+'"><i class="fa-solid fa-magnifying-glass"></i> معلمون آخرون</button></div>'+
              (candidates.length?candidates.map(c=>'<button type="button" class="reserve-edit-candidate" data-choice="'+esc(id)+'" data-teacher="'+esc(c.name)+'"><span><strong>'+esc(c.name)+'</strong><small>مشغول: <b dir="ltr">'+esc(list(c.occupiedPeriods))+'</b></small></span><em>اختيار</em></button>').join(""):'<p class="p-3 text-center text-xs text-slate-500">لا توجد مقترحات إضافية لهذه الحصة.</p>')+'</div>':'';
            return '<article class="reserve-edit-lesson" data-edit-lesson="'+esc(id)+'"><div class="reserve-edit-lesson-head"><div class="flex items-center gap-3"><b class="reserve-edit-period">الحصة <span dir="ltr">'+fmt(x.period)+'</span></b><span class="reserve-edit-class">الصف '+esc(x.className||preview.className||"—")+'</span></div><button type="button" class="reserve-edit-btn" data-other="'+esc(id)+'"><i class="fa-solid fa-users"></i> معلمون آخرون</button></div><div class="reserve-edit-body">'+chosen+choices+'<details class="reserve-edit-extra"><summary>سبب الاحتياط</summary><textarea rows="2" maxlength="500" data-reason="'+esc(id)+'">'+esc(saved.reason||x.reason||"-")+'</textarea></details></div></article>';
          }).join("");
          return '<section class="reserve-edit-group"><header class="reserve-edit-absent"><div><strong>المعلم الغائب: '+esc(name)+'</strong><small>'+rows.length+' حصص</small></div><span class="reserve-edit-periods" dir="ltr">('+summary+')</span></header><div class="reserve-edit-lessons">'+lessons+'<details class="reserve-edit-extra"><summary>سبب الغياب</summary><textarea rows="2" maxlength="500" data-absence="'+esc(name)+'">'+esc(absence.get(name)||"-")+'</textarea></details></div></section>';
        }).join("");
        modal.innerHTML='<div class="reserve-edit-shell"><header class="reserve-edit-head"><div><h3><i class="fa-solid fa-pen-to-square ml-2 text-amber-200"></i>تعديل توزيع الاحتياط</h3><small>'+esc(date)+' · '+items.length+' حصة محفوظة</small></div><button type="button" class="reserve-edit-close" data-close>×</button></header><div class="reserve-edit-groups">'+cards+'</div><div id="reserveEditError" class="reserve-edit-error" hidden></div><footer class="reserve-edit-actions"><button type="button" class="reserve-edit-action reserve-edit-save" data-save>اعتماد وحفظ التوزيع</button><button type="button" class="reserve-edit-action reserve-edit-share" data-share>مشاركة واتساب</button><button type="button" class="reserve-edit-action reserve-edit-pdf" data-pdf>طباعة PDF</button></footer></div><div class="reserve-edit-other" '+(otherId?'':'hidden')+'><section class="reserve-edit-other-panel"><div class="flex items-center justify-between gap-3"><b class="font-black">معلمون آخرون</b><button type="button" class="reserve-edit-close" data-other-close>×</button></div><input id="reserveEditSearch" class="reserve-edit-search" type="search" placeholder="ابحث باسم المعلم أو المادة..." value="'+esc(otherQuery)+'"><div id="reserveEditOtherList" class="grid gap-2"></div><p class="mt-3 text-[10px] leading-6 text-slate-500">تظهر الحصص المشغولة بجانب كل معلم. يعيد الخادم التحقق من الأهلية قبل الحفظ.</p></section></div>';
        if(otherId)otherTeachers();
      }
      document.body.appendChild(modal);draw();
      modal.addEventListener("click",async event=>{
        const button=event.target.closest("button");if(!button||!modal.contains(button))return;
        if(button.hasAttribute("data-close")){modal.remove();return;}
        if(button.hasAttribute("data-other-close")){otherId="";draw();return;}
        if(button.hasAttribute("data-change")){const id=button.dataset.change,old=state.get(id);state.set(id,{...old,expanded:true});draw();return;}
        if(button.hasAttribute("data-other")){otherId=button.dataset.other;otherQuery="";draw();modal.querySelector("#reserveEditSearch")?.focus();return;}
        if(button.hasAttribute("data-choice")||button.hasAttribute("data-other-choice")){
          const id=button.dataset.choice||button.dataset.otherChoice,old=state.get(id);
          const selectedIndex=items.findIndex(item=>String(item.id)===String(id));
          state.set(id,{...old,sub:button.dataset.teacher,expanded:false});
          if(button.hasAttribute("data-other-choice"))otherId="";
          draw();
          const nextItem=items[selectedIndex+1];
          if(nextItem)requestAnimationFrame(()=>{
            const target=[...modal.querySelectorAll("[data-edit-lesson]")].find(card=>card.dataset.editLesson===String(nextItem.id));
            target?.scrollIntoView({behavior:"smooth",block:"center"});
          });
          return;
        }
        if(button.hasAttribute("data-save")){
          if(saving)return;
          const changes=[];
          items.forEach(x=>{
            const saved=state.get(String(x.id)),absenceReason=String(absence.get(x.absentTeacherName)||x.absenceReason||"-").trim()||"-",reason=String(saved.reason||"-").trim()||"-",sub=String(saved.sub||"").trim();
            if(sub!==String(x.substituteTeacherName||"")||reason!==String(x.reason||"-")||absenceReason!==String(x.absenceReason||"-"))changes.push({assignmentId:x.id,substituteTeacherName:sub,reserveReason:reason,absenceReason});
          });
          if(!changes.length){modal.remove();status("لم تغيّر أي بيانات في توزيع هذا اليوم.","info");return;}
          if(changes.some(x=>!x.substituteTeacherName)){const box=modal.querySelector("#reserveEditError");box.textContent="اختر بديلاً لكل حصة قبل الحفظ.";box.hidden=false;return;}
          saving=true;button.disabled=true;button.textContent="جارٍ حفظ التعديلات...";
          try{
            await appAuthRequest({action:"timetable_substitution_update_batch",assignments:changes,includeOtherDepartments:includeOthers()},appAuthSession?.token||readAppAuthToken());
            modal.remove();status("تم حفظ "+changes.length+" تعديل في عملية واحدة، مع الاحتفاظ بالسجلات السابقة في سجل المراجعة.","success");
            await timetableDailyLoadArchive();await timetableDailyRefreshAll();
            if(typeof window.subxLoadEditableAssignments==="function")await window.subxLoadEditableAssignments();
            if(typeof window.substitutionLoadStats==="function")await window.substitutionLoadStats();
          }catch(error){
            saving=false;const box=modal.querySelector("#reserveEditError");if(box){box.textContent=error?.message||"تعذر حفظ التعديلات؛ لم يتم اعتماد أي تعديل جزئي.";box.hidden=false;}
            const save=modal.querySelector("[data-save]");if(save){save.disabled=false;save.textContent="اعتماد وحفظ التوزيع";}
          }
          return;
        }
        if(button.hasAttribute("data-share")){
          const grouped=new Map();items.forEach(x=>{const n=String(x.absentTeacherName||"غير محدد");if(!grouped.has(n))grouped.set(n,[]);grouped.get(n).push(x);});
          const groups=[...grouped.entries()].map(([name,rows])=>({absentName:name,rows:rows.map(x=>({
            period:x.period,className:x.className,substitute:state.get(String(x.id))?.sub||x.substituteTeacherName||"لم يحدد"
          }))}));
          const subject=await reservePrintActorSubject();
          const message=buildReserveWhatsAppMessage(groups,date,weekday,subject);
          window.open("https://wa.me/?text="+encodeURIComponent(message),"_blank","noopener,noreferrer");return;
        }
        if(button.hasAttribute("data-pdf")){
          const printable=items.map(x=>({...x,substituteTeacherName:state.get(String(x.id))?.sub||x.substituteTeacherName,reason:state.get(String(x.id))?.reason||x.reason,absenceReason:absence.get(x.absentTeacherName)||x.absenceReason}));
          if(typeof window.timetableDailyPrintArchiveRange==="function")window.timetableDailyPrintArchiveRange(printable);else status("قالب كشف PDF الرسمي غير متاح حالياً.","error");
        }
      });
      modal.addEventListener("input",event=>{
        const input=event.target;
        if(input.matches("[data-reason]")){const old=state.get(input.dataset.reason);state.set(input.dataset.reason,{...old,reason:input.value});}
        else if(input.matches("[data-absence]"))absence.set(input.dataset.absence,input.value);
        else if(input.id==="reserveEditSearch"){otherQuery=input.value;otherTeachers();}
      });
      modal.addEventListener("keydown",event=>{if(event.key==="Escape"){if(otherId){otherId="";draw();}else modal.remove();}});
    }catch(error){status(error?.message||"تعذر فتح مساحة تعديل توزيع اليوم.","error");}
  };
  window.timetableDailyCancelAssignment = async function (assignmentId) {
    const item=reserveHomeToday.find(row=>row.id===assignmentId)||reserveArchive.find(row=>row.id===assignmentId)||reserveCumulativeArchive.find(row=>row.id===assignmentId)||(reserveBatchPreview?.existingAssignments||[]).find(row=>row.id===assignmentId);
    if(!item){status("تعذر العثور على التكليف. حدّث القائمة ثم حاول مجدداً.","error");return;}
    if(item.canDelete!==true||!["assigned","confirmed","completed"].includes(item.status)){status("انتهت مهلة حذف هذا التكليف؛ يسمح بالحذف حتى نهاية وقت الحصة المحدد في الجدول.","error");return;}
    if(!window.confirm("سيتم حذف هذا التكليف من التوزيع النشط، مع الاحتفاظ بسجل المراجعة. هل تريد المتابعة؟"))return;
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      await appAuthRequest({action:"timetable_substitution_cancel",assignmentId,weekday:item.weekday,assignmentDate:item.assignmentDate},token);
      status("تم حذف التكليف من التوزيع النشط، مع الاحتفاظ بسجل المراجعة.","success");
      await timetableDailyRefreshAll();
      if(typeof window.subxRefreshExistingPlan==="function")await window.subxRefreshExistingPlan();
      if(!$("timetableDailyArchivePanel")?.classList.contains("hidden"))await timetableDailyLoadArchive();
      if(typeof window.substitutionLoadStats==="function")await window.substitutionLoadStats();
    }catch(error){status(error?.message||"تعذر إلغاء التكليف؛ لم يُحذف أي سجل.","error");}
  };
  window.timetableDailyCancelAbsentDistribution = async function(date,absentTeacherName) {
    const source=[...(reserveBatchPreview?.existingAssignments||[]),...(reserveHomeToday||[]),...(reserveArchive||[]),...(reserveCumulativeArchive||[])];
    const items=source.filter(item=>item.assignmentDate===date&&item.absentTeacherName===absentTeacherName&&
      item.canDelete===true&&["assigned","confirmed","completed"].includes(item.status))
      .filter((item,index,all)=>all.findIndex(row=>row.id===item.id)===index);
    if(!items.length){status("لا توجد حصص قابلة للحذف لهذا المعلم في هذا التاريخ.","error");return;}
    const completedCount=items.filter(item=>item.status==="completed").length;
    const completedWarning=completedCount?"، منها "+completedCount+" حصص مكتملة وستُلغى نقاطها أيضاً":"";
    if(!window.confirm("سيتم حذف توزيع المعلم الغائب بالكامل في "+date+" ("+items.length+" حصص"+completedWarning+")، وعكس جميع نقاطه مع الاحتفاظ بسجل المراجعة. هل تريد المتابعة؟"))return;
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      const assignmentIds=items.map(item=>item.id);
      await appAuthRequest({action:"timetable_substitution_cancel_batch",assignmentIds,absentTeacherName,assignmentDate:date,weekday:items[0].weekday},token);
      if(date===timetableSubstitutionGetDate().date&&timetableDailyAbsentTeachers.includes(absentTeacherName)){
        timetableDailyAbsentTeachers=timetableDailyAbsentTeachers.filter(name=>name!==absentTeacherName);
        delete reserveAbsenceReasons[absentTeacherName];
        delete reserveReasons[absentTeacherName];
        Object.keys(reserveReasons).filter(key=>key.startsWith(String(absentTeacherName)+"\u0000")).forEach(key=>delete reserveReasons[key]);
        Object.keys(reserveManualChoices).filter(key=>key.startsWith(String(absentTeacherName)+"\u0000")).forEach(key=>delete reserveManualChoices[key]);
        reserveDraftApproved.delete(absentTeacherName);
        timetableDailyRenderTags();
      }
      status("تم حذف غياب المعلم وتوزيع حصصه بالكامل، وعكس جميع نقاطه المرتبطة مع الاحتفاظ بسجل المراجعة.","success");
      await timetableDailyRefreshAll();
      if(!$("timetableDailyArchivePanel")?.classList.contains("hidden"))await timetableDailyLoadArchive();
      if(typeof window.substitutionLoadStats==="function")await window.substitutionLoadStats();
    }catch(error){status(error?.message||"تعذر حذف التوزيع بالكامل؛ لم يتم اعتماد حذف جزئي.","error");}
  };
  window.timetableDailyRegisterExternalAssignments = function(items) {
    (Array.isArray(items)?items:[]).forEach(item=>{
      if(!item||!item.id)return;
      const normalized={...item,canEdit:item.canEdit===true,canDelete:item.canDelete===true,assignmentDate:item.assignmentDate||"",weekday:item.weekday||"",status:item.status||"assigned"};
      for(const records of [reserveArchive,reserveCumulativeArchive]){
        const index=records.findIndex(row=>String(row.id)===String(normalized.id));
        if(index>=0)records[index]=normalized;else records.push(normalized);
      }
    });
  };
  window.timetableDailyOpenArchiveEdit = async function (assignmentId) {
    const item=reserveHomeToday.find(row=>row.id===assignmentId)||reserveArchive.find(row=>row.id===assignmentId)||reserveCumulativeArchive.find(row=>row.id===assignmentId)||(reserveBatchPreview?.existingAssignments||[]).find(row=>row.id===assignmentId);
    if(!item){status("تعذر العثور على التكليف. حدّث قائمة الاحتياط ثم حاول مجدداً.","error");return;}
    if(item.canEdit!==true||!["assigned","confirmed"].includes(item.status)){
      status("انتهت مهلة تعديل هذه الحصة؛ يسمح بالتعديل حتى نهاية وقتها المحدد في الجدول.","error");return;
    }
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      const directoryResult=await appAuthRequest({action:"timetable_substitution_preview",weekday:item.weekday,assignmentDate:item.assignmentDate,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherDepartmentIds:selectedOtherDepartmentIds(),otherTeacherNames:[...reserveSelectedOtherTeacherNames]},token);
      const absentNames=Array.isArray(directoryResult.absentTeachers)?directoryResult.absentTeachers.slice():[];
      if(!absentNames.includes(item.absentTeacherName))absentNames.unshift(item.absentTeacherName);
      let currentPreview=await fetchArchivePreview(item.absentTeacherName,item.assignmentDate,item.weekday);
      const makePeriodOptions=(lessons,selected)=>{
        return (Array.isArray(lessons)?lessons:[]).slice().sort((a,b)=>Number(a.period)-Number(b.period)).map(lesson=>
          '<option value="'+Number(lesson.period)+'" '+(Number(lesson.period)===Number(selected)?"selected":"")+'>الحصة '+Number(lesson.period)+' · '+esc(lesson.className||"—")+'</option>'
        ).join("");
      };
      const makeClassOptions=(lessons,selected)=>{
        return (Array.isArray(lessons)?lessons:[]).slice().sort((a,b)=>Number(a.period)-Number(b.period)).map(lesson=>
          '<option value="'+Number(lesson.period)+'" '+(Number(lesson.period)===Number(selected)?"selected":"")+' >'+esc(lesson.className||"—")+' · الحصة '+Number(lesson.period)+'</option>'
        ).join("");
      };
      const makeSubstituteOptions=(candidates,selected)=>{
        const rows=Array.isArray(candidates)?candidates:[];
        const choices=rows.filter(candidate=>candidate.name!==selected).map(candidate=>
          '<option value="'+esc(candidate.name)+'">'+esc(candidate.name)+' · الحصص '+((Array.isArray(candidate.occupiedPeriods)?candidate.occupiedPeriods:[]).map(Number).filter(period=>Number.isInteger(period)&&period>0).sort((a,b)=>a-b).map(period=>new Intl.NumberFormat("ar").format(period)).join("، ")||"—")+'</option>'
        ).join("");
        return '<option value="'+esc(selected)+'" selected>'+esc(selected)+' (الحالي)</option>'+choices;
      };
      const initialLessons=Array.isArray(currentPreview.lessons)?currentPreview.lessons:[];
      if(!initialLessons.length)throw new Error("لا توجد حصص تدريس قابلة للتعديل للمعلم الغائب في هذا اليوم.");
      const selectedInitialPeriod=initialLessons.some(row=>Number(row.period)===Number(item.period))?Number(item.period):Number(initialLessons[0].period);
      const modal=document.createElement("div");modal.id="timetableDailyArchiveEditModal";
      modal.className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm";
      modal.innerHTML='<div class="max-h-[92vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-3xl border border-white/30 bg-white/95 p-5 shadow-2xl backdrop-blur-xl">'+
        '<div class="flex items-center justify-between gap-3"><div><h3 class="font-black text-base text-slate-900">تعديل سجل الاحتياط</h3><p class="mt-1 text-[10px] text-slate-500">يمكن التعديل خلال اليوم الحالي وحتى نهايته بتوقيت سلطنة عمان</p></div><button type="button" data-close-edit class="rounded-xl bg-slate-100 px-3 py-2">×</button></div>'+
        '<div class="grid gap-3 sm:grid-cols-2">'+
        '<label class="block text-xs font-black text-slate-700">المعلم الغائب<select id="ttArchiveEditAbsent" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs">'+absentNames.map(name=>'<option value="'+esc(name)+'" '+(name===item.absentTeacherName?"selected":"")+'>'+esc(name)+'</option>').join("")+'</select></label>'+
        '<label class="block text-xs font-black text-slate-700">الحصة<select id="ttArchiveEditPeriod" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs">'+makePeriodOptions(initialLessons,selectedInitialPeriod)+'</select></label>'+
        '<label class="block text-xs font-black text-slate-700">الصف (مرتبط بالجدول)<select id="ttArchiveEditClass" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs">'+makeClassOptions(initialLessons,selectedInitialPeriod)+'</select></label>'+
        '<label class="block text-xs font-black text-slate-700 sm:col-span-2">المعلم البديل<select id="ttArchiveEditSubstitute" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs">'+makeSubstituteOptions((initialLessons.find(row=>Number(row.period)===selectedInitialPeriod)||{}).candidates,item.substituteTeacherName)+'</select></label>'+
        '<div id="ttArchiveEditClassInfo" class="rounded-xl border border-sky-100 bg-sky-50 p-3 text-xs text-sky-900 sm:col-span-2"></div>'+
        '<label class="block text-xs font-black text-slate-700 sm:col-span-2">سبب الغياب<textarea id="ttArchiveEditAbsenceReason" rows="2" maxlength="500" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs" placeholder="إجازة مرضية، إجازة اضطرارية، مهمة رسمية...">'+esc(item.absenceReason==="-"?"":item.absenceReason||"")+'</textarea></label>'+
        '<label class="block text-xs font-black text-slate-700 sm:col-span-2">سبب الاحتياط (التكليف المسند للمعلم البديل لهذه الحصة)<textarea id="ttArchiveEditReason" rows="2" maxlength="500" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs" placeholder="متابعة الصف وتنفيذ الحصة المقررة...">'+esc(item.reason==="-"?"":item.reason||"")+'</textarea></label></div>'+
        '<p class="text-[10px] leading-5 text-slate-500">الصف والمادة يُحدّثان تلقائياً حسب المعلم الغائب والحصة المختارة في الجدول الأسبوعي المعتمد؛ وذلك لمنع حفظ بيانات لا تطابق الجدول.</p>'+
        '<div id="ttArchiveEditError" class="hidden rounded-xl bg-red-50 p-3 text-xs text-red-700"></div><div class="flex flex-wrap justify-end gap-2"><button type="button" data-close-edit class="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold">إلغاء</button><button type="button" id="ttArchiveEditSave" class="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-black text-white">حفظ التعديلات</button></div></div>';
      document.body.appendChild(modal);
      modal.querySelectorAll("[data-close-edit]").forEach(button=>button.addEventListener("click",()=>modal.remove()));
      const absentSelect=modal.querySelector("#ttArchiveEditAbsent");
      const periodSelect=modal.querySelector("#ttArchiveEditPeriod");
      const subSelect=modal.querySelector("#ttArchiveEditSubstitute");
      const classSelect=modal.querySelector("#ttArchiveEditClass");
      const classInfo=modal.querySelector("#ttArchiveEditClassInfo");
      const errorBox=modal.querySelector("#ttArchiveEditError");
      const getSelectedLesson=()=>((currentPreview.lessons||[]).find(row=>Number(row.period)===Number(periodSelect.value))||null);
      const renderSelectedLesson=()=>{
        const lesson=getSelectedLesson();
        if(classSelect)classSelect.innerHTML=makeClassOptions(currentPreview.lessons,periodSelect.value);
        if(!lesson){
          classInfo.textContent="لا توجد حصة مطابقة في الجدول لهذا الاختيار.";
          subSelect.innerHTML="";
          return;
        }
        classInfo.innerHTML='<strong>الصف:</strong> '+esc(lesson.className||"—")+' <span class="mx-2">|</span> <strong>المادة:</strong> '+esc(lesson.subject||"—");
        const candidates=Array.isArray(lesson.candidates)?lesson.candidates:[];
        const currentRecordCell=absentSelect.value===item.absentTeacherName&&Number(periodSelect.value)===Number(item.period);
        const selectedIsAvailable=candidates.some(candidate=>candidate.name===subSelect.value);
        const selectedSubstitute=selectedIsAvailable||currentRecordCell?subSelect.value:(candidates[0]?.name||"");
        subSelect.innerHTML=(selectedSubstitute?makeSubstituteOptions(candidates,selectedSubstitute):'<option value="" selected disabled>لا يوجد معلم بديل متاح لهذه الحصة</option>'+candidates.map(candidate=>'<option value="'+esc(candidate.name)+'">'+esc(candidate.name)+'</option>').join(""));
      };
      renderSelectedLesson();
      absentSelect.addEventListener("change",async()=>{
        absentSelect.disabled=true;periodSelect.disabled=true;subSelect.disabled=true;
        errorBox.classList.add("hidden");
        try{
          currentPreview=await fetchArchivePreview(absentSelect.value,item.assignmentDate,item.weekday);
          const lessons=Array.isArray(currentPreview.lessons)?currentPreview.lessons:[];
          if(!lessons.length)throw new Error("لا توجد حصص تدريس لهذا المعلم في اليوم المحدد.");
          const preferred=lessons.some(row=>Number(row.period)===Number(periodSelect.value))?Number(periodSelect.value):Number(lessons[0].period);
          periodSelect.innerHTML=makePeriodOptions(lessons,preferred);
          renderSelectedLesson();
        }catch(error){
          errorBox.textContent=error?.message||"تعذر تحميل حصص المعلم الغائب المحدد.";
          errorBox.classList.remove("hidden");
        }finally{absentSelect.disabled=false;periodSelect.disabled=false;subSelect.disabled=false;}
      });
      periodSelect.addEventListener("change",renderSelectedLesson);
      classSelect?.addEventListener("change",()=>{periodSelect.value=classSelect.value;renderSelectedLesson();});
      modal.querySelector("#ttArchiveEditSave").addEventListener("click",async()=>{
        const button=modal.querySelector("#ttArchiveEditSave");
        const lesson=getSelectedLesson();
        if(!lesson){errorBox.textContent="اختر حصة صحيحة من جدول المعلم الغائب.";errorBox.classList.remove("hidden");return;}
        if(!subSelect.value){errorBox.textContent="اختر معلماً بديلاً للحصة المحددة.";errorBox.classList.remove("hidden");return;}
        button.disabled=true;button.textContent="جارٍ حفظ التعديلات...";
        errorBox.classList.add("hidden");
        try{
          await appAuthRequest({action:"timetable_substitution_update",assignmentId,absentTeacherName:absentSelect.value,period:Number(periodSelect.value),substituteTeacherName:subSelect.value,reserveReason:modal.querySelector("#ttArchiveEditReason").value.trim()||"-",absenceReason:modal.querySelector("#ttArchiveEditAbsenceReason").value.trim()||"-",includeOtherDepartments:includeOthers()},token);
          modal.remove();
          if(absentSelect.value!==item.absentTeacherName&&!timetableDailyAbsentTeachers.includes(absentSelect.value)){timetableDailyAbsentTeachers.push(absentSelect.value);timetableDailyRenderTags();}
          status("تم حفظ التعديلات وتحديث الحصة والصف والمادة وفق الجدول، مع الاحتفاظ بالسجل السابق في سجل المراجعة.","success");
          await timetableDailyRefreshAll();
          if(typeof window.subxRefreshExistingPlan==="function")await window.subxRefreshExistingPlan();
          if(!$("timetableDailyArchivePanel")?.classList.contains("hidden"))await timetableDailyLoadArchive();
          if(typeof window.substitutionLoadStats==="function")await window.substitutionLoadStats();
          if(!$("substitutionCumulativeArchivePanel")?.classList.contains("hidden")&&typeof window.substitutionLoadCumulativeArchive==="function")await window.substitutionLoadCumulativeArchive();
        }catch(error){
          errorBox.textContent=error?.message||"تعذر حفظ التعديل.";
          errorBox.classList.remove("hidden");button.disabled=false;button.textContent="حفظ التعديلات";
        }
      });
    }catch(error){status(error?.message||"تعذر فتح نافذة تعديل تكليف الاحتياط.","error");}
  };
  function formatReservePeriod(period){
    return ({1:"الأولى",2:"الثانية",3:"الثالثة",4:"الرابعة",5:"الخامسة",6:"السادسة",7:"السابعة",8:"الثامنة"})[Number(period)]||String(period);
  }
  function formatReserveDateArabic(dateValue){
    if(!dateValue)return "";
    const date=new Date(String(dateValue)+"T12:00:00+04:00");
    if(!Number.isFinite(date.getTime()))return String(dateValue);
    return new Intl.DateTimeFormat("ar-OM",{day:"numeric",month:"long",year:"numeric",numberingSystem:"arab",timeZone:"Asia/Muscat"}).format(date);
  }
  function formatReserveWhatsAppDigits(value){
    const arabicDigits="٠١٢٣٤٥٦٧٨٩";
    return String(value??"").replace(/[0-9]/g,digit=>arabicDigits[Number(digit)]);
  }
  function formatReserveWeekdayArabic(dateValue,fallback){
    const preferred=String(fallback||"").trim();
    if(preferred)return preferred;
    if(!dateValue)return "";
    const date=new Date(String(dateValue)+"T12:00:00+04:00");
    if(!Number.isFinite(date.getTime()))return "";
    return new Intl.DateTimeFormat("ar-OM",{weekday:"long",timeZone:"Asia/Muscat"}).format(date);
  }
  function buildReserveWhatsAppMessage(groups,date,weekday,subject){
    const tick=String.fromCharCode(96);
    const visibleGroups=(Array.isArray(groups)?groups:[]).map(group=>({
      ...group,
      rows:(Array.isArray(group?.rows)?group.rows:[]).slice().sort((a,b)=>Number(a.period)-Number(b.period))
    })).filter(group=>group.rows.length);
    const dateLabel=[formatReserveWeekdayArabic(date,weekday),formatReserveDateArabic(date)].filter(Boolean).join("، ");
    let message="✨ *كـشـف تـوزيـع حـصـص الاحـتـيـاط* ✨\n";
    message+="🏫 *مدرسة أبو دجانة الأنصاري*\n\n";
    message+="📚 *المادة:* "+tick+String(subject||"غير محددة").trim()+tick+"\n";
    message+="🗓️ *التاريخ:* *"+dateLabel+"*\n\n";
    message+="━━━━━━━━━━━━━━━━━━\n\n";
    visibleGroups.forEach((group,index)=>{
      message+="👤 *"+formatReserveWhatsAppDigits(index+1)+". المعلم الغائب:* "+tick+String(group.absentName||"غير محدد").trim()+tick+"\n\n";
      group.rows.forEach(row=>{
        message+="🔹 *الحصة "+formatReserveWhatsAppDigits(row.period)+"* | الصف "+tick+String(row.className||"غير محدد")+tick+"\n";
        message+="   ↳ *الاحتياط:* *"+String(row.substitute||"لم يحدد")+"*\n\n";
      });
      if(index<visibleGroups.length-1)message+="━━━━━━━━━━━━━━━━━━\n\n";
    });
    message+="━━━━━━━━━━━━━━━━━━\n\n";
    message+="🙏 *شكرًا لتعاونكم وحرصكم الدائم، ونتمنى لكم يومًا دراسيًا موفقًا ومثمرًا.* 🌟";
    return message;
  }
  function formatReservePrintPeriod(period){return ({1:"١",2:"٢",3:"٣",4:"٤",5:"٥",6:"٦",7:"٧",8:"٨"})[Number(period)]||String(period);}
  function formatReservePrintFullDate(dateValue){
    const match=String(dateValue||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? Number(match[3])+" / "+Number(match[2])+" / "+match[1]+" م" : formatReserveDateArabic(dateValue);
  }
  const RESERVE_OFFICIAL_ROWS_PER_PAGE = 22;
  const RESERVE_OFFICIAL_SINGLE_PAGE_CONTENT_MM = 176;
  function reserveOfficialPrintRowHeightEstimate(row){
    const classLength=Array.from(String(row?.className||"")).length;
    const substituteLength=Array.from(String(row?.substitute||"")).length;
    const lines=Math.max(1,Math.ceil(classLength/13),Math.ceil(substituteLength/16));
    return 2+lines*4.4;
  }
  function reserveOfficialPrintPages(groups,date,weekday,subject,options={}){
    const maxRowsPerPage=RESERVE_OFFICIAL_ROWS_PER_PAGE;
    // Reserve a measured 176 mm content budget for the table, leaving the
    // school heading, date, repeated table header, manager signature and stamp
    // safely inside the A4 page.
    const maxLineUnitsPerPage=Math.floor(RESERVE_OFFICIAL_SINGLE_PAGE_CONTENT_MM/4.4);
    const pages=[];let current=[],pageRows=0,pageUnits=0;
    const flushPage=()=>{if(current.length)pages.push(current);current=[];pageRows=0;pageUnits=0;};
    (groups||[]).forEach(group=>{
      const rows=(group.rows||[]).slice().sort((a,b)=>Number(a.period)-Number(b.period));
      if(!rows.length)return;
      const absentLines=Math.max(1,Math.ceil(Array.from(String(group.absentName||"")).length/22));
      const reasonLines=Math.max(1,Math.ceil(Array.from(String(group.absenceReason||group.reason||"")).length/18));
      let chunk=[];
      const flushChunk=()=>{if(chunk.length){current.push({...group,rows:chunk});chunk=[];}};
      rows.forEach(row=>{
        const estimatedRowHeight=reserveOfficialPrintRowHeightEstimate(row);
        const rowUnits=Math.max(
          1,
          Math.ceil((estimatedRowHeight-2)/4.4),
          Math.ceil(absentLines/rows.length),
          Math.ceil(reasonLines/rows.length)
        );
        if(pageRows&&(pageRows>=maxRowsPerPage||pageUnits+rowUnits>maxLineUnitsPerPage)){
          flushChunk();flushPage();
        }
        chunk.push(row);pageRows++;pageUnits+=rowUnits;
      });
      flushChunk();
    });
    flushPage();
    if(!pages.length)pages.push([]);
    return pages.map((pageGroups,index)=>{
      const pageOptions=options?.singlePage&&index>0
        ?{...options,title:options.continuationTitle||"تابع كشف توزيع الاحتياط"}
        :options;
      return reserveOfficialPrintMarkup(pageGroups,date,weekday,subject,pageOptions);
    });
  }
  function reserveOfficialPrintMarkup(groups,date,weekday,subject,options={}){
    const widths=[20,16,10.5,10.5,13,11,19];
    const columns='<colgroup>'+widths.map(width=>'<col style="width:'+width+'%">').join('')+'</colgroup>';
    const header='<thead><tr><th>المعلم الغائب</th><th>سبب الغياب</th><th>الحصة</th><th>الصف</th><th>معلم الاحتياط</th><th>التوقيع</th><th>الملاحظات</th></tr></thead>';
    let used=0;
    const rowsMarkup=(groups||[]).map(group=>{
      const rows=(group.rows||[]).slice().sort((a,b)=>Number(a.period)-Number(b.period));if(!rows.length)return "";used+=rows.length;
      const absent=esc(group.absentName||""),departmentLabel=options?.showDepartment?String(group.departmentName||"").trim():"",absenceMarkup=absent+(departmentLabel?'<div style="font-size:75%;font-weight:600;line-height:1.1;margin-top:.4mm">القسم: '+esc(departmentLabel)+'</div>':""),rawAbsenceReason=String(group.absenceReason||group.reason||"").trim(),absenceReason=esc(rawAbsenceReason==="-"||rawAbsenceReason==="—"?"":rawAbsenceReason);
      return rows.map((row,rowIndex)=>{
        const merged=rowIndex===0?'<td class="tt-official-merged tt-official-absent" rowspan="'+rows.length+'">'+absenceMarkup+'</td><td class="tt-official-merged tt-official-reason" rowspan="'+rows.length+'">'+(absenceReason||"—")+'</td>':"";
        return '<tr class="'+(rowIndex===0?'tt-official-group-start':'')+'">'+merged+'<td>'+esc(formatReservePrintPeriod(row.period))+'</td><td class="tt-official-class">'+esc(row.className||"") +'</td><td class="tt-official-substitute">'+esc(row.substitute||"") +'</td><td class="tt-official-blank"></td><td class="tt-official-blank"></td></tr>';
      }).join("");
    }).join("");
    const remaining=options?.singlePage?0:Math.max(0,RESERVE_OFFICIAL_ROWS_PER_PAGE-used);
    const singlePageFontSize=used>85?4.8:used>70?5.2:used>60?5.8:used>44?6.6:used>30?7.4:used>22?8.2:9.2;
    const reservedSecondTeacher=remaining>0
      ?Array.from({length:remaining},(_,i)=>'<tr class="'+(i===0?'tt-official-group-start':'')+'">'+(i===0?'<td class="tt-official-merged" rowspan="'+remaining+'"></td><td class="tt-official-merged" rowspan="'+remaining+'"></td>':"")+'<td></td><td></td><td></td><td class="tt-official-blank"></td><td class="tt-official-blank"></td></tr>').join("")
      :"";
    const safeDate=String(date||"");let resolvedWeekday=String(weekday||"").trim();
    if(!resolvedWeekday&&safeDate){const d=new Date(safeDate+"T12:00:00+04:00");if(Number.isFinite(d.getTime()))resolvedWeekday=new Intl.DateTimeFormat("ar-OM",{weekday:"long",timeZone:"Asia/Muscat"}).format(d);}
    const detectedSubjects=[...new Set((groups||[]).flatMap(group=>(group.rows||[]).map(row=>String(row.subject||"").trim()).filter(Boolean)))];
    const subjectLabel=String(subject||"").trim()||detectedSubjects.join("، ");
    const subjectTitle=String(options?.title||"").trim()||(subjectLabel?(detectedSubjects.length>1&&!subject?"توزيع احتياط مواد: "+subjectLabel:"توزيع احتياط مادة "+subjectLabel):"كشف توزيع حصص الاحتياط");
    return '<main class="tt-official-page"'+(options?.singlePage?' data-single-page="1"':'')+'><header class="tt-official-heading"><div>سلطنة عُمان</div><div>وزارة التعليم</div><div>المديرية العامة لمحافظة شمال الباطنة</div><div>إدارة التعليم بالسويق</div><div class="tt-official-school">مدرسة أبو دجانة</div></header>'+
      '<div class="tt-official-meta"><div><strong>اليوم:</strong> '+esc(resolvedWeekday)+'</div><div><strong>التاريخ:</strong> '+esc(formatReservePrintFullDate(safeDate))+'</div></div>'+
      '<div class="tt-official-subject"><span>'+esc(subjectTitle)+'</span></div>'+
      '<table class="tt-official-table '+(reservedSecondTeacher?'tt-official-table-full':'')+(options?.singlePage?' tt-official-single-page':'')+'"'+(options?.singlePage?' style="font-size:'+singlePageFontSize+'pt"':'')+'>'+columns+header+'<tbody>'+rowsMarkup+reservedSecondTeacher+'</tbody></table>'+
      '<footer class="tt-official-footer"><div class="tt-official-manager"><strong>د. ناصر السناني</strong><span>مدير المدرسة</span></div><div class="tt-official-stamp" aria-label="مساحة مخصصة للختم"></div></footer></main>';
  }
  function reservePrintDocumentTitle(subject){
    const label=String(subject||"").trim().replace(/^مادة\s+/,"");
    return label?"احتياط مادة "+label:"كشف توزيع حصص الاحتياط";
  }
  function printOfficialReservePages(pages,subject,options={}){
    const previousTitle=document.title;
    document.title=String(options?.title||"").trim()||reservePrintDocumentTitle(subject);
    document.getElementById("ttReservePrintRoot")?.remove();document.getElementById("ttReserveOfficialPrintStyle")?.remove();
    const style=document.createElement("style");style.id="ttReserveOfficialPrintStyle";
    style.textContent='@page{size:A4 portrait;margin:8mm}html,body{margin:0!important;padding:0!important;background:#fff!important}body.tt-reserve-print-mode>*:not(#ttReservePrintRoot){display:none!important}body.tt-reserve-print-mode{background:#fff!important;color:#111!important}#ttReservePrintRoot{display:block!important;width:100%;margin:0!important;padding:0!important;color:#111!important;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;direction:rtl}'+
      '.tt-official-page{box-sizing:border-box;width:100%;height:281mm;max-height:281mm;display:flex;flex-direction:column;direction:rtl;background:#fff;border:.35mm solid #333;padding:2.5mm 3mm 2mm;overflow:hidden;page-break-after:always;break-after:page}.tt-official-page:last-child{page-break-after:auto;break-after:auto}'+
      '.tt-official-heading{flex:0 0 auto;text-align:center;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;font-size:10.5pt;font-weight:700;line-height:1.35;padding:2.5mm 2mm 2mm;background:#078b98;color:#fff;border-bottom:1mm solid #155e75;-webkit-print-color-adjust:exact;print-color-adjust:exact}.tt-official-heading>div{margin:0}.tt-official-school{font-weight:900;font-size:12.5pt;margin-top:.7mm!important}'+
      '.tt-official-meta{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:10mm;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;font-size:10.5pt;font-weight:700;margin:2mm 0 1.5mm}.tt-official-subject{flex:0 0 auto;text-align:center;font-size:10.5pt;font-weight:900;margin:0 auto 1.5mm;width:max-content;max-width:92%;padding:1mm 7mm;background:#e8f1ff;border:1.2px solid #315b91;border-radius:2mm;color:#173b68;box-shadow:0 0 0 .5mm #e8f1ff}.tt-official-table{flex:0 0 auto;width:100%;height:auto;border-collapse:collapse;table-layout:fixed;direction:rtl;margin:0;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;font-size:10.5pt;break-inside:avoid;page-break-inside:avoid}.tt-official-table.tt-official-table-full{height:162mm}.tt-official-table thead{display:table-header-group;height:9mm}.tt-official-table th,.tt-official-table td{box-sizing:border-box;border:1px solid #222;text-align:center;vertical-align:middle;padding:.7mm .8mm;overflow-wrap:anywhere}#ttReservePrintRoot .tt-official-table thead th{height:9mm;font-size:10pt!important;line-height:1.5!important;font-weight:900!important;background:#12345a!important;background-color:#12345a!important;color:#fff!important;border:1.2px solid #0b1f36!important;text-shadow:0 1px 0 rgba(0,0,0,.25);-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}.tt-official-table tbody tr{height:6.8mm;break-inside:avoid;page-break-inside:avoid}.tt-official-table tbody td{height:6.8mm;font-size:9pt}.tt-official-table.tt-official-single-page tbody tr{height:auto!important;min-height:0;break-inside:avoid;page-break-inside:avoid}.tt-official-table.tt-official-single-page tbody td{height:auto!important;font-size:inherit!important;line-height:1.12;padding:.25mm .4mm}.tt-official-table .tt-official-merged{font-weight:800;white-space:normal}.tt-official-table .tt-official-group-start td{border-top:1.5px solid #111}'+
      '.tt-official-footer{direction:ltr;flex:0 0 19mm;display:flex;justify-content:space-between;align-items:flex-end;margin-top:auto;padding-top:1.5mm;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;font-size:13pt}.tt-official-manager{direction:rtl;display:flex;flex-direction:column;gap:2mm;text-align:center;font-weight:700}.tt-official-stamp{direction:rtl;width:42mm;height:16mm;flex:0 0 42mm;display:block;font-weight:700}'+
      '.tt-official-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2mm;margin:0 0 2mm;padding:2mm;background:#f8fafc;border:1.2px solid #1e293b;border-radius:1.5mm;direction:rtl;break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}'+
      '.tt-official-summary-box{min-width:0;display:flex;flex-direction:column;gap:.7mm;padding:1.5mm 2mm;background:#fff;border:1px solid #1e293b;border-radius:1mm;color:#000;overflow-wrap:anywhere}'+
      '.tt-official-summary-box>span{font-size:8pt;font-weight:900;color:#334155}'+
      '.tt-official-summary-box>strong{font-size:9pt;font-weight:900;color:#000;line-height:1.45;overflow-wrap:anywhere}'+
      '.tt-official-summary-box>.tt-summary-absent,.tt-official-summary-box>.tt-summary-reason{color:#991b1b}'+
      '.tt-official-summary-box>.tt-summary-class{color:#1e3a8a}'+
      '.tt-official-summary-box>.tt-summary-sub{color:#065f46}'+
      '.tt-official-table .tt-official-merged{background:#fff!important;color:#000!important;border:1.2px solid #1e293b!important;font-weight:900!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}'+
      '.tt-official-table tbody td{background:#fff!important;color:#000!important}'+
      '.tt-official-summary,.tt-official-summary-box,.tt-official-table th,.tt-official-table td{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}'+
      '.tt-official-summary-box{background:#fff!important;border:1.5px solid #1e293b!important;color:#000!important}'+
      '.tt-official-summary-box>span{color:#334155!important;font-weight:900!important}'+
      '.tt-official-summary-box>.tt-summary-absent,.tt-official-summary-box>.tt-summary-reason{color:#991b1b!important}'+
      '.tt-official-summary-box>.tt-summary-class{color:#1e3a8a!important}'+
      '.tt-official-summary-box>.tt-summary-sub{color:#065f46!important}'+
      '.tt-official-table tbody td.tt-official-absent,.tt-official-table tbody td.tt-official-reason{color:#991b1b!important;font-weight:900!important;background:#fff!important;border:1.5px solid #1e293b!important}'+
      '.tt-official-table tbody td.tt-official-class{color:#1e3a8a!important;font-weight:900!important;background:#fff!important}'+
      '.tt-official-table tbody td.tt-official-substitute{color:#065f46!important;font-weight:900!important;background:#fff!important}'+
      '.tt-official-table th,.tt-official-table td{border-color:#1e293b!important}'+
      '@media screen{#ttReservePrintRoot{width:210mm;margin:12px auto!important;padding:8mm!important;background:#fff;box-shadow:0 2px 18px #0002}.tt-official-page{margin:0 auto 8mm}}@media print{#ttReservePrintRoot{width:auto}.tt-official-page{margin:0}}';
    if(options?.singlePage)style.textContent += '.tt-official-page[data-single-page="1"] .tt-official-table{height:auto!important}.tt-official-page[data-single-page="1"] .tt-official-table thead{height:7mm!important}.tt-official-page[data-single-page="1"] .tt-official-table thead th{height:7mm!important;padding:.35mm!important;font-size:8pt!important;line-height:1.1!important}.tt-official-page[data-single-page="1"] .tt-official-table tbody tr{height:auto!important;min-height:0!important}.tt-official-page[data-single-page="1"] .tt-official-table tbody td{height:auto!important;padding:.3mm .4mm!important;font-size:inherit!important;line-height:1.05!important}';
    document.head.appendChild(style);const root=document.createElement("div");root.id="ttReservePrintRoot";root.innerHTML=(pages||[]).join("");document.body.appendChild(root);document.body.classList.add("tt-reserve-print-mode");
    let cleaned=false;const cleanup=()=>{if(cleaned)return;cleaned=true;document.body.classList.remove("tt-reserve-print-mode");root.remove();style.remove();document.title=previousTitle;window.removeEventListener("afterprint",cleanup);};
    window.addEventListener("afterprint",cleanup,{once:true});
    try{window.print();}catch(error){cleanup();throw error;}
    setTimeout(cleanup,15000);
  }
  async function reservePrintActorSubject(){
    const token=appAuthSession?.token||readAppAuthToken();
    if(!token)return "";
    try{
      const response=await appAuthRequest({action:"timetable_substitution_departments"},token);
      return String(response?.actorDepartmentName||"").trim();
    }catch(error){
      console.warn("Could not resolve reserve distributor subject for print:",error?.message||error);
      return "";
    }
  }
  // Shared official A4 print entry point for every reserve workflow.
  // Keeps the legacy planner and the daily timetable on one canonical template.
  window.printOfficialReserveReport=async function(groups,date,weekday){
    const subject=await reservePrintActorSubject();
    const pages=reserveOfficialPrintPages(Array.isArray(groups)?groups:[],date||"",weekday||"",subject);
    printOfficialReservePages(pages,subject);
  };
  window.printSchoolwideReserveDistributionReport=function(dayReports){
    const options={singlePage:true,title:"توزيع الاحتياط",continuationTitle:"تابع كشف توزيع الاحتياط"};
    const pages=(Array.isArray(dayReports)?dayReports:[]).flatMap(day=>
      reserveOfficialPrintPages(Array.isArray(day?.groups)?day.groups:[],day?.date||"",day?.weekday||"","",options)
    );
    if(pages.length)printOfficialReservePages(pages,"",options);
  };
  function buildReserveReportGroups(response){
    const current=currentPlanRows(response||{}),saved=current.saved||[],planned=current.planned||[],missing=current.missing||[];
    return timetableDailyAbsentTeachers.map(absentName=>{
      const rows=[
        ...saved.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,subject:x.subject,substitute:x.substituteTeacherName,reason:x.reason||x.reserveReason||x.reserve_reason||"",absenceReason:x.absenceReason||"",reserveReason:String(reserveReasons[reserveReasonKey(absentName,x.period)]||x.reason||x.reserveReason||x.reserve_reason||"")})),
        ...planned.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,subject:x.subject,substitute:x.substituteTeacherName,reason:x.reason||x.reserveReason||x.reserve_reason||"",reserveReason:String(reserveReasons[reserveReasonKey(absentName,x.period)]||reserveReasons[absentName]||"")})),
        ...missing.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,subject:x.subject,substitute:"",reason:x.reason||x.reserveReason||x.reserve_reason||"",reserveReason:String(reserveReasons[reserveReasonKey(absentName,x.period)]||reserveReasons[absentName]||"")}))
      ].sort((a,b)=>Number(a.period)-Number(b.period));
      return {absentName,absenceReason:String(reserveAbsenceReasons[absentName]||rows.find(row=>row.absenceReason&&row.absenceReason!=="-")?.absenceReason||""),rows};
    }).filter(group=>group.rows.length);
  }
  window.timetableDailyPrintReport = async function () {
    if(!reserveBatchPreview&&timetableDailyAbsentTeachers.length)await timetableDailyRefreshAll();
    if(!timetableDailyAbsentTeachers.length){status("اختر المعلمين الغائبين قبل الطباعة.","error");return;}
    const groups=buildReserveReportGroups(reserveBatchPreview||{});
    if(!groups.length){status("لا توجد حصص متاحة للطباعة.","error");return;}
    const date=$("timetableSubstitutionDate")?.value||"",weekday=$("timetableSubstitutionWeekday")?.value||"";
    const subject=await reservePrintActorSubject();
    printOfficialReservePages(reserveOfficialPrintPages(groups,date,weekday,subject),subject);
  };
  window.timetableDailyShareWhatsApp = async function () {
    if(!timetableDailyAbsentTeachers.length){status("أضف المعلمين الغائبين أولاً.","error");return;}
    const popup=window.open("about:blank","_blank");if(!popup){status("اسمح بالنوافذ المنبثقة لمشاركة كشف واتساب.","error");return;}
    try{
      if(!reserveBatchPreview)await timetableDailyRefreshAll();
      const groups=buildReserveReportGroups(reserveBatchPreview||{});
      if(!groups.length){popup.close();status("لا توجد حصص لعرضها في كشف اليوم.","info");return;}
      const date=$("timetableSubstitutionDate")?.value||"",weekday=$("timetableSubstitutionWeekday")?.value||"";
      const subject=await reservePrintActorSubject();
      const message=buildReserveWhatsAppMessage(groups,date,weekday,subject);
      popup.location.href="https://wa.me/?text="+encodeURIComponent(message);
    }catch(error){popup.close();status(error?.message||"تعذر تجهيز رسالة الواتساب.","error");}
  };
  function applyTeacherTimetablePresentation() {
    const view=$("teacherTimetableView"),host=$("teacherTimetableWeekGrid");
    if(!view||!host)return;
    view.querySelectorAll(".flex.flex-wrap.gap-2").forEach(node=>{
      const text=String(node.textContent||"");
      if(text.includes("حصة فارغة")&&text.includes("حصة تدريس")&&text.includes("الحصة الآن")&&text.includes("حصة احتياط")){
        node.remove();
      }
    });
    const wrapper=host.firstElementChild;
    if(wrapper&&wrapper.style.overflowX!=="hidden")wrapper.style.overflowX="hidden";
    const table=host.querySelector("table");
    if(table){
      if(table.style.minWidth!=="0px")table.style.minWidth="0";
      if(table.style.width!=="100%")table.style.width="100%";
      if(table.style.tableLayout!=="fixed")table.style.tableLayout="fixed";
    }
  }
  function installLegacyOtherDepartmentTeacherPicker(){
    // The current index.html already owns this picker and its selection state.
    // Do not install the legacy picker: it reused the same DOM id and overwrote
    // the native checkboxes, making selected teachers invisible to generation.
    if($("substitutionOtherTeacherChoices"))return;
    const departmentSelect=$("substitutionOtherDepartmentSelect");
    const departmentToggle=$("substitutionOtherDepartments");
    if(!departmentSelect||!departmentToggle||departmentSelect.dataset.teacherPickerReady==="1")return;
    departmentSelect.dataset.teacherPickerReady="1";
    departmentSelect.insertAdjacentHTML("afterend",
      '<section id="substitutionOtherTeacherPicker" class="hidden mt-3 rounded-xl border border-indigo-100 bg-indigo-50/70 p-3">'+
      '<p class="mb-2 text-xs font-black text-indigo-900">اختر المعلمين المتعاونين من هذا القسم</p>'+
      '<div id="substitutionOtherTeacherChoices" class="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2"></div>'+
      '<p id="substitutionOtherTeacherSelectionStatus" class="mt-2 text-[10px] text-indigo-800">حدد معلماً واحداً أو أكثر ليظهروا ضمن البدلاء المقترحين.</p></section>');
    const picker=$("substitutionOtherTeacherPicker"),host=$("substitutionOtherTeacherChoices"),statusBox=$("substitutionOtherTeacherSelectionStatus");
    let selectedNames=new Set();
    let loading=false;
    async function loadTeachers(){
      const departmentId=String(departmentSelect.value||"").trim();
      selectedNames=new Set();
      if(!departmentToggle.checked||!departmentId){picker?.classList.add("hidden");if(host)host.innerHTML="";return;}
      picker?.classList.remove("hidden");
      if(host)host.innerHTML='<p class="text-xs text-slate-500">جارٍ تحميل معلمي القسم...</p>';
      if(loading)return;
      loading=true;
      try{
        const token=appAuthSession?.token||readAppAuthToken();
        if(!token)throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
        const result=await appAuthRequest({action:"timetable_substitution_departments"},token);
        const department=(result.departments||[]).find(item=>String(item.id)===departmentId);
        const teachers=Array.isArray(department?.teachers)?department.teachers:[];
        if(!teachers.length){
          if(host)host.innerHTML='<p class="text-xs text-slate-600">لا يوجد معلمون مؤهلون في هذا القسم ضمن الجدول النشط.</p>';
          if(statusBox)statusBox.textContent="لا توجد أسماء متاحة للاختيار في هذا القسم.";
          return;
        }
        if(host)host.innerHTML=teachers.map(teacher=>
          '<label class="flex items-center gap-2 rounded-lg border border-indigo-100 bg-white p-2 text-xs font-semibold text-slate-800">'+
          '<input type="checkbox" class="h-4 w-4" data-legacy-other-teacher="'+esc(teacher.name)+'">'+
          '<span>'+esc(teacher.name)+'</span></label>'
        ).join("");
        host?.querySelectorAll("[data-legacy-other-teacher]").forEach(input=>input.addEventListener("change",()=>{
          const name=String(input.dataset.legacyOtherTeacher||"");
          if(input.checked)selectedNames.add(name);else selectedNames.delete(name);
          if(statusBox)statusBox.textContent="تم تحديد "+selectedNames.size+" من المعلمين.";
        }));
        if(statusBox)statusBox.textContent="حدد المعلمين الذين تريد إضافتهم إلى البدلاء المقترحين.";
      }catch(error){
        if(host)host.innerHTML='<p class="text-xs font-bold text-red-700">'+esc(error?.message||"تعذر تحميل معلمي القسم.")+'</p>';
        if(statusBox)statusBox.textContent="تعذر تحميل القائمة. غيّر القسم أو أعد فتح شاشة الاحتياط للمحاولة.";
      }finally{loading=false;}
    }
    departmentSelect.addEventListener("change",loadTeachers);
    departmentToggle.addEventListener("change",()=>{
      if(!departmentToggle.checked){selectedNames=new Set();picker?.classList.add("hidden");if(host)host.innerHTML="";}
      else if(departmentSelect.value)loadTeachers();
    });
    const originalRequest=window.appAuthRequest;
    if(typeof originalRequest==="function"&&!window.__legacyOtherTeacherRequestGuard){
      window.__legacyOtherTeacherRequestGuard=true;
      window.appAuthRequest=async function(body,token,signal){
        const action=String(body?.action||"");
        const legacyActions=["timetable_substitution_batch_preview","timetable_substitution_batch_save"];
        if(legacyActions.includes(action)&&body?.includeOtherDepartments===true){
          const departmentId=String(departmentSelect.value||"").trim();
          if(departmentId&&departmentId===String(body.otherDepartmentId||"")){
            const names=[...selectedNames];
            if(!names.length)throw new Error("اختر معلماً واحداً على الأقل من قائمة معلمي القسم قبل إنشاء التوزيع أو حفظه.");
            body={...body,otherTeacherNames:names};
          }
        }
        const result=await originalRequest.call(this,body,token,signal);
        return result;
      };
    }
  }
  function installHomeReserveArchive() {
    const view=$("substitutionView");
    // Do not initialize or fetch reserve archives while the user is on the login
    // screen or another dashboard. Install only when the reserve view is opened.
    if(!view||view.classList.contains("hidden")||view.dataset.cumulativeArchiveInstalled==="1")return;
    const accessCheck=view.dataset.cumulativeArchiveAccessCheck||"";
    if(accessCheck==="pending"||accessCheck==="denied")return;
    const canViewLocally=isGeneralAdminUser(activeUser)||activeUser?.permissions?.reserve===true||appAuthSession?.principal?.permissions?.reserve===true;
    if(!canViewLocally&&accessCheck!=="allowed"){
      const token=appAuthSession?.token||readAppAuthToken();
      if(!token)return;
      view.dataset.cumulativeArchiveAccessCheck="pending";
      appAuthRequest({action:"timetable_substitution_archive_access"},token).then(result=>{
        view.dataset.cumulativeArchiveAccessCheck=result?.canView===true?"allowed":"denied";
        if(result?.canView===true)installHomeReserveArchive();
      }).catch(()=>{
        view.dataset.cumulativeArchiveAccessCheck="denied";
      });
      return;
    }
    const header=view.querySelector(".subx-toolbar")||view.querySelector(".relative.z-10.flex.flex-wrap.items-center.justify-between.gap-3");
    const stats=$("substitutionStatsPanel");
    const plan=$("substitutionPlanPanel");
    if(!header||!stats||!plan)return;
    view.dataset.cumulativeArchiveInstalled="1";
    plan.insertAdjacentHTML("beforebegin",
      '<section id="substitutionTodayAssignmentsPanel" class="mt-5 space-y-3 rounded-3xl border border-emerald-200 bg-emerald-50/70 p-4 shadow-sm dark:border-emerald-900 dark:bg-emerald-950/20">'+
      '<div class="flex flex-wrap items-center justify-between gap-2"><div><h3 class="text-sm font-black text-emerald-950 dark:text-emerald-100">تكليفات الاحتياط لهذا اليوم</h3><p class="mt-1 text-[10px] text-emerald-800 dark:text-emerald-300">تظهر هنا التكليفات الحالية مباشرة، مع إتاحة التعديل والحذف للتكليفات النشطة المسموح بها خلال اليوم.</p></div><div class="flex items-center gap-2"><span id="substitutionTodayAssignmentsCount" class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-900">0</span><button type="button" id="substitutionTodayAssignmentsReload" class="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-[10px] font-black text-emerald-900 hover:bg-emerald-100">تحديث القائمة</button></div></div>'+
      '<div id="substitutionTodayAssignmentsStatus" class="text-[10px] font-bold text-slate-500" role="status" aria-live="polite">جارٍ تحميل تكليفات اليوم...</div>'+
      '<div id="substitutionTodayAssignmentsResults" class="space-y-2"><p class="rounded-xl border border-dashed border-emerald-200 bg-white p-4 text-center text-xs text-slate-500">جارٍ تحميل السجلات...</p></div></section>');
    $("substitutionTodayAssignmentsPanel").insertAdjacentHTML("afterend",
      '<section id="substitutionCumulativeArchivePanel" class="mt-5 space-y-3 rounded-3xl border border-indigo-200 bg-white p-4 shadow-sm dark:border-indigo-900 dark:bg-slate-900">'+
      '<div><h3 class="text-sm font-black text-slate-900 dark:text-white">سجل الاحتياط التراكمي</h3><p class="mt-1 text-[10px] text-slate-500">سجل موحّد لجميع المواد، مرتب حسب أيام التوزيع الفعلية، دون إظهار المادة أو اسم من أنشأ التوزيع.</p></div>'+
      '<div class="grid gap-2 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">'+
      '<label class="text-[10px] font-bold text-slate-600">من تاريخ<input id="substitutionArchiveFrom" type="date" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs"></label>'+
      '<label class="text-[10px] font-bold text-slate-600">إلى تاريخ<input id="substitutionArchiveTo" type="date" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs"></label>'+
      '<button type="button" id="substitutionArchiveReload" class="rounded-xl border border-slate-300 bg-white px-4 py-3 text-xs font-black text-slate-800">عرض السجلات</button>'+
      '<button type="button" id="substitutionArchivePrint" class="rounded-xl bg-indigo-700 px-4 py-3 text-xs font-black text-white"><i class="fa-solid fa-print ml-1"></i> طباعة السجل</button></div>'+
      '<div id="substitutionCumulativeArchiveStatus" class="text-[10px] font-bold text-slate-500" role="status" aria-live="polite"></div>'+
      '<div id="substitutionCumulativeArchiveResults" class="space-y-3"><p class="rounded-xl border border-dashed p-4 text-center text-xs text-slate-500">اختر الفترة الزمنية ثم اعرض السجلات.</p></div></section>');
    try{const today=timetableSubstitutionGetDate().date;$("substitutionArchiveFrom").value=today;$("substitutionArchiveTo").value=today;}catch{}
    $("substitutionArchiveReload")?.addEventListener("click",()=>window.substitutionLoadCumulativeArchive());
    $("substitutionTodayAssignmentsReload")?.addEventListener("click",()=>window.substitutionLoadHomeTodayAssignments());
    $("substitutionArchivePrint")?.addEventListener("click",()=>{
      if(!(reserveCumulativeArchive||[]).some(item=>item.status!=="cancelled"&&item.assignmentDate)){
        setHomeArchiveStatus("حمّل السجلات أولاً، ولا توجد توزيعات غير ملغاة للطباعة.","error");return;
      }
      window.timetableDailyPrintArchiveRange(reserveCumulativeArchive);
    });
    window.substitutionLoadHomeTodayAssignments();
    // Keep the cumulative report visible and loaded automatically for authorized reserve coordinators.
    window.substitutionLoadCumulativeArchive();
  }
  function setHomeArchiveStatus(message,kind) {
    const node=$("substitutionCumulativeArchiveStatus");if(!node)return;
    node.textContent=String(message||"");
    node.className="text-[10px] font-bold "+(kind==="error"?"text-rose-700":kind==="success"?"text-emerald-700":"text-slate-500");
  }
  window.substitutionLoadCumulativeArchive = function() {
    const host=$("substitutionCumulativeArchiveResults");if(!host)return Promise.resolve(false);
    const from=$("substitutionArchiveFrom")?.value||"",to=$("substitutionArchiveTo")?.value||"";
    const requestKey=from+"|"+to;
    if(reserveCumulativeArchiveLoadPromise){
      if(reserveCumulativeArchiveLoadKey===requestKey)return reserveCumulativeArchiveLoadPromise;
      return reserveCumulativeArchiveLoadPromise.then(()=>window.substitutionLoadCumulativeArchive());
    }
    reserveCumulativeArchiveLoadKey=requestKey;
    reserveCumulativeArchiveLoadPromise=Promise.resolve().then(async()=>{
      try{
        if(!from||!to||from>to){setHomeArchiveStatus("حدد فترة زمنية صحيحة قبل عرض السجل.","error");return false;}
        host.innerHTML='<div class="rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-500">جارٍ تحميل سجل الاحتياط...</div>';
        setHomeArchiveStatus("يتم جلب التوزيعات المحفوظة من النظام...");
        const token=appAuthSession?.token||readAppAuthToken();
        if(!token)throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
        const response=await reserveArchiveRequestWithTimeout(appAuthRequest({action:"timetable_substitution_archive",dateFrom:from,dateTo:to},token));
        if(($("substitutionArchiveFrom")?.value||"")!==from||($("substitutionArchiveTo")?.value||"")!==to)return false;
        reserveCumulativeArchive=Array.isArray(response.archive)?response.archive:[];
        window.substitutionRenderCumulativeArchive();
        setHomeArchiveStatus("تم تحديث السجل من قاعدة البيانات مباشرة.","success");
        return true;
      }catch(error){
        host.innerHTML='<div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">'+esc(error?.message||"تعذر تحميل السجل.")+'</div>';
        setHomeArchiveStatus(error?.message||"تعذر تحميل السجل.","error");
        return false;
      }finally{reserveCumulativeArchiveLoadPromise=null;reserveCumulativeArchiveLoadKey=null;}
    });
    return reserveCumulativeArchiveLoadPromise;
  };
  function setHomeTodayStatus(message,kind) {
    const node=$("substitutionTodayAssignmentsStatus");if(!node)return;
    node.textContent=String(message||"");
    node.className="text-[10px] font-bold "+(kind==="error"?"text-rose-700":kind==="success"?"text-emerald-700":"text-slate-500");
  }
  window.substitutionLoadHomeTodayAssignments = async function() {
    const host=$("substitutionTodayAssignmentsResults");if(!host)return false;
    if(reserveHomeTodayLoadPromise)return reserveHomeTodayLoadPromise;
    let today = "";
    try {
      today = timetableSubstitutionGetDate().date;
    } catch (error) {
      const validationMessage = String(error?.message || "");
      if (validationMessage.includes("الاحتياط متاح لأيام الدراسة من الأحد إلى الخميس فقط.")) {
        const notice = "لا توجد تكليفات احتياط في أيام العطلة الأسبوعية.";
        host.innerHTML = '<div class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">'+esc(notice)+'</div>';
        setHomeTodayStatus(notice,"info");
        return false;
      }
      const notice = validationMessage || "تعذر تحديد تاريخ تكليفات اليوم.";
      host.innerHTML = '<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">'+esc(notice)+'</div>';
      setHomeTodayStatus(notice,"error");
      return false;
    }
    const token=appAuthSession?.token||readAppAuthToken();
    if(!token){
      const message="تعذر التحقق من جلسة الدخول. أعد تسجيل الدخول ثم حدّث القائمة.";
      host.innerHTML='<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">'+esc(message)+'</div>';
      setHomeTodayStatus(message,"error");return false;
    }
    host.innerHTML='<div class="rounded-xl bg-white p-4 text-center text-xs text-slate-500">جارٍ تحميل تكليفات اليوم...</div>';
    setHomeTodayStatus("يتم جلب تكليفات اليوم من قاعدة البيانات...");
    reserveHomeTodayLoadPromise=(async()=>{
      try{
        const response=await appAuthRequest({action:"timetable_substitution_archive",dateFrom:today,dateTo:today,homeToday:true},token);
        reserveHomeToday=Array.isArray(response.archive)?response.archive:[];
        window.substitutionRenderHomeTodayAssignments();
        setHomeTodayStatus("تم تحديث القائمة من قاعدة البيانات مباشرة.","success");
        return true;
      }catch(error){
        const message=error?.message||"تعذر تحميل تكليفات اليوم.";
        host.innerHTML='<div class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">'+esc(message)+'</div>';
        setHomeTodayStatus(message,"error");return false;
      }finally{reserveHomeTodayLoadPromise=null;}
    })();
    return reserveHomeTodayLoadPromise;
  };
  window.substitutionRenderHomeTodayAssignments = function() {
    const host=$("substitutionTodayAssignmentsResults");if(!host)return;
    const today=timetableSubstitutionGetDate().date;
    const records=(reserveHomeToday||[]).filter(item=>item.assignmentDate===today&&item.status!=="cancelled")
      .sort((a,b)=>Number(a.period)-Number(b.period)||String(a.absentTeacherName||"").localeCompare(String(b.absentTeacherName||""),"ar"));
    const count=$("substitutionTodayAssignmentsCount");
    if(count)count.textContent=String(records.length);
    if(!records.length){
      host.innerHTML='<div class="rounded-xl border border-dashed border-emerald-200 bg-white p-5 text-center text-xs text-slate-500">لا توجد تكليفات احتياط محفوظة لهذا اليوم.</div>';
      return;
    }
    const byAbsent=new Map();
    records.forEach(item=>{
      const name=String(item.absentTeacherName||"غير محدد");
      if(!byAbsent.has(name))byAbsent.set(name,[]);
      byAbsent.get(name).push(item);
    });
    host.innerHTML=Array.from(byAbsent.entries()).map(([absentName,items])=>{
        const groupCanEdit=items.length>0&&items.every(item=>item.canEdit===true&&["assigned","confirmed"].includes(item.status));
      const groupCanDelete=items.length>0&&items.every(item=>item.canDelete===true&&["assigned","confirmed","completed"].includes(item.status));
      const groupActions='<div class="flex flex-wrap gap-1.5">'+
        (groupCanEdit?'<button type="button" class="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-[10px] font-black text-indigo-900" data-home-today-edit-group="'+esc(absentName)+'">تعديل التوزيع</button>':'')+
        (groupCanDelete?'<button type="button" class="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-[10px] font-black text-rose-800" data-home-today-delete-group="'+esc(absentName)+'">حذف الغياب والاحتياط بالكامل</button>':'')+
      '</div>';
      return '<section class="rounded-2xl border border-emerald-100 bg-white p-3 shadow-sm">'+
      '<div class="mb-2 flex flex-wrap items-center justify-between gap-2"><strong class="text-xs font-black text-slate-900">المعلم الغائب: '+esc(absentName)+'</strong><div class="flex flex-wrap items-center gap-2"><span class="text-[10px] text-slate-500">'+items.length+' حصص</span>'+groupActions+'</div></div>'+
      '<div class="space-y-2">'+items.map(item=>{
        const editable=item.canEdit===true&&["assigned","confirmed"].includes(item.status);
        const state=item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":item.status==="assigned"?"محفوظ":String(item.status||"");
        const editButton=item.canEdit===true&&["assigned","confirmed"].includes(item.status)?'<button type="button" class="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-[11px] font-black text-indigo-900 transition hover:bg-indigo-100" data-home-today-edit="'+esc(item.id)+'"><i class="fa-solid fa-pen-to-square ml-1"></i> تعديل</button>':"";
        const deleteButton=item.canDelete===true?'<button type="button" class="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-[11px] font-black text-rose-800 transition hover:bg-rose-100" data-home-today-delete="'+esc(item.id)+'"><i class="fa-solid fa-trash-can ml-1"></i> حذف</button>':"";
        const actions=editButton||deleteButton?'<div class="flex shrink-0 flex-wrap gap-1.5">'+editButton+deleteButton+'</div>':'<span class="text-[10px] font-bold text-slate-400">'+(item.status==="completed"?"مكتمل · انتهت الحصة":"انتهت مهلة الحصة أو السجل للقراءة فقط")+'</span>';
        return '<article class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3"><div class="min-w-0 flex-1"><strong class="block text-xs font-black text-slate-900">الحصة '+Number(item.period)+' · '+esc(item.className||"—")+' · '+esc(item.subject||"—")+'</strong><span class="mt-1 block text-xs text-slate-700">المعلم البديل: '+esc(item.substituteTeacherName||"—")+'</span><span class="mt-1 block text-[10px] text-amber-700">سبب الغياب: '+esc(item.absenceReason||"-")+'</span><span class="mt-1 block text-[10px] text-indigo-700">سبب الاحتياط: '+esc(item.reason||"-")+'</span></div>'+actions+'</article>';
      }).join("")+'</div></section>';
    }).join("");
    host.querySelectorAll("[data-home-today-edit-group]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyOpenArchiveDayEdit(today,button.dataset.homeTodayEditGroup)));
    host.querySelectorAll("[data-home-today-delete-group]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyCancelAbsentDistribution(today,button.dataset.homeTodayDeleteGroup)));
    host.querySelectorAll("[data-home-today-edit]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyOpenArchiveEdit(button.dataset.homeTodayEdit)));
    host.querySelectorAll("[data-home-today-delete]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyCancelAssignment(button.dataset.homeTodayDelete)));
  };
  window.substitutionRenderCumulativeArchive = function() {
    const host=$("substitutionCumulativeArchiveResults");if(!host)return;
    // Cancelled assignments remain in the audit trail, but are not part of the
    // current cumulative reserve record shown to coordinators or sent to print.
    const records=(reserveCumulativeArchive||[]).filter(item=>item.status!=="cancelled"&&item.assignmentDate);
    if(!records.length){host.innerHTML='<div class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">لا توجد توزيعات احتياط فعلية في الفترة المحددة.</div>';return;}
    const active=records.filter(item=>item.canEdit===true&&["assigned","confirmed"].includes(item.status));
    const historical=records.length-active.length;
    const byDate=new Map();
    records.forEach(item=>{const date=item.assignmentDate;if(!byDate.has(date))byDate.set(date,[]);byDate.get(date).push(item);});
    host.innerHTML='<div class="grid gap-2 sm:grid-cols-2"><div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><strong class="block text-xs text-emerald-900">توزيعات قابلة للتعديل والحذف</strong><span class="text-[10px] text-emerald-800">'+active.length+' تكليف ضمن المهلة</span></div><div class="rounded-xl border border-slate-200 bg-slate-50 p-3"><strong class="block text-xs text-slate-800">السجل التاريخي</strong><span class="text-[10px] text-slate-600">'+historical+' تكليف محفوظ للمراجعة</span></div></div>'+
      Array.from(byDate.entries()).sort((a,b)=>b[0].localeCompare(a[0])).map(([date,items])=>{
        const byAbsent=new Map();
        items.forEach(item=>{const name=String(item.absentTeacherName||"غير محدد");if(!byAbsent.has(name))byAbsent.set(name,[]);byAbsent.get(name).push(item);});
        const groups=Array.from(byAbsent.entries()).sort((a,b)=>a[0].localeCompare(b[0],"ar")).map(([absentName,rows])=>{
          rows.sort((a,b)=>Number(a.period)-Number(b.period));
          const current=rows.filter(item=>["assigned","confirmed","completed"].includes(item.status));
          const canDelete=current.length>0&&current.every(item=>item.canDelete===true);
          const deleteAll=canDelete?'<button type="button" class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] font-black text-rose-700" data-home-delete-group-date="'+esc(date)+'" data-home-delete-group-absent="'+esc(absentName)+'">حذف التوزيع بالكامل ('+current.length+')</button>':"";
          const rowHtml=rows.map(item=>{
            const state=item.status==="cancelled"?"ملغى":item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":"محفوظ";
            const editButton=item.canEdit===true&&["assigned","confirmed"].includes(item.status)?'<button type="button" class="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[10px] font-black text-indigo-800" data-home-archive-edit="'+esc(item.id)+'">تعديل</button>':"";
            const deleteButton=item.canDelete===true?'<button type="button" class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] font-black text-rose-700" data-home-archive-delete="'+esc(item.id)+'">حذف</button>':"";
            const actions=editButton||deleteButton?'<div class="flex gap-1">'+editButton+deleteButton+'</div>':'<span class="text-[10px] text-slate-400">'+(item.canEdit===false&&item.canDelete!==true?"انتهى يوم التوزيع · للقراءة فقط":state)+'</span>';
            return '<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3"><div><strong class="block text-xs text-slate-800">الحصة '+Number(item.period)+' · '+esc(item.className||"—")+' ← '+esc(item.substituteTeacherName||"")+'</strong><span class="block text-[10px] text-amber-700">سبب الغياب: '+esc(item.absenceReason||"-")+'</span><span class="block text-[10px] text-indigo-700">سبب الاحتياط: '+esc(item.reason||"-")+'</span><span class="block text-[10px] text-slate-500">'+state+'</span></div>'+actions+'</div>';
          }).join("");
          return '<section class="rounded-xl border border-slate-200 bg-slate-50 p-3"><div class="mb-2 flex flex-wrap items-center justify-between gap-2"><strong class="text-xs font-black text-slate-800">المعلم الغائب: '+esc(absentName)+'</strong>'+deleteAll+'</div><div class="space-y-2">'+rowHtml+'</div></section>';
        }).join("");
        return '<details open class="rounded-xl border border-slate-200 bg-white p-3"><summary class="cursor-pointer text-xs font-black text-slate-800">'+esc(date)+' · '+items.length+' تكليف</summary><div class="mt-3 space-y-3">'+groups+'</div></details>';
      }).join("");
    host.querySelectorAll("[data-home-archive-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveEdit(button.dataset.homeArchiveEdit)));
    host.querySelectorAll("[data-home-archive-delete]").forEach(button=>button.addEventListener("click",()=>timetableDailyCancelAssignment(button.dataset.homeArchiveDelete)));
    host.querySelectorAll("[data-home-delete-group-date]").forEach(button=>button.addEventListener("click",()=>timetableDailyCancelAbsentDistribution(button.dataset.homeDeleteGroupDate,button.dataset.homeDeleteGroupAbsent)));
  };
  function installReserveArchiveAutoRefresh() {
    if(window.__reserveArchiveAutoRefreshInstalled)return;
    const originalRequest=window.appAuthRequest;
    if(typeof originalRequest!=="function")return;
    window.__reserveArchiveAutoRefreshInstalled=true;
    let dailyArchiveLoadPromise=null,dailyArchiveRefreshQueued=false;
    const refreshDailyArchiveInBackground=()=>{
      if(typeof window.timetableDailyLoadArchive!=="function")return;
      if(dailyArchiveLoadPromise){dailyArchiveRefreshQueued=true;return;}
      dailyArchiveLoadPromise=(async()=>{
        do{
          dailyArchiveRefreshQueued=false;
          try{await window.timetableDailyLoadArchive();}
          catch(error){console.warn("Reserve archive background refresh failed.",error);}
        }while(dailyArchiveRefreshQueued);
      })().finally(()=>{dailyArchiveLoadPromise=null;});
    };
    const refreshInBackground=(label,loader)=>{
      if(typeof loader!=="function")return;
      Promise.resolve().then(loader).catch(error=>console.warn(label,error));
    };
    const mutationActions=new Set([
      "timetable_substitution_batch_save","timetable_substitution_save",
      "timetable_substitution_update","timetable_substitution_update_batch",
      "timetable_substitution_cancel","timetable_substitution_cancel_batch"
    ]);
    window.appAuthRequest=async function(body,token,signal) {
      const action=String(body?.action||"");
      const result=await originalRequest.call(this,body,token,signal);
      if(action==="timetable_substitution_archive_access"&&result?.canView===true){
        // The archive page initially used canViewSchoolwide as a proxy for
        // department switching. That is not the same permission: authorized
        // coordinators may open the school archive, but may only select their
        // own department in the department archive. Let the page finish its
        // immediate access rendering, then apply the authoritative capability.
        const archiveAccess=result;
        Promise.resolve().then(()=>Promise.resolve().then(()=>{
          const picker=$("subxArchiveDepartmentPickerWrap");
          if(picker)picker.classList.toggle("hidden",archiveAccess.canSelectAnyDepartment!==true);
          const summary=$("subxArchiveDepartmentSummary");
          if(summary){
            const departmentName=String(archiveAccess.departmentName||"القسم المرتبط بحسابك").trim();
            summary.textContent=archiveAccess.canSelectAnyDepartment===true
              ?"يمكنك اختيار القسم المطلوب من هذه البطاقة، وتعرض البطاقة الثانية أرشيف المدرسة لجميع الأقسام والتخصصات."
              :"تعرض هذه البطاقة أرشيف "+departmentName+" المرتبط بحسابك، وتعرض البطاقة الثانية أرشيف المدرسة لجميع الأقسام والتخصصات.";
          }
        }));
      }
      const reserveMutation=mutationActions.has(action);
      // Do not warm archive/preview/statistics reads as a side effect of a permission check.
      // The edit/archive screen loads its own data when the user opens it.
      if(reserveMutation)refreshDailyArchiveInBackground();
      if(reserveMutation&&typeof window.refreshDashboardDailyMetrics==="function"){
        refreshInBackground("Dashboard reserve metric refresh failed.",()=>window.refreshDashboardDailyMetrics(true));
      }
      if(reserveMutation&&$("substitutionTodayAssignmentsResults")){
        refreshInBackground("Reserve home-today refresh failed.",window.substitutionLoadHomeTodayAssignments);
      }
      if(reserveMutation&&$("substitutionCumulativeArchivePanel")&&
        !$("substitutionCumulativeArchivePanel").classList.contains("hidden")){
        refreshInBackground("Reserve cumulative archive refresh failed.",window.substitutionLoadCumulativeArchive);
      }
      // Return the actual request result immediately. Optional archive refreshes
      // run independently and cannot stall saves, edits, cancellations or login.
      return result;
    };
  }
  // Integrate absence reasons and post-approval controls into the actual home
  // substitution workflow (#substitutionView), not only the timetable sub-panel.
  function installMainSubstitutionViewIntegration(){
    const root=$("substitutionView");
    if(!root)return;
    // The current single-screen adapter moves the real distribution flow into
    // #subxScreen_smart. Build the department choices there, not in the hidden
    // legacy timetable panel.
    function installCanonicalDepartmentChoiceCards(){
      const smartScreen=$("subxScreen_smart");
      const deptWrap=$("substitutionOtherDepartmentsWrap");
      if(!smartScreen||!deptWrap)return;
      let grid=$("subxReserveDepartmentChoiceCards");
      if(!grid){
        grid=document.createElement("section");
        grid.id="subxReserveDepartmentChoiceCards";
        grid.className="subx-department-choice-grid";
        grid.setAttribute("role","group");
        grid.setAttribute("aria-label","اختر نطاق توزيع الاحتياط");
        grid.innerHTML=
          '<button type="button" class="subx-department-choice-card tt-reserve-choice-card tt-reserve-local-card is-active" data-reserve-scope="local" aria-pressed="true">'+
            '<span class="subx-department-choice-icon"><i class="fa-solid fa-people-group"></i></span>'+
            '<span class="tt-reserve-choice-copy"><small class="subx-department-choice-kicker">المسار الأساسي</small><strong data-reserve-department-title>التوزيع لمعلمي قسمك</strong><small>توزيع الغياب على معلمي قسمك فقط، وتبقى قائمة الغائبين ضمن نطاق القسم.</small></span>'+
            '<span class="subx-department-choice-action">اعتماد هذا المسار <i class="fa-solid fa-arrow-left"></i></span>'+
          '</button>'+
          '<button type="button" class="subx-department-choice-card tt-reserve-choice-card tt-reserve-support-card" data-reserve-scope="external" aria-pressed="false">'+
            '<span class="subx-department-choice-icon"><i class="fa-solid fa-handshake-angle"></i></span>'+
            '<span class="tt-reserve-choice-copy"><small class="subx-department-choice-kicker">مسار مساند اختياري</small><strong>الاستعانة بالأقسام الأخرى</strong><small>اختر الأقسام المساندة، ثم حدد المعلمين الذين تريد إضافتهم إلى البدلاء.</small></span>'+
            '<span class="subx-department-choice-action">اختيار الأقسام المساندة <i class="fa-solid fa-arrow-left"></i></span>'+
          '</button>';
        const intro=smartScreen.querySelector(".subx-glass-card");
        if(intro)intro.insertAdjacentElement("afterend",grid);
        else smartScreen.insertBefore(grid,deptWrap);
      }
      const localCard=grid.querySelector('[data-reserve-scope="local"]');
      const externalCard=grid.querySelector('[data-reserve-scope="external"]');
      const localTitle=grid.querySelector("[data-reserve-department-title]");
      const select=$("substitutionOtherDepartmentSelect");
      const teacherChoices=$("substitutionOtherTeacherChoices");
      const deptIntro=$("substitutionOtherDepartments");
      if(deptIntro)deptIntro.innerHTML='<strong class="block text-sm font-black">الأقسام المساندة المتاحة</strong><small class="mt-1 block text-[11px] font-medium opacity-80">اختر قسماً أو أكثر، ثم حدد المعلمين الذين تريد الاستعانة بهم.</small>';
      let departmentCardsHost=$("subxReserveDepartmentCards");
      if(!departmentCardsHost){
        departmentCardsHost=document.createElement("div");
        departmentCardsHost.id="subxReserveDepartmentCards";
        departmentCardsHost.className="subx-canonical-department-cards";
        departmentCardsHost.setAttribute("aria-label","الأقسام المساندة المتاحة");
        if(select)select.insertAdjacentElement("beforebegin",departmentCardsHost);
      }
      const renderCanonicalDepartmentCards=()=>{
        if(!departmentCardsHost||!select)return;
        const departments=Array.isArray(window.substitutionOtherDepartmentsData)?window.substitutionOtherDepartmentsData:[];
        const selectedIds=new Set(Array.from(select.selectedOptions||[]).map(option=>String(option.value||"")).filter(Boolean));
        if(!departments.length){
          departmentCardsHost.innerHTML='<p class="subx-department-empty">سيتم عرض الأقسام المتاحة هنا بعد تحميلها.</p>';
          return;
        }
        departmentCardsHost.innerHTML=
          '<div class="subx-department-card-toolbar"><div><strong>اختر الأقسام التي ترغب بالاستعانة بمعلميها</strong><small>اضغط على بطاقة القسم لفتح قائمة معلميه. يمكنك فتح أكثر من قسم معاً.</small></div><div><button type="button" data-department-bulk="all">تحديد كل الأقسام</button><button type="button" data-department-bulk="clear">إلغاء الكل</button></div></div>'+
          '<div class="subx-canonical-department-grid">'+departments.map(department=>{
            const id=String(department.id||"");
            const teachers=(Array.isArray(department.teachers)?department.teachers:[]).filter(teacher=>String(teacher?.name||"").trim());
            const names=new Set(teachers.map(teacher=>String(teacher.name).trim()));
            const selectedCount=[...(window.substitutionSelectedOtherTeacherNames||[])].filter(name=>names.has(String(name))).length;
            const isSelected=selectedIds.has(id);
            return '<article class="subx-canonical-department-item'+(isSelected?' is-selected':'')+'" data-canonical-department-card-id="'+esc(id)+'">'+
              '<label class="subx-canonical-department-card" aria-label="اختيار قسم '+esc(department.name||"قسم")+'">'+
                '<input type="checkbox" data-canonical-department-id="'+esc(id)+'" aria-label="اختيار قسم '+esc(department.name||"قسم")+'" '+(isSelected?"checked":"")+'>'+
                '<span class="subx-canonical-department-icon"><i class="fa-solid fa-book-open"></i></span>'+
                '<span class="subx-canonical-department-copy"><strong>'+esc(department.name||"قسم")+'</strong><small>'+teachers.length+' معلم متاح · '+selectedCount+' محدد</small></span>'+
                '<span class="subx-canonical-department-open"><i class="fa-solid fa-chevron-down"></i></span>'+
              '</label>'+
              '<div class="subx-canonical-department-expanded" '+(isSelected?'':'hidden')+'><div class="subx-canonical-department-expanded-heading"><strong>معلمو '+esc(department.name||"القسم")+'</strong><small>حدد معلماً أو أكثر، أو استخدم تحديد الكل</small></div><div class="subx-canonical-department-teachers" data-canonical-teacher-host="'+esc(id)+'"><p>جارٍ تحميل قائمة المعلمين...</p></div></div>'+
            '</article>';
          }).join("")+'</div>';
        departmentCardsHost.querySelectorAll("[data-canonical-department-id]").forEach(box=>box.addEventListener("change",()=>{
          const id=String(box.dataset.canonicalDepartmentId||"");
          const option=Array.from(select.options).find(item=>String(item.value||"")===id);
          if(option)option.selected=box.checked;
          select.dispatchEvent(new Event("change",{bubbles:true}));
        }));
        departmentCardsHost.querySelectorAll("[data-department-bulk]").forEach(button=>button.addEventListener("click",()=>{
          const selectAll=button.dataset.departmentBulk==="all";
          Array.from(select.options).forEach(option=>{if(option.value)option.selected=selectAll;});
          select.dispatchEvent(new Event("change",{bubbles:true}));
        }));
        // Rebuild the source teacher list after every department-card render.
        // The card renderer replaces the expanded-card DOM; without this call the
        // native teacher sections can be left detached while the new cards show loaders.
        if(typeof window.renderSubstitutionOtherTeacherChoices==="function"){
          window.renderSubstitutionOtherTeacherChoices();
        }
        // Keep the original source checkboxes and their native selection handlers.
        if(typeof enhanceCanonicalTeacherCards==="function")enhanceCanonicalTeacherCards();
      };
      if(select&&!select.dataset.canonicalDepartmentCardsBound){
        select.dataset.canonicalDepartmentCardsBound="1";
        select.addEventListener("change",renderCanonicalDepartmentCards,true);
      }
      const enhanceCanonicalTeacherCards=()=>{
        const host=$("substitutionOtherTeacherChoices");
        if(!host)return;
        const ids=substitutionOtherDepartmentIds();
        const departments=ids.map(id=>(window.substitutionOtherDepartmentsData||[]).find(item=>String(item.id)===String(id))).filter(Boolean);
        const sections=Array.from(host.querySelectorAll(":scope > section"));
        sections.forEach((section,index)=>{
          const department=departments[index];
          if(!department)return;
          const id=String(department.id);
          section.dataset.canonicalTeacherDepartment=id;
          section.classList.add("subx-canonical-teacher-group");
          const card=departmentCardsHost?.querySelector('[data-canonical-department-card-id="'+CSS.escape(id)+'"]');
          const target=card?.querySelector(".subx-canonical-department-teachers");
          if(target&&section.parentElement!==target)target.replaceChildren(section);
          const heading=section.querySelector("b");
          if(heading&&!section.querySelector(".subx-canonical-teacher-tools")){
            const tools=document.createElement("div");
            tools.className="subx-canonical-teacher-tools";
            tools.innerHTML='<span data-teacher-group-count></span><div><button type="button" data-teacher-group-action="all">تحديد الكل</button><button type="button" data-teacher-group-action="clear">إلغاء الكل</button></div>';
            heading.insertAdjacentElement("afterend",tools);
            tools.querySelector('[data-teacher-group-action="all"]')?.addEventListener("click",()=>{
              section.querySelectorAll("[data-other-department-teacher]").forEach(box=>{
                if(!box.checked){box.checked=true;box.dispatchEvent(new Event("change",{bubbles:true}));}
              });
              updateTeacherGroupCount();
            });
            tools.querySelector('[data-teacher-group-action="clear"]')?.addEventListener("click",()=>{
              section.querySelectorAll("[data-other-department-teacher]").forEach(box=>{
                if(box.checked){box.checked=false;box.dispatchEvent(new Event("change",{bubbles:true}));}
              });
              updateTeacherGroupCount();
            });
          }
          section.querySelectorAll("label").forEach(label=>label.classList.add("subx-canonical-teacher-option"));
          section.querySelectorAll("[data-other-department-teacher]").forEach(box=>box.classList.add("subx-canonical-teacher-checkbox"));
          const updateTeacherGroupCount=()=>{
            const boxes=Array.from(section.querySelectorAll("[data-other-department-teacher]"));
            const count=section.querySelector("[data-teacher-group-count]");
            if(count)count.textContent=boxes.length+" معلم متاح · "+boxes.filter(box=>box.checked).length+" محدد";
            const item=departmentCardsHost?.querySelector('[data-canonical-department-card-id="'+CSS.escape(id)+'"]');
            const summary=item?.querySelector(".subx-canonical-department-copy small");
            if(summary)summary.textContent=boxes.length+" معلم متاح · "+boxes.filter(box=>box.checked).length+" محدد";
          };
          if(section.dataset.countListenerBound!=="1"){
            section.addEventListener("change",updateTeacherGroupCount);
            section.dataset.countListenerBound="1";
          }
          updateTeacherGroupCount();
        });
        // Keep all selected departments expanded simultaneously; their live teacher
        // controls remain the original controls created by the existing renderer.
        departmentCardsHost?.querySelectorAll("[data-canonical-department-card-id]").forEach(card=>{
          const id=String(card.dataset.canonicalDepartmentCardId||"");
          const expanded=card.querySelector(".subx-canonical-department-expanded");
          if(expanded)expanded.hidden=!ids.includes(id);
        });
      };
      if(typeof window.renderSubstitutionOtherTeacherChoices==="function"&&!window.renderSubstitutionOtherTeacherChoices.__canonicalDepartmentCardsWrapped){
        const originalRender=window.renderSubstitutionOtherTeacherChoices;
        const wrappedRender=function(...args){
          const result=originalRender.apply(this,args);
          enhanceCanonicalTeacherCards();
          return result;
        };
        wrappedRender.__canonicalDepartmentCardsWrapped=true;
        wrappedRender.__original=originalRender;
        window.renderSubstitutionOtherTeacherChoices=wrappedRender;
      }
      // The legacy teacher renderer may be registered after this screen installer,
      // or populate its host asynchronously. Observe its real output so the
      // canonical cards never remain stuck on the "loading teachers" placeholder.
      const canonicalTeacherSourceHost=$("substitutionOtherTeacherChoices");
      if(canonicalTeacherSourceHost&&canonicalTeacherSourceHost.dataset.canonicalTeacherObserverBound!=="1"&&typeof MutationObserver!=="undefined"){
        canonicalTeacherSourceHost.dataset.canonicalTeacherObserverBound="1";
        const canonicalTeacherObserver=new MutationObserver(()=>{
          if(!departmentCardsHost?.isConnected)return;
          enhanceCanonicalTeacherCards();
        });
        canonicalTeacherObserver.observe(canonicalTeacherSourceHost,{childList:true,subtree:true});
        // Also handle content that was already rendered before the observer was attached.
        enhanceCanonicalTeacherCards();
      }
      const principal=appAuthSession?.principal;
      const sameSessionAdmin=principal?.type==="admin"&&principal?.name===activeUser?.name;
      const canExpand=canManageReserveWorkspace(activeUser)||sameSessionAdmin||
        (principal?.type==="teacher"&&principal?.permissions?.reserve===true);
      if(externalCard)externalCard.hidden=!canExpand;
      const setActiveScope=scope=>{
        grid.dataset.scope=scope;
        [localCard,externalCard].forEach(card=>{
          const active=card?.dataset.reserveScope===scope;
          card?.classList.toggle("is-active",active);
          card?.setAttribute("aria-pressed",active?"true":"false");
        });
      };
      const chooseLocal=()=>{
        setActiveScope("local");
        deptWrap.classList.add("hidden");
        if(select){
          Array.from(select.options).forEach(option=>{option.selected=false;});
          select.dispatchEvent(new Event("change",{bubbles:true}));
        }
        renderCanonicalDepartmentCards();
        window.substitutionSelectedOtherDepartmentIds=[];
        window.substitutionSelectedOtherDepartmentId="";
        window.substitutionSelectedOtherTeacherNames=new Set();
        teacherChoices?.classList.add("hidden");
        if(teacherChoices)teacherChoices.innerHTML='<p class="text-xs text-slate-500">تم اختيار التوزيع ضمن قسمك فقط.</p>';
      };
      const chooseExternal=async()=>{
        if(!canExpand)return;
        setActiveScope("external");
        deptWrap.classList.remove("hidden");
        try{
          if(!Array.isArray(window.substitutionOtherDepartmentsData)||!window.substitutionOtherDepartmentsData.length){
              await window.timetableLoadOtherDepartmentOptions?.("substitutionOtherDepartments","substitutionOtherDepartmentSelect");
          }
          select?.classList.add("hidden");
          renderCanonicalDepartmentCards();
          window.renderSubstitutionOtherTeacherChoices?.();
          deptWrap.scrollIntoView({behavior:"smooth",block:"center"});
        }catch(error){
          showToast(error?.message||"تعذر تحميل الأقسام المساندة.","error");
        }
      };
      if(grid.dataset.handlersBound!=="1"){
        localCard?.addEventListener("click",chooseLocal);
        externalCard?.addEventListener("click",chooseExternal);
        grid.dataset.handlersBound="1";
        grid.dataset.scope="local";
      }
      if(grid.dataset.scope!=="external"||!canExpand){
        setActiveScope("local");
        deptWrap.classList.add("hidden");
      }else{
        setActiveScope("external");
        deptWrap.classList.remove("hidden");
      }
      if(smartScreen.dataset.departmentChoiceObserver!=="1"&&typeof MutationObserver!=="undefined"){
        const observer=new MutationObserver(()=>{
          if(!smartScreen.classList.contains("is-visible"))return;
          if(grid.dataset.scope==="external"&&canExpand)deptWrap.classList.remove("hidden");
          else deptWrap.classList.add("hidden");
          if(grid.dataset.actorDepartmentLoaded==="1"||grid.dataset.actorDepartmentLoading==="1")return;
          grid.dataset.actorDepartmentLoading="1";
          Promise.resolve(loadOtherDepartments()).then(()=>{
            const department=String(reserveActorDepartmentName||"").trim();
            if(localTitle&&department)localTitle.textContent="التوزيع لمعلمي قسم "+department;
            grid.dataset.actorDepartmentLoaded="1";
          }).catch(()=>{}).finally(()=>{delete grid.dataset.actorDepartmentLoading;});
        });
        observer.observe(smartScreen,{attributes:true,attributeFilter:["class"]});
        smartScreen.dataset.departmentChoiceObserver="1";
        if(smartScreen.classList.contains("is-visible")){
          Promise.resolve(loadOtherDepartments()).then(()=>{
            const department=String(reserveActorDepartmentName||"").trim();
            if(localTitle&&department)localTitle.textContent="التوزيع لمعلمي قسم "+department;
            grid.dataset.actorDepartmentLoaded="1";
          }).catch(()=>{});
        }
      }
      const generateButton=$("substitutionGenerateButton");
      if(generateButton){
        generateButton.classList.add("subx-smart-generate-button");
        generateButton.innerHTML='<span class="subx-smart-generate-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span><span class="subx-smart-generate-label">التوزيع الذكي للاحتياط</span>';
      }
      if(!document.getElementById("subxReserveDepartmentChoiceStyles")){
        const style=document.createElement("style");
        style.id="subxReserveDepartmentChoiceStyles";
        style.textContent=[
          "#subxScreen_smart .subx-department-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0 0 16px}",
          "#subxScreen_smart .subx-department-choice-card{position:relative;display:grid;grid-template-columns:48px minmax(0,1fr);align-items:center;gap:12px;width:100%;min-width:0;min-height:142px;padding:16px;text-align:right;border:1px solid rgba(255,255,255,.75);border-radius:22px;background:linear-gradient(135deg,rgba(14,165,233,.96),rgba(79,70,229,.94));color:#fff;box-shadow:0 14px 32px rgba(30,41,59,.13),inset 0 1px 0 rgba(255,255,255,.5);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);transition:transform .18s,box-shadow .18s,border-color .18s}",
          "#subxScreen_smart .subx-department-choice-card:hover{transform:translateY(-2px);box-shadow:0 18px 36px rgba(30,41,59,.18)}",
          "#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external]{background:linear-gradient(135deg,rgba(16,185,129,.97),rgba(5,150,105,.95),rgba(13,148,136,.96))}",
          "#subxScreen_smart .subx-department-choice-card.is-active{border:2px solid rgba(255,255,255,.96);filter:saturate(1.28) brightness(1.12);transform:translateY(-3px);box-shadow:0 0 0 5px rgba(15,23,42,.16),0 22px 42px rgba(15,23,42,.27),inset 0 1px 0 rgba(255,255,255,.62)}",
          "#subxScreen_smart .subx-department-choice-card[data-reserve-scope=local].is-active{background:linear-gradient(135deg,#075985 0%,#1d4ed8 48%,#6d28d9 100%);box-shadow:0 0 0 5px rgba(37,99,235,.22),0 22px 42px rgba(30,64,175,.32),inset 0 1px 0 rgba(255,255,255,.62)}",
          "#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external].is-active{background:linear-gradient(135deg,#047857 0%,#0f766e 48%,#0e7490 100%);box-shadow:0 0 0 5px rgba(13,148,136,.24),0 22px 42px rgba(6,95,70,.32),inset 0 1px 0 rgba(255,255,255,.62)}",
          "#subxScreen_smart .subx-department-choice-card.is-active:after{content:'✓';position:absolute;top:9px;left:10px;width:25px;height:25px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.75);border-radius:50%;background:rgba(255,255,255,.24);color:#fff;font-size:14px;font-weight:1000;box-shadow:0 3px 10px rgba(15,23,42,.16)}",
          "#subxScreen_smart .subx-department-choice-card[hidden]{display:none!important}",
          "#subxScreen_smart .subx-department-choice-icon{width:48px;height:48px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.55);border-radius:15px;background:rgba(255,255,255,.2);font-size:20px}",
          "#subxScreen_smart .subx-department-choice-card .tt-reserve-choice-copy{display:grid;gap:4px;min-width:0}",
          "#subxScreen_smart .subx-department-choice-kicker{font-size:10px;font-weight:900;color:rgba(255,255,255,.85)}",
          "#subxScreen_smart .subx-department-choice-card strong{font-size:15px;line-height:1.5;font-weight:1000;color:#fff;overflow-wrap:anywhere}",
          "#subxScreen_smart .subx-department-choice-card .tt-reserve-choice-copy small:last-child{font-size:11px;line-height:1.7;color:rgba(255,255,255,.92)}",
          "#subxScreen_smart .subx-department-choice-action{grid-column:1/-1;display:flex;justify-content:center;align-items:center;gap:8px;min-height:38px;padding:8px;border:1px solid rgba(255,255,255,.45);border-radius:13px;background:rgba(255,255,255,.17);font-size:11px;font-weight:900}",
          "#subxScreen_smart .subx-smart-generate-button{display:flex!important;justify-content:center;align-items:center;width:100%;min-height:56px;margin:0 0 12px!important;border:1px solid rgba(255,255,255,.55)!important;border-radius:18px!important;background:linear-gradient(105deg,#7c3aed,#4f46e5 38%,#0ea5e9 72%,#0d9488)!important;color:#fff!important;box-shadow:0 14px 30px rgba(79,70,229,.25),inset 0 1px 0 rgba(255,255,255,.35)!important;font-size:16px!important;font-weight:1000!important}",
          "#subxScreen_smart #subxReserveDepartmentCards{margin:.5rem 0 .9rem}",
          "#subxScreen_smart .subx-department-card-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin:10px 0;padding:13px 15px;border:1px solid rgba(255,255,255,.72);border-radius:18px;background:linear-gradient(135deg,rgba(255,255,255,.88),rgba(224,242,254,.76));box-shadow:0 9px 24px rgba(15,23,42,.07);font-size:12px;color:#17324d;backdrop-filter:blur(14px)}",
          "#subxScreen_smart .subx-department-card-toolbar>div:first-child{display:grid;gap:4px}#subxScreen_smart .subx-department-card-toolbar>div:first-child small{font-size:10px;color:#64748b;line-height:1.6}",
          "#subxScreen_smart .subx-department-card-toolbar>div:last-child{display:flex;flex-wrap:wrap;gap:6px}",
          "#subxScreen_smart .subx-department-card-toolbar button{padding:8px 11px;border:1px solid rgba(14,116,144,.22);border-radius:11px;background:linear-gradient(135deg,#fff,#ecfeff);color:#0e7490;font-size:10px;font-weight:900;box-shadow:0 3px 10px rgba(15,23,42,.05)}",
          "#subxScreen_smart .subx-canonical-department-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}",
          "#subxScreen_smart .subx-canonical-department-item{min-width:0;overflow:hidden;border:1px solid rgba(255,255,255,.82);border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.94),rgba(219,234,254,.72),rgba(224,242,254,.78));box-shadow:0 13px 30px rgba(15,23,42,.10),inset 0 1px 0 rgba(255,255,255,.85);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);transition:transform .2s,box-shadow .2s,border-color .2s}",
          "#subxScreen_smart .subx-canonical-department-item.is-selected{border:2px solid rgba(13,148,136,.68);background:linear-gradient(145deg,rgba(167,243,208,.96),rgba(204,251,241,.92),rgba(224,242,254,.9));box-shadow:0 0 0 3px rgba(13,148,136,.13),0 16px 32px rgba(13,148,136,.18),inset 0 1px 0 rgba(255,255,255,.9);transform:translateY(-2px)}",
          "#subxScreen_smart .subx-canonical-department-card{position:relative;display:grid;grid-template-columns:28px 52px minmax(0,1fr) 22px;align-items:center;gap:11px;min-height:96px;padding:15px;border:0;border-radius:20px;background:transparent;cursor:pointer}",
          "#subxScreen_smart .subx-canonical-department-card input{position:static;display:block;width:27px;height:27px;margin:0;opacity:1;pointer-events:auto;accent-color:#059669;cursor:pointer;filter:drop-shadow(0 2px 3px rgba(15,23,42,.12))}",
          "#subxScreen_smart .subx-canonical-department-icon{width:52px;height:52px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.82);border-radius:17px;background:linear-gradient(145deg,#0e7490,#2563eb);color:#fff;font-size:22px;box-shadow:0 8px 19px rgba(37,99,235,.24),inset 0 1px 0 rgba(255,255,255,.42)}",
          "#subxScreen_smart .subx-canonical-department-copy{display:grid;gap:5px;min-width:0}",
          "#subxScreen_smart .subx-canonical-department-copy strong{font-size:14px;font-weight:1000;color:#17324d;overflow-wrap:anywhere}",
          "#subxScreen_smart .subx-canonical-department-copy small{font-size:10px;color:#64748b;line-height:1.5}",
          
          "#subxScreen_smart .subx-canonical-department-open{display:grid;place-items:center;color:#64748b;transition:transform .18s}",
          "#subxScreen_smart .subx-canonical-department-item.is-selected .subx-canonical-department-icon{background:linear-gradient(145deg,#047857,#0d9488);box-shadow:0 7px 18px rgba(13,148,136,.24)}",
          "#subxScreen_smart .subx-canonical-department-item.is-selected .subx-canonical-department-copy strong{color:#065f46}",
          
          "#subxScreen_smart .subx-canonical-department-item.is-selected .subx-canonical-department-open{transform:rotate(180deg);color:#047857}",
          "#subxScreen_smart .subx-canonical-department-card:focus-within{outline:3px solid rgba(13,148,136,.28);outline-offset:-4px}",
          "#subxScreen_smart .subx-canonical-department-item:hover{transform:translateY(-2px);box-shadow:0 17px 34px rgba(15,23,42,.13)}",
          "#subxScreen_smart .subx-canonical-department-expanded{padding:0 12px 13px;border-top:1px solid rgba(13,148,136,.16)}",
          "#subxScreen_smart .subx-canonical-department-expanded[hidden]{display:none!important}",
          "#subxScreen_smart .subx-canonical-department-expanded-heading{display:grid;gap:3px;padding:12px 3px 8px;color:#065f46}",
          "#subxScreen_smart .subx-canonical-department-expanded-heading strong{font-size:12px;font-weight:1000}#subxScreen_smart .subx-canonical-department-expanded-heading small{font-size:10px;color:#64748b}",
          "#subxScreen_smart .subx-canonical-department-teachers{min-width:0}",
          "#subxScreen_smart .subx-department-empty{padding:12px;border:1px dashed #cbd5e1;border-radius:12px;text-align:center;font-size:11px;color:#64748b}",
          "#subxScreen_smart #substitutionOtherDepartmentSelect{display:none!important}",
          "#subxScreen_smart .subx-canonical-department-teachers>section.subx-canonical-teacher-group{margin:8px 0 0;padding:12px;border:1px solid rgba(13,148,136,.18);border-radius:15px;background:linear-gradient(145deg,rgba(255,255,255,.97),rgba(236,253,245,.82));box-shadow:0 8px 20px rgba(13,148,136,.07)}",
          "#subxScreen_smart .subx-canonical-teacher-tools{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 10px;padding:8px;border-radius:12px;background:rgba(238,242,255,.8)}",
          "#subxScreen_smart .subx-canonical-teacher-tools>span{font-size:9px;font-weight:900;color:#475569}",
          "#subxScreen_smart .subx-canonical-teacher-tools>div{display:flex;gap:5px}",
          "#subxScreen_smart .subx-canonical-teacher-tools button{padding:6px 9px;border:1px solid rgba(79,70,229,.18);border-radius:9px;background:#fff;color:#4338ca;font-size:9px;font-weight:900}",
          "#subxScreen_smart .subx-canonical-teacher-option{min-height:58px!important;padding:12px 14px!important;border:1px solid rgba(13,148,136,.22)!important;border-radius:15px!important;background:linear-gradient(135deg,rgba(255,255,255,.96),rgba(236,253,245,.82))!important;font-size:13px!important;font-weight:900!important;box-shadow:0 5px 14px rgba(15,23,42,.055);cursor:pointer}",
          "#subxScreen_smart .subx-canonical-teacher-checkbox{width:27px!important;height:27px!important;min-width:27px!important;accent-color:#059669!important;cursor:pointer}",
          "#subxScreen_smart .subx-canonical-teacher-tools{background:linear-gradient(135deg,rgba(204,251,241,.72),rgba(224,242,254,.72))!important;border:1px solid rgba(13,148,136,.12)}",
          "#subxScreen_smart .subx-canonical-teacher-tools button{min-height:34px;padding:7px 11px;border-radius:10px;font-size:10px}",
          "html.dark #subxScreen_smart .subx-department-card-toolbar{background:rgba(15,23,42,.82);color:#e2e8f0}",
          "html.dark #subxScreen_smart .subx-canonical-department-item,html.dark #subxScreen_smart .subx-canonical-department-teachers>section.subx-canonical-teacher-group{background:linear-gradient(145deg,rgba(15,23,42,.94),rgba(30,41,59,.92));border-color:rgba(148,163,184,.2)}",
          "html.dark #subxScreen_smart .subx-canonical-department-item.is-selected{background:linear-gradient(145deg,rgba(6,95,70,.94),rgba(15,118,110,.78),rgba(15,23,42,.94));border:2px solid rgba(45,212,191,.72);box-shadow:0 0 0 3px rgba(45,212,191,.16),0 16px 32px rgba(0,0,0,.28)}",
          "html.dark #subxScreen_smart .subx-canonical-department-copy strong,html.dark #subxScreen_smart .subx-canonical-department-expanded-heading strong{color:#f1f5f9}",
          "html.dark #subxScreen_smart .subx-canonical-department-expanded-heading small{color:#94a3b8}",
          "html.dark #subxScreen_smart .subx-canonical-teacher-option{background:rgba(15,23,42,.82)!important;border-color:rgba(148,163,184,.2)!important;color:#f8fafc!important}",
          "html.dark #subxScreen_smart .subx-canonical-department-copy strong{color:#f1f5f9}",
          "html.dark #subxScreen_smart .subx-canonical-department-copy small{color:#94a3b8}",
          "@media(max-width:620px){#subxScreen_smart .subx-canonical-department-grid{grid-template-columns:1fr}#subxScreen_smart .subx-department-card-toolbar{align-items:flex-start}#subxScreen_smart .subx-canonical-department-card{grid-template-columns:28px 48px minmax(0,1fr) 20px;min-height:88px;padding:13px;gap:9px}#subxScreen_smart .subx-canonical-department-icon{width:48px;height:48px}#subxScreen_smart .subx-canonical-department-card input{width:26px;height:26px}}",
          "#subxScreen_smart .subx-smart-generate-button:disabled{opacity:.45!important;filter:grayscale(.25)}",
          "html.dark #subxScreen_smart .subx-department-choice-card{border-color:rgba(255,255,255,.2);box-shadow:0 14px 32px rgba(0,0,0,.28)}",
          "@media(max-width:620px){#subxScreen_smart .subx-department-choice-grid{grid-template-columns:1fr}#subxScreen_smart .subx-department-choice-card{min-height:126px;padding:14px}}"
        ].join("\n");
        document.head.appendChild(style);
      }
      if(!document.getElementById("subxReservePolishedChoiceStyles")){
        const polish=document.createElement("style");
        polish.id="subxReservePolishedChoiceStyles";
        polish.textContent="#subxScreen_smart .subx-department-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:0 0 18px}\n#subxScreen_smart .subx-department-choice-card{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:54px minmax(0,1fr);align-items:center;gap:13px;width:100%;min-width:0;min-height:144px;padding:17px;text-align:right;border:1px solid rgba(192,210,219,.82)!important;border-radius:24px!important;background:linear-gradient(145deg,rgba(255,255,255,.97),rgba(242,248,250,.94))!important;color:#263f53!important;box-shadow:0 13px 32px rgba(35,62,82,.09),inset 0 1px 0 rgba(255,255,255,.96)!important;backdrop-filter:blur(20px) saturate(135%);-webkit-backdrop-filter:blur(20px) saturate(135%);filter:none!important;transform:none;transition:transform .22s,border-color .22s,box-shadow .22s}\n#subxScreen_smart .subx-department-choice-card:before{content:'';position:absolute;inset:0;z-index:0;border-radius:inherit;background:radial-gradient(circle at 8% 0%,rgba(89,157,169,.13),transparent 48%);pointer-events:none}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external]:before{background:radial-gradient(circle at 8% 0%,rgba(126,132,177,.14),transparent 48%)}\n#subxScreen_smart .subx-department-choice-card>*{position:relative;z-index:1}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=local]{background:linear-gradient(145deg,rgba(255,255,255,.98),rgba(237,247,249,.94))!important}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external]{background:linear-gradient(145deg,rgba(255,255,255,.98),rgba(245,245,250,.95))!important}\n#subxScreen_smart .subx-department-choice-card:hover{transform:translateY(-3px)!important;box-shadow:0 18px 36px rgba(35,62,82,.13),inset 0 1px 0 rgba(255,255,255,.98)!important}\n#subxScreen_smart .subx-department-choice-card.is-active{filter:none!important;transform:translateY(-2px)!important;border-width:1px!important}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=local].is-active{border-color:rgba(48,126,145,.62)!important;background:linear-gradient(145deg,#edf8fa,#fff 86%)!important;box-shadow:0 0 0 3px rgba(48,126,145,.09),0 17px 36px rgba(48,126,145,.13),inset 0 1px 0 #fff!important}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external].is-active{border-color:rgba(111,119,163,.58)!important;background:linear-gradient(145deg,#f1f1f8,#fff 86%)!important;box-shadow:0 0 0 3px rgba(111,119,163,.09),0 17px 36px rgba(83,91,137,.12),inset 0 1px 0 #fff!important}\n#subxScreen_smart .subx-department-choice-card.is-active:after{content:'✓';position:absolute;top:11px;left:12px;z-index:2;width:25px;height:25px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.9);border-radius:50%;background:#397e8d;color:#fff;font-size:13px;font-weight:1000;box-shadow:0 4px 12px rgba(35,83,101,.2)}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external].is-active:after{background:#777da4}\n#subxScreen_smart .subx-department-choice-card[hidden]{display:none!important}\n#subxScreen_smart .subx-department-choice-icon{width:52px;height:52px;display:grid;place-items:center;border:1px solid rgba(72,133,149,.18);border-radius:18px;background:linear-gradient(145deg,#e8f3f5,#dcebee);color:#397b8b;font-size:21px;box-shadow:0 7px 18px rgba(46,108,127,.09),inset 0 1px 0 #fff}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external] .subx-department-choice-icon{border-color:rgba(113,120,163,.18);background:linear-gradient(145deg,#efeff7,#e5e7f1);color:#737a9f;box-shadow:0 7px 18px rgba(83,91,137,.08),inset 0 1px 0 #fff}\n#subxScreen_smart .subx-department-choice-card .tt-reserve-choice-copy{display:grid;gap:5px;min-width:0}\n#subxScreen_smart .subx-department-choice-kicker{font-size:10px;font-weight:900;color:#64808d}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external] .subx-department-choice-kicker{color:#777e9d}\n#subxScreen_smart .subx-department-choice-card strong{font-size:15px;line-height:1.5;font-weight:1000;color:#203b50;overflow-wrap:anywhere}\n#subxScreen_smart .subx-department-choice-card .tt-reserve-choice-copy small:last-child{font-size:11px;line-height:1.75;color:#6b7d8b}\n#subxScreen_smart .subx-department-choice-action{grid-column:1/-1;display:flex;justify-content:center;align-items:center;gap:8px;min-height:38px;padding:8px 12px;border:1px solid rgba(75,133,148,.17);border-radius:13px;background:rgba(255,255,255,.72);color:#397889;font-size:10px;font-weight:900;box-shadow:inset 0 1px 0 rgba(255,255,255,.96);transition:background .2s,border-color .2s,transform .2s}\n#subxScreen_smart .subx-department-choice-card[data-reserve-scope=external] .subx-department-choice-action{border-color:rgba(113,120,163,.17);color:#747b9d}\n#subxScreen_smart .subx-department-choice-card:hover .subx-department-choice-action{background:rgba(255,255,255,.96);transform:translateY(-1px)}\n#subxScreen_smart .subx-department-choice-card:focus-visible{outline:3px solid rgba(63,132,151,.3);outline-offset:3px}\n#substitutionView .subx-floating-bar{right:50%;bottom:calc(10px + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;width:min(184px,calc(100vw - 24px));padding:9px 10px 10px;border:1px solid rgba(202,218,224,.68);border-radius:25px;background:rgba(248,252,253,.92);box-shadow:0 18px 46px rgba(22,51,69,.16),inset 0 1px 0 rgba(255,255,255,.95);backdrop-filter:blur(20px) saturate(140%);-webkit-backdrop-filter:blur(20px) saturate(140%);transform:translate(50%,18px);transition:transform .25s,opacity .25s}\n#substitutionView .subx-floating-bar.is-visible{transform:translate(50%,0);opacity:1;pointer-events:auto}\n#substitutionView .subx-floating-copy{display:flex;justify-content:center;align-items:center;width:100%;min-width:0;text-align:center}\n#substitutionView .subx-floating-dot{display:none}\n#substitutionView .subx-floating-copy>div{min-width:0;text-align:center}\n#substitutionView .subx-floating-copy b{display:block;color:#28465a;font-size:10px;font-weight:900;line-height:1.4}\n#substitutionView .subx-floating-copy small{display:block;margin-top:2px;color:#758895;font-size:9px;line-height:1.4}\n#substitutionView #subxGenerateDock{display:grid;place-items:center;width:100%;min-width:0}\n#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button{position:relative;isolation:isolate;overflow:visible!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;gap:8px!important;width:clamp(116px,35vw,146px)!important;height:clamp(116px,35vw,146px)!important;min-width:116px!important;min-height:116px!important;max-width:146px!important;margin:0!important;padding:12px!important;aspect-ratio:1/1;border:1px solid rgba(255,255,255,.88)!important;border-radius:50%!important;background:radial-gradient(circle at 34% 22%,#5b9aa6 0%,#347e8e 34%,#245e76 68%,#1b455f 100%)!important;color:#fff!important;box-shadow:0 13px 30px rgba(28,82,103,.25),0 0 0 6px rgba(91,154,166,.10),inset 0 1px 0 rgba(255,255,255,.42)!important;white-space:normal!important;text-align:center;font-size:12px!important;font-weight:1000!important;line-height:1.4!important;transition:transform .22s,box-shadow .22s,filter .22s}\n#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button:before{content:'';position:absolute;inset:-7px;z-index:-1;border:1px solid rgba(83,151,165,.34);border-radius:50%;box-shadow:0 0 0 4px rgba(83,151,165,.065),0 0 24px rgba(76,151,164,.16);animation:subxSmartHalo 4.2s ease-in-out infinite;pointer-events:none}\n#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button:after{content:'';position:absolute;inset:8px;border:1px solid rgba(255,255,255,.18);border-radius:50%;pointer-events:none}\n#substitutionView .subx-smart-generate-icon{display:grid;place-items:center;width:46px;height:46px;border:1px solid rgba(255,255,255,.3);border-radius:16px;background:rgba(255,255,255,.14);color:#fff;font-size:22px;box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 5px 16px rgba(8,35,49,.12)}\n#substitutionView .subx-smart-generate-label{display:block;max-width:100%;color:#fff;font-size:12px;font-weight:1000;line-height:1.55;text-shadow:0 1px 7px rgba(10,40,54,.22)}\n#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button:hover:not(:disabled){transform:translateY(-3px) scale(1.025);box-shadow:0 18px 36px rgba(28,82,103,.31),0 0 0 7px rgba(91,154,166,.12),inset 0 1px 0 rgba(255,255,255,.48)!important}\n#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button:active:not(:disabled){transform:scale(.97)}\n#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button:disabled{opacity:.58!important;filter:saturate(.72);box-shadow:0 8px 20px rgba(28,82,103,.13),0 0 0 5px rgba(91,154,166,.06)!important}\nhtml.dark #substitutionView .subx-floating-bar{border-color:rgba(117,143,157,.3);background:rgba(15,29,42,.94);box-shadow:0 18px 48px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.08)}\nhtml.dark #substitutionView .subx-floating-copy b{color:#e7f0f5}html.dark #substitutionView .subx-floating-copy small{color:#9eb0bc}\nhtml.dark #substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button{background:radial-gradient(circle at 34% 22%,#477e8a 0%,#285c70 55%,#173d55 100%)!important;border-color:rgba(222,242,246,.56)!important}\nhtml.dark #subxScreen_smart .subx-department-choice-card{border-color:rgba(148,171,183,.3)!important;background:linear-gradient(145deg,rgba(25,43,57,.96),rgba(18,34,48,.94))!important;color:#edf4f7!important;box-shadow:0 15px 34px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.06)!important}\nhtml.dark #subxScreen_smart .subx-department-choice-card[data-reserve-scope=local].is-active{border-color:rgba(89,174,188,.64)!important;background:linear-gradient(145deg,rgba(29,70,82,.9),rgba(21,48,64,.96))!important}\nhtml.dark #subxScreen_smart .subx-department-choice-card[data-reserve-scope=external].is-active{border-color:rgba(151,153,193,.62)!important;background:linear-gradient(145deg,rgba(55,57,84,.9),rgba(24,37,54,.96))!important}\nhtml.dark #subxScreen_smart .subx-department-choice-icon{border-color:rgba(143,195,204,.2);background:linear-gradient(145deg,rgba(48,104,116,.52),rgba(33,71,86,.6));color:#9ed1d8}\nhtml.dark #subxScreen_smart .subx-department-choice-card[data-reserve-scope=external] .subx-department-choice-icon{background:linear-gradient(145deg,rgba(84,87,126,.58),rgba(50,57,87,.68));color:#c1c4e3}\nhtml.dark #subxScreen_smart .subx-department-choice-kicker{color:#9bc3cb}html.dark #subxScreen_smart .subx-department-choice-card[data-reserve-scope=external] .subx-department-choice-kicker{color:#b8bad6}\nhtml.dark #subxScreen_smart .subx-department-choice-card strong{color:#f1f6f8}html.dark #subxScreen_smart .subx-department-choice-card .tt-reserve-choice-copy small:last-child{color:#b6c5cd}\nhtml.dark #subxScreen_smart .subx-department-choice-action{border-color:rgba(145,187,197,.2);background:rgba(255,255,255,.055);color:#a7d4dc}html.dark #subxScreen_smart .subx-department-choice-card[data-reserve-scope=external] .subx-department-choice-action{color:#c0c2df}\n@media(max-width:620px){#subxScreen_smart .subx-department-choice-grid{grid-template-columns:1fr;gap:10px}#subxScreen_smart .subx-department-choice-card{min-height:128px;padding:14px;grid-template-columns:50px minmax(0,1fr)}#subxScreen_smart .subx-department-choice-icon{width:48px;height:48px}#substitutionView .subx-floating-bar{width:min(172px,calc(100vw - 22px));padding:8px 9px 10px}#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button{width:clamp(116px,35vw,140px)!important;height:clamp(116px,35vw,140px)!important}}\n@keyframes subxSmartHalo{0%,100%{opacity:.68;transform:scale(.985)}50%{opacity:1;transform:scale(1.015)}}\n@media(prefers-reduced-motion:reduce){#subxScreen_smart .subx-department-choice-card,#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button{transition:none!important}#substitutionView #subxGenerateDock #substitutionGenerateButton.subx-smart-generate-button:before{animation:none!important}}";
        document.head.appendChild(polish);
      }
    }
    installCanonicalDepartmentChoiceCards();
    // Bind the visible dashboard card directly. Do not rely on its inline
    // handler: later UI installers can replace global entry points, leaving
    // a visually active card with no working click action.
    const dashboardCard=$("substitutionDashboardCard");
    if(dashboardCard&&dashboardCard.dataset.canonicalReserveClickBound!=="1"){
      dashboardCard.dataset.canonicalReserveClickBound="1";
      dashboardCard.removeAttribute("onclick");
      dashboardCard.removeAttribute("onkeydown");
      dashboardCard.addEventListener("click",event=>{
        event.preventDefault();
        const opener=window.openSubstitutionView;
        if(typeof opener!=="function"){
          showToast("تعذر تشغيل شاشة توزيع الاحتياط. حدّث الصفحة ثم حاول مجدداً.","error");
          return;
        }
        try{
          const opening=opener();
          Promise.resolve(opening).catch(error=>status(error?.message||"تعذر فتح شاشة توزيع الاحتياط.","error"));
        }catch(error){
          status(error?.message||"تعذر فتح شاشة توزيع الاحتياط.","error");
        }
      });
      dashboardCard.addEventListener("keydown",event=>{
        if(event.key!=="Enter"&&event.key!==" ")return;
        event.preventDefault();
        dashboardCard.click();
      });
    }
    // Keep the legacy daily panels hidden as compatibility engines.
    // The visible edit/archive lists are rendered by index.html and open this
    // module's authenticated full-day editor; moving both old panels into them
    // would create two competing edit paths.
    function installReserveArchivePremiumDateControls(){
      const host=$("subxArchiveMountArea");
      if(!host)return false;
      const styleId="subxReserveArchivePremiumDateStyles";
      if(!document.getElementById(styleId)){
        const style=document.createElement("style");
        style.id=styleId;
        style.textContent=[
          "#subxArchiveMountArea .subx-archive-date-label{display:grid;gap:8px;min-width:0;padding:13px;border:1px solid rgba(148,163,184,.22);border-radius:18px;background:linear-gradient(145deg,rgba(255,255,255,.96),rgba(240,249,255,.82));box-shadow:0 8px 22px rgba(15,23,42,.055);color:#334155;font-weight:900}",
          "#subxArchiveMountArea .subx-archive-date-icon{display:grid;place-items:center;width:32px;height:32px;border:1px solid rgba(13,148,136,.18);border-radius:11px;background:linear-gradient(145deg,#ecfeff,#ccfbf1);color:#0f766e;font-size:14px}",
          "#subxArchiveMountArea .subx-archive-date-input{display:block;width:100%;min-height:54px;padding:10px 13px;border:1px solid rgba(13,148,136,.24);border-radius:15px;background:linear-gradient(135deg,#fff,#effdfa);color:#123047;font-size:14px;font-weight:900;letter-spacing:.02em;text-align:center;direction:ltr;box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 5px 14px rgba(13,148,136,.055);transition:border-color .18s,box-shadow .18s,transform .18s}",
          "#subxArchiveMountArea .subx-archive-date-input:hover{border-color:rgba(13,148,136,.5);box-shadow:0 7px 18px rgba(13,148,136,.1)}",
          "#subxArchiveMountArea .subx-archive-date-input:focus-visible{outline:3px solid rgba(20,184,166,.18);outline-offset:2px;border-color:#0f9b8e;box-shadow:0 0 0 4px rgba(20,184,166,.11)}",
          "#subxArchiveMountArea .subx-archive-date-input::-webkit-calendar-picker-indicator{cursor:pointer;opacity:.86;filter:sepia(.5) saturate(2.5) hue-rotate(125deg);padding:4px;border-radius:8px}",
          "#subxArchiveMountArea .subx-archive-date-presets{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:10px;padding:10px 11px;border:1px solid rgba(148,163,184,.17);border-radius:16px;background:linear-gradient(135deg,rgba(248,250,252,.92),rgba(236,253,250,.76))}",
          "#subxArchiveMountArea .subx-archive-date-presets>span{margin-inline-end:3px;color:#64748b;font-size:10px;font-weight:900}",
          "#subxArchiveMountArea .subx-archive-date-preset{min-height:36px;padding:8px 12px;border:1px solid rgba(13,148,136,.22);border-radius:999px;background:rgba(255,255,255,.94);color:#0f766e;font-size:10px;font-weight:900;transition:background .18s,border-color .18s,transform .18s}",
          "#subxArchiveMountArea .subx-archive-date-preset:hover{transform:translateY(-1px);border-color:rgba(13,148,136,.5);background:#ecfdf5}",
          "#subxArchiveMountArea .subx-archive-date-preset.is-active{border-color:#0f766e;background:linear-gradient(135deg,#0f766e,#0e7490);color:#fff;box-shadow:0 5px 13px rgba(15,118,110,.2)}",
          "html.dark #subxArchiveMountArea .subx-archive-date-label{border-color:rgba(71,85,105,.6);background:linear-gradient(145deg,rgba(15,23,42,.96),rgba(17,48,61,.88));color:#e2e8f0}",
          "html.dark #subxArchiveMountArea .subx-archive-date-input{border-color:rgba(45,212,191,.27);background:linear-gradient(135deg,#0f172a,#102a35);color:#e2e8f0}",
          "html.dark #subxArchiveMountArea .subx-archive-date-presets{border-color:rgba(71,85,105,.56);background:linear-gradient(135deg,rgba(15,23,42,.92),rgba(15,55,58,.74))}",
          "html.dark #subxArchiveMountArea .subx-archive-date-presets>span{color:#94a3b8}",
          "html.dark #subxArchiveMountArea .subx-archive-date-preset{border-color:rgba(45,212,191,.22);background:rgba(15,23,42,.92);color:#99f6e4}",
          "@media(max-width:520px){#subxArchiveMountArea .subx-archive-date-label{padding:11px}#subxArchiveMountArea .subx-archive-date-input{min-height:51px}#subxArchiveMountArea .subx-archive-date-presets{gap:6px}#subxArchiveMountArea .subx-archive-date-preset{flex:1 1 auto}}"
        ].join("\n");
        document.head.appendChild(style);
      }
      const shiftDate=(value,days)=>{
        const date=new Date(String(value||"")+"T00:00:00Z");
        if(!Number.isFinite(date.getTime()))return "";
        date.setUTCDate(date.getUTCDate()+days);
        return date.toISOString().slice(0,10);
      };
      const apply=()=>{
        const systemAdmin=appAuthSession?.principal?.type==="admin";
        const picker=$("subxArchiveDepartmentPickerWrap");
        if(picker)picker.classList.toggle("hidden",!systemAdmin);
        ["department","school"].forEach(mode=>{
          const prefix=mode==="school"?"subxArchiveSchool":"subxArchiveDepartment";
          const fromInput=$(prefix+"From"),toInput=$(prefix+"To");
          [fromInput,toInput].forEach((input,index)=>{
            if(!input)return;
            input.classList.add("subx-archive-date-input");
            input.setAttribute("aria-label",(mode==="school"?"أرشيف المدرسة — ":"أرشيف القسم — ")+(index===0?"من تاريخ":"إلى تاريخ"));
            const label=input.closest("label");
            if(label){
              label.classList.add("subx-archive-date-label");
              if(!label.querySelector("[data-subx-archive-date-icon]")){
                const icon=document.createElement("span");
                icon.className="subx-archive-date-icon";
                icon.dataset.subxArchiveDateIcon="1";
                icon.setAttribute("aria-hidden","true");
                icon.innerHTML='<i class="fa-regular fa-calendar-days"></i>';
                label.insertBefore(icon,input);
              }
            }
          });
          const grid=fromInput?.closest(".grid")||toInput?.closest(".grid");
          if(grid&&!grid.parentElement?.querySelector('[data-subx-archive-presets="'+mode+'"]')){
            const presets=document.createElement("div");
            presets.className="subx-archive-date-presets";
            presets.dataset.subxArchivePresets=mode;
            presets.setAttribute("role","group");
            presets.setAttribute("aria-label","اختصارات تحديد فترة أرشيف الاحتياط");
            presets.innerHTML='<span>فترات سريعة</span><button type="button" class="subx-archive-date-preset" data-subx-archive-preset="7">آخر ٧ أيام</button><button type="button" class="subx-archive-date-preset" data-subx-archive-preset="30">آخر ٣٠ يوماً</button><button type="button" class="subx-archive-date-preset" data-subx-archive-preset="month">هذا الشهر</button>';
            grid.insertAdjacentElement("afterend",presets);
          }
          const shortcuts=grid?.parentElement?.querySelector('[data-subx-archive-presets="'+mode+'"]');
          if(shortcuts&&!shortcuts.dataset.bound){
            shortcuts.dataset.bound="1";
            shortcuts.addEventListener("click",event=>{
              const button=event.target.closest("[data-subx-archive-preset]");
              if(!button)return;
              const today=reserveCurrentMuscatDate(),to=shiftDate(today,-1);
              let from="";
              if(button.dataset.subxArchivePreset==="month"){
                from=today.slice(0,7)+"-01";
                if(from>to){
                  const node=$(mode==="school"?"subxArchiveSchoolStatus":"subxArchiveDepartmentStatus");
                  if(node)node.textContent="لا توجد أيام مكتملة في الشهر الحالي حتى الآن.";
                  return;
                }
              }else{
                const span=Number(button.dataset.subxArchivePreset);
                if(!Number.isInteger(span)||span<1||span>366)return;
                from=shiftDate(to,-(span-1));
              }
              if(!from||!to||from>to)return;
              if(fromInput)fromInput.value=from;
              if(toInput)toInput.value=to;
              [fromInput,toInput].forEach(input=>input?.dispatchEvent(new Event("change",{bubbles:true})));
              shortcuts.querySelectorAll("[data-subx-archive-preset]").forEach(item=>item.classList.toggle("is-active",item===button));
              const node=$(mode==="school"?"subxArchiveSchoolStatus":"subxArchiveDepartmentStatus");
              if(node)node.textContent="تم تحديد الفترة: "+from+" — "+to+". اضغط عرض الأرشيف لجلب السجلات.";
            });
          }
          [fromInput,toInput].forEach(input=>{
            if(!input||input.dataset.archivePresetReset==="1")return;
            input.dataset.archivePresetReset="1";
            input.addEventListener("change",()=>{
              shortcuts?.querySelectorAll("[data-subx-archive-preset]").forEach(item=>item.classList.remove("is-active"));
            });
          });
        });
      };
      apply();
      return true;
    }
    // This mount is reserved for the canonical editor and archive cards only.
    // Legacy administration/reset panels are intentionally not created or moved here.
    function mountCanonicalPanel(){
      // The unified reserve workspace owns its editor and archive mounts.
      // The legacy timetable panel is optional and is not part of the current DOM.
      const panel=$("timetableSubstitutionPanel");
      const archiveHost=$("subxArchiveMountArea");
      if(!$("subxEditMountArea")||!archiveHost)return false;
      if(panel)panel.classList.add("hidden");
      $("timetableDailyActivePanel")?.classList.add("hidden");
      $("timetableDailyArchivePanel")?.classList.add("hidden");
      return true;
    }
    function restoreCanonicalPanel(){
      $("timetableSubstitutionPanel")?.classList.add("hidden");
    }
    if(typeof window.openSubstitutionView==="function"&&!window.openSubstitutionView.__canonicalReserveWrapped){
      window.openSubstitutionView=async function(){
        // The visibility observer also runs when this function opens the view.
        // Prevent it from replaying the same open operation while requests are pending.
        if(window.__canonicalReserveOpening)return;
        window.__canonicalReserveOpening=true;
        try{
          const reservePrincipal=appAuthSession?.principal;
          const sameSessionAdmin=reservePrincipal?.type==="admin"&&reservePrincipal?.name===activeUser?.name;
          const allowed=canManageReserveWorkspace(activeUser)||sameSessionAdmin||reservePrincipal?.type==="custom"||(reservePrincipal?.type==="teacher"&&reservePrincipal?.permissions?.reserve===true);
          if(!allowed){showToast("لا تملك صلاحية توزيع حصص الاحتياط.","error");return;}
          ["dashboardSelectionView","dutyView","dutyClassesView","teacherTimetableView","attendanceView","classesView","behaviorClassesView","behaviorSessionView"].forEach(id=>$(id)?.classList.add("hidden"));
          root.classList.remove("hidden");
          if(!mountCanonicalPanel()){showToast("تعذر فتح مساحة توزيع الاحتياط الموحدة. أعد تحميل الصفحة وحاول مجدداً.","error");return;}
          installReserveArchivePremiumDateControls();
          const today=typeof getOmanLocalDate==="function"?getOmanLocalDate():new Date().toISOString().slice(0,10);
          const date=$("substitutionDate");
          if(date){
            // Historical dates remain selectable; default only an empty date to Muscat today.
            if(!date.value)date.value=today;
          }
          const legacyDate=$("timetableSubstitutionDate");
          if(legacyDate)legacyDate.value=date?.value||today;
          const canExpand=canManageReserveWorkspace(activeUser)||sameSessionAdmin||(reservePrincipal?.type==="teacher"&&reservePrincipal?.permissions?.reserve===true);
          const isCustomCoordinator=reservePrincipal?.type==="custom";
          $("substitutionOtherDepartmentsWrap")?.classList.toggle("hidden",!canExpand);
          $("timetableDailyOtherDepartmentsButton")?.classList.toggle("hidden",!canExpand);
          root.querySelector('[data-subx-tab="edit"]')?.classList.toggle("hidden",isCustomCoordinator);
          root.querySelector('[data-subx-tab="stats"]')?.classList.toggle("hidden",isCustomCoordinator);
          // Absence coordinators may open the archive; the server validates the grant and scopes every request.
          if(isCustomCoordinator)root.querySelector('[data-subx-tab="daily"]')?.click();
          // The new day-card renderer owns the edit/archive views for every authorized role.
          // Keep the legacy daily panels hidden so they cannot become a second competing path.
          $("timetableDailyActivePanel")?.classList.add("hidden");
          $("substitutionStatsPanel")?.classList.toggle("hidden",isCustomCoordinator);
          $("timetableDailyArchivePanel")?.classList.add("hidden");
          if(typeof window.substitutionLoadAbsentees==="function"){
            try{await window.substitutionLoadAbsentees();}
            catch(error){status(error?.message||"تعذر تحميل قائمة المعلمين الغائبين.","error");}
          }
          if(!isCustomCoordinator){
            const startBackgroundLoad=(loader,fallback)=>{
              if(typeof loader!=="function")return;
              Promise.resolve().then(loader).catch(error=>{
                status(error?.message||fallback,"error");
              });
            };
            startBackgroundLoad(window.substitutionLoadStats,"تعذر تحميل إحصائيات الاحتياط.");
          }
        }finally{
          window.__canonicalReserveOpening=false;
        }
      };
      window.openSubstitutionView.__canonicalReserveWrapped=true;
    }
    // Visibility alone is not a request to open the reserve workspace.
    // This installer also runs during unrelated view changes and page boot;
    // all reserve reads must wait for an explicit dashboard-card click.
    if(typeof window.closeSubstitutionView==="function"&&!window.closeSubstitutionView.__canonicalReserveWrapped){
      window.closeSubstitutionView=function(){
        restoreCanonicalPanel();
        root.classList.add("hidden");
        $("dashboardSelectionView")?.classList.remove("hidden");
        if(typeof window.refreshSubstitutionDashboardCard==="function")window.refreshSubstitutionDashboardCard();
      };
      window.closeSubstitutionView.__canonicalReserveWrapped=true;
    }
    const distributionDate=$("substitutionDate");
    if(distributionDate){
      const omanToday=()=>typeof getOmanLocalDate==="function"
        ?String(getOmanLocalDate())
        :new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const enforceNoPastDistributionDate=()=>{
        const today=omanToday();
        distributionDate.min=today;
        distributionDate.setAttribute("min",today);
        // Initial normalization is silent: dispatching "change" here runs the
        // legacy inline handler and preloads reserve data during unrelated app boot.
        if(!distributionDate.value||distributionDate.value<today)distributionDate.value=today;
      };
      enforceNoPastDistributionDate();
      // Capture before the inline onchange handler so an invalid past date is
      // corrected before substitutionDateChanged reads it. No synthetic events.
      distributionDate.addEventListener("input",enforceNoPastDistributionDate,true);
      distributionDate.addEventListener("change",enforceNoPastDistributionDate,true);
      const dateCard=distributionDate.closest(".subx-date-card")||distributionDate.parentElement;
      if(dateCard&&!dateCard.querySelector("#subxCanonicalDateQuickNav")){
        const nav=document.createElement("div");
        nav.id="subxCanonicalDateQuickNav";
        nav.className="tt-premium-date-nav";
        nav.setAttribute("role","group");
        nav.setAttribute("aria-label","التنقل السريع بين تواريخ الاحتياط");
        nav.setAttribute("aria-controls","substitutionDate");
        nav.innerHTML='<button type="button" data-date-offset="0" class="is-today"><i class="fa-regular fa-calendar-check"></i><span>اليوم</span></button><button type="button" data-date-offset="1"><span>غداً</span><i class="fa-solid fa-chevron-left"></i></button><span class="tt-date-nav-hint">يمكنك اختيار أي تاريخ من التقويم</span>';
        dateCard.appendChild(nav);
        nav.addEventListener("click",event=>{
          const button=event.target.closest("[data-date-offset]");
          if(!button)return;
          const base=typeof getOmanLocalDate==="function"
            ?String(getOmanLocalDate())
            :new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
          const parts=base.split("-").map(Number);
          if(parts.length!==3||parts.some(value=>!Number.isFinite(value)))return;
          const offset=Number(button.dataset.dateOffset);
          const selected=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]+offset,12));
          distributionDate.value=selected.toISOString().slice(0,10);
          distributionDate.dispatchEvent(new Event("input",{bubbles:true}));
          distributionDate.dispatchEvent(new Event("change",{bubbles:true}));
          nav.querySelectorAll("button").forEach(item=>item.classList.toggle("is-selected",item===button));
        });
      }
      if(distributionDate.dataset.canonicalLegacyDateSync!=="1"){
        distributionDate.dataset.canonicalLegacyDateSync="1";
        distributionDate.addEventListener("change",()=>{
          const legacyDate=$("timetableSubstitutionDate");
          if(!legacyDate||legacyDate.value===distributionDate.value)return;
          legacyDate.value=distributionDate.value;
          legacyDate.dispatchEvent(new Event("change",{bubbles:true}));
        });
      }
    }
    const reasons=window.__mainReserveAbsenceReasons||(window.__mainReserveAbsenceReasons=Object.create(null));
    // The new date picker is authoritative. Keep the hidden compatibility
    // engine's date synchronized before its original loader refreshes the plan.
    if(typeof window.substitutionDateChanged==="function"&&!window.substitutionDateChanged.__reserveDateSyncWrapped){
      const originalDateChanged=window.substitutionDateChanged;
      const syncedDateChanged=async function(...args){
        const selectedDate=String($("substitutionDate")?.value||"").trim();
        const legacyDate=$("timetableSubstitutionDate");
        if(legacyDate&&selectedDate)legacyDate.value=selectedDate;
        return originalDateChanged.apply(this,args);
      };
      syncedDateChanged.__reserveDateSyncWrapped=true;
      syncedDateChanged.__original=originalDateChanged;
      window.substitutionDateChanged=syncedDateChanged;
    }
    const reasonKey=name=>String(document.getElementById("substitutionDate")?.value||"")+"::"+String(name||"").trim();
    const bypass=window.__mainReserveReasonBypass||(window.__mainReserveReasonBypass=new WeakSet());
    if(root.dataset.mainReserveReasonsInstalled!=="1"){
      root.dataset.mainReserveReasonsInstalled="1";
      root.addEventListener("change",event=>{
        const input=event.target;
        if(!(input instanceof HTMLInputElement)||!input.matches('input[name="substitutionAbsentTeacher"]'))return;
        if(bypass.has(input)){bypass.delete(input);return;}
        if(!input.checked)return;
        const absentName=String(input.value||"").trim();
        if(!absentName||reasons[reasonKey(absentName)])return;
        event.stopImmediatePropagation();
        event.stopPropagation();
        input.checked=false;
        const picker=window.openSubstitutionAbsenceReasonPicker;
        if(typeof picker!=="function"){
          input.checked=false;
          showToast("نافذة سبب الغياب غير جاهزة. حدّث الصفحة ثم حاول مجدداً.","error");
          return;
        }
        picker(absentName,"",value=>{
          if(!value)return;
          reasons[reasonKey(absentName)]=value;
          input.checked=true;
          bypass.add(input);
          input.dispatchEvent(new Event("change",{bubbles:true}));
        });
      },true);
    }
    if(typeof window.substitutionToggleAllAbsentees==="function"&&!window.substitutionToggleAllAbsentees.__mainReserveReasonWrapped){
      const originalToggle=window.substitutionToggleAllAbsentees;
      const wrappedToggle=function(){
        const boxes=Array.from(root.querySelectorAll('input[name="substitutionAbsentTeacher"]'));
        const unchecked=boxes.filter(box=>!box.checked);
        if(!unchecked.length){
          boxes.filter(box=>box.checked).forEach(box=>{
            box.checked=false;bypass.add(box);box.dispatchEvent(new Event("change",{bubbles:true}));
          });
          return;
        }
        (async()=>{
          for(const box of unchecked){
            const absentName=String(box.value||"").trim();
            if(!absentName)continue;
            if(!reasons[reasonKey(absentName)]){
              const value=await new Promise(resolve=>window.openSubstitutionAbsenceReasonPicker(absentName,"",resolve));
              if(!value)break;
              reasons[reasonKey(absentName)]=value;
            }
            box.checked=true;bypass.add(box);box.dispatchEvent(new Event("change",{bubbles:true}));
          }
        })();
      };
      wrappedToggle.__mainReserveReasonWrapped=true;
      wrappedToggle.__original=originalToggle;
      window.substitutionToggleAllAbsentees=wrappedToggle;
    }
    if(typeof window.appAuthRequest==="function"&&!window.appAuthRequest.__mainReserveReasonPayloadWrapped){
      const originalRequest=window.appAuthRequest;
      const wrappedRequest=async function(body,token,signal){
        if(body?.action==="timetable_substitution_batch_save"&&Array.isArray(body.assignments)){
          body={...body,assignments:body.assignments.map(item=>({
            ...item,
            absenceReason:String(item?.absenceReason||reasons[reasonKey(item?.absentTeacherName)]||"-").trim()
          }))};
        }
        return originalRequest.call(this,body,token,signal);
      };
      wrappedRequest.__mainReserveReasonPayloadWrapped=true;
      wrappedRequest.__original=originalRequest;
      window.appAuthRequest=wrappedRequest;
    }
    if(typeof window.printOfficialReserveReport==="function"&&!window.printOfficialReserveReport.__mainReserveReasonWrapped){
      const originalPrint=window.printOfficialReserveReport;
      const wrappedPrint=function(groups,...args){
        const enriched=(Array.isArray(groups)?groups:[]).map(group=>({
          ...group,
          reason:String(group?.reason||reasons[reasonKey(group?.absentName)]||"-")
        }));
        return originalPrint.call(this,enriched,...args);
      };
      wrappedPrint.__mainReserveReasonWrapped=true;
      wrappedPrint.__original=originalPrint;
      window.printOfficialReserveReport=wrappedPrint;
    }
  }
  installLegacyOtherDepartmentTeacherPicker();
  installMainSubstitutionViewIntegration();
  installReserveEnhancements();
  installReserveArchiveAutoRefresh();

  // Add the narrowly-scoped schoolwide reserve archive permission to the
  // existing teacher permissions dialog without changing login or other grants.
  (function installSchoolwideReserveArchivePermissionControl(){
    const modal=document.getElementById("teacherPermissionsModal");
    if(!modal||modal.dataset.schoolwideArchivePermissionInstalled==="1")return;
    const saveButton=modal.querySelector('button[onclick="saveTeacherPermissions()"]');
    const footer=saveButton?.parentElement;
    if(!footer)return;
    const section=document.createElement("div");
    section.className="rounded-2xl border border-cyan-200 bg-cyan-50/80 p-4 dark:border-cyan-900 dark:bg-cyan-950/30";
    section.innerHTML='<label for="perm_p_schoolwideReserveArchive" class="flex cursor-pointer items-start gap-3"><input id="perm_p_schoolwideReserveArchive" type="checkbox" class="mt-1 h-4 w-4 accent-cyan-700"><span><span class="block text-sm font-black text-cyan-950 dark:text-cyan-100">عرض أرشيف الاحتياط الشامل للمدرسة</span><span class="mt-1 block text-xs leading-6 text-cyan-800 dark:text-cyan-200">تسمح هذه الصلاحية بالاطلاع على سجلات الاحتياط لجميع التخصصات، وتُظهر لصاحبها مؤشر عدد المعلمين الموزعين احتياط في لوحة التحكم. لا تمنح صلاحية التوزيع أو التعديل أو الإلغاء.</span></span></label>';
    footer.parentElement.insertBefore(section,footer);
    modal.dataset.schoolwideArchivePermissionInstalled="1";
    const syncCheckbox=()=>{
      const name=String(document.getElementById("permTeacherName")?.textContent||"").trim();
      const teacher=(typeof db!=="undefined"&&Array.isArray(db.teachers))?db.teachers.find(item=>item.name===name):null;
      const checkbox=document.getElementById("perm_p_schoolwideReserveArchive");
      if(checkbox)checkbox.checked=teacher?.permissions?.schoolwideReserveArchive===true;
    };
    if(typeof window.openPermissionsModal==="function"&&!window.openPermissionsModal.__schoolwideArchiveWrapped){
      const originalOpen=window.openPermissionsModal;
      const wrappedOpen=function(...args){const result=originalOpen.apply(this,args);syncCheckbox();return result;};
      wrappedOpen.__schoolwideArchiveWrapped=true;wrappedOpen.__original=originalOpen;
      window.openPermissionsModal=wrappedOpen;
    }
    if(typeof window.saveTeacherPermissions==="function"&&!window.saveTeacherPermissions.__schoolwideArchiveWrapped){
      const originalSave=window.saveTeacherPermissions;
      const wrappedSave=async function(...args){
        const name=String(document.getElementById("permTeacherName")?.textContent||"").trim();
        const teacher=(typeof db!=="undefined"&&Array.isArray(db.teachers))?db.teachers.find(item=>item.name===name):null;
        if(teacher){
          if(!teacher.permissions||typeof teacher.permissions!=="object")teacher.permissions={};
          teacher.permissions.schoolwideReserveArchive=document.getElementById("perm_p_schoolwideReserveArchive")?.checked===true;
        }
        return originalSave.apply(this,args);
      };
      wrappedSave.__schoolwideArchiveWrapped=true;wrappedSave.__original=originalSave;
      window.saveTeacherPermissions=wrappedSave;
    }
  })();

  // The schoolwide daily count is shown only to principals who can actually
  // read the consolidated archive; the ordinary dashboard cards stay intact.
  if(typeof window.refreshDashboardDailyMetrics==="function"&&!window.refreshDashboardDailyMetrics.__schoolwideArchiveVisibilityWrapped){
    const originalRefresh=window.refreshDashboardDailyMetrics;
    const wrappedRefresh=function(...args){
      const allowed=typeof activeUser!=="undefined"&&(
        activeUser?.type==="admin"||
        activeUser?.permissions?.admin===true||
        activeUser?.permissions?.reserve===true||
        activeUser?.permissions?.schoolwideReserveArchive===true
      );
      const metricCard=document.getElementById("dashReserveTeachersCount")?.closest(".p-4");
      if(metricCard)metricCard.classList.toggle("hidden",!allowed);
      return originalRefresh.apply(this,args);
    };
    wrappedRefresh.__schoolwideArchiveVisibilityWrapped=true;
    wrappedRefresh.__original=originalRefresh;
    window.refreshDashboardDailyMetrics=wrappedRefresh;
  }
  applyTeacherTimetablePresentation();
  if(typeof MutationObserver!=="undefined"){
    const substitutionView=$("substitutionView");
    if(substitutionView){
      const initializeHomeReserveView=()=>{
        if(substitutionView.classList.contains("hidden"))return;
        installMainSubstitutionViewIntegration();
      };
      const substitutionVisibilityObserver=new MutationObserver(initializeHomeReserveView);
      substitutionVisibilityObserver.observe(substitutionView,{attributes:true,attributeFilter:["class"]});
      const substitutionContentObserver=new MutationObserver(initializeHomeReserveView);
      // Observe only direct children of the home view. The canonical timetable
      // workspace is mounted inside this view; observing its entire subtree
      // re-runs the full installer for every lesson/list/status DOM update and
      // can lock the browser during reserve loading.
      substitutionContentObserver.observe(substitutionView,{childList:true});
      initializeHomeReserveView();
    }
    const timetableHost=$("teacherTimetableWeekGrid");
    if(timetableHost){
      const timetableObserver=new MutationObserver(()=>applyTeacherTimetablePresentation());
      timetableObserver.observe(timetableHost,{childList:true,subtree:true});
    }
  }
  
})();