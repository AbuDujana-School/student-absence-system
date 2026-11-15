/* Reserve workflow enhancement: whole-day matching, staged edits, archive and A4 report. */
(function () {
  "use strict";
  let reserveBatchPreview = null;
  let reserveDraftAssignments = [];
  let reserveDraftApproved = new Set();
  let reserveLastAbsentSignature = "";
  let reserveReasons = Object.create(null);
  let reserveManualChoices = Object.create(null);
  let reserveDraftScope = "";
  let reserveOtherDepartmentId = "";
  let reserveDraftRestoreChecked = false;
  let reserveArchive = [];
  const DRAFT_STORAGE_KEY="abu-dujana-reserve-draft-v1";
  function currentActorName(){return String(appAuthSession?.principal?.name||"").trim();}
  function clearStoredDraft(){try{localStorage.removeItem(DRAFT_STORAGE_KEY);}catch{}}
  function persistStoredDraft(){
    try{
      const actor=currentActorName();if(!actor)return;
      const {date,weekday}=timetableSubstitutionGetDate();
      localStorage.setItem(DRAFT_STORAGE_KEY,JSON.stringify({actor,date,weekday,savedAt:Date.now(),
        absentTeachers:[...timetableDailyAbsentTeachers],manualChoices:reserveManualChoices,reasons:reserveReasons,approvedAbsentTeachers:[...reserveDraftApproved],includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId()}));
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
      if(otherDepartmentSelect&&saved.otherDepartmentId)otherDepartmentSelect.value=saved.otherDepartmentId;
      const otherButton=$("timetableDailyOtherDepartmentsButton");
      if(otherButton)otherButton.innerHTML=otherToggle?.checked
        ?'<i class="fa-solid fa-filter-circle-xmark ml-1"></i> إخفاء الأقسام الأخرى'
        :'<i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى';
      reserveManualChoices=Object.assign(Object.create(null),saved.manualChoices||{});
      reserveDraftApproved=new Set(Array.isArray(saved.approvedAbsentTeachers)?saved.approvedAbsentTeachers.filter(name=>timetableDailyAbsentTeachers.includes(name)):[]);
      reserveReasons=Object.assign(Object.create(null),saved.reasons||{});
      reserveDraftScope=currentDraftScope();
      if(typeof timetableDailyRenderTags==="function")timetableDailyRenderTags();
      status("استُعيدت مسودة الاحتياط غير المحفوظة من هذا الجهاز. راجعها قبل الاعتماد.","info");
      return true;
    }catch{return false;}
  }
  const draftKey = (name, period) => String(name) + "\u0000" + Number(period);
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
  async function loadOtherDepartments() {
    const token=appAuthSession?.token||readAppAuthToken();
    const result=await appAuthRequest({action:"timetable_substitution_departments"},token);
    const select=$("timetableDailyOtherDepartmentSelect");
    if(!select)return;
    const current=reserveOtherDepartmentId||selectedOtherDepartmentId();
    select.innerHTML='<option value="">اختر المادة / القسم المساند</option>'+
      (result.departments||[]).map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join("");
    if(current && (result.departments||[]).some(item=>item.id===current)){select.value=current;reserveOtherDepartmentId=current;}
  }

  function reasonControlMarkup(absentName, reason) {
    const value=String(reason||"").trim();
    return '<div class="w-full max-w-md"><label class="mb-1 block text-[10px] font-black text-slate-600">سبب الاحتياط <span class="font-normal text-slate-400">(اختياري)</span></label>'+
      '<textarea data-tt-reason="'+esc(absentName)+'" rows="2" maxlength="500" class="tt-reason resize-y" placeholder="اكتب سبب الاحتياط أو اتركه فارغاً">'+esc(value)+'</textarea></div>';
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
        '<button type="button" id="timetableDailyArchiveButton" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800"><i class="fa-solid fa-box-archive ml-1"></i> أرشيف الاحتياط</button>');
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
    if (otherToggle) otherToggle.setAttribute("onchange", "timetableDailyRefreshAll()");
    if (toolbar) {
      toolbar.insertAdjacentHTML("beforeend", '<button type="button" id="timetableDailyOtherDepartmentsButton" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800"><i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى</button>');
      $("timetableDailyOtherDepartmentsButton")?.addEventListener("click", async () => {
        const toggle = $("timetableSubstitutionOtherDepartments");
        if (!toggle) return;
        toggle.checked = !toggle.checked;
        const select=$("timetableDailyOtherDepartmentSelect");
        if(toggle.checked){
          try{
            await loadOtherDepartments();
            $("timetableDailyOtherDepartmentWrap")?.classList.remove("hidden");
            $("timetableDailyOtherDepartmentsButton").innerHTML='<i class="fa-solid fa-filter-circle-xmark ml-1"></i> إخفاء الأقسام الأخرى';
            if(!selectedOtherDepartmentId()){status("اختر القسم أولاً، ثم سيعرض النظام معلميه المتاحين فقط.","info");return;}
          }catch(error){toggle.checked=false;if(select)select.classList.add("hidden");status(error?.message||"تعذر تحميل قائمة الأقسام.","error");return;}
        }else{
          if(select){select.classList.add("hidden");select.value="";reserveOtherDepartmentId="";}
          $("timetableDailyOtherDepartmentsButton").innerHTML='<i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى';
        }
        await timetableDailyRefreshAll();
      });
      const toolbarSelect='<label id="timetableDailyOtherDepartmentWrap" class="hidden min-w-[190px] text-[10px] font-bold text-slate-600"><span class="mb-1 block">القسم المساند</span><select id="timetableDailyOtherDepartmentSelect" class="w-full rounded-xl border border-indigo-200 bg-white p-2 text-xs"><option value="">اختر المادة / القسم المساند</option></select></label>';
      $("timetableDailyOtherDepartmentsButton")?.insertAdjacentHTML("afterend",toolbarSelect);
      $("timetableDailyOtherDepartmentSelect")?.addEventListener("change",async()=>{reserveOtherDepartmentId=selectedOtherDepartmentId();if(includeOthers()&&reserveOtherDepartmentId)await timetableDailyRefreshAll();});
      $("timetableDailyOtherDepartmentSelect")?.closest("label")?.classList.toggle("hidden",!includeOthers());
      if(includeOthers())loadOtherDepartments().then(()=>{$("timetableDailyOtherDepartmentWrap")?.classList.remove("hidden");}).catch(()=>{});
    }
    const results = $("timetableSubstitutionResults");
    if (results) {
      results.insertAdjacentHTML("beforebegin", '<div id="timetableDailySummary" class="grid grid-cols-2 gap-2 sm:grid-cols-4"></div>');
      results.insertAdjacentHTML("afterend",
        '<section id="timetableDailyArchivePanel" class="hidden mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/40">' +
        '<div class="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h4 class="font-black text-sm text-slate-900 dark:text-white">أرشيف توزيع الاحتياط</h4><p class="mt-1 text-[10px] text-slate-500">اختر فترة زمنية لعرض السجلات وطباعتها؛ كل يوم في صفحة مستقلة.</p></div></div>' +
        '<div class="grid gap-2 rounded-xl border border-indigo-100 bg-white p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"><label class="text-[10px] font-bold text-slate-600">من تاريخ<input id="timetableDailyArchiveFrom" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label><label class="text-[10px] font-bold text-slate-600">إلى تاريخ<input id="timetableDailyArchiveTo" type="date" class="mt-1 w-full rounded-lg border border-slate-300 p-2 text-xs"></label><button type="button" id="timetableDailyArchiveReload" class="tt-action border border-slate-300 bg-white text-slate-800">عرض السجلات</button><button type="button" id="timetableDailyArchivePrint" class="tt-action bg-indigo-700 text-white"><i class="fa-solid fa-print ml-1"></i> طباعة الفترة</button></div><div id="timetableDailyArchiveResults" class="space-y-3"></div></section>');
      $("timetableDailyArchiveReload")?.addEventListener("click", timetableDailyLoadArchive);
      $("timetableDailyArchivePrint")?.addEventListener("click", timetableDailyPrintArchiveRange);
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
    const {date, weekday} = timetableSubstitutionGetDate();
    const token = appAuthSession?.token || readAppAuthToken();
    if (!token) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({
      action: "timetable_substitution_batch_preview", weekday, assignmentDate: date,
      absentTeacherNames: [...timetableDailyAbsentTeachers], includeOtherDepartments: includeOthers(), otherDepartmentId:selectedOtherDepartmentId()
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
      if(!pendingRows.length)return '<section class="tt-group border border-emerald-200 bg-emerald-50 p-3"><div class="text-[10px] font-black text-emerald-700">محفوظ مسبقاً</div><strong class="text-xs text-slate-900">'+esc(absentName)+'</strong><div class="text-[10px] text-emerald-700">'+rows.length+' حصة محفوظة</div></section>';
      const savedReason = saved.find(item=>item.absentTeacherName===absentName&&item.reason&&item.reason!=="-")?.reason || "";
      if (reserveReasons[absentName] === undefined && savedReason) reserveReasons[absentName] = savedReason;
      const reason = reserveReasons[absentName] ?? savedReason;
      const cards = rows.map(item => {
        const draft = reserveDraftAssignments.find(row=>row.absentTeacherName===absentName&&Number(row.period)===Number(item.period));
        let choice="", action="";
        if (item.kind==="saved") {
          const state=item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":item.status==="cancelled"?"ملغى":"محفوظ";
          choice='<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-800"><div>البديل المحفوظ: '+esc(item.substituteTeacherName)+' · '+state+'</div><div class="mt-1 text-[10px] font-normal">سبب الاحتياط: '+esc(item.reason||"-")+'</div></div>';
          action=["assigned","confirmed"].includes(item.status)&&item.canEdit!==false&&item.id?'<div class="flex flex-wrap gap-1"><button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-edit="'+esc(item.id)+'">تعديل</button><button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-delete="'+esc(item.id)+'">إلغاء</button></div>':(item.canEdit===false?'<span class="text-[10px] text-slate-400">إصدار سابق · للعرض فقط</span>':'<span class="text-[10px] text-slate-400">'+state+'</span>');
        } else {
          const candidates=item.candidateOptions||[];
          const options=candidates.map(candidate=>'<option value="'+esc(candidate.teacherName)+'" '+(draft?.substituteTeacherName===candidate.teacherName?"selected":"")+'>'+esc(candidate.teacherName)+' · رصيد '+Number(candidate.pointsBalance||0)+' · احتياط اليوم '+Number(candidate.dailySubstitutionCount||0)+'</option>').join("");
          choice=candidates.length?'<label class="block"><span class="mb-1 block text-[10px] font-bold text-slate-500">أفضل البدلاء المتاحين لهذه الحصة، مرتبين حسب الملاءمة</span><select data-tt-substitute data-absent="'+esc(absentName)+'" data-period="'+Number(item.period)+'"><option value="">اختر البديل</option>'+options+'</select></label>':(item.blockReason==="daily_limit"?'<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">يوجد '+Number(item.blockedCandidateCount||0)+' من المعلمين لديهم فراغ مؤكد، لكنهم بلغوا الحد الأعلى المسموح: حصتان احتياط في اليوم. لم يتجاوز النظام هذا الحد حفاظاً على العدالة.</div>':item.blockReason==="period_capacity"?'<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">المعلمون المتاحون لهذه الفترة خُصصوا لتغطية حصص غياب أخرى في الفترة نفسها؛ لا يمكن تكليف المعلم بحصتين متزامنتين.</div>':'<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">لا يوجد معلم متاح بفراغ مؤكد لهذه الحصة.</div>');
          if(draft?.createsThreeConsecutive||item.createsThreeConsecutive)choice+='<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-[10px] font-bold text-amber-800">تنبيه: هذا الاختيار يكوّن ثلاث حصص متتالية أو أكثر.</div>';
          action='<span class="text-[10px] text-slate-500">'+(draft?"مقترح قابل للتعديل":"لا يوجد اقتراح")+"</span>";
        }
        return '<article class="tt-lesson"><div class="tt-lesson-main"><div class="text-[10px] font-bold text-slate-500">الحصة '+Number(item.period)+'</div><strong class="mt-1 block text-xs text-slate-900">'+esc(item.className||"الشعبة غير محددة")+'</strong><div class="mt-1 text-[10px] text-slate-500">'+esc(item.subject||"المادة غير محددة")+'</div></div><div class="tt-lesson-choice">'+choice+'</div><div class="tt-lesson-actions">'+action+"</div></article>";
      }).join("");
      const approvalControl=pendingRows.length
        ? '<div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 p-3"><span class="text-[10px] font-bold '+(approved?'text-emerald-700':'text-slate-500')+'">'+(approved?'تم اعتماد توزيع هذا المعلم ضمن مسودة اليوم':'راجع الحصص والبدلاء ثم اعتمد هذا المعلم')+'</span><button type="button" data-tt-approve="'+esc(absentName)+'" class="tt-action '+(approved?'border border-emerald-300 bg-emerald-50 text-emerald-800':'bg-indigo-700 text-white')+'">'+(approved?'إلغاء الاعتماد للمراجعة':'اعتماد توزيع هذا المعلم')+'</button></div>'
        : '<div class="border-t border-slate-200 bg-emerald-50 p-3 text-[10px] font-bold text-emerald-700">لا توجد تكليفات جديدة لهذا المعلم؛ الحصص الظاهرة محفوظة مسبقاً.</div>';
      return '<section class="tt-group"><div class="tt-group-head"><div><div class="text-[10px] font-black text-emerald-700">المعلم الغائب</div><h4 class="mt-1 text-sm font-black text-slate-900">'+esc(absentName)+'</h4><div class="mt-1 text-[10px] text-slate-500">'+rows.length+' حصة · '+rows.filter(x=>x.kind==="saved").length+' محفوظة · '+rows.filter(x=>x.kind==="planned").length+' مقترحة</div></div>'+reasonControlMarkup(absentName,reason)+'</div><div class="space-y-2 p-3 sm:p-4">'+cards+'</div>'+approvalControl+'</section>';
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
      reserveReason:(reserveReasons[item.absentTeacherName]||"").trim()||"-"
    }));
    if(!assignments.length){status("لا توجد اقتراحات جاهزة للحفظ. أعد إعداد التوزيع الذكي أو اختر البدلاء يدوياً.","error");return;}
    timetableDailyBusy=true;timetableDailySetBusy(true);
    try{
      const {date,weekday}=timetableSubstitutionGetDate(),token=appAuthSession?.token||readAppAuthToken();
      const result=await appAuthRequest({action:"timetable_substitution_batch_save",weekday,assignmentDate:date,
        absentTeacherNames:[...timetableDailyAbsentTeachers],assignments,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId()},token);
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
    const host=$("timetableDailyArchiveResults");if(!host)return;
    host.innerHTML='<div class="p-4 text-center text-xs text-slate-500">جارٍ تحميل الأرشيف...</div>';
    try{
      const from=$("timetableDailyArchiveFrom")?.value||"",to=$("timetableDailyArchiveTo")?.value||"",token=appAuthSession?.token||readAppAuthToken();
      if(!from||!to){throw new Error("حدد تاريخ البداية وتاريخ النهاية.");}
      if(from>to){throw new Error("تاريخ البداية يجب أن يسبق تاريخ النهاية أو يساويه.");}
      const response=await appAuthRequest({action:"timetable_substitution_archive",dateFrom:from,dateTo:to},token);
      reserveArchive=response.archive||[];timetableDailyRenderArchive();
    }catch(error){host.innerHTML='<div class="rounded-xl bg-red-50 p-3 text-xs text-red-700">'+esc(error?.message||"تعذر تحميل الأرشيف.")+"</div>";}
  };
  window.timetableDailyPrintArchiveRange = function () {
    const records=(reserveArchive||[]).filter(item=>item.status!=="cancelled"&&item.assignmentDate);
    if(!records.length){status("لا توجد سجلات احتياط غير ملغاة للطباعة في الفترة المحددة.","error");return;}
    const grouped=new Map();records.forEach(item=>{const date=String(item.assignmentDate);if(!grouped.has(date))grouped.set(date,[]);grouped.get(date).push(item);});
    const days=[...grouped.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
    const pages=days.flatMap(([date,items])=>{const byAbsent=new Map();items.forEach(item=>{const name=String(item.absentTeacherName||"");if(!byAbsent.has(name))byAbsent.set(name,{absentName:name,reason:(String(item.reason||"").trim()==="-"||String(item.reason||"").trim()==="—")?"":String(item.reason||""),rows:[]});byAbsent.get(name).rows.push({period:item.period,className:item.className,substitute:item.substituteTeacherName||""});});return reserveOfficialPrintPages([...byAbsent.values()],date,items[0]?.weekday||"");});
    printOfficialReservePages(pages);
  };

  async function fetchArchivePreview(absentName, date, weekday) {
    const token=appAuthSession?.token||readAppAuthToken();
    if(!token)throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({action:"timetable_substitution_preview",weekday,assignmentDate:date,
      absentTeacherName:absentName,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId()},token);
  }

  window.timetableDailyRenderArchive = function () {
    const host=$("timetableDailyArchiveResults");if(!host)return;
    if(!reserveArchive.length){host.innerHTML='<div class="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">لا توجد سجلات احتياط محفوظة ضمن نطاق صلاحيتك.</div>';return;}
    const grouped=new Map();reserveArchive.forEach(item=>{const key=item.assignmentDate||"تاريخ غير محدد";if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(item);});
    host.innerHTML=Array.from(grouped.entries()).map(([date,items])=>{
      const editableItems=items.filter(item=>item.canEdit!==false&&["assigned","confirmed"].includes(item.status));
      const rows=items.map(item=>{
        const state=item.status==="cancelled"?"ملغى":item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":"محفوظ";
        const editable=item.canEdit!==false&&["assigned","confirmed"].includes(item.status);
        const readOnly=item.canEdit===false&&["assigned","confirmed"].includes(item.status);
        return '<div class="tt-archive-row"><div><div class="text-xs font-black text-slate-800">'+esc(item.absentTeacherName)+" ← "+esc(item.substituteTeacherName)+'</div><small>الحصة '+Number(item.period)+" · "+esc(item.className||"—")+" · سبب الاحتياط: "+esc(item.reason||"-")+" · "+state+(readOnly?" · إصدار جدول سابق":"")+"</small></div>"+
          (editable?'<div class="flex flex-wrap gap-1"><button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-archive-edit="'+esc(item.id)+'">تعديل</button><button type="button" class="tt-action border border-rose-200 bg-rose-50 text-rose-700" data-tt-delete="'+esc(item.id)+'">إلغاء</button></div>':'<span class="text-[10px] text-slate-400">'+(readOnly?"إصدار سابق · للعرض فقط":state)+"</span>")+"</div>";
      }).join("");
      const dayButton=editableItems.length?'<button type="button" class="tt-action bg-indigo-700 text-white" data-tt-open-day-edit="'+esc(date)+'">فتح توزيع اليوم وتعديله ('+editableItems.length+')</button>':"";
      return '<details open class="rounded-xl border border-slate-200 bg-white p-3"><summary class="cursor-pointer text-xs font-black text-slate-800">'+esc(date)+" · "+items.length+' تكليف</summary><div class="mt-3 flex justify-end">'+dayButton+'</div><div class="mt-3 space-y-2">'+rows+"</div></details>";
    }).join("");
    host.querySelectorAll("[data-tt-archive-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveEdit(button.dataset.ttArchiveEdit)));
    host.querySelectorAll("[data-tt-delete]").forEach(button=>button.addEventListener("click",()=>timetableDailyCancelAssignment(button.dataset.ttDelete)));
    host.querySelectorAll("[data-tt-open-day-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveDayEdit(button.dataset.ttOpenDayEdit)));
  };

  window.timetableDailyOpenArchiveDayEdit = async function(date) {
    const items=reserveArchive.filter(item=>item.assignmentDate===date&&item.canEdit!==false&&["assigned","confirmed"].includes(item.status));
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
          .map(candidate=>'<option value="'+esc(candidate.name)+'">'+esc(candidate.name)+' · رصيد '+Number(candidate.pointsBalance||0)+' · احتياط اليوم '+Number(candidate.dailySubstitutionCount||0)+'</option>').join("");
        return '<div class="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3" data-archive-day-row="'+esc(item.id)+'">'+
          '<div><div class="text-[10px] font-black text-slate-500">'+esc(item.absentTeacherName)+'</div><div class="mt-1 text-xs font-black text-slate-900">الحصة '+Number(item.period)+' · '+esc(item.className||"-")+'</div><div class="text-[10px] text-slate-500">'+esc(item.subject||"")+'</div></div>'+
          '<label class="text-[10px] font-black text-slate-600">المعلم البديل<select data-batch-sub-id="'+esc(item.id)+'" data-original-sub="'+esc(item.substituteTeacherName)+'" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs"><option value="'+esc(item.substituteTeacherName)+'" selected>'+esc(item.substituteTeacherName)+' (الحالي)</option>'+options+'</select></label>'+
          '<label class="text-[10px] font-black text-slate-600">سبب الاحتياط<textarea data-batch-reason="'+esc(item.id)+'" data-original-reason="'+esc(item.reason||"-")+'" rows="1" class="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-xs" placeholder="اختياري">'+esc(item.reason==="-"?"":item.reason||"")+'</textarea></label></div>';
      }).join("");
      modal.innerHTML='<div class="max-h-[90vh] w-full max-w-5xl space-y-4 overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl"><div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="font-black text-base text-slate-900">مراجعة وتعديل توزيع اليوم بالكامل</h3><p class="mt-1 text-[10px] text-slate-500">التاريخ: '+esc(date)+' · '+items.length+' تكليف · التغييرات تحفظ في عملية واحدة.</p></div><button type="button" data-close-day-edit class="rounded-xl bg-slate-100 px-3 py-2">×</button></div><div class="space-y-2">'+rows+'</div><div id="ttArchiveDayEditError" class="hidden rounded-xl bg-red-50 p-3 text-xs text-red-700"></div><div class="flex justify-end gap-2"><button type="button" data-close-day-edit class="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold">إلغاء</button><button type="button" id="ttArchiveDayEditSave" class="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-black text-white">حفظ تعديلات اليوم</button></div></div>';
      document.body.appendChild(modal);
      modal.querySelectorAll("[data-close-day-edit]").forEach(button=>button.addEventListener("click",()=>modal.remove()));
      modal.querySelector("#ttArchiveDayEditSave").addEventListener("click",async()=>{
        const button=modal.querySelector("#ttArchiveDayEditSave"),errorBox=modal.querySelector("#ttArchiveDayEditError");
        const changes=[];
        modal.querySelectorAll("[data-batch-sub-id]").forEach(select=>{
          const id=select.dataset.batchSubId,reasonInput=modal.querySelector('[data-batch-reason="'+id+'"]');
          const reason=(reasonInput?.value||"").trim()||"-";
          if(select.value!==select.dataset.originalSub||reason!==(reasonInput?.dataset.originalReason||"-")){
            changes.push({assignmentId:id,substituteTeacherName:select.value,reserveReason:reason});
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
        }catch(error){errorBox.textContent=error?.message||"تعذر حفظ تعديلات اليوم؛ لم يتم اعتماد أي تعديل جزئي.";errorBox.classList.remove("hidden");button.disabled=false;button.textContent="حفظ تعديلات اليوم";}
      });
    }catch(error){status(error?.message||"تعذر فتح توزيع اليوم للتعديل.","error");}
  };


  window.timetableDailyCancelAssignment = async function (assignmentId) {
    const item=reserveArchive.find(row=>row.id===assignmentId)||(reserveBatchPreview?.existingAssignments||[]).find(row=>row.id===assignmentId);
    if(!item){status("تعذر العثور على التكليف. حدّث القائمة ثم حاول مجدداً.","error");return;}
    if(item.canEdit===false||!["assigned","confirmed"].includes(item.status)){status("هذا التكليف غير نشط أو مرتبط بإصدار جدول سابق؛ لا يمكن إلغاؤه من هذه الشاشة.","error");return;}
    if(!window.confirm("سيتم إلغاء هذا التكليف المحدد فقط وإزالته من التوزيع النشط، مع الاحتفاظ بسجل المراجعة. هل تريد المتابعة؟"))return;
    try{
      const token=appAuthSession?.token||readAppAuthToken();
      await appAuthRequest({action:"timetable_substitution_cancel",assignmentId,weekday:item.weekday,assignmentDate:item.assignmentDate},token);
      status("تم إلغاء التكليف المحدد. بقي سجل العملية محفوظاً للمراجعة.","success");
      await timetableDailyRefreshAll();
      if(!$("timetableDailyArchivePanel")?.classList.contains("hidden"))await timetableDailyLoadArchive();
    }catch(error){status(error?.message||"تعذر إلغاء التكليف؛ لم يُحذف أي سجل.","error");}
  };

  window.timetableDailyOpenArchiveEdit = async function (assignmentId) {
    const item=reserveArchive.find(row=>row.id===assignmentId)||(reserveBatchPreview?.existingAssignments||[]).find(row=>row.id===assignmentId);
    if(!item){status("تعذر العثور على التكليف. حدّث قائمة الاحتياط ثم حاول مجدداً.","error");return;}
    try{
      if(item.canEdit===false||!["assigned","confirmed"].includes(item.status)){status("هذا التكليف مرتبط بإصدار سابق أو حالته غير نشطة؛ يمكن مراجعته فقط.","error");return;}
      const token=appAuthSession?.token||readAppAuthToken();
      const directoryResult=await appAuthRequest({action:"timetable_substitution_preview",weekday:item.weekday,assignmentDate:item.assignmentDate,includeOtherDepartments:includeOthers(),otherDepartmentId:selectedOtherDepartmentId()},token);
      const absentNames=Array.isArray(directoryResult.absentTeachers)?directoryResult.absentTeachers:[];
      if(!absentNames.includes(item.absentTeacherName))absentNames.unshift(item.absentTeacherName);
      const initialPreview=await fetchArchivePreview(item.absentTeacherName,item.assignmentDate,item.weekday);
      const initialLesson=(initialPreview.lessons||[]).find(row=>Number(row.period)===Number(item.period));
      const makeOptions=(candidates,selected)=>{
        const rows=Array.isArray(candidates)?candidates:[];
        const choices=rows.filter(candidate=>candidate.name!==selected).map(candidate=>'<option value="'+esc(candidate.name)+'">'+esc(candidate.name)+' · رصيد '+Number(candidate.pointsBalance||0)+'</option>').join("");
        return '<option value="'+esc(selected)+'" selected>'+esc(selected)+' (الحالي)</option>'+choices;
      };
      const modal=document.createElement("div");modal.id="timetableDailyArchiveEditModal";
      modal.className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm";
      modal.innerHTML='<div class="max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto rounded-3xl border border-white/30 bg-white/95 p-5 shadow-2xl backdrop-blur-xl"><div class="flex items-center justify-between"><div><h3 class="font-black text-base text-slate-900">تعديل تكليف الاحتياط</h3><p class="mt-1 text-[10px] text-slate-500">الحصة '+Number(item.period)+' · '+esc(item.assignmentDate||"")+'</p></div><button type="button" data-close-edit class="rounded-xl bg-slate-100 px-3 py-2">×</button></div>'+
        '<label class="block text-xs font-black text-slate-700">المعلم الغائب<select id="ttArchiveEditAbsent" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs">'+absentNames.map(name=>'<option value="'+esc(name)+'" '+(name===item.absentTeacherName?"selected":"")+'>'+esc(name)+'</option>').join("")+'</select></label>'+
        '<label class="block text-xs font-black text-slate-700">المعلم البديل<select id="ttArchiveEditSubstitute" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs">'+makeOptions(initialLesson?.candidates,item.substituteTeacherName)+'</select></label>'+
        '<label class="block text-xs font-black text-slate-700">سبب الاحتياط (اختياري)<textarea id="ttArchiveEditReason" rows="2" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs" placeholder="اكتب السبب أو اتركه فارغاً">'+esc(item.reason==="-"?"":item.reason||"")+'</textarea></label>'+
        '<div id="ttArchiveEditError" class="hidden rounded-xl bg-red-50 p-3 text-xs text-red-700"></div><div class="flex flex-wrap justify-end gap-2"><button type="button" data-close-edit class="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold">إلغاء</button><button type="button" id="ttArchiveEditSave" class="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-black text-white">حفظ التعديل</button></div></div>';
      document.body.appendChild(modal);
      modal.querySelectorAll("[data-close-edit]").forEach(button=>button.addEventListener("click",()=>modal.remove()));
      const absentSelect=modal.querySelector("#ttArchiveEditAbsent"),subSelect=modal.querySelector("#ttArchiveEditSubstitute");
      absentSelect.addEventListener("change",async()=>{
        absentSelect.disabled=true;subSelect.disabled=true;
        try{
          const preview=await fetchArchivePreview(absentSelect.value,item.assignmentDate,item.weekday);
          const lesson=(preview.lessons||[]).find(row=>Number(row.period)===Number(item.period));
          subSelect.innerHTML=makeOptions(lesson?.candidates,item.substituteTeacherName);
        }catch(error){
          const box=modal.querySelector("#ttArchiveEditError");box.textContent=error?.message||"تعذر تحميل البدائل للمعلم الغائب المحدد.";box.classList.remove("hidden");
        }finally{absentSelect.disabled=false;subSelect.disabled=false;}
      });
      modal.querySelector("#ttArchiveEditSave").addEventListener("click",async()=>{
        const button=modal.querySelector("#ttArchiveEditSave"),errorBox=modal.querySelector("#ttArchiveEditError");
        button.disabled=true;button.textContent="جارٍ الحفظ...";
        try{
          await appAuthRequest({action:"timetable_substitution_update",assignmentId,absentTeacherName:absentSelect.value,substituteTeacherName:subSelect.value,reserveReason:modal.querySelector("#ttArchiveEditReason").value.trim()||"-",includeOtherDepartments:includeOthers()},token);
          modal.remove();
          if(absentSelect.value!==item.absentTeacherName&&!timetableDailyAbsentTeachers.includes(absentSelect.value)){timetableDailyAbsentTeachers.push(absentSelect.value);timetableDailyRenderTags();}
          status("تم حفظ التعديل؛ أُبقي السجل السابق والجديد في سجل المراجعة.","success");
          await timetableDailyRefreshAll();
          if(!$("timetableDailyArchivePanel")?.classList.contains("hidden"))await timetableDailyLoadArchive();
        }catch(error){errorBox.textContent=error?.message||"تعذر حفظ التعديل.";errorBox.classList.remove("hidden");button.disabled=false;button.textContent="حفظ التعديل";}
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
    return new Intl.DateTimeFormat("ar-OM",{day:"numeric",month:"long",numberingSystem:"latn",timeZone:"Asia/Muscat"}).format(date);
  }
  function formatReservePrintPeriod(period){return ({1:"١",2:"٢",3:"٣",4:"٤",5:"٥",6:"٦",7:"٧",8:"٨"})[Number(period)]||String(period);}
  const RESERVE_OFFICIAL_ROWS_PER_PAGE = 15;
  function reserveOfficialPrintPages(groups,date,weekday){
    const pages=[];let current=[],count=0;
    (groups||[]).forEach(group=>{
      const rows=(group.rows||[]).slice().sort((a,b)=>Number(a.period)-Number(b.period));
      if(!rows.length)return;
      if(rows.length>RESERVE_OFFICIAL_ROWS_PER_PAGE){if(count){pages.push(current);current=[];count=0;}for(let i=0;i<rows.length;i+=RESERVE_OFFICIAL_ROWS_PER_PAGE)pages.push([{...group,rows:rows.slice(i,i+RESERVE_OFFICIAL_ROWS_PER_PAGE)}]);return;}
      if(count+rows.length>RESERVE_OFFICIAL_ROWS_PER_PAGE){pages.push(current);current=[];count=0;}
      current.push({...group,rows});count+=rows.length;
    });
    if(current.length)pages.push(current);if(!pages.length)pages.push([]);
    return pages.map(pageGroups=>reserveOfficialPrintMarkup(pageGroups,date,weekday));
  }
  function reserveOfficialPrintMarkup(groups,date,weekday){
    const widths=[22,16,8,11,14,12,17];
    const columns='<colgroup>'+widths.map(width=>'<col style="width:'+width+'%">').join('')+'</colgroup>';
    const header='<thead><tr><th>المعلم الغائب</th><th>سبب الغياب</th><th>الحصة</th><th>الصف</th><th>معلم الاحتياط</th><th>التوقيع</th><th>الملاحظات</th></tr></thead>';
    let used=0;
    const rowsMarkup=(groups||[]).map(group=>{
      const rows=(group.rows||[]).slice().sort((a,b)=>Number(a.period)-Number(b.period));if(!rows.length)return "";used+=rows.length;
      const absent=esc(group.absentName||""),rawReason=String(group.reason||"").trim(),reason=esc(rawReason==="-"||rawReason==="—"?"":rawReason);
      return rows.map((row,rowIndex)=>{
        const merged=rowIndex===0?'<td class="tt-official-merged" rowspan="'+rows.length+'">'+absent+'</td><td class="tt-official-merged" rowspan="'+rows.length+'">'+reason+'</td>':"";
        return '<tr class="'+(rowIndex===0?'tt-official-group-start':'')+'">'+merged+'<td>'+esc(formatReservePrintPeriod(row.period))+'</td><td>'+esc(row.className||"")+'</td><td>'+esc(row.substitute||"")+'</td><td class="tt-official-blank"></td><td class="tt-official-blank"></td></tr>';
      }).join("");
    }).join("");
    const remaining=Math.max(0,RESERVE_OFFICIAL_ROWS_PER_PAGE-used);
    const reservedSecondTeacher=(groups||[]).length===1&&remaining>0
      ?Array.from({length:remaining},(_,i)=>'<tr class="'+(i===0?'tt-official-group-start':'')+'">'+(i===0?'<td class="tt-official-merged" rowspan="'+remaining+'"></td><td class="tt-official-merged" rowspan="'+remaining+'"></td>':"")+'<td></td><td></td><td></td><td class="tt-official-blank"></td><td class="tt-official-blank"></td></tr>').join("")
      :"";
    const safeDate=String(date||"");let resolvedWeekday=String(weekday||"").trim();
    if(!resolvedWeekday&&safeDate){const d=new Date(safeDate+"T12:00:00+04:00");if(Number.isFinite(d.getTime()))resolvedWeekday=new Intl.DateTimeFormat("ar-OM",{weekday:"long",timeZone:"Asia/Muscat"}).format(d);}
    return '<main class="tt-official-page"><header class="tt-official-heading"><div>سلطنة عمان</div><div>وزارة التعليم</div><div>المديرية العامة للتعليم بمحافظة شمال الباطنة</div><div>إدارة التعليم بالسويق</div><div class="tt-official-school">مدرسة أبو دجانة الأنصاري للبنين (9 - 12)</div></header>'+
      '<div class="tt-official-meta"><div><strong>اليوم:</strong> '+esc(resolvedWeekday)+'</div><div><strong>التاريخ:</strong> '+esc(formatReserveDateArabic(safeDate))+'</div></div>'+
      '<table class="tt-official-table">'+columns+header+'<tbody>'+rowsMarkup+reservedSecondTeacher+'</tbody></table>'+
      '<footer class="tt-official-footer"><div class="tt-official-manager"><strong>د. ناصر السناني</strong><span>مدير المدرسة</span></div><div class="tt-official-stamp">ختم المدرسة</div></footer></main>';
  }
  function printOfficialReservePages(pages){
    document.getElementById("ttReservePrintRoot")?.remove();document.getElementById("ttReserveOfficialPrintStyle")?.remove();
    const style=document.createElement("style");style.id="ttReserveOfficialPrintStyle";
    style.textContent='@page{size:A4 portrait;margin:8mm}html,body{margin:0!important;padding:0!important;background:#fff!important}body.tt-reserve-print-mode>*:not(#ttReservePrintRoot){display:none!important}body.tt-reserve-print-mode{background:#fff!important;color:#111!important}#ttReservePrintRoot{display:block!important;width:100%;margin:0!important;padding:0!important;color:#111!important;font-family:Tahoma,Arial,sans-serif;direction:rtl}'+
      '.tt-official-page{box-sizing:border-box;width:100%;height:281mm;min-height:281mm;max-height:281mm;display:flex;flex-direction:column;direction:rtl;background:#fff;overflow:hidden;page-break-after:always;break-after:page}.tt-official-page:last-child{page-break-after:auto;break-after:auto}'+
      '.tt-official-heading{flex:0 0 auto;text-align:center;font-size:12pt;font-weight:700;line-height:1.7;padding:0 0 3mm;border-bottom:1px solid #222}.tt-official-heading>div{margin:0}.tt-official-school{font-weight:900;font-size:13pt;margin-top:1mm!important}'+
      '.tt-official-meta{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:10mm;font-size:12pt;font-weight:700;margin:4mm 0 3mm}.tt-official-table{flex:0 0 auto;width:100%;height:180mm;border-collapse:collapse;table-layout:fixed;direction:rtl;margin:0;font-size:10pt;break-inside:avoid;page-break-inside:avoid}.tt-official-table thead{display:table-header-group;height:12mm}.tt-official-table th,.tt-official-table td{box-sizing:border-box;border:1px solid #222;text-align:center;vertical-align:middle;padding:1.5mm 1mm;overflow-wrap:anywhere}.tt-official-table th{height:12mm;font-size:10.5pt;font-weight:900;background:#f1f1f1;-webkit-print-color-adjust:exact;print-color-adjust:exact}.tt-official-table tbody tr{height:11.2mm;break-inside:avoid;page-break-inside:avoid}.tt-official-table tbody td{height:11.2mm}.tt-official-table .tt-official-merged{font-weight:800;white-space:normal}.tt-official-table .tt-official-group-start td{border-top:1.5px solid #111}'+
      '.tt-official-footer{direction:ltr;flex:0 0 25mm;display:flex;justify-content:space-between;align-items:flex-end;margin-top:auto;padding-top:3mm;font-size:12pt}.tt-official-manager{direction:rtl;display:flex;flex-direction:column;gap:2mm;text-align:center;font-weight:700}.tt-official-stamp{direction:rtl;width:42mm;height:20mm;display:flex;align-items:flex-start;justify-content:center;font-weight:700}'+
      '@media screen{#ttReservePrintRoot{width:210mm;margin:12px auto!important;padding:8mm!important;background:#fff;box-shadow:0 2px 18px #0002}.tt-official-page{margin:0 auto 8mm}}@media print{#ttReservePrintRoot{width:auto}.tt-official-page{margin:0}}';
    document.head.appendChild(style);const root=document.createElement("div");root.id="ttReservePrintRoot";root.innerHTML=(pages||[]).join("");document.body.appendChild(root);document.body.classList.add("tt-reserve-print-mode");
    let cleaned=false;const cleanup=()=>{if(cleaned)return;cleaned=true;document.body.classList.remove("tt-reserve-print-mode");root.remove();style.remove();window.removeEventListener("afterprint",cleanup);};
    window.addEventListener("afterprint",cleanup,{once:true});window.print();setTimeout(cleanup,15000);
  }
  function buildReserveReportGroups(response){
    const current=currentPlanRows(response||{}),saved=current.saved||[],planned=current.planned||[],missing=current.missing||[];
    return timetableDailyAbsentTeachers.map(absentName=>{
      const rows=[
        ...saved.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,subject:x.subject,substitute:x.substituteTeacherName})),
        ...planned.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,subject:x.subject,substitute:x.substituteTeacherName})),
        ...missing.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,subject:x.subject,substitute:""}))
      ].sort((a,b)=>Number(a.period)-Number(b.period));
      return {absentName,reason:String(reserveReasons[absentName]||rows.find(row=>row.reason)?.reason||""),rows};
    }).filter(group=>group.rows.length);
  }
  window.timetableDailyPrintReport = async function () {
    if(!reserveBatchPreview&&timetableDailyAbsentTeachers.length)await timetableDailyRefreshAll();
    if(!timetableDailyAbsentTeachers.length){status("اختر المعلمين الغائبين قبل الطباعة.","error");return;}
    const groups=buildReserveReportGroups(reserveBatchPreview||{});
    if(!groups.length){status("لا توجد حصص متاحة للطباعة.","error");return;}
    const date=$("timetableSubstitutionDate")?.value||"",weekday=$("timetableSubstitutionWeekday")?.value||"";
    printOfficialReservePages(reserveOfficialPrintPages(groups,date,weekday));
  };

  window.timetableDailyShareWhatsApp = async function () {
    if(!timetableDailyAbsentTeachers.length){status("أضف المعلمين الغائبين أولاً.","error");return;}
    const popup=window.open("about:blank","_blank");if(!popup){status("اسمح بالنوافذ المنبثقة لمشاركة كشف واتساب.","error");return;}
    try{
      if(!reserveBatchPreview)await timetableDailyRefreshAll();
      const groups=buildReserveReportGroups(reserveBatchPreview||{});
      if(!groups.length){popup.close();status("لا توجد حصص لعرضها في كشف اليوم.","info");return;}
      const date=$("timetableSubstitutionDate")?.value||"",weekday=$("timetableSubstitutionWeekday")?.value||"";
      const subject=[...new Set(groups.flatMap(group=>group.rows.map(row=>String(row.subject||"").trim()).filter(Boolean)))].join("، ")||"المادة المحددة";
      let message="*توزيع حصص الاحتياط*\n*لمادة "+subject+"*\n\n*"+weekday+"*\n_"+formatReserveDateArabic(date)+"_\n\n";
      groups.forEach((group,index)=>{
        const heading=groups.length===1?group.absentName:"المعلم الغائب "+(index+1)+": "+group.absentName;
        message+="*"+heading+"*\n\n";
        group.rows.forEach(row=>{
          message+="الحصة "+formatReservePeriod(row.period)+" – الصف "+(row.className||"غير محدد")+"\n";
          message+="المعلم البديل: *"+(row.substitute||"لم يحدد")+"*\n\n";
        });
        if(index<groups.length-1)message+="\n";
      });
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
      '<div id="ttAdminToolsStatus" class="hidden rounded-lg p-3 text-xs font-bold" role="status" aria-live="polite"></div>';
    panel.appendChild(card);
    const token=()=>appAuthSession?.token||readAppAuthToken();
    const say=(message,error=false)=>{const box=$("ttAdminToolsStatus");if(!box)return;box.textContent=message;box.className="rounded-lg p-3 text-xs font-bold "+(error?"bg-red-100 text-red-800":"bg-emerald-100 text-emerald-800");};
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

  installReserveEnhancements();
  window.timetableDailyInstallAdminTools=installAdminReserveTools;
  window.timetableDailyInstallDepartmentTools=installDepartmentReserveTools;
  installDepartmentReserveTools();
  installAdminReserveTools();
  applyTeacherTimetablePresentation();
  if(typeof MutationObserver!=="undefined"&&document.body){
    const adminToolsObserver=new MutationObserver(()=>{installDepartmentReserveTools();installAdminReserveTools();applyTeacherTimetablePresentation();});
    adminToolsObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["class","style"]});
    const timetableHost=$("teacherTimetableWeekGrid");
    if(timetableHost){
      const timetableObserver=new MutationObserver(()=>applyTeacherTimetablePresentation());
      timetableObserver.observe(timetableHost,{childList:true,subtree:true});
    }
  }
})();