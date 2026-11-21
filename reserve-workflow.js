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
  let reserveOtherDepartments = [];
  let reserveSelectedOtherTeacherNames = new Set();
  let reserveDraftRestoreChecked = false;
  let reserveArchive = [];
  let reserveHomeToday = [];
  let reserveHomeTodayLoadPromise = null;
  const DRAFT_STORAGE_KEY="abu-dujana-reserve-draft-v1";
  function currentActorName(){return String(appAuthSession?.principal?.name||"").trim();}
  function clearStoredDraft(){try{localStorage.removeItem(DRAFT_STORAGE_KEY);}catch{}}
  function persistStoredDraft(){
    try{
      const actor=currentActorName();if(!actor)return;
      const {date,weekday}=timetableSubstitutionGetDate();
      localStorage.setItem(DRAFT_STORAGE_KEY,JSON.stringify({actor,date,weekday,savedAt:Date.now(),
        absentTeachers:[...timetableDailyAbsentTeachers],manualChoices:reserveManualChoices,reasons:reserveReasons,absenceReasons:reserveAbsenceReasons,approvedAbsentTeachers:[...reserveDraftApproved],includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherTeacherNames:[...reserveSelectedOtherTeacherNames]}));
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
      reserveSelectedOtherTeacherNames=new Set(Array.isArray(saved.otherTeacherNames)?saved.otherTeacherNames.map(String):[]);
      if(otherDepartmentSelect&&saved.otherDepartmentId)otherDepartmentSelect.value=saved.otherDepartmentId;
      const otherButton=$("timetableDailyOtherDepartmentsButton");
      if(otherButton)otherButton.innerHTML=otherToggle?.checked
        ?'<i class="fa-solid fa-filter-circle-xmark ml-1"></i> إخفاء الأقسام الأخرى'
        :'<i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى';
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
    try { const value=timetableSubstitutionGetDate(); return [value.date,value.weekday,includeOthers()?"other:"+selectedOtherDepartmentId():"department"].join("|"); }
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
  const selectedOtherDepartmentId = () => String($("timetableDailyOtherDepartmentSelect")?.value||reserveOtherDepartmentId||"").trim();
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
  function renderOtherDepartmentTeachers() {
    const host=$("timetableDailyOtherTeacherChoices"), add=$("timetableDailyAddOtherTeachersButton");
    if(!host)return;
    const department=reserveOtherDepartments.find(item=>String(item.id)===selectedOtherDepartmentId());
    const teachers=Array.isArray(department?.teachers)?department.teachers:[];
    host.innerHTML=department ? (teachers.length ? teachers.map(teacher=>
      '<label class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-xs font-semibold"><input type="checkbox" class="h-4 w-4" data-other-teacher-name="'+esc(teacher.name)+'"'+(reserveSelectedOtherTeacherNames.has(String(teacher.name))?" checked":"")+'><span>'+esc(teacher.name)+'</span></label>'
    ).join("") : '<p class="text-xs text-slate-500">لا يوجد معلمون مؤهلون في هذا القسم ضمن الجدول النشط.</p>') : '<p class="text-xs text-slate-500">اختر القسم لعرض معلميه.</p>';
    if(add)add.disabled=!department||teachers.length===0;
  }
  async function loadOtherDepartments() {
    const token=appAuthSession?.token||readAppAuthToken();
    const result=await appAuthRequest({action:"timetable_substitution_departments"},token);
    const select=$("timetableDailyOtherDepartmentSelect");
    if(!select)return;
    reserveOtherDepartments=Array.isArray(result.departments)?result.departments:[];
    const current=reserveOtherDepartmentId||selectedOtherDepartmentId();
    select.innerHTML='<option value="">اختر المادة / القسم المساند</option>'+
      reserveOtherDepartments.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join("");
    if(current && reserveOtherDepartments.some(item=>item.id===current)){select.value=current;reserveOtherDepartmentId=current;}
    renderOtherDepartmentTeachers();
  }

  function reserveCurrentMuscatDate(){
    return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Muscat",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  }
  const ABSENCE_REASON_OPTIONS=["طارئة","مرضية","موعد مستشفى","دورة تدريبية","أخرى"];
  function openAbsenceReasonPicker(absentName,onConfirm){
    const old=document.getElementById("timetableDailyAbsenceReasonModal");if(old)old.remove();
    const current=String(reserveAbsenceReasons[absentName]||"");
    const selected=ABSENCE_REASON_OPTIONS.includes(current)?current:(current.startsWith("أخرى:")?"أخرى":"");
    const customValue=current.startsWith("أخرى:")?current.slice(5).trim():"";
    const modal=document.createElement("div");modal.id="timetableDailyAbsenceReasonModal";
    modal.className="fixed inset-0 z-[100000] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm";
    modal.innerHTML='<section class="w-full max-w-md space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl" dir="rtl">'+
      '<div><h3 class="text-base font-black text-slate-900">تحديد سبب غياب '+esc(absentName)+'</h3><p class="mt-1 text-xs text-slate-500">اختر سبب الغياب قبل إضافة المعلم إلى توزيع الاحتياط.</p></div>'+
      '<div class="grid gap-2">'+ABSENCE_REASON_OPTIONS.map(reason=>'<label class="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm font-bold text-slate-800"><input type="radio" name="ttAbsenceReasonChoice" value="'+esc(reason)+'" '+(selected===reason?"checked":"")+'><span>'+esc(reason)+'</span></label>').join("")+'</div>'+
      '<label id="ttAbsenceReasonOtherWrap" class="'+(selected==="أخرى"?"":"hidden")+' block text-xs font-bold text-slate-700">اكتب سبب الغياب<textarea id="ttAbsenceReasonOther" rows="2" maxlength="500" class="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm" placeholder="اكتب سبب الغياب بالتفصيل...">'+esc(customValue)+'</textarea></label>'+
      '<p id="ttAbsenceReasonError" class="hidden rounded-lg bg-rose-50 p-2 text-xs font-bold text-rose-700"></p>'+
      '<div class="flex justify-end gap-2"><button type="button" data-absence-reason-cancel class="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700">إلغاء</button><button type="button" data-absence-reason-confirm class="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-black text-white">موافق</button></div></section>';
    document.body.appendChild(modal);
    modal.querySelectorAll('input[name="ttAbsenceReasonChoice"]').forEach(radio=>radio.addEventListener("change",()=>{
      modal.querySelector("#ttAbsenceReasonOtherWrap")?.classList.toggle("hidden",radio.value!=="أخرى");
      if(radio.value==="أخرى")modal.querySelector("#ttAbsenceReasonOther")?.focus();
    }));
    modal.querySelector("[data-absence-reason-cancel]")?.addEventListener("click",()=>modal.remove());
    modal.addEventListener("click",event=>{if(event.target===modal)modal.remove();});
    modal.querySelector("[data-absence-reason-confirm]")?.addEventListener("click",()=>{
      const choice=modal.querySelector('input[name="ttAbsenceReasonChoice"]:checked')?.value||"";
      const custom=String(modal.querySelector("#ttAbsenceReasonOther")?.value||"").trim();
      const error=modal.querySelector("#ttAbsenceReasonError");
      if(!choice){error.textContent="اختر سبب الغياب أولاً.";error.classList.remove("hidden");return;}
      if(choice==="أخرى"&&!custom){error.textContent="اكتب سبب الغياب عند اختيار «أخرى».";error.classList.remove("hidden");modal.querySelector("#ttAbsenceReasonOther")?.focus();return;}
      const value=choice==="أخرى"?"أخرى: "+custom:choice;
      modal.remove();onConfirm(value);
    });
  }
  function reasonControlMarkup(absentName, absenceReason) {
    const value=String(absenceReason||"").trim();
    return '<div class="flex flex-wrap items-center gap-2 text-[10px] font-black text-slate-600"><span>سبب الغياب: '+esc(value||"لم يحدد")+'</span><button type="button" data-tt-edit-absence-reason="'+esc(absentName)+'" class="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-800">تغيير السبب</button></div>';
  }
  function installAbsenceReasonPicker(){
    const handlerNames=Object.getOwnPropertyNames(window).filter(name=>
      /^timetableDaily.*(?:Add|Select).*Absent/i.test(name)&&typeof window[name]==="function");
    if(typeof window.timetableDailyAddAbsent==="function"&&!handlerNames.includes("timetableDailyAddAbsent"))handlerNames.push("timetableDailyAddAbsent");
    let installed=false;
    handlerNames.forEach(handlerName=>{
      const original=window[handlerName];
      if(typeof original!=="function"||original.__reserveAbsenceReasonWrapped)return;
      const wrapped=function(...args){
        const absentName=args.map(value=>typeof value==="string"?value:String(value?.name||"").trim())
          .find(value=>value&&value.length<=160&&!timetableDailyAbsentTeachers.includes(value));
        if(!absentName)return original.apply(this,args);
        openAbsenceReasonPicker(absentName,value=>{
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
      toolbar.insertAdjacentHTML("beforeend", '<button type="button" id="timetableDailyOtherDepartmentsButton" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800"><i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى</button>');
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
            button.innerHTML='<i class="fa-solid fa-filter-circle-xmark ml-1"></i> إخفاء الأقسام الأخرى';
            if(!selectedOtherDepartmentId()){
              status("اختر القسم المساند أولاً؛ لن تظهر أسماء المعلمين قبل اختيار القسم.","info");
              $("timetableDailyOtherDepartmentSelect")?.focus();return;
            }
            await timetableDailyRefreshAll();
          }catch(error){
            toggle.checked=false;
            if(select){select.value="";select.closest("label")?.classList.add("hidden");}
            reserveOtherDepartmentId="";
            button.innerHTML='<i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى';
            status(error?.message||"تعذر تحميل الأقسام المساندة. حاول مرة أخرى.","error");
          }finally{button.disabled=false;}
          return;
        }
        toggle.checked=false;
        if(select){select.value="";select.closest("label")?.classList.add("hidden");}
        reserveOtherDepartmentId="";reserveSelectedOtherTeacherNames=new Set();reserveDraftScope="";
        button.innerHTML='<i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى';
        await timetableDailyRefreshAll();
      });
      const toolbarSelect='<div id="timetableDailyOtherDepartmentWrap" class="hidden min-w-[220px] text-[10px] font-bold text-slate-600"><label class="block"><span class="mb-1 block">القسم المساند</span><select id="timetableDailyOtherDepartmentSelect" class="w-full rounded-xl border border-indigo-200 bg-white p-2 text-xs"><option value="">اختر المادة / القسم المساند</option></select></label><section class="mt-2 rounded-xl border border-indigo-100 bg-indigo-50/70 p-3"><p class="mb-2 text-xs font-black text-slate-800">حدد المعلمين الذين ترغب في إضافتهم</p><div id="timetableDailyOtherTeacherChoices" class="grid max-h-52 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2"><p class="text-xs text-slate-500">اختر القسم لعرض معلميه.</p></div><button type="button" id="timetableDailyAddOtherTeachersButton" class="mt-3 w-full rounded-lg bg-indigo-700 px-3 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-50" disabled>إضافة المعلمين المحددين</button><p class="mt-2 text-[10px] text-slate-500">لن يُستخدم أي معلم قبل تحديده والضغط على زر الإضافة.</p></section></div>';
      $("timetableDailyOtherDepartmentsButton")?.insertAdjacentHTML("afterend",toolbarSelect);
      $("timetableDailyOtherDepartmentSelect")?.addEventListener("change",()=>{
        reserveOtherDepartmentId=selectedOtherDepartmentId();reserveSelectedOtherTeacherNames=new Set();reserveDraftScope="";reserveDraftApproved=new Set();
        reserveBatchPreview=null;reserveDraftAssignments=[];renderOtherDepartmentTeachers();window.timetableDailyRenderLessons();
        status("حدد المعلمين الذين تريد الاستعانة بهم من القسم المختار، ثم اضغط إضافة المعلمين المحددين.","info");
      });
      $("timetableDailyAddOtherTeachersButton")?.addEventListener("click",async()=>{
        const selected=[...document.querySelectorAll("#timetableDailyOtherTeacherChoices [data-other-teacher-name]:checked")].map(input=>String(input.dataset.otherTeacherName||"")).filter(Boolean);
        if(!selected.length){status("حدد معلماً واحداً على الأقل قبل الإضافة.","error");return;}
        reserveSelectedOtherTeacherNames=new Set(selected);reserveDraftScope="";reserveDraftApproved=new Set();
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
        '<div class="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h4 class="font-black text-sm text-slate-900 dark:text-white">سجل الاحتياط التراكمي</h4><p class="mt-1 text-[10px] text-slate-500">يعرض جميع توزيعات المدرسة من المواد كافة، مرتبة حسب التاريخ. كل يوم في صفحة مستقلة.</p></div></div>' +
        '<div class="grid gap-2 rounded-xl border border-indigo-100 bg-white p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"><label class="text-[10px] font-bold text-slate-600">من تاريخ<input id="timetableDailyArchiveFrom" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label><label class="text-[10px] font-bold text-slate-600">إلى تاريخ<input id="timetableDailyArchiveTo" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label><button type="button" id="timetableDailyArchiveReload" class="tt-action border border-slate-300 bg-white text-slate-800">عرض السجلات</button><button type="button" id="timetableDailyArchivePrint" class="tt-action bg-indigo-700 text-white"><i class="fa-solid fa-print ml-1"></i> طباعة كشف PDF</button></div><div id="timetableDailyArchiveResults" class="space-y-3"></div></section>');
      $("timetableDailyArchivePanel")?.insertAdjacentHTML("afterend",
        '<section id="timetableDailyActivePanel" class="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4"><div class="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h4 class="text-sm font-black text-emerald-950">التوزيعات الحالية — قابلة للتعديل والحذف خلال اليوم الحالي</h4><p class="mt-1 text-[10px] text-emerald-800">تُحمّل سجلات اليوم تلقائياً بعد التحقق من صلاحية الدخول. ويمكنك تحديثها يدوياً في أي وقت.</p></div><div class="flex items-center gap-2"><span id="timetableDailyActiveCount" class="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-900">0</span><button type="button" id="timetableDailyActiveReload" class="tt-action border border-emerald-300 bg-white text-emerald-900">تحديث سجلات اليوم</button></div></div><div id="timetableDailyActiveResults" class="space-y-2"><p class="text-center text-xs text-slate-500">جارٍ انتظار التحقق من صلاحية الدخول لتحميل سجلات اليوم.</p></div></section>');
      $("timetableDailyArchiveReload")?.addEventListener("click", timetableDailyLoadArchive);
      $("timetableDailyArchivePrint")?.addEventListener("click", timetableDailyPrintArchiveRange);
      $("timetableDailyActiveReload")?.addEventListener("click", timetableDailyLoadArchive);
      try{const today=timetableSubstitutionGetDate().date;$("timetableDailyArchiveFrom").value=today;$("timetableDailyArchiveTo").value=today;}catch{}
    }
    const style = document.createElement("style");
    style.id = "reserve-workflow-styles";
    style.textContent = [
      "#timetableSubstitutionPanel{isolation:isolate}",
      "#timetableSubstitutionPanel .tt-reserve-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.55rem;margin:.2rem 0}",
      "#timetableSubstitutionPanel .tt-reserve-steps button{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;align-items:center;column-gap:.55rem;text-align:right;padding:.7rem;border:1px solid #dbe4ed;border-radius:1rem;background:#f8fafc;min-width:0}",
      "#timetableSubstitutionPanel .tt-reserve-steps button span{grid-row:1/3;display:grid;place-items:center;width:2rem;height:2rem;border-radius:.7rem;background:#d1fae5;color:#065f46;font-weight:900}",
      "#timetableSubstitutionPanel .tt-reserve-steps button strong{font-size:.72rem;color:#0f172a}",
      "#timetableSubstitutionPanel .tt-reserve-steps button small{font-size:.58rem;color:#64748b}",
      "@media(max-width:520px){#timetableSubstitutionPanel .tt-reserve-steps{grid-template-columns:1fr}#timetableSubstitutionPanel .tt-reserve-steps button{grid-template-columns:2rem 1fr;grid-template-rows:auto auto}}",
      "#timetableSubstitutionPanel .tt-lesson{border-color:#dbe4ed;background:linear-gradient(135deg,#fff,#f8fafc);box-shadow:0 5px 18px rgba(15,23,42,.045);border-radius:1rem}",
      "#timetableSubstitutionPanel .tt-lesson:focus-within{border-color:#60a5fa;box-shadow:0 0 0 3px rgba(59,130,246,.1)}",
      "#timetableSubstitutionPanel .tt-lesson-choice{min-width:0}",
      "#timetableSubstitutionPanel .tt-lesson-choice select{display:block;width:100%;min-width:0;max-width:100%;border:1px solid #cbd5e1;border-radius:.8rem;background:#fff;padding:.7rem;font-size:16px;line-height:1.4}",
      "#timetableSubstitutionPanel .tt-lesson{min-width:0}",
      "@media(max-width:640px){#timetableSubstitutionPanel .tt-lesson{display:grid;grid-template-columns:minmax(0,1fr);gap:.65rem;padding:.85rem}#timetableSubstitutionPanel .tt-lesson-actions{display:flex;flex-wrap:wrap;gap:.4rem}#timetableSubstitutionPanel .tt-group-head{padding:.85rem}}",
      "#timetableSubstitutionPanel .tt-group{overflow:hidden;border:1px solid #dbe4ed;border-radius:1.25rem;background:#fff;box-shadow:0 8px 24px rgba(15,23,42,.04)}",
      "#timetableSubstitutionPanel .tt-group-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem;padding:1rem 1.1rem;background:linear-gradient(90deg,#f8fafc,#ecfdf5)}",
      "#timetableSubstitutionPanel .tt-reason{width:100%;min-height:2.6rem;border:1px solid #cbd5e1;border-radius:.8rem;padding:.7rem;background:#fff;color:#0f172a;font-size:.75rem}",
      "#timetableDailySummary .tt-stat{border:1px solid #e2e8f0;border-radius:1rem;background:#f8fafc;padding:.8rem}",
      "#timetableDailySummary .tt-stat strong{display:block;font-size:1.25rem;font-weight:900;color:#0f172a}",
      "#timetableDailyArchiveResults .tt-archive-row{display:grid;grid-template-columns:1fr auto;gap:.75rem;align-items:center;border:1px solid #e2e8f0;border-radius:.9rem;background:#fff;padding:.8rem}",
      "#timetableDailyArchiveResults .tt-archive-row small{color:#64748b}",
      "@media(max-width:768px){#timetableSubstitutionPanel .tt-group-head{align-items:stretch}#timetableDailyArchiveResults .tt-archive-row{grid-template-columns:1fr}}",
      "@media print{body.tt-reserve-print-mode *{visibility:hidden!important}body.tt-reserve-print-mode #sec-timetable,body.tt-reserve-print-mode #sec-timetable *{visibility:hidden!important}body.tt-reserve-print-mode #ttReservePrintRoot,body.tt-reserve-print-mode #ttReservePrintRoot *{visibility:visible!important}body.tt-reserve-print-mode #ttReservePrintRoot{display:block!important;position:absolute!important;inset:0!important;width:100%!important;margin:0!important;padding:0!important;background:#fff!important;color:#111!important}@page{size:A4 portrait;margin:10mm}#ttReservePrintRoot{direction:rtl;font-family:'Tajawal',Arial,sans-serif;color:#111;background:#fff}#ttReservePrintRoot .tt-print-header{text-align:center;font-size:10pt;font-weight:800;line-height:1.55;margin-bottom:7mm}#ttReservePrintRoot .tt-print-meta{display:flex;justify-content:space-between;gap:8mm;margin:5mm 0;font-weight:800;font-size:10pt}#ttReservePrintRoot table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:9.5pt}#ttReservePrintRoot th,#ttReservePrintRoot td{border:1px solid #333;padding:2.5mm 2mm;text-align:center;vertical-align:middle;overflow-wrap:anywhere}#ttReservePrintRoot th{background:#eef1f4!important;font-weight:900;-webkit-print-color-adjust:exact;print-color-adjust:exact}#ttReservePrintRoot tr{break-inside:avoid;page-break-inside:avoid}#ttReservePrintRoot .tt-print-footer{margin-top:9mm;display:flex;justify-content:space-between;font-size:9pt;font-weight:800}}"
    ].join("\n");
    document.head.appendChild(style);
    updateBatchSaveVisibility();
  }

  async function fetchBatchPreview() {
    if(includeOthers()&&!selectedOtherDepartmentId())throw new Error("اختر القسم المساند أولاً قبل تحميل أسماء المعلمين.");
    if(includeOthers()&&!reserveSelectedOtherTeacherNames.size)throw new Error("حدد معلماً واحداً على الأقل من القسم المساند واضغط إضافة المعلمين المحددين.");
    const {date, weekday} = timetableSubstitutionGetDate();
    const token = appAuthSession?.token || readAppAuthToken();
    if (!token) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({
      action: "timetable_substitution_batch_preview", weekday, assignmentDate: date,
      absentTeacherNames: [...timetableDailyAbsentTeachers], includeOtherDepartments: includeOthers(), otherDepartmentId:selectedOtherDepartmentId(), otherTeacherNames:[...reserveSelectedOtherTeacherNames]
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
    if(appAuthSession?.principal?.type==="admin")installAdminReserveTools();
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
    ].map(([label,value,icon]) => '<div class="tt-stat"><span class="text-[10px] font-bold text-slate-500"><i class="fa-solid ' + icon + ' ml-1"></i>' + label + '</span><strong>' + Number(value) + "</strong></div>").join("");
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
        const date=timetableSubstitutionGetDate().date;
        const editable=date===reserveCurrentMuscatDate()&&savedRows.length>0&&savedRows.every(item=>item.canEdit!==false&&["assigned","confirmed"].includes(item.status));
        const savedReason=String(savedRows.find(item=>item.absenceReason&&item.absenceReason!=="-")?.absenceReason||reserveAbsenceReasons[absentName]||"");
        const actions=editable?'<div class="mt-3 flex flex-wrap gap-2"><button type="button" data-tt-edit-saved-group="'+esc(absentName)+'" data-tt-saved-date="'+esc(date)+'" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800">تعديل التوزيع</button><button type="button" data-tt-delete-saved-group="'+esc(absentName)+'" data-tt-saved-date="'+esc(date)+'" class="tt-action border border-rose-200 bg-rose-50 text-rose-700">حذف الغياب والاحتياط بالكامل</button></div>':'<span class="mt-2 block text-[10px] text-slate-500">التوزيع مكتمل أو غير قابل للتعديل.</span>';
        return '<section class="tt-group border border-emerald-200 bg-emerald-50 p-3"><div class="flex flex-wrap items-center justify-between gap-2"><div><div class="text-[10px] font-black text-emerald-700">تم حفظ التوزيع</div><strong class="text-xs text-slate-900">'+esc(absentName)+'</strong><div class="text-[10px] text-emerald-700">'+savedRows.length+' حصص محفوظة</div><div class="mt-1 text-[10px] text-amber-800">سبب الغياب: '+esc(savedReason||"—")+'</div></div>'+actions+'</div></section>';
      }
      const savedAbsenceReason=saved.find(item=>item.absentTeacherName===absentName&&item.absenceReason&&item.absenceReason!=="-")?.absenceReason||"";
      if(reserveAbsenceReasons[absentName]===undefined&&savedAbsenceReason)reserveAbsenceReasons[absentName]=savedAbsenceReason;
      const absenceReason=reserveAbsenceReasons[absentName]??savedAbsenceReason;
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
          action=item.assignmentDate===reserveCurrentMuscatDate()&&["assigned","confirmed"].includes(item.status)&&item.canEdit!==false&&item.id?'<div class="flex flex-wrap gap-1"><button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-edit="'+esc(item.id)+'">تعديل</button><button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-delete="'+esc(item.id)+'">إلغاء</button></div>':(item.canEdit===false?'<span class="text-[10px] text-slate-400">إصدار سابق · للعرض فقط</span>':'<span class="text-[10px] text-slate-400">'+state+'</span>');
        } else {
          const candidates=item.candidateOptions||[];
          const options=candidates.map(candidate=>{const occupied=(Array.isArray(candidate.occupiedPeriods)?candidate.occupiedPeriods:[]).map(Number).filter(period=>Number.isInteger(period)&&period>0).sort((a,b)=>a-b);const periodText=occupied.length?occupied.map(period=>new Intl.NumberFormat("ar").format(period)).join("، "):"—";return '<option value="'+esc(candidate.teacherName)+'" '+(draft?.substituteTeacherName===candidate.teacherName?"selected":"")+'>'+esc(candidate.teacherName)+' · الحصص '+periodText+'</option>';}).join("");
          choice=candidates.length?'<label class="block"><span class="mb-1 block text-[10px] font-bold text-slate-500">أفضل البدلاء المتاحين لهذه الحصة، مرتبين حسب الملاءمة</span><select data-tt-substitute data-absent="'+esc(absentName)+'" data-period="'+Number(item.period)+'"><option value="">اختر البديل</option>'+options+'</select></label>':(item.blockReason==="daily_limit"?'<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">يوجد '+Number(item.blockedCandidateCount||0)+' من المعلمين لديهم فراغ مؤكد، لكنهم بلغوا الحد الأعلى المسموح: حصتان احتياط في اليوم. لم يتجاوز النظام هذا الحد حفاظاً على العدالة.</div>':item.blockReason==="period_capacity"?'<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">المعلمون المتاحون لهذه الفترة خُصصوا لتغطية حصص غياب أخرى في الفترة نفسها؛ لا يمكن تكليف المعلم بحصتين متزامنتين.</div>':'<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">لا يوجد معلم متاح بفراغ مؤكد لهذه الحصة.</div>');
          if(draft?.createsThreeConsecutive||item.createsThreeConsecutive)choice+='<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-[10px] font-bold text-amber-800">تنبيه: هذا الاختيار يكوّن ثلاث حصص متتالية أو أكثر.</div>';
          action='<span class="text-[10px] text-slate-500">'+(draft?"مقترح قابل للتعديل":"لا يوجد اقتراح")+"</span>";
        }
        return '<article class="tt-lesson"><div class="tt-lesson-main"><div class="text-[10px] font-bold text-slate-500">الحصة '+Number(item.period)+'</div><strong class="mt-1 block text-xs text-slate-900">'+esc(item.className||"الشعبة غير محددة")+'</strong><div class="mt-1 text-[10px] text-slate-500">'+esc(item.subject||"المادة غير محددة")+'</div></div><div class="tt-lesson-choice">'+choice+(item.kind!=="saved"?reserveDutyReasonMarkup(absentName,item.period,dutyReason):"")+'</div><div class="tt-lesson-actions">'+action+"</div></article>";
      }).join("");
      const approvalControl=pendingRows.length
        ? '<div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 p-3"><span class="text-[10px] font-bold '+(approved?'text-emerald-700':'text-slate-500')+'">'+(approved?'تم اعتماد توزيع هذا المعلم ضمن مسودة اليوم':'راجع الحصص والبدلاء ثم اعتمد هذا المعلم')+'</span><button type="button" data-tt-approve="'+esc(absentName)+'" class="tt-action '+(approved?'border border-emerald-300 bg-emerald-50 text-emerald-800':'bg-indigo-700 text-white')+'">'+(approved?'إلغاء الاعتماد للمراجعة':'اعتماد توزيع هذا المعلم')+'</button></div>'
        : '<div class="border-t border-slate-200 bg-emerald-50 p-3 text-[10px] font-bold text-emerald-700">لا توجد تكليفات جديدة لهذا المعلم؛ الحصص الظاهرة محفوظة مسبقاً.</div>';
      return '<section class="tt-group"><div class="tt-group-head"><div><div class="text-[10px] font-black text-emerald-700">المعلم الغائب</div><h4 class="mt-1 text-sm font-black text-slate-900">'+esc(absentName)+'</h4><div class="mt-1 text-[10px] text-slate-500">'+rows.length+' حصة · '+rows.filter(x=>x.kind==="saved").length+' محفوظة · '+rows.filter(x=>x.kind==="planned").length+' مقترحة</div></div>'+reasonControlMarkup(absentName,absenceReason)+'</div><div class="space-y-2 p-3 sm:p-4">'+cards+'</div>'+approvalControl+'</section>';
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
      openAbsenceReasonPicker(absentName,value=>{reserveAbsenceReasons[absentName]=value;persistStoredDraft();window.timetableDailyRenderLessons();});
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
        absentTeacherNames:[...timetableDailyAbsentTeachers],assignments,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherTeacherNames:[...reserveSelectedOtherTeacherNames]},token);
      status("تم حفظ "+(result.assignmentCount||assignments.length)+" تكليف في عملية واحدة. يجري تحديث الأرشيف.","success");
      reserveManualChoices=Object.create(null);
      reserveDraftApproved=new Set();
      await timetableDailyRefreshAll();await timetableDailyLoadArchive();
      clearStoredDraft();
      // If the logged-in coordinator assigned a reserve lesson to themselves, show the daily notice immediately.
      if(typeof window.teacherShowDailySubstitutionWelcome==="function") await window.teacherShowDailySubstitutionWelcome();
    }catch(error){status(error?.message||"تعذر حفظ التوزيع الجماعي. لم يتم حفظ جزء من العملية.","error");}
    finally{timetableDailyBusy=false;timetableDailySetBusy(false);}
  };

  window.timetableDailyToggleArchive = async function () {
    const panel=$("timetableDailyArchivePanel");if(!panel)return;
    const opening=panel.classList.contains("hidden");panel.classList.toggle("hidden");if(opening)await timetableDailyLoadArchive();
  };
  window.timetableDailyLoadArchive = async function () {
    const host=$("timetableDailyArchiveResults");if(!host)return false;
    host.innerHTML='<div class="p-4 text-center text-xs text-slate-500">جارٍ تحميل الأرشيف...</div>';
    const activeHost=$("timetableDailyActiveResults");
    if(activeHost)activeHost.innerHTML='<p class="text-center text-xs text-slate-500">جارٍ تحميل سجلات اليوم...</p>';
    try{
      const from=$("timetableDailyArchiveFrom")?.value||"",to=$("timetableDailyArchiveTo")?.value||"",token=appAuthSession?.token||readAppAuthToken();
      if(!token)throw new Error("سجّل الدخول أولاً لعرض التوزيعات الحالية.");
      if(!from||!to){throw new Error("حدد تاريخ البداية وتاريخ النهاية.");}
      if(from>to){throw new Error("تاريخ البداية يجب أن يسبق تاريخ النهاية أو يساويه.");}
      const response=await appAuthRequest({action:"timetable_substitution_archive",dateFrom:from,dateTo:to},token);
      reserveArchive=response.archive||[];timetableDailyRenderArchive();return true;
    }catch(error){
      const message=error?.message||"تعذر تحميل الأرشيف.";
      host.innerHTML='<div class="rounded-xl bg-red-50 p-3 text-xs text-red-700">'+esc(message)+"</div>";
      if(activeHost)activeHost.innerHTML='<div class="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">'+esc(message)+'</div>';
      return false;
    }
  };
  window.timetableDailyPrintArchiveRange = function () {
    const records=(reserveArchive||[]).filter(item=>item.status!=="cancelled"&&item.assignmentDate);
    if(!records.length){status("لا توجد سجلات احتياط غير ملغاة للطباعة في الفترة المحددة.","error");return;}
    const grouped=new Map();
    records.forEach(item=>{
      const date=String(item.assignmentDate);
      if(!grouped.has(date))grouped.set(date,[]);
      grouped.get(date).push(item);
    });
    // Preserve the original approved official A4 PDF template; only reverse
    // the date order so the newest distribution appears first.
    const days=[...grouped.entries()].sort((a,b)=>b[0].localeCompare(a[0]));
    const pages=days.flatMap(([date,items])=>{
      const byAbsent=new Map();
      items.forEach(item=>{
        const name=String(item.absentTeacherName||"");
        if(!byAbsent.has(name)){
          const rawAbsenceReason=String(item.absenceReason||"").trim();
          const rawReserveReason=String(item.reason||"").trim();
          byAbsent.set(name,{
            absentName:name,
            absenceReason:rawAbsenceReason==="-"||rawAbsenceReason==="—"?"":rawAbsenceReason,
            reserveReason:rawReserveReason==="-"||rawReserveReason==="—"?"":rawReserveReason,
            rows:[]
          });
        }
        byAbsent.get(name).rows.push({
          period:item.period,
          className:item.className,
          substitute:item.substituteTeacherName||"",
          reserveReason:String(item.reason||"")
        });
      });
      return reserveOfficialPrintPages([...byAbsent.values()],date,items[0]?.weekday||"");
    });
    printOfficialReservePages(pages);
  };

  async function fetchArchivePreview(absentName, date, weekday) {
    const token=appAuthSession?.token||readAppAuthToken();
    if(!token)throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({action:"timetable_substitution_preview",weekday,assignmentDate:date,
      absentTeacherName:absentName,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherTeacherNames:[...reserveSelectedOtherTeacherNames]},token);
  }

  window.timetableDailyRenderArchive = function () {
    const host=$("timetableDailyArchiveResults");if(!host)return;
    const activeRecords=(reserveArchive||[]).filter(item=>item.canEdit!==false&&["assigned","confirmed"].includes(item.status));
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
    const activeTotal=reserveArchive.filter(item=>item.canEdit!==false&&["assigned","confirmed"].includes(item.status)).length;
    const archivedTotal=reserveArchive.length-activeTotal;
    host.innerHTML='<div class="mb-3 grid gap-2 sm:grid-cols-2">'+
      '<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><strong class="block text-xs text-emerald-900">توزيعات نشطة قابلة للتعديل والحذف</strong><span class="text-[10px] text-emerald-800">'+activeTotal+' تكليف متاح تعديلها وحذفها حتى نهاية اليوم بتوقيت سلطنة عمان</span></div>'+
      '<div class="rounded-xl border border-slate-200 bg-slate-50 p-3"><strong class="block text-xs text-slate-800">السجل التاريخي للقراءة والطباعة</strong><span class="text-[10px] text-slate-600">'+archivedTotal+' تكليف محفوظ في الأرشيف</span></div></div>'+
      Array.from(grouped.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([date,items])=>{
        const byAbsent=new Map();
        items.forEach(item=>{const name=String(item.absentTeacherName||"غير محدد");if(!byAbsent.has(name))byAbsent.set(name,[]);byAbsent.get(name).push(item);});
        const editableItems=items.filter(item=>item.canEdit!==false&&["assigned","confirmed"].includes(item.status));
        const dayButton=editableItems.length?'<button type="button" class="tt-action bg-indigo-700 text-white" data-tt-open-day-edit="'+esc(date)+'">تعديل توزيع اليوم ('+editableItems.length+')</button>':"";
        const absentGroups=Array.from(byAbsent.entries()).sort((a,b)=>a[0].localeCompare(b[0],"ar")).map(([absentName,rows])=>{
          rows.sort((a,b)=>Number(a.period)-Number(b.period));
          const activeRows=rows.filter(item=>["assigned","confirmed"].includes(item.status));
          const canDeleteGroup=activeRows.length>0&&activeRows.every(item=>item.canEdit!==false);
          const groupDelete=canDeleteGroup?
            '<button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-delete-group-date="'+esc(date)+'" data-tt-delete-group-absent="'+esc(absentName)+'">حذف التوزيع بالكامل ('+activeRows.length+')</button>':"";
          const rowsMarkup=rows.map(item=>{
            const state=item.status==="cancelled"?"ملغى":item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":"محفوظ";
            const editable=item.canEdit!==false&&["assigned","confirmed"].includes(item.status);
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

  window.timetableDailyOpenArchiveDayEdit = async function(date,absentTeacherName) {
    const items=reserveArchive.filter(item=>item.assignmentDate===date&&(!absentTeacherName||item.absentTeacherName===absentTeacherName)&&item.canEdit!==false&&["assigned","confirmed"].includes(item.status));
    if(!items.length){status("لا توجد تكليفات قابلة للتعديل لهذا التاريخ في إصدار الجدول النشط.","error");return;}
    try{
      const absentNames=[...new Set(items.map(item=>item.absentTeacherName))],weekday=items[0].weekday;
      const previews=await Promise.all(absentNames.map(async name=>[name,await fetchArchivePreview(name,date,weekday)]));
      const previewByAbsent=new Map(previews);
      const modal=document.createElement("div");modal.id="timetableDailyArchiveDayEditModal";
      modal.className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm";
      const rows=items.sort((a,b)=>Number(a.period)-Number(b.period)).map(item=>{
        const preview=previewByAbsent.get(item.absentTeacherName);
        const lesson=(preview?.lessons||[]).find(row=>Number(row.period)===Number(item.period));
        const candidates=lesson?.candidates||[];
        const options=candidates.filter(candidate=>candidate.name!==item.substituteTeacherName)
          .map(candidate=>{const occupied=(Array.isArray(candidate.occupiedPeriods)?candidate.occupiedPeriods:[]).map(Number).filter(period=>Number.isInteger(period)&&period>0).sort((a,b)=>a-b);const periodText=occupied.length?occupied.map(period=>new Intl.NumberFormat("ar").format(period)).join("، "):"—";return '<option value="'+esc(candidate.name)+'">'+esc(candidate.name)+' · الحصص '+periodText+'</option>';}).join("");
        return '<div class="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-4" data-archive-day-row="'+esc(item.id)+'">'+
          '<div><div class="text-[10px] font-black text-slate-500">'+esc(item.absentTeacherName)+'</div><div class="mt-1 text-xs font-black text-slate-900">الحصة '+Number(item.period)+' · '+esc(item.className||"-")+'</div><div class="text-[10px] text-slate-500">'+esc(item.subject||"")+'</div></div>'+
          '<label class="text-[10px] font-black text-slate-600">المعلم البديل<select data-batch-sub-id="'+esc(item.id)+'" data-original-sub="'+esc(item.substituteTeacherName)+'" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs"><option value="'+esc(item.substituteTeacherName)+'" selected>'+esc(item.substituteTeacherName)+' (الحالي)</option>'+options+'</select></label>'+
          '<label class="text-[10px] font-black text-slate-600">سبب الغياب<textarea data-batch-absence-reason="'+esc(item.id)+'" data-batch-absence-group="'+esc(item.absentTeacherName)+'" data-original-absence-reason="'+esc(item.absenceReason||"-")+'" rows="1" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs" placeholder="إجازة مرضية، مهمة رسمية...">'+esc(item.absenceReason==="-"?"":item.absenceReason||"")+'</textarea></label>'+
          '<label class="text-[10px] font-black text-slate-600">سبب الاحتياط<textarea data-batch-reason="'+esc(item.id)+'" data-original-reason="'+esc(item.reason||"-")+'" rows="1" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs" placeholder="تكليف تغطية الحصة...">'+esc(item.reason==="-"?"":item.reason||"")+'</textarea></label></div>';
      }).join("");
      modal.innerHTML='<div class="max-h-[90vh] w-full max-w-5xl space-y-4 overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl"><div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-black text-base text-slate-900">مراجعة وتعديل توزيع اليوم بالكامل</h3><p class="mt-1 text-[10px] text-slate-500">التاريخ: '+esc(date)+' · '+items.length+' تكليف · التغييرات تحفظ في عملية واحدة.</p></div><button type="button" data-close-day-edit class="rounded-xl bg-slate-100 px-3 py-2">×</button></div><div class="space-y-2">'+rows+'</div><div id="ttArchiveDayEditError" class="hidden rounded-xl bg-red-50 p-3 text-xs text-red-700"></div><div class="flex justify-end gap-2"><button type="button" data-close-day-edit class="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold">إلغاء</button><button type="button" id="ttArchiveDayEditSave" class="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-black text-white">حفظ تعديلات اليوم</button></div></div>';
      document.body.appendChild(modal);
      modal.querySelectorAll("[data-close-day-edit]").forEach(button=>button.addEventListener("click",()=>modal.remove()));
      modal.querySelectorAll("[data-batch-absence-reason]").forEach(input=>input.addEventListener("input",()=>{
        const group=input.dataset.batchAbsenceGroup;
        modal.querySelectorAll("[data-batch-absence-reason]").forEach(other=>{
          if(other.dataset.batchAbsenceGroup===group)other.value=input.value;
        });
      }));
      modal.querySelector("#ttArchiveDayEditSave").addEventListener("click",async()=>{
        const button=modal.querySelector("#ttArchiveDayEditSave"),errorBox=modal.querySelector("#ttArchiveDayEditError");
        const changes=[];
        modal.querySelectorAll("[data-batch-sub-id]").forEach(select=>{
          const id=select.dataset.batchSubId,reasonInput=modal.querySelector('[data-batch-reason="'+id+'"]'),absenceInput=modal.querySelector('[data-batch-absence-reason="'+id+'"]');
          const reason=(reasonInput?.value||"").trim()||"-",absenceReason=(absenceInput?.value||"").trim()||"-";
          if(select.value!==select.dataset.originalSub||reason!==(reasonInput?.dataset.originalReason||"-")||absenceReason!==(absenceInput?.dataset.originalAbsenceReason||"-")){
            changes.push({assignmentId:id,substituteTeacherName:select.value,reserveReason:reason,absenceReason});
          }
        });
        if(!changes.length){modal.remove();status("لم تغيّر أي بيانات في توزيع هذا اليوم.","info");return;}
        button.disabled=true;button.textContent="جارٍ حفظ جميع التعديلات...";
        try{
          const token=appAuthSession?.token||readAppAuthToken();
          await appAuthRequest({action:"timetable_substitution_update_batch",assignments:changes,
            includeOtherDepartments:includeOthers()},token);
          modal.remove();status("تم حفظ "+changes.length+" تعديل في عملية واحدة، مع الاحتفاظ بالسجلات السابقة في سجل المراجعة.","success");
          await timetableDailyLoadArchive();await timetableDailyRefreshAll();
          if(typeof window.substitutionLoadStats==="function")await window.substitutionLoadStats();
        }catch(error){errorBox.textContent=error?.message||"تعذر حفظ تعديلات اليوم؛ لم يتم اعتماد أي تعديل جزئي.";errorBox.classList.remove("hidden");button.disabled=false;button.textContent="حفظ تعديلات اليوم";}
      });
    }catch(error){status(error?.message||"تعذر فتح توزيع اليوم للتعديل.","error");}
  };


  window.timetableDailyCancelAssignment = async function (assignmentId) {
    const item=reserveHomeToday.find(row=>row.id===assignmentId)||reserveArchive.find(row=>row.id===assignmentId)||(reserveBatchPreview?.existingAssignments||[]).find(row=>row.id===assignmentId);
    if(!item){status("تعذر العثور على التكليف. حدّث القائمة ثم حاول مجدداً.","error");return;}
    if(item.canEdit===false||!["assigned","confirmed"].includes(item.status)){status("لا يمكن حذف هذا التكليف إلا خلال يومه، أو لأنه مكتمل أو مرتبط بإصدار جدول سابق.","error");return;}
    if(!window.confirm("سيتم حذف هذا التكليف من التوزيع النشط، مع الاحتفاظ بسجل المراجعة. هل تريد المتابعة؟"))return;
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      await appAuthRequest({action:"timetable_substitution_cancel",assignmentId,weekday:item.weekday,assignmentDate:item.assignmentDate},token);
      status("تم حذف التكليف من التوزيع النشط، مع الاحتفاظ بسجل المراجعة.","success");
      await timetableDailyRefreshAll();
      if(!$("timetableDailyArchivePanel")?.classList.contains("hidden"))await timetableDailyLoadArchive();
      if(typeof window.substitutionLoadStats==="function")await window.substitutionLoadStats();
    }catch(error){status(error?.message||"تعذر إلغاء التكليف؛ لم يُحذف أي سجل.","error");}
  };

  window.timetableDailyCancelAbsentDistribution = async function(date,absentTeacherName) {
    const source=[...(reserveArchive||[]),...(reserveHomeToday||[]),...(reserveBatchPreview?.existingAssignments||[])];
    const items=source.filter(item=>item.assignmentDate===date&&item.absentTeacherName===absentTeacherName&&
      item.canEdit!==false&&["assigned","confirmed"].includes(item.status))
      .filter((item,index,all)=>all.findIndex(row=>row.id===item.id)===index);
    if(!items.length){status("لا توجد حصص نشطة قابلة للحذف لهذا المعلم في هذا التاريخ.","error");return;}
    if(!window.confirm("سيتم حذف توزيع المعلم الغائب بالكامل في "+date+" ("+items.length+" حصص)، مع الاحتفاظ بجميع سجلات المراجعة. هل تريد المتابعة؟"))return;
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      const assignmentIds=items.map(item=>item.id);
      await appAuthRequest({action:"timetable_substitution_cancel_batch",assignmentIds,absentTeacherName,assignmentDate:date,weekday:items[0].weekday},token);
      if(date===timetableSubstitutionGetDate().date&&timetableDailyAbsentTeachers.includes(absentTeacherName)){
        timetableDailyAbsentTeachers=timetableDailyAbsentTeachers.filter(name=>name!==absentTeacherName);
        delete reserveAbsenceReasons[absentTeacherName];
        reserveDraftApproved.delete(absentTeacherName);
        timetableDailyRenderTags();
      }
      status("تم حذف غياب المعلم وتوزيع حصصه بالكامل، وعكس جميع نقاطه المرتبطة مع الاحتفاظ بسجل المراجعة.","success");
      await timetableDailyRefreshAll();
      if(!$("timetableDailyArchivePanel")?.classList.contains("hidden"))await timetableDailyLoadArchive();
      if(typeof window.substitutionLoadStats==="function")await window.substitutionLoadStats();
    }catch(error){status(error?.message||"تعذر حذف التوزيع بالكامل؛ لم يتم اعتماد حذف جزئي.","error");}
  };


  window.timetableDailyOpenArchiveEdit = async function (assignmentId) {
    const item=reserveHomeToday.find(row=>row.id===assignmentId)||reserveArchive.find(row=>row.id===assignmentId)||(reserveBatchPreview?.existingAssignments||[]).find(row=>row.id===assignmentId);
    if(!item){status("تعذر العثور على التكليف. حدّث قائمة الاحتياط ثم حاول مجدداً.","error");return;}
    if(item.canEdit===false||!["assigned","confirmed"].includes(item.status)){
      status("يمكن تعديل أو حذف التكليفات النشطة في يومها فقط، وحتى نهاية اليوم بتوقيت سلطنة عمان.","error");return;
    }
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      const directoryResult=await appAuthRequest({action:"timetable_substitution_preview",weekday:item.weekday,assignmentDate:item.assignmentDate,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId(),otherTeacherNames:[...reserveSelectedOtherTeacherNames]},token);
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
  function formatReservePrintPeriod(period){return ({1:"١",2:"٢",3:"٣",4:"٤",5:"٥",6:"٦",7:"٧",8:"٨"})[Number(period)]||String(period);}
  function formatReservePrintFullDate(dateValue){
    const match=String(dateValue||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? Number(match[3])+" / "+Number(match[2])+" / "+match[1]+" م" : formatReserveDateArabic(dateValue);
  }
  const RESERVE_OFFICIAL_ROWS_PER_PAGE = 22;
  function reserveOfficialPrintPages(groups,date,weekday,subject){
    const pages=[];let current=[],count=0;
    (groups||[]).forEach(group=>{
      const rows=(group.rows||[]).slice().sort((a,b)=>Number(a.period)-Number(b.period));
      if(!rows.length)return;
      if(rows.length>RESERVE_OFFICIAL_ROWS_PER_PAGE){if(count){pages.push(current);current=[];count=0;}for(let i=0;i<rows.length;i+=RESERVE_OFFICIAL_ROWS_PER_PAGE)pages.push([{...group,rows:rows.slice(i,i+RESERVE_OFFICIAL_ROWS_PER_PAGE)}]);return;}
      if(count+rows.length>RESERVE_OFFICIAL_ROWS_PER_PAGE){pages.push(current);current=[];count=0;}
      current.push({...group,rows});count+=rows.length;
    });
    if(current.length)pages.push(current);if(!pages.length)pages.push([]);
    return pages.map(pageGroups=>reserveOfficialPrintMarkup(pageGroups,date,weekday,subject));
  }
  function reserveOfficialPrintMarkup(groups,date,weekday,subject){
    const widths=[20,16,10.5,10.5,13,11,19];
    const columns='<colgroup>'+widths.map(width=>'<col style="width:'+width+'%">').join('')+'</colgroup>';
    const header='<thead><tr><th>المعلم الغائب</th><th>سبب الغياب</th><th>الحصة</th><th>الصف</th><th>معلم الاحتياط</th><th>التوقيع</th><th>الملاحظات</th></tr></thead>';
    let used=0;
    const rowsMarkup=(groups||[]).map(group=>{
      const rows=(group.rows||[]).slice().sort((a,b)=>Number(a.period)-Number(b.period));if(!rows.length)return "";used+=rows.length;
      const absent=esc(group.absentName||""),rawAbsenceReason=String(group.absenceReason||"").trim(),absenceReason=esc(rawAbsenceReason==="-"||rawAbsenceReason==="—"?"":rawAbsenceReason);
      return rows.map((row,rowIndex)=>{
        const merged=rowIndex===0?'<td class="tt-official-merged tt-official-absent" rowspan="'+rows.length+'">'+absent+'</td><td class="tt-official-merged tt-official-reason" rowspan="'+rows.length+'">'+(absenceReason||"—")+'</td>':"";
        return '<tr class="'+(rowIndex===0?'tt-official-group-start':'')+'">'+merged+'<td>'+esc(formatReservePrintPeriod(row.period))+'</td><td class="tt-official-class">'+esc(row.className||"") +'</td><td class="tt-official-substitute">'+esc(row.substitute||"") +'</td><td class="tt-official-blank"></td><td class="tt-official-blank"></td></tr>';
      }).join("");
    }).join("");
    const remaining=Math.max(0,RESERVE_OFFICIAL_ROWS_PER_PAGE-used);
    const reservedSecondTeacher=remaining>0
      ?Array.from({length:remaining},(_,i)=>'<tr class="'+(i===0?'tt-official-group-start':'')+'">'+(i===0?'<td class="tt-official-merged" rowspan="'+remaining+'"></td><td class="tt-official-merged" rowspan="'+remaining+'"></td>':"")+'<td></td><td></td><td></td><td class="tt-official-blank"></td><td class="tt-official-blank"></td></tr>').join("")
      :"";
    const safeDate=String(date||"");let resolvedWeekday=String(weekday||"").trim();
    if(!resolvedWeekday&&safeDate){const d=new Date(safeDate+"T12:00:00+04:00");if(Number.isFinite(d.getTime()))resolvedWeekday=new Intl.DateTimeFormat("ar-OM",{weekday:"long",timeZone:"Asia/Muscat"}).format(d);}
    const detectedSubjects=[...new Set((groups||[]).flatMap(group=>(group.rows||[]).map(row=>String(row.subject||"").trim()).filter(Boolean)))];
    const subjectLabel=String(subject||"").trim()||detectedSubjects.join("، ");
    const subjectTitle=subjectLabel?(detectedSubjects.length>1&&!subject?"توزيع احتياط مواد: "+subjectLabel:"توزيع احتياط مادة "+subjectLabel):"كشف توزيع حصص الاحتياط";

    return '<main class="tt-official-page"><header class="tt-official-heading"><div>سلطنة عُمان</div><div>وزارة التربية والتعليم</div><div>المديرية العامة لمحافظة شمال الباطنة</div><div>إدارة التعليم بالسويق</div><div class="tt-official-school">مدرسة أبو دجانة</div></header>'+
      '<div class="tt-official-meta"><div><strong>اليوم:</strong> '+esc(resolvedWeekday)+'</div><div><strong>التاريخ:</strong> '+esc(formatReservePrintFullDate(safeDate))+'</div></div>'+

      '<div class="tt-official-subject"><span>'+esc(subjectTitle)+'</span></div>'+
      '<table class="tt-official-table '+(reservedSecondTeacher?'tt-official-table-full':'')+'">'+columns+header+'<tbody>'+rowsMarkup+reservedSecondTeacher+'</tbody></table>'+
      '<footer class="tt-official-footer"><div class="tt-official-manager"><strong>د. ناصر السناني</strong><span>مدير المدرسة</span></div><div class="tt-official-stamp" aria-label="مساحة مخصصة للختم"></div></footer></main>';
  }
  function reservePrintDocumentTitle(subject){
    const label=String(subject||"").trim().replace(/^مادة\s+/,"");
    return label?"احتياط مادة "+label:"كشف توزيع حصص الاحتياط";
  }
  function printOfficialReservePages(pages,subject){
    const previousTitle=document.title;
    document.title=reservePrintDocumentTitle(subject);
    document.getElementById("ttReservePrintRoot")?.remove();document.getElementById("ttReserveOfficialPrintStyle")?.remove();
    const style=document.createElement("style");style.id="ttReserveOfficialPrintStyle";
    style.textContent='@page{size:A4 portrait;margin:8mm}html,body{margin:0!important;padding:0!important;background:#fff!important}body.tt-reserve-print-mode>*:not(#ttReservePrintRoot){display:none!important}body.tt-reserve-print-mode{background:#fff!important;color:#111!important}#ttReservePrintRoot{display:block!important;width:100%;margin:0!important;padding:0!important;color:#111!important;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;direction:rtl}'+
      '.tt-official-page{box-sizing:border-box;width:100%;height:281mm;max-height:281mm;display:flex;flex-direction:column;direction:rtl;background:#fff;border:.35mm solid #333;padding:2.5mm 3mm 2mm;overflow:hidden;page-break-after:always;break-after:page}.tt-official-page:last-child{page-break-after:auto;break-after:auto}'+
      '.tt-official-heading{flex:0 0 auto;text-align:center;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;font-size:10.5pt;font-weight:700;line-height:1.35;padding:2.5mm 2mm 2mm;background:#078b98;color:#fff;border-bottom:1mm solid #155e75;-webkit-print-color-adjust:exact;print-color-adjust:exact}.tt-official-heading>div{margin:0}.tt-official-school{font-weight:900;font-size:12.5pt;margin-top:.7mm!important}'+
      '.tt-official-meta{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:10mm;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;font-size:10.5pt;font-weight:700;margin:2mm 0 1.5mm}.tt-official-subject{flex:0 0 auto;text-align:center;font-size:10.5pt;font-weight:900;margin:0 auto 1.5mm;width:max-content;max-width:92%;padding:1mm 7mm;background:#e8f1ff;border:1.2px solid #315b91;border-radius:2mm;color:#173b68;box-shadow:0 0 0 .5mm #e8f1ff}.tt-official-table{flex:0 0 auto;width:100%;height:auto;border-collapse:collapse;table-layout:fixed;direction:rtl;margin:0;font-family:"Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif;font-size:10.5pt;break-inside:avoid;page-break-inside:avoid}.tt-official-table.tt-official-table-full{height:162mm}.tt-official-table thead{display:table-header-group;height:9mm}.tt-official-table th,.tt-official-table td{box-sizing:border-box;border:1px solid #222;text-align:center;vertical-align:middle;padding:.7mm .8mm;overflow-wrap:anywhere}#ttReservePrintRoot .tt-official-table thead th{height:9mm;font-size:10pt!important;line-height:1.5!important;font-weight:900!important;background:#12345a!important;background-color:#12345a!important;color:#fff!important;border:1.2px solid #0b1f36!important;text-shadow:0 1px 0 rgba(0,0,0,.25);-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}.tt-official-table tbody tr{height:6.8mm;break-inside:avoid;page-break-inside:avoid}.tt-official-table tbody td{height:6.8mm;font-size:9pt}.tt-official-table .tt-official-merged{font-weight:800;white-space:normal}.tt-official-table .tt-official-group-start td{border-top:1.5px solid #111}'+
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
      let message="*توزيع حصص الاحتياط*\n\n*"+weekday+"، "+formatReserveDateArabic(date)+"*\n\n";
      groups.forEach((group,index)=>{
        message+="*"+(index+1)+"-* المعلم الغائب: *"+group.absentName+"*\n";
        if(group.absenceReason&&group.absenceReason!=="-")message+="سبب الغياب: "+group.absenceReason+"\n";
        message+="\n";
        group.rows.slice().sort((a,b)=>Number(a.period)-Number(b.period)).forEach(row=>{
          message+="- الحصة *"+String(row.period)+"* | الصف "+(row.className||"غير محدد")+"\n";
          message+="*الاحتياط: "+(row.substitute||"لم يحدد")+"*\n";
          if(row.reserveReason&&row.reserveReason!=="-")message+="سبب الاحتياط: "+row.reserveReason+"\n";
          message+="\n";
        });
      });
      message+="إدارة المدرسة";
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
  async function installDepartmentReserveTools() {
    const panel=$("timetableSubstitutionPanel");
    if(!panel || panel.dataset.departmentReserveTools==="1")return;
    if(activeUser?.type!=="teacher" || activeUser?.permissions?.reserve!==true)return;
    panel.dataset.departmentReserveTools="1";
    const card=document.createElement("section");
    card.id="ttDepartmentReserveTools";
    card.className="mt-5 space-y-3 rounded-2xl border border-indigo-200 bg-gradient-to-br from-white to-indigo-50 p-4 shadow-sm";
    card.innerHTML='<div class="flex items-start gap-3"><div class="rounded-xl bg-indigo-100 p-3 text-indigo-800"><i class="fa-solid fa-calendar-xmark"></i></div><div><h3 class="text-sm font-black text-slate-900">إدارة احتياط القسم</h3><p class="mt-1 text-[10px] leading-5 text-slate-600">يمكنك إلغاء سجلات احتياط مادتك في يوم محدد فقط. لا يؤثر الإجراء في بقية المواد أو الأيام، ويُحفظ في سجل التدقيق.</p></div></div>'+
      '<div class="grid gap-3 rounded-xl border border-indigo-100 bg-white p-3 md:grid-cols-[1fr_1fr_auto] md:items-end">'+
      '<label class="text-[10px] font-bold text-slate-600">تاريخ الاحتياط<input id="ttDepartmentResetDate" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label>'+
      '<label class="text-[10px] font-bold text-slate-600">المادة<select id="ttDepartmentResetSubject" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs"><option value="">حمّل مواد قسمك حسب التاريخ</option></select></label>'+
      '<button type="button" id="ttDepartmentLoadSubjects" class="rounded-lg bg-slate-800 px-4 py-2 text-xs font-black text-white">عرض المواد</button>'+
      '<button type="button" id="ttDepartmentResetSubjectDay" class="rounded-lg bg-indigo-700 px-4 py-2 text-xs font-black text-white md:col-span-3">إلغاء احتياط المادة في هذا اليوم فقط</button></div>'+
      '<div id="ttDepartmentToolsStatus" class="hidden rounded-lg p-3 text-xs font-bold" role="status" aria-live="polite"></div>';
    panel.appendChild(card);
    const token=()=>appAuthSession?.token||readAppAuthToken();
    const say=(message,error=false)=>{
      const box=$("ttDepartmentToolsStatus");if(!box)return;
      box.textContent=message;
      box.className="rounded-lg p-3 text-xs font-bold "+(error?"bg-red-100 text-red-800":"bg-emerald-100 text-emerald-800");
    };
    const dateInput=$("ttDepartmentResetDate");
    try{if(dateInput&&!dateInput.value)dateInput.value=timetableSubstitutionGetDate().date;}catch{}
    $("ttDepartmentLoadSubjects")?.addEventListener("click",async()=>{
      const date=dateInput?.value||"",select=$("ttDepartmentResetSubject"),button=$("ttDepartmentLoadSubjects");
      if(!date){say("اختر التاريخ أولاً.",true);return;}
      button.disabled=true;
      try{
        const result=await appAuthRequest({action:"timetable_substitution_reset_options",assignmentDate:date},token());
        select.innerHTML='<option value="">اختر مادة من قسمك</option>'+
          (result.subjects||[]).map(subject=>'<option value="'+esc(subject)+'">'+esc(subject)+'</option>').join("");
        say((result.subjects||[]).length?"تم تحميل مواد قسمك التي لديها سجلات احتياط نشطة في هذا التاريخ.":"لا توجد سجلات احتياط نشطة لمواد قسمك في هذا التاريخ.");
      }catch(error){say(error?.message||"تعذر تحميل مواد القسم.",true);}
      finally{button.disabled=false;}
    });
    $("ttDepartmentResetSubjectDay")?.addEventListener("click",async()=>{
      const date=dateInput?.value||"",subject=$("ttDepartmentResetSubject")?.value||"";
      if(!date||!subject){say("حدد التاريخ والمادة أولاً.",true);return;}
      if(!window.confirm("سيتم إلغاء سجلات احتياط مادة «"+subject+"» في تاريخ "+date+" فقط. ستبقى بقية المواد والأيام كما هي. هل تؤكد؟"))return;
      const button=$("ttDepartmentResetSubjectDay");button.disabled=true;
      try{
        const result=await appAuthRequest({action:"timetable_substitution_reset",mode:"subject_day",assignmentDate:date,subject},token());
        say("تم إلغاء "+Number(result.result?.cancelled_count||0)+" تكليف للمادة المحددة في هذا اليوم فقط.");
        if(typeof window.timetableDailyLoadArchive==="function")await window.timetableDailyLoadArchive();
        if(typeof window.timetableDailyRefreshAll==="function")await window.timetableDailyRefreshAll();
      }catch(error){say(error?.message||"تعذر إلغاء سجلات المادة.",true);}
      finally{button.disabled=false;}
    });
  }

  async function installAdminReserveTools() {
    const panel=$("timetableSubstitutionPanel");
    if(!panel || panel.dataset.adminReserveTools==="1" || appAuthSession?.principal?.type!=="admin")return;
    panel.dataset.adminReserveTools="1";
    const card=document.createElement("section");
    card.id="ttAdminReserveTools";
    card.className="mt-6 space-y-4 rounded-2xl border border-amber-200 bg-gradient-to-br from-white to-amber-50 p-4 shadow-sm";
    card.innerHTML='<div class="flex items-start gap-3"><div class="rounded-xl bg-amber-100 p-3 text-amber-800"><i class="fa-solid fa-shield-halved"></i></div><div><h3 class="text-sm font-black text-slate-900">إدارة سجلات الاحتياط والصلاحيات العامة</h3><p class="mt-1 text-[10px] leading-5 text-slate-600">هذه الأدوات متاحة لمدير النظام العام فقط. الإلغاء يحفظ السجلات في سجل التدقيق ولا يحذفها نهائياً.</p></div></div>'+
      '<div class="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-[1fr_1fr_auto] md:items-end">'+
      '<label class="text-[10px] font-bold text-slate-600">تاريخ الاحتياط<input id="ttAdminResetDate" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label>'+
      '<label class="text-[10px] font-bold text-slate-600">المادة / القسم<select id="ttAdminResetSubject" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs"><option value="">حمّل المواد حسب التاريخ</option></select></label>'+
      '<button type="button" id="ttAdminLoadSubjects" class="rounded-lg bg-slate-800 px-4 py-2 text-xs font-black text-white">عرض المواد</button>'+
      '<button type="button" id="ttAdminResetSubjectDay" class="rounded-lg bg-amber-600 px-4 py-2 text-xs font-black text-white md:col-span-3">إلغاء احتياط المادة المحددة في هذا اليوم فقط</button>'+
      '</div>'+
      '<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3"><div><strong class="block text-xs text-red-900">إعادة ضبط جميع سجلات الاحتياط النشطة</strong><span class="text-[10px] text-red-700">يشمل جميع المواد والتواريخ؛ يحتفظ النظام بالسجلات الملغاة في الأرشيف والتدقيق.</span></div><button type="button" id="ttAdminResetAll" class="rounded-lg bg-red-700 px-4 py-2 text-xs font-black text-white">تفريغ جميع الاحتياط النشط</button></div>'+
      '<div class="rounded-xl border border-indigo-100 bg-white p-3"><div class="flex flex-wrap items-center justify-between gap-2"><div><strong class="text-xs text-slate-900">من يحق له دخول الجداول ورؤية إحصائيات المدرسة؟</strong><p class="mt-1 text-[10px] text-slate-500">يمكن منح صلاحية الجداول وصلاحية الإحصائيات العامة كلٌّ على حدة، للحسابات المخصصة أيضاً.</p></div><button type="button" id="ttAdminLoadAccess" class="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[10px] font-black text-indigo-800">تحميل الحسابات</button></div>'+
      '<div id="ttAdminAccessList" class="mt-3 space-y-2 text-xs"><p class="text-slate-400">اضغط «تحميل الحسابات» لعرض المستخدمين.</p></div>'+
      '<div class="mt-3 flex justify-end"><button type="button" id="ttAdminSaveAccess" class="rounded-lg bg-indigo-700 px-4 py-2 text-xs font-black text-white">حفظ الصلاحيات المحددة</button></div></div>'+
      '<div class="rounded-xl border border-emerald-200 bg-white p-3"><div class="flex flex-wrap items-center justify-between gap-3"><div><strong class="block text-xs text-emerald-900">التقرير الشامل لجميع سجلات الاحتياط</strong><p class="mt-1 text-[10px] text-slate-600">يجمع جميع المواد والتواريخ المتاحة في النظام، ويقسم التقرير حسب اليوم والمادة.</p></div><button type="button" id="ttAdminPrintAllReserve" class="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-black text-white">تصدير PDF شامل</button></div></div><div id="ttAdminToolsStatus" class="hidden rounded-lg p-3 text-xs font-bold" role="status" aria-live="polite"></div>';
    panel.appendChild(card);
    const token=()=>appAuthSession?.token||readAppAuthToken();
    const say=(message,error=false)=>{const box=$("ttAdminToolsStatus");if(!box)return;box.textContent=message;box.className="rounded-lg p-3 text-xs font-bold "+(error?"bg-red-100 text-red-800":"bg-emerald-100 text-emerald-800");};
    $("ttAdminPrintAllReserve")?.addEventListener("click",async()=>{
      const button=$("ttAdminPrintAllReserve");
      if(appAuthSession?.principal?.type!=="admin"){say("هذه الميزة متاحة لمدير النظام العام فقط.",true);return;}
      button.disabled=true;button.textContent="جارٍ تجميع السجلات...";
      try{
        const response=await appAuthRequest({action:"timetable_substitution_archive",dateFrom:"1900-01-01",dateTo:"2100-12-31"},token());
        reserveArchive=response.archive||[];
        const records=reserveArchive.filter(item=>item.status!=="cancelled"&&item.assignmentDate);
        if(!records.length){say("لا توجد سجلات احتياط متاحة للتصدير.");return;}
        const dayCount=new Set(records.map(item=>String(item.assignmentDate))).size;
        say("تم تجهيز "+records.length+" تكليف احتياط موحداً عبر "+dayCount+" يوماً.");
        window.timetableDailyPrintArchiveRange();
      }catch(error){say(error?.message||"تعذر إنشاء التقرير الشامل.",true);}
      finally{button.disabled=false;button.textContent="تصدير PDF شامل";}
    });
    const dateInput=$("ttAdminResetDate");
    try{const d=timetableSubstitutionGetDate().date;if(dateInput&&!dateInput.value)dateInput.value=d;}catch{}
    $("ttAdminLoadSubjects")?.addEventListener("click",async()=>{
      const date=dateInput?.value||"",select=$("ttAdminResetSubject");
      if(!date){say("اختر التاريخ أولاً.",true);return;}
      const button=$("ttAdminLoadSubjects");button.disabled=true;
      try{
        const result=await appAuthRequest({action:"timetable_substitution_reset_options",assignmentDate:date},token());
        select.innerHTML='<option value="">اختر المادة</option>'+(result.subjects||[]).map(s=>'<option value="'+esc(s)+'">'+esc(s)+'</option>').join("");
        say((result.subjects||[]).length?"تم تحميل المواد التي لديها تكليفات نشطة في هذا التاريخ.":"لا توجد تكليفات احتياط نشطة لهذا التاريخ.");
      }catch(error){say(error?.message||"تعذر تحميل المواد.",true);}
      finally{button.disabled=false;}
    });
    $("ttAdminResetSubjectDay")?.addEventListener("click",async()=>{
      const date=dateInput?.value||"",subject=$("ttAdminResetSubject")?.value||"";
      if(!date||!subject){say("حدد التاريخ والمادة أولاً.",true);return;}
      if(!window.confirm("سيتم إلغاء سجلات احتياط مادة «"+subject+"» في تاريخ "+date+" فقط. ستبقى سجلات بقية المواد كما هي. هل تريد المتابعة؟"))return;
      const button=$("ttAdminResetSubjectDay");button.disabled=true;
      try{
        const result=await appAuthRequest({action:"timetable_substitution_reset",mode:"subject_day",assignmentDate:date,subject},token());
        say("تم إلغاء "+Number(result.result?.cancelled_count||0)+" تكليف للمادة المحددة في هذا اليوم فقط. بقيت بقية المواد دون تغيير.");
        if(typeof window.timetableDailyLoadArchive==="function")await window.timetableDailyLoadArchive();
      }catch(error){say(error?.message||"تعذر إلغاء سجلات المادة.",true);}
      finally{button.disabled=false;}
    });
    $("ttAdminResetAll")?.addEventListener("click",async()=>{
      if(!window.confirm("تحذير: سيؤدي هذا الإجراء إلى إلغاء جميع تكليفات الاحتياط النشطة في جميع المواد والتواريخ. سيحتفظ النظام بسجل التدقيق. هل تؤكد التفريغ الشامل؟"))return;
      const button=$("ttAdminResetAll");button.disabled=true;
      try{
        const result=await appAuthRequest({action:"timetable_substitution_reset",mode:"all_active"},token());
        say("اكتمل التفريغ الشامل: أُلغي "+Number(result.result?.cancelled_count||0)+" تكليف نشط.");
        if(typeof window.timetableDailyLoadArchive==="function")await window.timetableDailyLoadArchive();
      }catch(error){say(error?.message||"تعذر تنفيذ التفريغ الشامل.",true);}
      finally{button.disabled=false;}
    });
    $("ttAdminLoadAccess")?.addEventListener("click",loadAdminAccess);
    $("ttAdminSaveAccess")?.addEventListener("click",saveAdminAccess);
    async function loadAdminAccess(){
      const host=$("ttAdminAccessList");host.innerHTML='<p class="text-slate-400">جارٍ تحميل الحسابات...</p>';
      try{
        const [timetable,stats]=await Promise.all([
          appAuthRequest({action:"timetable_list_access"},token()),
          appAuthRequest({action:"timetable_reserve_stats_access_list"},token())
        ]);
        const statsMap=new Map((stats.users||[]).map(u=>[u.principalType+":"+u.principalName,u.enabled===true]));
        host.innerHTML=(timetable.users||[]).map(u=>{
          const key=u.principal_type+":"+u.principal_name,statsOn=statsMap.get(key)===true;
          return '<div class="grid gap-2 rounded-lg border border-slate-200 p-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center" data-admin-user="'+esc(key)+'">'+
            '<div><strong class="block text-xs text-slate-800">'+esc(u.principal_name)+'</strong><span class="text-[10px] text-slate-500">'+(u.principal_type==="custom"?"حساب مخصص":"معلم")+(u.category?" · "+esc(u.category):"")+'</span></div>'+
            '<label class="flex items-center gap-2 text-[10px] font-bold text-slate-700"><input type="checkbox" data-admin-timetable '+(u.can_access?"checked":"")+' data-original="'+(u.can_access?"1":"0")+'"> دخول الجداول وأرشيف الاحتياط</label>'+
            '<label class="flex items-center gap-2 text-[10px] font-bold text-indigo-800"><input type="checkbox" data-admin-stats '+(statsOn?"checked":"")+' data-original="'+(statsOn?"1":"0")+'"> إحصائيات المدرسة كاملة</label></div>';
        }).join("")||'<p class="text-slate-400">لا توجد حسابات قابلة لمنح الصلاحية.</p>';
      }catch(error){host.innerHTML='<p class="text-red-700">'+esc(error?.message||"تعذر تحميل الصلاحيات.")+'</p>';}
    }
    async function saveAdminAccess(){
      const button=$("ttAdminSaveAccess"),host=$("ttAdminAccessList");button.disabled=true;
      try{
        const rows=[...host.querySelectorAll("[data-admin-user]")],statsGrants=[];
        for(const row of rows){
          const [principalType,principalName]=row.dataset.adminUser.split(":",2);
          const timetable=row.querySelector("[data-admin-timetable]"),stats=row.querySelector("[data-admin-stats]");
          if(timetable && timetable.checked!==(timetable.dataset.original==="1")){
            await appAuthRequest({action:"timetable_set_access",principalType,principalName,canAccess:timetable.checked},token());
            timetable.dataset.original=timetable.checked?"1":"0";
          }
          statsGrants.push({principalType,principalName,enabled:stats?.checked===true});
        }
        await appAuthRequest({action:"timetable_reserve_stats_access_save",grants:statsGrants},token());
        host.querySelectorAll("[data-admin-stats]").forEach(input=>input.dataset.original=input.checked?"1":"0");
        say("تم حفظ صلاحيات الدخول إلى الجداول وإحصائيات المدرسة.");
      }catch(error){say(error?.message||"تعذر حفظ الصلاحيات؛ راجع الاتصال ثم أعد المحاولة.",true);}
      finally{button.disabled=false;}
    }
  }


  // Legacy reserve screen: explicitly choose supporting teachers from the selected department.
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
      window.appAuthRequest=async function(body,token){
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
        const result=await originalRequest.call(this,body,token);
        return result;
      };
    }
  }

  function installHomeReserveArchive() {
    const view=$("substitutionView");
    if(!view||view.dataset.cumulativeArchiveInstalled==="1")return;
    const accessCheck=view.dataset.cumulativeArchiveAccessCheck||"";
    if(accessCheck==="pending"||accessCheck==="denied")return;
    const canViewLocally=activeUser?.type==="admin"||activeUser?.permissions?.reserve===true||appAuthSession?.principal?.type==="admin";
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
    const header=view.querySelector(".relative.z-10.flex.flex-wrap.items-center.justify-between.gap-3");
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
      if(!(reserveArchive||[]).some(item=>item.status!=="cancelled"&&item.assignmentDate)){
        setHomeArchiveStatus("حمّل السجلات أولاً، ولا توجد توزيعات غير ملغاة للطباعة.","error");return;
      }
      window.timetableDailyPrintArchiveRange();
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

  window.substitutionLoadCumulativeArchive = async function() {
    const host=$("substitutionCumulativeArchiveResults");if(!host)return;
    const from=$("substitutionArchiveFrom")?.value||"",to=$("substitutionArchiveTo")?.value||"";
    if(!from||!to||from>to){setHomeArchiveStatus("حدد فترة زمنية صحيحة قبل عرض السجل.","error");return;}
    host.innerHTML='<div class="rounded-xl bg-slate-50 p-4 text-center text-xs text-slate-500">جارٍ تحميل سجل الاحتياط...</div>';
    setHomeArchiveStatus("يتم جلب التوزيعات المحفوظة من النظام...");
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      const response=await appAuthRequest({action:"timetable_substitution_archive",dateFrom:from,dateTo:to},token);
      reserveArchive=response.archive||[];
      window.substitutionRenderCumulativeArchive();
      setHomeArchiveStatus("تم تحديث السجل من قاعدة البيانات مباشرة.","success");
    }catch(error){
      host.innerHTML='<div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">'+esc(error?.message||"تعذر تحميل السجل.")+'</div>';
      setHomeArchiveStatus(error?.message||"تعذر تحميل السجل.","error");
    }
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
    host.innerHTML=Array.from(byAbsent.entries()).map(([absentName,items])=>
      '<section class="rounded-2xl border border-emerald-100 bg-white p-3 shadow-sm">'+
      '<div class="mb-2 flex flex-wrap items-center justify-between gap-2"><strong class="text-xs font-black text-slate-900">المعلم الغائب: '+esc(absentName)+'</strong><span class="text-[10px] text-slate-500">'+items.length+' حصص</span></div>'+
      '<div class="space-y-2">'+items.map(item=>{
        const editable=item.canEdit===true&&["assigned","confirmed"].includes(item.status);
        const state=item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":item.status==="assigned"?"محفوظ":String(item.status||"");
        const actions=editable
          ?'<div class="flex shrink-0 flex-wrap gap-1.5"><button type="button" class="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-[11px] font-black text-indigo-900 transition hover:bg-indigo-100" data-home-today-edit="'+esc(item.id)+'"><i class="fa-solid fa-pen-to-square ml-1"></i> تعديل</button><button type="button" class="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-[11px] font-black text-rose-800 transition hover:bg-rose-100" data-home-today-delete="'+esc(item.id)+'"><i class="fa-solid fa-trash-can ml-1"></i> حذف</button></div>'
          :'<span class="text-[10px] font-bold text-slate-400">'+(item.status==="completed"?"مكتمل · لا يقبل التعديل":"للقراءة فقط · تحقق من صلاحية الإدارة وإصدار الجدول")+'</span>';
        return '<article class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3"><div class="min-w-0 flex-1"><strong class="block text-xs font-black text-slate-900">الحصة '+Number(item.period)+' · '+esc(item.className||"—")+' · '+esc(item.subject||"—")+'</strong><span class="mt-1 block text-xs text-slate-700">المعلم البديل: '+esc(item.substituteTeacherName||"—")+'</span><span class="mt-1 block text-[10px] text-amber-700">سبب الغياب: '+esc(item.absenceReason||"-")+'</span><span class="mt-1 block text-[10px] text-indigo-700">سبب الاحتياط: '+esc(item.reason||"-")+'</span></div>'+actions+'</article>';
      }).join("")+'</div></section>'
    ).join("");
    host.querySelectorAll("[data-home-today-edit]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyOpenArchiveEdit(button.dataset.homeTodayEdit)));
    host.querySelectorAll("[data-home-today-delete]").forEach(button=>button.addEventListener("click",()=>window.timetableDailyCancelAssignment(button.dataset.homeTodayDelete)));
  };

  window.substitutionRenderCumulativeArchive = function() {
    const host=$("substitutionCumulativeArchiveResults");if(!host)return;
    // Cancelled assignments remain in the audit trail, but are not part of the
    // current cumulative reserve record shown to coordinators or sent to print.
    const records=(reserveArchive||[]).filter(item=>item.status!=="cancelled"&&item.assignmentDate);
    if(!records.length){host.innerHTML='<div class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">لا توجد توزيعات احتياط فعلية في الفترة المحددة.</div>';return;}
    const active=records.filter(item=>item.canEdit!==false&&["assigned","confirmed"].includes(item.status));
    const historical=records.length-active.length;
    const byDate=new Map();
    records.forEach(item=>{const date=item.assignmentDate;if(!byDate.has(date))byDate.set(date,[]);byDate.get(date).push(item);});
    host.innerHTML='<div class="grid gap-2 sm:grid-cols-2"><div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><strong class="block text-xs text-emerald-900">توزيعات قابلة للتعديل والحذف</strong><span class="text-[10px] text-emerald-800">'+active.length+' تكليف ضمن المهلة</span></div><div class="rounded-xl border border-slate-200 bg-slate-50 p-3"><strong class="block text-xs text-slate-800">السجل التاريخي</strong><span class="text-[10px] text-slate-600">'+historical+' تكليف محفوظ للمراجعة</span></div></div>'+
      Array.from(byDate.entries()).sort((a,b)=>b[0].localeCompare(a[0])).map(([date,items])=>{
        const byAbsent=new Map();
        items.forEach(item=>{const name=String(item.absentTeacherName||"غير محدد");if(!byAbsent.has(name))byAbsent.set(name,[]);byAbsent.get(name).push(item);});
        const groups=Array.from(byAbsent.entries()).sort((a,b)=>a[0].localeCompare(b[0],"ar")).map(([absentName,rows])=>{
          rows.sort((a,b)=>Number(a.period)-Number(b.period));
          const current=rows.filter(item=>["assigned","confirmed"].includes(item.status));
          const canDelete=current.length>0&&current.every(item=>item.canEdit!==false);
          const deleteAll=canDelete?'<button type="button" class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] font-black text-rose-700" data-home-delete-group-date="'+esc(date)+'" data-home-delete-group-absent="'+esc(absentName)+'">حذف التوزيع بالكامل ('+current.length+')</button>':"";
          const rowHtml=rows.map(item=>{
            const state=item.status==="cancelled"?"ملغى":item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":"محفوظ";
            const editable=item.canEdit!==false&&["assigned","confirmed"].includes(item.status);
            const actions=editable?'<div class="flex gap-1"><button type="button" class="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[10px] font-black text-indigo-800" data-home-archive-edit="'+esc(item.id)+'">تعديل</button><button type="button" class="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] font-black text-rose-700" data-home-archive-delete="'+esc(item.id)+'">حذف</button></div>':'<span class="text-[10px] text-slate-400">'+(item.canEdit===false&&["assigned","confirmed"].includes(item.status)?"سجل تاريخي · للقراءة فقط":state)+'</span>';
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
    let loadedActorDateKey="",dailyArchiveLoadPromise=null;
    window.appAuthRequest=async function(body,token) {
      const action=String(body?.action||"");
      const result=await originalRequest.call(this,body,token);
      const accessGranted=action==="timetable_substitution_archive_access"&&result?.canView===true;
      const reserveMutationActions=new Set([
        "timetable_substitution_batch_save","timetable_substitution_save",
        "timetable_substitution_update","timetable_substitution_update_batch",
        "timetable_substitution_cancel","timetable_substitution_cancel_batch"
      ]);
      const reserveAction=reserveMutationActions.has(action);
      if((accessGranted||reserveAction)&&$("timetableDailyActivePanel")&&
        typeof window.timetableDailyLoadArchive==="function"){
        const actor=String(appAuthSession?.principal?.name||"");
        let date="";
        try{date=String(timetableSubstitutionGetDate().date||"");}catch{}
        const key=actor+"|"+date;
        if(actor&&key!==loadedActorDateKey&&!dailyArchiveLoadPromise){
          loadedActorDateKey=key;
          dailyArchiveLoadPromise=(async()=>{
            const loaded=await window.timetableDailyLoadArchive();
            if(loaded!==true)loadedActorDateKey="";
          })().catch(()=>{loadedActorDateKey="";}).finally(()=>{dailyArchiveLoadPromise=null;});
        }
      }
      if(["timetable_substitution_batch_save","timetable_substitution_save","timetable_substitution_update","timetable_substitution_update_batch","timetable_substitution_cancel","timetable_substitution_cancel_batch"].includes(action)&&
        $("substitutionTodayAssignmentsResults")&&typeof window.substitutionLoadHomeTodayAssignments==="function") {
        try{await window.substitutionLoadHomeTodayAssignments();}catch{}
      }
      if(["timetable_substitution_batch_save","timetable_substitution_save","timetable_substitution_update","timetable_substitution_update_batch","timetable_substitution_cancel","timetable_substitution_cancel_batch"].includes(action)&&
        !$("substitutionCumulativeArchivePanel")?.classList.contains("hidden")&&
        typeof window.substitutionLoadCumulativeArchive==="function") {
        try{await window.substitutionLoadCumulativeArchive();}catch{}
      }
      return result;
    };
  }

  installLegacyOtherDepartmentTeacherPicker();
  installAbsenceReasonPicker();
  if(typeof MutationObserver!=="undefined"&&document.body){
    const absencePickerObserver=new MutationObserver(()=>installAbsenceReasonPicker());
    absencePickerObserver.observe(document.body,{subtree:true,childList:true});
  }

  installReserveEnhancements();
  installHomeReserveArchive();
  installReserveArchiveAutoRefresh();
  window.timetableDailyInstallAdminTools=installAdminReserveTools;
  window.timetableDailyInstallDepartmentTools=installDepartmentReserveTools;
  installDepartmentReserveTools();
  installAdminReserveTools();
  applyTeacherTimetablePresentation();
  if(typeof MutationObserver!=="undefined"&&document.body){
    const adminToolsObserver=new MutationObserver(()=>{installDepartmentReserveTools();installAdminReserveTools();installHomeReserveArchive();installReserveArchiveAutoRefresh();applyTeacherTimetablePresentation();});
    adminToolsObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["class","style"]});
    const timetableHost=$("teacherTimetableWeekGrid");
    if(timetableHost){
      const timetableObserver=new MutationObserver(()=>applyTeacherTimetablePresentation());
      timetableObserver.observe(timetableHost,{childList:true,subtree:true});
    }
  }
})();