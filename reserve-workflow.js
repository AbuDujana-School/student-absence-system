/* Reserve workflow enhancement: whole-day matching, staged edits, archive and A4 report. */
(function () {
  "use strict";
  let reserveBatchPreview = null;
  let reserveDraftAssignments = [];
  let reserveReasons = Object.create(null);
  let reserveManualChoices = Object.create(null);
  let reserveDraftScope = "";
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
        absentTeachers:[...timetableDailyAbsentTeachers],manualChoices:reserveManualChoices,reasons:reserveReasons}));
    }catch{}
  }
  function restoreStoredDraft(){
    if(reserveDraftRestoreChecked)return false;
    reserveDraftRestoreChecked=true;
    try{
      const actor=currentActorName();if(!actor)return false;
      const raw=localStorage.getItem(DRAFT_STORAGE_KEY);if(!raw)return false;
      const saved=JSON.parse(raw),current=timetableSubstitutionGetDate();
      if(saved.actor!==actor||saved.date!==current.date||saved.weekday!==current.weekday||
         !Number.isFinite(saved.savedAt)||Date.now()-saved.savedAt>8*60*60*1000){clearStoredDraft();return false;}
      if(!Array.isArray(saved.absentTeachers)||!saved.absentTeachers.length)return false;
      timetableDailyAbsentTeachers=[...new Set(saved.absentTeachers.map(String).filter(Boolean))];
      reserveManualChoices=Object.assign(Object.create(null),saved.manualChoices||{});
      reserveReasons=Object.assign(Object.create(null),saved.reasons||{});
      reserveDraftScope=currentDraftScope();
      if(typeof timetableDailyRenderTags==="function")timetableDailyRenderTags();
      status("استُعيدت مسودة الاحتياط غير المحفوظة من هذا الجهاز. راجعها قبل الاعتماد.","info");
      return true;
    }catch{return false;}
  }
  const draftKey = (name, period) => String(name) + "\u0000" + Number(period);
  function currentDraftScope() {
    try { const value=timetableSubstitutionGetDate(); return [value.date,value.weekday,includeOthers()?"all":"department"].join("|"); }
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
  const ABSENCE_REASONS = ["دورة تدريبية","طارئة","موعد مستشفى","إجازة مرضية","إجازة أبوة","مرافقة مريض","أخرى"];
  function reasonControlMarkup(absentName, reason) {
    const value=String(reason||"").trim();
    const isKnown=ABSENCE_REASONS.includes(value);
    const selected=isKnown?value:(value?"أخرى":"");
    const custom=value&&!isKnown?value:"";
    return '<div class="w-full max-w-md"><label class="mb-1 block text-[10px] font-black text-slate-600">سبب الغياب <span class="font-normal text-slate-400">(اختر سبباً لكل معلم)</span></label>'+
      '<select data-tt-reason-select="'+esc(absentName)+'" class="tt-reason"><option value="">اختر سبب الغياب</option>'+
      ABSENCE_REASONS.map(option=>'<option value="'+esc(option)+'" '+(selected===option?"selected":"")+'>'+esc(option)+'</option>').join("")+
      '</select><input type="text" data-tt-reason-custom="'+esc(absentName)+'" class="tt-reason mt-2 '+(selected==="أخرى"?"":"hidden")+'" maxlength="500" placeholder="اكتب سبب الغياب بالتفصيل" value="'+esc(custom)+'"></div>';
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
        $("timetableDailyOtherDepartmentsButton").innerHTML = toggle.checked
          ? '<i class="fa-solid fa-filter-circle-xmark ml-1"></i> إخفاء الأقسام الأخرى'
          : '<i class="fa-solid fa-people-group ml-1"></i> جلب بدلاء من الأقسام الأخرى';
        await timetableDailyRefreshAll();
      });
    }
    const results = $("timetableSubstitutionResults");
    if (results) {
      results.insertAdjacentHTML("beforebegin", '<div id="timetableDailySummary" class="grid grid-cols-2 gap-2 sm:grid-cols-4"></div>');
      results.insertAdjacentHTML("afterend",
        '<section id="timetableDailyArchivePanel" class="hidden mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/40">' +
        '<div class="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h4 class="font-black text-sm text-slate-900 dark:text-white">أرشيف توزيع الاحتياط</h4><p class="mt-1 text-[10px] text-slate-500">جميع التكليفات السابقة محفوظة بالتاريخ، ويمكن فتح التكليف وتعديله.</p></div><button type="button" id="timetableDailyArchiveReload" class="tt-action border border-slate-300 bg-white text-slate-800">تحديث الأرشيف</button></div>' +
        '<div id="timetableDailyArchiveResults" class="space-y-3"></div></section>');
      $("timetableDailyArchiveReload")?.addEventListener("click", timetableDailyLoadArchive);
    }
    const style = document.createElement("style");
    style.id = "reserve-workflow-styles";
    style.textContent = [
      "#timetableSubstitutionPanel{isolation:isolate}",
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
  }

  async function fetchBatchPreview() {
    const {date, weekday} = timetableSubstitutionGetDate();
    const token = appAuthSession?.token || readAppAuthToken();
    if (!token) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({
      action: "timetable_substitution_batch_preview", weekday, assignmentDate: date,
      absentTeacherNames: [...timetableDailyAbsentTeachers], includeOtherDepartments: includeOthers()
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
      reserveBatchPreview = null; reserveDraftAssignments = []; reserveManualChoices=Object.create(null); reserveDraftScope=""; window.timetableDailyRenderLessons(); return;
    }
    const scope=currentDraftScope();
    if(reserveDraftScope&&reserveDraftScope!==scope)reserveManualChoices=Object.create(null);
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
      reserveDraftAssignments = []; reserveManualChoices=Object.create(null); window.timetableDailyRenderLessons();
      status(error?.message || "تعذر تحليل جميع الحصص دفعة واحدة.", "error"); throw error;
    }
  };

  window.timetableDailyRemoveAbsent = async function (name) {
    if (timetableDailyBusy) return;
    timetableDailyAbsentTeachers = timetableDailyAbsentTeachers.filter(item => item !== name);
    delete reserveReasons[name];
    Object.keys(reserveManualChoices).filter(key=>key.startsWith(String(name)+"\u0000")).forEach(key=>delete reserveManualChoices[key]);
    timetableDailyRenderTags(); await window.timetableDailyRefreshAll();
  };

  window.timetableDailyRenderLessons = function () {
    const host = $("timetableSubstitutionResults"), summary = $("timetableDailySummary");
    if (!host) return;
    if (reserveBatchPreview?.error) {
      host.innerHTML = '<div class="rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-bold text-red-700">' + esc(reserveBatchPreview.error) + "</div>";
      if (summary) summary.innerHTML = ""; return;
    }
    if (!timetableDailyAbsentTeachers.length) {
      host.innerHTML = '<div class="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-500"><i class="fa-solid fa-user-plus mb-2 block text-2xl text-slate-400"></i>ابحث عن المعلم الغائب ثم أضفه إلى القائمة.</div>';
      if (summary) summary.innerHTML = ""; return;
    }
    const planned = reserveBatchPreview?.assignments || [], missing = reserveBatchPreview?.unassigned || [], saved = reserveBatchPreview?.existingAssignments || [];
    const total = planned.length + missing.length + saved.length;
    if (summary) summary.innerHTML = [
      ["المعلمون الغائبون",timetableDailyAbsentTeachers.length,"fa-users"],["إجمالي الحصص",total,"fa-book-open"],
      ["اقتراحات جاهزة",planned.length,"fa-circle-check"],["تحتاج معالجة",missing.length,"fa-triangle-exclamation"]
    ].map(([label,value,icon]) => '<div class="tt-stat"><span class="text-[10px] font-bold text-slate-500"><i class="fa-solid ' + icon + ' ml-1"></i>' + label + '</span><strong>' + Number(value) + "</strong></div>").join("");
    host.innerHTML = timetableDailyAbsentTeachers.map(absentName => {
      const rows = [
        ...planned.filter(item=>item.absentTeacherName===absentName).map(item=>({...item,kind:"planned"})),
        ...missing.filter(item=>item.absentTeacherName===absentName).map(item=>({...item,kind:"missing"})),
        ...saved.filter(item=>item.absentTeacherName===absentName).map(item=>({...item,kind:"saved"}))
      ].sort((a,b)=>Number(a.period)-Number(b.period));
      if (!rows.length) return "";
      const savedReason = saved.find(item=>item.absentTeacherName===absentName&&item.reason&&item.reason!=="-")?.reason || "";
      if (reserveReasons[absentName] === undefined && savedReason) reserveReasons[absentName] = savedReason;
      const reason = reserveReasons[absentName] ?? savedReason;
      const cards = rows.map(item => {
        const draft = reserveDraftAssignments.find(row=>row.absentTeacherName===absentName&&Number(row.period)===Number(item.period));
        let choice="", action="";
        if (item.kind==="saved") {
          const state=item.status==="completed"?"مكتمل":item.status==="confirmed"?"مؤكد":item.status==="cancelled"?"ملغى":"محفوظ";
          choice='<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-800"><div>البديل المحفوظ: '+esc(item.substituteTeacherName)+' · '+state+'</div><div class="mt-1 text-[10px] font-normal">سبب الاحتياط: '+esc(item.reason||"-")+'</div></div>';
          action=["assigned","confirmed"].includes(item.status)?'<button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-edit="'+esc(item.id)+'">تعديل</button>':"";
        } else {
          const candidates=item.candidateOptions||[];
          const options=candidates.map(candidate=>'<option value="'+esc(candidate.teacherName)+'" '+(draft?.substituteTeacherName===candidate.teacherName?"selected":"")+'>'+esc(candidate.teacherName)+' · رصيد '+Number(candidate.pointsBalance||0)+' · احتياط اليوم '+Number(candidate.dailySubstitutionCount||0)+'</option>').join("");
          choice=candidates.length?'<label class="block"><span class="mb-1 block text-[10px] font-bold text-slate-500">أفضل البدلاء المتاحين لهذه الحصة، مرتبين حسب الملاءمة</span><select data-tt-substitute data-absent="'+esc(absentName)+'" data-period="'+Number(item.period)+'"><option value="">اختر البديل</option>'+options+'</select></label>':'<div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">لا يوجد معلم متاح بفراغ مؤكد لهذه الحصة.</div>';
          if(draft?.createsThreeConsecutive||item.createsThreeConsecutive)choice+='<div class="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-[10px] font-bold text-amber-800">تنبيه: هذا الاختيار يكوّن ثلاث حصص متتالية أو أكثر.</div>';
          action='<span class="text-[10px] text-slate-500">'+(draft?"مقترح قابل للتعديل":"لا يوجد اقتراح")+"</span>";
        }
        return '<article class="tt-lesson"><div class="tt-lesson-main"><div class="text-[10px] font-bold text-slate-500">الحصة '+Number(item.period)+'</div><strong class="mt-1 block text-xs text-slate-900">'+esc(item.className||"الشعبة غير محددة")+'</strong><div class="mt-1 text-[10px] text-slate-500">'+esc(item.subject||"المادة غير محددة")+'</div></div><div class="tt-lesson-choice">'+choice+'</div><div class="tt-lesson-actions">'+action+"</div></article>";
      }).join("");
      return '<section class="tt-group"><div class="tt-group-head"><div><div class="text-[10px] font-black text-emerald-700">المعلم الغائب</div><h4 class="mt-1 text-sm font-black text-slate-900">'+esc(absentName)+'</h4><div class="mt-1 text-[10px] text-slate-500">'+rows.length+' حصة · '+rows.filter(x=>x.kind==="saved").length+' محفوظة · '+rows.filter(x=>x.kind==="planned").length+' مقترحة</div></div>'+reasonControlMarkup(absentName,reason)+'</div><div class=\"space-y-2 p-3 sm:p-4\">"+cards+"</div></section>";
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
      }else{
        item.substituteTeacherName="";
        delete reserveManualChoices[draftKey(item.absentTeacherName,item.period)];
        status("أزيل اختيار البديل لهذه الحصة.","info");
      }
    }));
    host.querySelectorAll("[data-tt-reason-select]").forEach(select=>select.addEventListener("change",()=>{
      const name=select.dataset.ttReasonSelect,custom=host.querySelector('[data-tt-reason-custom="'+name+'"]');
      if(custom){custom.classList.toggle("hidden",select.value!=="أخرى");if(select.value!=="أخرى")custom.value="";}
      reserveReasons[name]=select.value==="أخرى"?(custom?.value||"").trim():select.value;
      persistStoredDraft();
      if(select.value==="أخرى")custom?.focus();
    }));
    host.querySelectorAll("[data-tt-reason-custom]").forEach(input=>input.addEventListener("input",()=>{
      reserveReasons[input.dataset.ttReasonCustom]=input.value.trim();
      persistStoredDraft();
    }));
    host.querySelectorAll("[data-tt-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveEdit(button.dataset.ttEdit)));
  };

  window.timetableDailyAutoAssign = async function () {
    if(timetableDailyBusy)return;
    if(!timetableDailyAbsentTeachers.length){status("أضف معلماً غائباً واحداً على الأقل.","error");return;}
    timetableDailyBusy=true;timetableDailySetBusy(true);
    try{
      reserveManualChoices=Object.create(null);
      reserveBatchPreview=await fetchBatchPreview();
      if(reserveBatchPreview.active===false)throw new Error("لا يوجد جدول أسبوعي نشط لتوزيع الاحتياط.");
      reserveDraftScope=currentDraftScope();
      reserveDraftAssignments=(reserveBatchPreview.assignments||[]).map(item=>({absentTeacherName:item.absentTeacherName,substituteTeacherName:item.substituteTeacherName,period:Number(item.period),candidateOptions:item.candidateOptions||[]}));
      timetableDailyRenderLessons();
      status("قرأ النظام جميع حصص الغياب معاً وأعد أفضل توزيع شامل. راجع البدلاء والأسباب ثم اضغط حفظ التوزيع.","success");
    }catch(error){status(error?.message||"تعذر إعداد التوزيع الذكي.","error");}
    finally{timetableDailyBusy=false;timetableDailySetBusy(false);}
  };

  window.timetableDailySaveBatch = async function () {
    if(timetableDailyBusy)return;
    if(!timetableDailyAbsentTeachers.length){status("اختر المعلمين الغائبين أولاً.","error");return;}
    const assignments=reserveDraftAssignments.filter(item=>item.substituteTeacherName).map(item=>({
      absentTeacherName:item.absentTeacherName,substituteTeacherName:item.substituteTeacherName,period:Number(item.period),
      reserveReason:(reserveReasons[item.absentTeacherName]||"").trim()||"-"
    }));
    if(!assignments.length){status("لا توجد اقتراحات جاهزة للحفظ. أعد إعداد التوزيع الذكي أو اختر البدلاء يدوياً.","error");return;}
    timetableDailyBusy=true;timetableDailySetBusy(true);
    try{
      const {date,weekday}=timetableSubstitutionGetDate(),token=appAuthSession?.token||readAppAuthToken();
      const result=await appAuthRequest({action:"timetable_substitution_batch_save",weekday,assignmentDate:date,
        absentTeacherNames:[...timetableDailyAbsentTeachers],assignments,includeOtherDepartments:includeOthers()},token);
      status("تم حفظ "+(result.assignmentCount||assignments.length)+" تكليف في عملية واحدة. يجري تحديث الأرشيف.","success");
      clearStoredDraft();reserveManualChoices=Object.create(null);
      await timetableDailyRefreshAll();await timetableDailyLoadArchive();
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
      const {weekday}=timetableSubstitutionGetDate(),token=appAuthSession?.token||readAppAuthToken();
      const response=await appAuthRequest({action:"timetable_substitution_archive",weekday},token);
      reserveArchive=response.archive||[];timetableDailyRenderArchive();
    }catch(error){host.innerHTML='<div class="rounded-xl bg-red-50 p-3 text-xs text-red-700">'+esc(error?.message||"تعذر تحميل الأرشيف.")+"</div>";}
  };
  async function fetchArchivePreview(absentName, date, weekday) {
    const token=appAuthSession?.token||readAppAuthToken();
    if(!token)throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    return await appAuthRequest({action:"timetable_substitution_preview",weekday,assignmentDate:date,
      absentTeacherName:absentName,includeOtherDepartments:includeOthers()},token);
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
          (editable?'<button type="button" class="tt-action border border-indigo-200 bg-indigo-50 text-indigo-800" data-tt-archive-edit="'+esc(item.id)+'">تعديل الحصة</button>':'<span class="text-[10px] text-slate-400">'+(readOnly?"للعرض فقط":state)+"</span>")+"</div>";
      }).join("");
      const dayButton=editableItems.length?'<button type="button" class="tt-action bg-indigo-700 text-white" data-tt-open-day-edit="'+esc(date)+'">فتح توزيع اليوم وتعديله ('+editableItems.length+')</button>':"";
      return '<details open class="rounded-xl border border-slate-200 bg-white p-3"><summary class="cursor-pointer text-xs font-black text-slate-800">'+esc(date)+" · "+items.length+' تكليف</summary><div class="mt-3 flex justify-end">'+dayButton+'</div><div class="mt-3 space-y-2">'+rows+"</div></details>";
    }).join("");
    host.querySelectorAll("[data-tt-archive-edit]").forEach(button=>button.addEventListener("click",()=>timetableDailyOpenArchiveEdit(button.dataset.ttArchiveEdit)));
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

  window.timetableDailyOpenArchiveEdit = async function (assignmentId) {
    const item=reserveArchive.find(row=>row.id===assignmentId);
    if(!item){status("تعذر العثور على التكليف في الأرشيف. حدّث الأرشيف.","error");return;}
    try{
      if(item.canEdit===false){status("هذا السجل مرتبط بإصدار جدول سابق؛ يمكن مراجعته لكن لا يمكن تعديله بأمان من الإصدار الحالي.","error");return;}
      const preview=await fetchArchivePreview(item.absentTeacherName,item.assignmentDate,item.weekday);
      const lesson=(preview.lessons||[]).find(row=>Number(row.period)===Number(item.period));
      const candidates=lesson?.candidates||[];
      const modal=document.createElement("div");modal.id="timetableDailyArchiveEditModal";
      modal.className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm";
      modal.innerHTML='<div class="w-full max-w-lg space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl"><div class="flex items-center justify-between"><div><h3 class="font-black text-base text-slate-900">تعديل تكليف الاحتياط</h3><p class="mt-1 text-[10px] text-slate-500">'+esc(item.absentTeacherName)+" · الحصة "+Number(item.period)+" · "+esc(item.assignmentDate||"")+'</p></div><button type="button" data-close-edit class="rounded-xl bg-slate-100 px-3 py-2">×</button></div>'+
        '<label class="block text-xs font-black text-slate-700">المعلم البديل<select id="ttArchiveEditSubstitute" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs"><option value="'+esc(item.substituteTeacherName)+'">'+esc(item.substituteTeacherName)+" (الحالي)</option>"+
        candidates.filter(candidate=>candidate.name!==item.substituteTeacherName).map(candidate=>'<option value="'+esc(candidate.name)+'">'+esc(candidate.name)+" · رصيد "+Number(candidate.pointsBalance||0)+"</option>").join("")+
        '</select></label><label class="block text-xs font-black text-slate-700">سبب الاحتياط (اختياري)<textarea id="ttArchiveEditReason" rows="2" class="mt-2 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 text-xs" placeholder="اكتب السبب أو اتركه فارغاً">'+esc(item.reason==="-"?"":item.reason||"")+'</textarea></label>'+
        '<div id="ttArchiveEditError" class="hidden rounded-xl bg-red-50 p-3 text-xs text-red-700"></div><div class="flex justify-end gap-2"><button type="button" data-close-edit class="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold">إلغاء</button><button type="button" id="ttArchiveEditSave" class="rounded-xl bg-indigo-700 px-4 py-2 text-xs font-black text-white">حفظ التعديل</button></div></div>';
      document.body.appendChild(modal);
      modal.querySelectorAll("[data-close-edit]").forEach(button=>button.addEventListener("click",()=>modal.remove()));
      modal.querySelector("#ttArchiveEditSave").addEventListener("click",async()=>{
        const button=modal.querySelector("#ttArchiveEditSave"),errorBox=modal.querySelector("#ttArchiveEditError");
        button.disabled=true;button.textContent="جارٍ الحفظ...";
        try{
          const token=appAuthSession?.token||readAppAuthToken();
          await appAuthRequest({action:"timetable_substitution_update",assignmentId,
            substituteTeacherName:modal.querySelector("#ttArchiveEditSubstitute").value,
            reserveReason:modal.querySelector("#ttArchiveEditReason").value.trim()||"-",
            includeOtherDepartments:includeOthers()},token);
          modal.remove();status("تم حفظ التعديل مع الاحتفاظ بالتكليف السابق في سجل المراجعة.","success");
          await timetableDailyLoadArchive();await timetableDailyRefreshAll();
        }catch(error){errorBox.textContent=error?.message||"تعذر حفظ التعديل.";errorBox.classList.remove("hidden");button.disabled=false;button.textContent="حفظ التعديل";}
      });
    }catch(error){status(error?.message||"تعذر تحميل بدائل الحصة لتعديل الأرشيف.","error");}
  };

  window.timetableDailyPrintReport = async function () {
    if(!reserveBatchPreview&&timetableDailyAbsentTeachers.length)await timetableDailyRefreshAll();
    if(!timetableDailyAbsentTeachers.length){status("اختر المعلمين الغائبين قبل الطباعة.","error");return;}
    const {planned,saved,missing}=currentPlanRows(reserveBatchPreview||{});
    const date=$("timetableSubstitutionDate")?.value||"",weekday=$("timetableSubstitutionWeekday")?.value||"",formattedDate=date.split("-").reverse().join(" / ")+" م";
    const groups=timetableDailyAbsentTeachers.map(absentName=>{
      const rows=[...saved.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,substitute:x.substituteTeacherName})),
        ...planned.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,substitute:x.substituteTeacherName})),
        ...missing.filter(x=>x.absentTeacherName===absentName).map(x=>({period:x.period,className:x.className,substitute:"-"}))]
        .sort((a,b)=>Number(a.period)-Number(b.period));
      const savedReason=saved.find(x=>x.absentTeacherName===absentName&&x.reason&&x.reason!=="-")?.reason||"";
      return {absentName,reason:(reserveReasons[absentName]||savedReason||"").trim()||"-",rows};
    }).filter(group=>group.rows.length);
    if(!groups.length){status("لا توجد حصص متاحة للطباعة.","error");return;}
    let tableRows="",count=0;
    groups.forEach(group=>group.rows.forEach((row,index)=>{
      tableRows+=(index===0?'<tr class="tt-print-group-start">':'<tr>')+(index===0?'<td rowspan="'+group.rows.length+'">'+esc(group.absentName)+'</td><td rowspan="'+group.rows.length+'">'+esc(group.reason)+'</td>':'')+
        "<td>"+Number(row.period)+"</td><td>"+esc(row.className||"-")+"</td><td>"+esc(row.substitute||"-")+"</td></tr>";count++;
    }));
    const root=document.createElement("div");root.id="ttReservePrintRoot";
    root.innerHTML='<div class="tt-print-header">سلطنة عمان<br>وزارة التعليم<br>المديرية العامة للتعليم بمحافظة شمال الباطنة<br>إدارة التعليم بالسويق<br><strong>مدرسة أبو دجانة الأنصاري للبنين (٩ - ١٢)</strong><br><strong>كشف توزيع الاحتياط</strong></div>'+
      '<div class="tt-print-meta"><span>اليوم: '+esc(weekday)+'</span><span>التاريخ: '+esc(formattedDate)+'</span></div>'+
      '<table><thead><tr><th>المعلم الغائب</th><th>سبب الاحتياط</th><th>الحصة</th><th>الصف</th><th>معلم الاحتياط</th></tr></thead><tbody>'+tableRows+"</tbody></table>"+
      '<div class="tt-print-footer"><span>إجمالي الحصص: '+count+'</span><span>المعلم الأول: ............................</span></div>';
    document.body.appendChild(root);document.body.classList.add("tt-reserve-print-mode");
    const cleanup=()=>{document.body.classList.remove("tt-reserve-print-mode");root.remove();window.removeEventListener("afterprint",cleanup);};
    window.addEventListener("afterprint",cleanup,{once:true});window.print();setTimeout(cleanup,5000);
  };

  window.timetableDailyShareWhatsApp = async function () {
    if(!timetableDailyAbsentTeachers.length){status("أضف المعلمين الغائبين أولاً.","error");return;}
    const popup=window.open("about:blank","_blank");if(!popup){status("اسمح بالنوافذ المنبثقة لمشاركة كشف واتساب.","error");return;}
    if(!reserveBatchPreview)await timetableDailyRefreshAll();
    const response=reserveBatchPreview||{},date=$("timetableSubstitutionDate")?.value||"",current=currentPlanRows(response),rows=[...current.saved,...current.planned,...current.missing];
    let message="*📋 كشف الاحتياط اليومي*\\n📅 التاريخ: "+date+"\\n\\n";
    rows.forEach(item=>{
      const reason=reserveReasons[item.absentTeacherName]||item.reason||"-";
      message+="• "+item.absentTeacherName+" | السبب: "+reason+" | الحصة "+item.period+" | "+(item.className||"غير محدد")+" ← "+(item.substituteTeacherName||"⚠️ لم يحدد")+"\\n";
    });
    if(!rows.length){popup.close();status("لا توجد حصص لعرضها في كشف اليوم.","info");return;}
    popup.location.href="https://wa.me/?text="+encodeURIComponent(message);
  };

  installReserveEnhancements();
})();