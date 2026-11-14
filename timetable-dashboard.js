/* Smart timetable dashboard. Uses the existing authenticated timetable API as the source of truth. */
(function () {
  "use strict";
  let ttDashboardAbsent = [];
  let ttDashboardResponses = new Map();
  let ttDashboardRenderToken = 0;
  let ttDashboardBusy = false;
  const ttDashboardSaving = new Set();
  let ttDashboardInitialized = false;

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => typeof timetableEsc === "function"
    ? timetableEsc(String(value ?? ""))
    : String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const token = () => appAuthSession?.token || (typeof readAppAuthToken === "function" ? readAppAuthToken() : "");
  const includeOther = () => byId("timetableSubstitutionOtherDepartments")?.checked === true;
  const normalizeSearch = (value) => String(value || "").normalize("NFD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي")
    .replace(/ة/g, "ه").replace(/\s+/g, " ").trim().toLocaleLowerCase("ar");

  function setStatus(message, kind = "info") {
    const el = byId("ttDashboardStatus");
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind;
  }
  function context() {
    const value = typeof timetableSubstitutionGetDate === "function"
      ? timetableSubstitutionGetDate()
      : null;
    if (!value) throw new Error("حدد تاريخ الغياب أولاً.");
    return value;
  }
  async function preview(absentTeacherName) {
    const sessionToken = token();
    if (!sessionToken) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
    const { date, weekday } = context();
    return appAuthRequest({
      action: "timetable_substitution_preview",
      weekday,
      assignmentDate: date,
      absentTeacherName,
      includeOtherDepartments: includeOther()
    }, sessionToken);
  }
  function syncHiddenSelection() {
    const select = byId("timetableSubstitutionAbsentTeacher");
    if (!select) return;
    Array.from(select.options).forEach(option => { option.selected = ttDashboardAbsent.includes(option.value); });
  }
  function renderTags() {
    const host = byId("ttAbsentTags");
    if (!host) return;
    host.innerHTML = ttDashboardAbsent.map(name =>
      '<span class="tt-tag">' + escapeHtml(name) +
      '<button type="button" data-tt-remove="' + escapeHtml(name) + '" aria-label="إزالة ' + escapeHtml(name) + '"' +
      (ttDashboardBusy ? " disabled" : "") + '>×</button></span>'
    ).join("");
    host.querySelectorAll("[data-tt-remove]").forEach(button => button.addEventListener("click", () => {
      ttDashboardAbsent = ttDashboardAbsent.filter(name => name !== button.dataset.ttRemove);
      ttDashboardResponses.delete(button.dataset.ttRemove);
      syncHiddenSelection();
      renderTags();
      renderAll();
    }));
    syncHiddenSelection();
  }
  function filterAbsent(query) {
    const host = byId("ttDashboardSuggestions");
    const select = byId("timetableSubstitutionAbsentTeacher");
    if (!host || !select) return;
    const q = normalizeSearch(query);
    if (!q) { host.style.display = "none"; host.innerHTML = ""; return; }
    const matches = Array.from(select.options)
      .map(option => option.value)
      .filter(name => name && !ttDashboardAbsent.includes(name) && normalizeSearch(name).includes(q))
      .slice(0, 12);
    host.innerHTML = matches.map(name =>
      '<button type="button" class="tt-suggestion" role="option" data-tt-add="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>'
    ).join("");
    host.style.display = matches.length ? "block" : "none";
    host.querySelectorAll("[data-tt-add]").forEach(button => button.addEventListener("click", () => {
      addAbsent(button.dataset.ttAdd);
      const input = byId("ttDashboardSearch");
      if (input) input.value = "";
      host.style.display = "none";
    }));
  }
  function addAbsent(name) {
    if (!name || ttDashboardAbsent.includes(name)) return;
    ttDashboardAbsent.push(name);
    renderTags();
    renderAll();
  }
  function renderCards() {
    const host = byId("timetableSubstitutionResults");
    if (!host) return;
    if (!ttDashboardAbsent.length) {
      host.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 p-7 text-center text-xs text-slate-500">أضف معلماً غائباً لعرض حصصه والبدلاء المتاحين.</div>';
      return;
    }
    const rows = [];
    ttDashboardAbsent.forEach(absentName => {
      const response = ttDashboardResponses.get(absentName);
      if (!response) {
        rows.push('<div class="tt-lesson"><strong>' + escapeHtml(absentName) + '</strong><span class="tt-lesson-meta">جارٍ تحميل الحصص...</span></div>');
        return;
      }
      if (response.active === false) {
        rows.push('<div class="tt-lesson"><strong>' + escapeHtml(absentName) + '</strong><span class="tt-lesson-meta">لا يوجد جدول أسبوعي معتمد.</span></div>');
        return;
      }
      const lessons = response.lessons || [];
      if (!lessons.length) {
        rows.push('<div class="tt-lesson"><strong>' + escapeHtml(absentName) + '</strong><span class="tt-lesson-meta">لا توجد حصص تدريس مسجلة لهذا المعلم في هذا اليوم.</span></div>');
        return;
      }
      lessons.forEach(lesson => {
        const candidates = lesson.candidates || [];
        const assignment = lesson.assignment;
        const options = candidates.map(candidate =>
          '<option value="' + escapeHtml(candidate.name) + '">' + escapeHtml(candidate.name) +
          (Number.isFinite(candidate.baseQuota) ? ' — نصاب: ' + candidate.baseQuota : '') +
          (Number.isFinite(candidate.substitutionCount) ? ' | احتياط سابق: ' + candidate.substitutionCount : '') +
          (Number.isFinite(candidate.workloadScore) ? ' | العبء: ' + candidate.workloadScore : '') + '</option>'
        ).join("");
        let control = "";
        if (assignment) {
          control = '<div class="tt-lesson-controls"><strong class="text-xs text-emerald-700">البديل: ' +
            escapeHtml(assignment.substituteTeacherName) + '</strong><button type="button" data-tt-cancel="' +
            escapeHtml(assignment.id) + '" data-tt-absent="' + escapeHtml(absentName) + '">إلغاء التكليف</button></div>';
        } else if (candidates.length) {
          control = '<div class="tt-lesson-controls"><select aria-label="البديل للحصة ' + lesson.period +
            '" data-tt-save-period="' + lesson.period + '" data-tt-absent="' + escapeHtml(absentName) +
            '"><option value="">اختر البديل المتفرغ — حفظ تلقائي</option>' + options +
            '</select><span class="tt-lesson-meta">المرشحون بفراغ مؤكد فقط، مرتّبون حسب عبء الاحتياط</span></div>';
        } else {
          control = '<div class="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">لا يوجد معلم متاح بفراغ مؤكد في هذه الحصة ضمن نطاق الصلاحية.</div>';
        }
        rows.push('<article class="tt-lesson"><div class="tt-lesson-head"><span>' +
          escapeHtml(absentName) + ' · الحصة ' + lesson.period + '</span><span class="tt-lesson-meta">' +
          escapeHtml(lesson.className || "الشعبة غير محددة") + ' · ' +
          escapeHtml(lesson.subject || "المادة غير محددة") + '</span></div>' + control +
          '<div class="flex justify-end"><button type="button" data-tt-wa="' + lesson.period +
          '" data-tt-wa-absent="' + escapeHtml(absentName) + '" class="text-green-700">واتساب</button></div></article>');
      });
    });
    host.innerHTML = rows.join("");
    host.querySelectorAll("[data-tt-save-period]").forEach(select => select.addEventListener("change", () => {
      if (select.value) {
        select.disabled = true;
        saveAssignment(select.dataset.ttAbsent, Number(select.dataset.ttSavePeriod), select.value);
      }
    }));
    host.querySelectorAll("[data-tt-cancel]").forEach(button => button.addEventListener("click", () => cancelAssignment(button.dataset.ttCancel)));
    host.querySelectorAll("[data-tt-wa]").forEach(button => button.addEventListener("click", () =>
      notifySingle(button.dataset.ttWaAbsent, Number(button.dataset.ttWa))));
  }
  async function renderAll() {
    const host = byId("timetableSubstitutionResults");
    if (!host) return;
    const renderId = ++ttDashboardRenderToken;
    if (!ttDashboardAbsent.length) { ttDashboardResponses.clear(); renderCards(); return; }
    renderCards();
    try {
      const pairs = await Promise.all(ttDashboardAbsent.map(async name => [name, await preview(name)]));
      if (renderId !== ttDashboardRenderToken) return;
      ttDashboardResponses = new Map(pairs);
      renderCards();
      const count = pairs.reduce((sum, pair) => sum + (pair[1].lessons || []).length, 0);
      setStatus('تم تحميل ' + ttDashboardAbsent.length + ' معلم/معلمين و' + count + ' حصة. اختر البديل وسيُحفظ التكليف مباشرة.', "success");
    } catch (error) {
      if (renderId !== ttDashboardRenderToken) return;
      setStatus(error?.message || "تعذر تحميل بيانات الاحتياط.", "error");
      renderCards();
    }
  }
  async function saveAssignment(absentName, period, substituteName, quiet = false) {
    const key = absentName + "|" + period;
    if (ttDashboardSaving.has(key)) return false;
    ttDashboardSaving.add(key);
    try {
      const { date, weekday } = context();
      const sessionToken = token();
      if (!sessionToken) throw new Error("انتهت جلسة الدخول.");
      await appAuthRequest({
        action: "timetable_substitution_save",
        weekday, assignmentDate: date, absentTeacherName: absentName,
        substituteTeacherName: substituteName, period,
        includeOtherDepartments: includeOther()
      }, sessionToken);
      if (!quiet) setStatus('تم حفظ تكليف ' + substituteName + ' للحصة ' + period + '.', "success");
      if (!quiet) await renderAll();
      return true;
    } catch (error) {
      if (!quiet) setStatus(error?.message || "تعذر حفظ التكليف؛ تحقق الخادم من التوفر والتعارض.", "error");
      if (!quiet) await renderAll();
      return false;
    } finally {
      ttDashboardSaving.delete(key);
    }
  }
  async function cancelAssignment(assignmentId) {
    if (!window.confirm("هل تريد إلغاء تكليف الاحتياط المحدد؟")) return;
    try {
      const { date, weekday } = context();
      await appAuthRequest({action:"timetable_substitution_cancel",weekday,assignmentDate:date,assignmentId},token());
      setStatus("تم إلغاء التكليف وإعادة إتاحة الحصة.", "success");
      await renderAll();
    } catch (error) { setStatus(error?.message || "تعذر إلغاء التكليف.", "error"); }
  }
  async function autoAssign() {
    if (ttDashboardBusy) return;
    if (!ttDashboardAbsent.length) { setStatus("أضف معلماً غائباً واحداً على الأقل أولاً.", "error"); return; }
    ttDashboardBusy = true;
    const button = byId("ttAutoAssignButton");
    const search = byId("ttDashboardSearch");
    const dateInput = byId("timetableSubstitutionDate");
    if (search) search.disabled = true;
    if (dateInput) dateInput.disabled = true;
    renderTags();
    if (button) { button.disabled = true; button.textContent = "جارٍ التوزيع والتحقق..."; }
    let saved = 0, skipped = 0;
    const failures = [];
    try {
      for (const absentName of ttDashboardAbsent) {
        // Refresh before each period: the previous save changes server-side availability.
        let current = await preview(absentName);
        const periods = (current.lessons || []).map(item => item.period).sort((a,b)=>a-b);
        for (const period of periods) {
          current = await preview(absentName);
          const lesson = (current.lessons || []).find(item => Number(item.period) === Number(period));
          if (!lesson || lesson.assignment) { skipped++; continue; }
          const candidate = (lesson.candidates || [])[0];
          if (!candidate) { skipped++; continue; }
          const ok = await saveAssignment(absentName, period, candidate.name, true);
          if (ok) saved++;
          else failures.push(absentName + " — الحصة " + period);
        }
      }
      await renderAll();
      setStatus("اكتمل التوزيع: " + saved + " تكليف محفوظ، " + skipped +
        " حصة بلا مرشح أو مسندة مسبقاً." + (failures.length ? " تعذر حفظ: " + failures.join("، ") : ""),
        failures.length ? "error" : "success");
    } catch (error) {
      setStatus(error?.message || "توقف التوزيع بسبب خطأ في التحقق.", "error");
      await renderAll();
    } finally {
      ttDashboardBusy = false;
      if (button) { button.disabled = false; button.textContent = "⚡ توزيع الاحتياط تلقائياً"; }
      if (search) search.disabled = false;
      if (dateInput) dateInput.disabled = false;
      renderTags();
    }
  }
  function notifySingle(absentName, period) {
    const response = ttDashboardResponses.get(absentName);
    const lesson = response?.lessons?.find(item => Number(item.period) === period);
    if (!lesson?.assignment) { setStatus("احفظ تكليف البديل أولاً قبل إرسال الإشعار.", "error"); return; }
    const msg = "السلام عليكم " + lesson.assignment.substituteTeacherName +
      "، نحيطكم علماً بإسناد حصة احتياط لكم اليوم:\n- الحصة: " + period +
      "\n- الصف: " + (lesson.className || "غير محدد") +
      "\n- المادة: " + (lesson.subject || "غير محددة") +
      "\n- المعلم الغائب: " + absentName + "\nشاكرين تعاونكم.";
    window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank", "noopener");
  }
  function share() {
    const lines = ["*📋 كشف حصص الاحتياط اليومي*"];
    let count = 0;
    ttDashboardAbsent.forEach(absentName => {
      const response = ttDashboardResponses.get(absentName);
      (response?.lessons || []).forEach(lesson => {
        const substitute = lesson.assignment?.substituteTeacherName || "⚠️ لم يحدد بعد";
        lines.push("• الحصة (" + lesson.period + ") | " + (lesson.className || "شعبة غير محددة") +
          " | " + (lesson.subject || "مادة غير محددة") + " | الغائب: " + absentName + " | البديل: *" + substitute + "*");
        count++;
      });
    });
    if (!count) { setStatus("لا توجد حصص لعرضها في كشف اليوم.", "error"); return; }
    window.open("https://wa.me/?text=" + encodeURIComponent(lines.join("\n")), "_blank", "noopener");
  }
  async function loadDay() {
    const dateInput = byId("timetableSubstitutionDate");
    if (dateInput && !dateInput.value && typeof getOmanLocalDate === "function") dateInput.value = getOmanLocalDate();
    ttDashboardAbsent = [];
    ttDashboardResponses.clear();
    renderTags();
    try {
      if (typeof timetableLoadSubstitutionOptions === "function") await timetableLoadSubstitutionOptions();
      const search = byId("ttDashboardSearch");
      if (search) { search.value = ""; search.disabled = false; }
      const panel = byId("timetableSubstitutionPanel");
      if (panel) panel.classList.remove("hidden");
      const checkboxWrap = byId("ttOtherDepartmentsWrap");
      if (checkboxWrap && activeUser?.type !== "admin") checkboxWrap.style.display = "none";
      const legacyStatus = byId("timetableSubstitutionStatus");
      if (legacyStatus?.textContent?.includes("لا يوجد جدول أسبوعي نشط")) {
        if (search) search.disabled = true;
        setStatus("لا يوجد جدول أسبوعي معتمد حتى الآن. انتقل إلى إعداد وإدارة الجدول العام واعتمد نسخة الأسبوع أولاً.", "error");
      } else if (legacyStatus?.className?.includes("border-red-")) {
        setStatus(legacyStatus.textContent || "تعذر تحميل بيانات اليوم.", "error");
      } else if (byId("timetableSubstitutionAbsentTeacher")?.options?.length <= 1) {
        setStatus("لا توجد حصص تدريس مسجلة لمعلمي نطاق صلاحيتك في هذا اليوم.", "info");
      } else {
        setStatus("اختر المعلمين الغائبين من البحث لعرض حصصهم.", "success");
      }
      renderCards();
    } catch (error) { setStatus(error?.message || "تعذر تحميل قائمة الغياب.", "error"); }
  }
  function switchTab(which) {
    const daily = which === "daily";
    const dailyPanel = byId("ttPanelDaily"), settingsPanel = byId("ttPanelSettings");
    if (dailyPanel) dailyPanel.hidden = !daily;
    if (settingsPanel) settingsPanel.hidden = daily;
    const dailyTab = byId("ttTabDaily"), settingsTab = byId("ttTabSettings");
    if (dailyTab) dailyTab.setAttribute("aria-selected", String(daily));
    if (settingsTab) settingsTab.setAttribute("aria-selected", String(!daily));
    if (daily) loadDay();
    else {
      if (typeof timetableLoadImports === "function") timetableLoadImports();
      if (activeUser?.type === "admin" && typeof timetableResumeWeeklyDraft === "function") timetableResumeWeeklyDraft();
      if (activeUser?.type === "admin" && typeof timetableLoadAccessManagement === "function") timetableLoadAccessManagement();
    }
  }
  function setupDropZone() {
    const zone = byId("ttDashboardDropZone"), input = byId("timetableExcelFile");
    if (!zone || !input) return;
    zone.addEventListener("click", () => input.click());
    ["dragenter","dragover"].forEach(type => zone.addEventListener(type, event => {
      event.preventDefault(); zone.classList.add("is-over");
    }));
    ["dragleave","drop"].forEach(type => zone.addEventListener(type, event => {
      event.preventDefault(); zone.classList.remove("is-over");
    }));
    zone.addEventListener("drop", event => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (!/\.(xlsx|xls|xlsm|csv)$/i.test(file.name)) {
        if (typeof timetableSetStatus === "function") timetableSetStatus("اختر ملف Excel أو CSV صالحاً.", "error");
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      if (typeof timetableImportWorkbook === "function") timetableImportWorkbook();
    });
    input.setAttribute("accept", ".xlsx,.xls,.xlsm,.csv");
    input.addEventListener("change", () => { if (input.files?.length && typeof timetableImportWorkbook === "function") timetableImportWorkbook(); });
  }
  function init() {
    if (ttDashboardInitialized) return;
    ttDashboardInitialized = true;
    setupDropZone();
    if (byId("timetableSubstitutionDate") && !byId("timetableSubstitutionDate").value && typeof getOmanLocalDate === "function") {
      byId("timetableSubstitutionDate").value = getOmanLocalDate();
    }
    renderTags();
  }

  window.ttDashboardSwitchTab = switchTab;
  window.ttDashboardLoadDay = loadDay;
  window.ttDashboardFilterAbsent = filterAbsent;
  window.ttDashboardRenderAll = renderAll;
  window.ttDashboardAutoAssign = autoAssign;
  window.ttDashboardShare = share;
  window.addEventListener("DOMContentLoaded", init, {once:true});
  if (document.readyState !== "loading") init();
})();