/* Teacher attendance-compliance report. This module deliberately reads attendance only;
   behavior records are never accessed. */
(function () {
  "use strict";
  const state = { mode: "today", requestId: 0, lastReport: null, loading: false };
  const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[ch]);
  const normalize = value => String(value || "").normalize("NFKC")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, "").trim();
  const classValues = value => (Array.isArray(value) ? value : String(value || "").split(/[،,؛;]+/))
    .map(item => String(item || "").trim()).filter(Boolean);
  const slotKey = (date, period, className) => date + "|" + Number(period) + "|" + normalize(className);
  function getDates() {
    const today = typeof getOmanLocalDate === "function" ? getOmanLocalDate() : new Date().toISOString().slice(0,10);
    const from = state.mode === "today" ? today : (document.getElementById("teachersActivityFrom")?.value || "");
    const to = state.mode === "today" ? today : (document.getElementById("teachersActivityTo")?.value || "");
    return { from, to, today };
  }
  function setStatus(message, kind) {
    const el = document.getElementById("teachersActivityStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "rounded-xl border px-4 py-3 text-xs font-bold " +
      (kind === "error" ? "border-rose-200 bg-rose-50 text-rose-800" :
       kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" :
       "border-sky-200 bg-sky-50 text-sky-800");
    el.classList.remove("hidden");
  }
  function setMode(mode) {
    state.mode = mode === "range" ? "range" : "today";
    const range = document.getElementById("teachersActivityRange");
    range?.classList.toggle("hidden", state.mode !== "range");
    document.getElementById("teachersActivityTodayBtn")?.classList.toggle("bg-slate-900", state.mode === "today");
    document.getElementById("teachersActivityTodayBtn")?.classList.toggle("text-white", state.mode === "today");
    document.getElementById("teachersActivityRangeBtn")?.classList.toggle("bg-slate-900", state.mode === "range");
    document.getElementById("teachersActivityRangeBtn")?.classList.toggle("text-white", state.mode === "range");
    if (state.mode === "range") {
      const today = getOmanLocalDate();
      const from = document.getElementById("teachersActivityFrom");
      const to = document.getElementById("teachersActivityTo");
      if (from && !from.value) from.value = today;
      if (to && !to.value) to.value = today;
    }
    loadReport();
  }
  function makeReport(data, from, to, today) {
    const teachers = Array.isArray(data.teachers) ? data.teachers : [];
    const cells = Array.isArray(data.cells) ? data.cells : [];
    const assignments = Array.isArray(data.assignments) ? data.assignments : [];
    const teacherNames = new Map();
    teachers.forEach(name => { const clean = String(name || "").trim(); if (clean) teacherNames.set(normalize(clean), clean); });
    cells.forEach(cell => { const name = String(cell.teacherName || "").trim(); if (name && !teacherNames.has(normalize(name))) teacherNames.set(normalize(name), name); });
    assignments.forEach(item => { const name = String(item.teacherName || "").trim(); if (name && !teacherNames.has(normalize(name))) teacherNames.set(normalize(name), name); });

    const versions = (Array.isArray(data.versions) ? data.versions : (data.version ? [data.version] : []))
      .map(version => ({
        id: String(version.id || ""),
        activatedDate: String(version.activatedDate || ""),
      }))
      .filter(version => version.id && /^\d{4}-\d{2}-\d{2}$/.test(version.activatedDate))
      .sort((a,b) => a.activatedDate.localeCompare(b.activatedDate));
    const scheduleByVersionDay = new Map();
    cells.filter(cell => cell.status === "teaching").forEach(cell => {
      const key = String(cell.versionId || "") + "|" + String(cell.weekday || "");
      if (!scheduleByVersionDay.has(key)) scheduleByVersionDay.set(key, []);
      scheduleByVersionDay.get(key).push(cell);
    });
    const expected = new Map();
    const ensure = name => {
      const key = normalize(name);
      if (!key) return null;
      if (!expected.has(key)) expected.set(key, { name: teacherNames.get(key) || name, slots: new Map() });
      return expected.get(key);
    };
    const cursor = new Date(from + "T12:00:00Z");
    const end = new Date(to + "T12:00:00Z");
    for (let date = new Date(cursor); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      const dateStr = date.toISOString().slice(0,10);
      if (dateStr > today) continue;
      const weekday = typeof dutyDayForDate === "function" ? dutyDayForDate(dateStr) : DAYS[date.getUTCDay()];
      if (!DAYS.includes(weekday)) continue;
      let effectiveVersion = null;
      for (const version of versions) {
        if (version.activatedDate <= dateStr) effectiveVersion = version;
        else break;
      }
      if (!effectiveVersion) continue;
      for (const cell of scheduleByVersionDay.get(effectiveVersion.id + "|" + weekday) || []) {
        const teacher = ensure(cell.teacherName);
        if (!teacher) continue;
        for (const className of classValues(cell.classSections)) {
          const key = slotKey(dateStr, cell.period, className);
          teacher.slots.set(key, { date: dateStr, period: Number(cell.period), className, source: "teaching" });
        }
      }
      for (const item of assignments) {
        if (item.assignmentDate !== dateStr || item.versionId !== effectiveVersion.id || item.assignmentType !== "substitution") continue;
        if (!["assigned", "confirmed", "completed"].includes(String(item.status || ""))) continue;
        const teacher = ensure(item.teacherName);
        if (!teacher) continue;
        const absentTeacher = expected.get(normalize(item.absentTeacherName));
        for (const className of classValues(item.classSections)) {
          const key = slotKey(dateStr, item.period, className);
          // The active reserve assignment transfers this exact lesson away from
          // the absent teacher; only the substitute is responsible for its register.
          absentTeacher?.slots.delete(key);
          teacher.slots.set(key, { date: dateStr, period: Number(item.period), className, source: "reserve" });
        }
      }
    }

    const saved = new Map();
    Object.entries(db?.attendance || {}).forEach(([key, session]) => {
      if (!session || typeof session !== "object") return;
      const parsed = typeof parseAttendanceKey === "function" ? parseAttendanceKey(key) : null;
      const date = String(parsed?.date || "");
      const className = String(session.className || parsed?.className || "");
      const period = Number(session.period || parsed?.period);
      if (!date || date < from || date > to || date > today || !className || !Number.isInteger(period)) return;
      saved.set(slotKey(date, period, className), normalize(session.teacher));
    });

    const rows = [];
    for (const item of expected.values()) {
      const complete = [], pending = [];
      for (const [key, slot] of item.slots) {
        const savedTeacher = saved.get(key);
        const label = slot.className + " — الحصة " + slot.period;
        if (savedTeacher && savedTeacher === normalize(item.name)) complete.push(label);
        else pending.push(label);
      }
      const total = complete.length + pending.length;
      if (!total) continue;
      rows.push({
        name: item.name, total, complete, pending,
        percentage: total ? complete.length / total * 100 : 0,
      });
    }
    rows.sort((a,b) => a.percentage - b.percentage || b.pending.length - a.pending.length || a.name.localeCompare(b.name,"ar"));
    return {
      rows, totalTeachers: teachers.length, totalLessons: rows.reduce((sum,row)=>sum+row.total,0),
      completeLessons: rows.reduce((sum,row)=>sum+row.complete.length,0),
      pendingLessons: rows.reduce((sum,row)=>sum+row.pending.length,0),
      from, to, version: data.version,
    };
  }
  function listHtml(items, tone) {
    if (!items.length) return '<span class="compliance-empty">—</span>';
    const marker = tone === "complete" ? "✓" : "•";
    return '<ul class="compliance-lesson-list">' + items.map(item =>
      '<li><span class="lesson-marker" aria-hidden="true">' + marker + '</span><span>' + esc(item) + '</span></li>'
    ).join("") + '</ul>';
  }
  function render(report) {
    const body = document.getElementById("teachersActivityTableBody");
    if (!body) return;
    const rows = report.rows;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-500">لا توجد حصص تدريس أو احتياط مطلوبة ضمن الفترة المحددة.</td></tr>';
    } else {
      body.innerHTML = rows.map((row,index) =>
        '<tr class="align-top hover:bg-slate-50/80">'+
        '<td class="compliance-cell compliance-cell--name font-black text-slate-800">'+esc(row.name)+'</td>'+
        '<td class="compliance-cell compliance-cell--count text-center font-black tabular-nums">'+row.total+'</td>'+
        '<td class="compliance-cell compliance-cell--lessons">'+listHtml(row.complete,"complete")+'</td>'+
        '<td class="compliance-cell compliance-cell--lessons">'+listHtml(row.pending,"pending")+'</td>'+
        '<td class="p-3 text-center"><span class="inline-flex min-w-[76px] justify-center rounded-full px-3 py-1.5 text-xs font-black tabular-nums '+(row.percentage>=80?"bg-emerald-100 text-emerald-800":row.percentage>=50?"bg-amber-100 text-amber-800":"bg-rose-100 text-rose-800")+'">'+row.percentage.toFixed(1)+'%</span></td>'+
        '</tr>'
      ).join("");
    }
    const rangeLabel = report.from === report.to ? report.from : report.from + " إلى " + report.to;
    const summary = document.getElementById("teachersActivitySummary");
    if (summary) summary.innerHTML =
      '<span class="rounded-xl bg-slate-100 px-3 py-2">الفترة: <b>'+esc(rangeLabel)+'</b></span>'+
      '<span class="rounded-xl bg-slate-100 px-3 py-2">إجمالي الحصص: <b>'+report.totalLessons+'</b></span>'+
      '<span class="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-800">رُصدت: <b>'+report.completeLessons+'</b></span>'+
      '<span class="rounded-xl bg-rose-50 px-3 py-2 text-rose-800">لم تُرصد: <b>'+report.pendingLessons+'</b></span>';
    const printButton = document.getElementById("teachersActivityPrintBtn");
    if (printButton) printButton.disabled = !rows.length;
  }
  async function loadReport(fromOverride, toOverride) {
    const requestId = ++state.requestId;
    const dates = getDates();
    if (typeof fromOverride === "string") dates.from = fromOverride;
    if (typeof toOverride === "string") dates.to = toOverride;
    if (!dates.from || !dates.to || dates.from > dates.to) {
      setStatus("تحقق من تاريخ البداية والنهاية.", "error"); return;
    }
    if (dates.from > dates.today) {
      setStatus("لا يمكن إعداد تقرير لفترة مستقبلية.", "error"); return;
    }
    if ((Date.parse(dates.to+"T00:00:00Z") - Date.parse(dates.from+"T00:00:00Z")) / 86400000 > 366) {
      setStatus("الفترة القصوى للتقرير 367 يوماً.", "error"); return;
    }
    const body = document.getElementById("teachersActivityTableBody");
    if (body) body.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-500"><i class="fa-solid fa-spinner fa-spin ml-2"></i> جارٍ احتساب الحصص والتحقق من كشوف الرصد...</td></tr>';
    setStatus("جارٍ تحميل الجدول الأسبوعي وتكليفات الاحتياط وسجلات الحفظ.", "info");
    try {
      const token = appAuthSession?.token || readAppAuthToken();
      if (!token) throw new Error("انتهت جلسة الدخول. سجّل الدخول مجدداً.");
      const reportRequest = { action:"timetable_activity_report_data", dateFrom:dates.from, dateTo:dates.to };
      if (typeof isAdminRecordsCenterScopedAccess === "function" && isAdminRecordsCenterScopedAccess(activeUser)) {
        reportRequest.admin_records_center = true;
      }
      const data = await appAuthRequest(reportRequest, token);
      if (requestId !== state.requestId) return;
      if (!data?.version) throw new Error("لا توجد نسخة جدول أسبوعي نشطة. لا يمكن احتساب الالتزام بدقة.");
      const report = makeReport(data, dates.from, dates.to, dates.today);
      state.lastReport = report;
      render(report);
      setStatus("تم تحديث التقرير. الحصة مكتملة فقط إذا وُجد سجل حفظ للحصة وكان اسم المعلم المسجل مطابقاً للمعلم المكلف.", "success");
    } catch (error) {
      if (requestId !== state.requestId) return;
      if (body) body.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-rose-700">'+esc(error?.message || "تعذر تحميل التقرير.")+'</td></tr>';
      state.lastReport = null;
      document.getElementById("teachersActivityPrintBtn")?.setAttribute("disabled","disabled");
      setStatus(error?.message || "تعذر تحميل التقرير.", "error");
    }
  }
  function printReport() {
    const report = state.lastReport;
    if (!report?.rows?.length) { setStatus("لا توجد بيانات جاهزة للطباعة.", "error"); return; }
    // Some Android in-app browsers block window.open even when called from a
    // user click. Fall back to a same-page print frame instead of silently failing.
    let w = window.open("", "_blank");
    let printFrame = null;
    if (!w) {
      printFrame = document.createElement("iframe");
      printFrame.setAttribute("title", "تقرير الالتزام برصد الغياب للطباعة");
      printFrame.setAttribute("aria-hidden", "true");
      printFrame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff;z-index:2147483647";
      document.body.appendChild(printFrame);
      w = printFrame.contentWindow;
      if (!w) {
        printFrame.remove();
        setStatus("تعذر فتح نافذة الطباعة في هذا المتصفح.", "error");
        return;
      }
      w.addEventListener("afterprint", () => printFrame?.remove(), { once: true });
    }
    const fmtDate = value => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
      return match ? match[3] + "-" + match[2] + "-" + match[1] : String(value || "");
    };
    const period = report.from === report.to ? fmtDate(report.from) : fmtDate(report.from) + " إلى " + fmtDate(report.to);
    const full = report.rows.filter(row => row.percentage === 100).length;
    const zero = report.rows.filter(row => row.complete.length === 0).length;
    const partial = report.rows.length - full - zero;
    const rows = report.rows.map((row,index) => {
      const status = row.percentage === 100 ? "full" : row.complete.length === 0 ? "zero" : "partial";
      const lessons = (items, kind) => items.length
        ? '<ul class="lesson-list lesson-list--' + kind + '">' + items.map(item => '<li>' + esc(item) + '</li>').join("") + '</ul>'
        : '<span class="empty">—</span>';
      return '<tr class="status-' + status + '">' +
        '<td class="serial">' + (index + 1) + '</td>' +
        '<td class="name">' + esc(row.name) + '</td>' +
        '<td class="num">' + row.total + '</td>' +
        '<td class="pct"><strong>' + row.percentage.toFixed(1) + '%</strong><span class="status-label">' +
          (status === "full" ? "رصد جميع الحصص" : status === "zero" ? "لم يرصد" : "رصد بعض الحصص") + '</span></td>' +
        '<td class="lessons complete">' + lessons(row.complete,"complete") + '</td>' +
        '<td class="lessons pending">' + lessons(row.pending,"pending") + '</td>' +
        '</tr>';
    }).join("");
    const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تقرير الالتزام برصد الغياب</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"><style>' +
      '@page{size:A4 landscape;margin:9mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'html,body{margin:0;padding:0}body{font-family:Tajawal,Arial,sans-serif;color:#172b3b;font-size:13px;line-height:1.55;background:#fff}' +
      '.official{border:1.6px solid #183653;border-top:5px solid #183653;padding:9px 14px 8px;text-align:center;margin-bottom:9px;break-inside:avoid}' +
      '.official-lines{font-size:13px;font-weight:800;line-height:1.65;color:#263f55}.official h1{font-size:21px;line-height:1.3;margin:5px 0 2px;color:#123653;font-weight:900}.period{font-size:14px;font-weight:800;color:#526579}' +
      '.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:8px 0}.kpi{border:1px solid #cbd8e2;border-radius:7px;padding:7px 9px;background:#f5f8fb;text-align:center;min-height:56px;break-inside:avoid}.kpi-label{display:block;font-size:12px;font-weight:800;color:#526579}.kpi-value{display:block;font-size:21px;font-weight:900;line-height:1.25;color:#183653}.kpi--done{background:#effaf5;border-color:#b8e2cd}.kpi--done .kpi-value{color:#08734b}.kpi--pending{background:#fff5f4;border-color:#f0c7c3}.kpi--pending .kpi-value{color:#a63131}' +
      '.classification{display:flex;gap:8px;margin:7px 0 10px}.class-item{flex:1;border:1px solid #d6e0e8;border-radius:6px;padding:6px 9px;text-align:center;font-weight:800;background:#fafcfd}.class-item b{font-size:17px;margin-inline-start:5px}.class-item.full{color:#08734b}.class-item.partial{color:#98620a}.class-item.zero{color:#a63131}' +
      'table{width:100%;border-collapse:collapse;table-layout:fixed;direction:rtl}thead{display:table-header-group}tfoot{display:table-footer-group}th{background:#183653;color:#fff;font-size:13px;font-weight:900;padding:8px 5px;border:1px solid #183653;text-align:center}td{border:1px solid #cbd5df;padding:6px 7px;vertical-align:top;font-size:13px;line-height:1.5;overflow-wrap:break-word;word-break:normal}tbody tr:nth-child(even){background:#f7f9fb}.serial,.num,.pct{text-align:center;vertical-align:middle;font-weight:900;font-variant-numeric:tabular-nums}.serial{color:#64748b}.name{font-size:14px;font-weight:900;white-space:normal;overflow-wrap:normal;word-break:normal}.pct strong{display:block;font-size:15px;color:#183653}.status-label{display:block;font-size:11px;font-weight:800;margin-top:2px;color:#526579}.status-full{background:#f0faf5!important}.status-partial{background:#fffaf0!important}.status-zero{background:#fff5f5!important}.lessons{font-size:12.5px}.lesson-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:3px 9px}.lesson-list li{display:inline-block;white-space:nowrap;break-inside:avoid;page-break-inside:avoid}.complete .lesson-list li:before{content:"✓ ";color:#08734b;font-weight:900}.pending .lesson-list li:before{content:"• ";color:#b33b3b;font-weight:900}.empty{color:#94a3b8}.signatures{display:flex;justify-content:space-between;gap:40px;margin:20px 8px 0;break-inside:avoid;font-size:14px;font-weight:900}.signatures div{width:42%;text-align:center;padding-top:7px}.signatures .line{display:block;border-top:1px solid #8292a0;margin-top:34px;padding-top:5px;color:#34495e}' +
      '.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:14px 0;padding:10px 12px;border:1px solid #cbdbea;border-radius:8px;background:#f1f6fb;color:#29445e;font-size:13px}.toolbar button{border:0;border-radius:7px;background:#183653;color:white;padding:10px 18px;font:inherit;font-weight:900;cursor:pointer;white-space:nowrap}' +
      '@media screen{body{padding:12px;background:#eef2f6}.page{max-width:1200px;margin:0 auto;background:#fff;padding:16px;box-shadow:0 5px 22px #17324d18;border-radius:10px}}' +
      '@media print{body{padding:0;background:#fff}.page{padding:0;max-width:none;box-shadow:none}.toolbar{display:none!important}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}.official,.kpi,.classification,.signatures{break-inside:avoid;page-break-inside:avoid}th,td{font-size:13px} .lesson-list li{white-space:nowrap}}' +
      '</style></head><body><main class="page">' +
      '<header class="official"><div class="official-lines">سلطنة عمان — وزارة التعليم<br>المديرية العامة للتعليم بمحافظة شمال الباطنة<br>إدارة التعليم بالسويق<br>مدرسة أبو دجانة الأنصاري للبنين (9 - 12)</div><h1>تقرير الالتزام برصد الغياب</h1><div class="period">الفترة الزمنية: ' + esc(period) + '</div></header>' +
      '<section class="summary">' +
      '<div class="kpi"><span class="kpi-label">إجمالي المعلمين</span><strong class="kpi-value">' + Number(report.totalTeachers || report.rows.length) + '</strong></div>' +
      '<div class="kpi"><span class="kpi-label">إجمالي الحصص</span><strong class="kpi-value">' + report.totalLessons + '</strong></div>' +
      '<div class="kpi kpi--done"><span class="kpi-label">إجمالي الحصص المرصودة</span><strong class="kpi-value">' + report.completeLessons + '</strong></div>' +
      '<div class="kpi kpi--pending"><span class="kpi-label">إجمالي الحصص غير المرصودة</span><strong class="kpi-value">' + report.pendingLessons + '</strong></div></section>' +
      '<section class="classification"><div class="class-item full">رصد جميع الحصص <b>' + full + '</b></div><div class="class-item partial">رصد بعض الحصص <b>' + partial + '</b></div><div class="class-item zero">لم يرصد الغياب <b>' + zero + '</b></div></section>' +
      '<table><colgroup><col style="width:4%"><col style="width:18%"><col style="width:8%"><col style="width:12%"><col style="width:29%"><col style="width:29%"></colgroup><thead><tr><th>م</th><th>اسم المعلم</th><th>عدد الحصص</th><th>نسبة الالتزام</th><th>الحصص المرصودة</th><th>الحصص غير المرصودة</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<footer class="signatures"><div>مساعد مدير المدرسة<span class="line">التوقيع: ........................................</span></div><div>مدير المدرسة<span class="line">التوقيع: ........................................</span></div></footer>' +
      '<div class="toolbar"><strong>لحفظ التقرير بصيغة PDF اختر «حفظ كملف PDF» من نافذة الطباعة.</strong><button type="button" onclick="window.focus();window.print()">طباعة / حفظ PDF</button></div>' +
      '</main><script>window.addEventListener("load",function(){var ready=document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve();ready.then(function(){setTimeout(function(){window.focus();window.print()},500)})});<\\/script></body></html>';
    w.document.open(); w.document.write(html); w.document.close(); w.focus();
  }
  window.setTeachersActivityMode = setMode;
  window.loadTeachersActivityCompliance = loadReport;
  window.printTeachersActivityPDF = printReport;
  window.renderTeachersActivity = loadReport;
  document.addEventListener("DOMContentLoaded", () => {
    const today = typeof getOmanLocalDate === "function" ? getOmanLocalDate() : new Date().toISOString().slice(0,10);
    const from = document.getElementById("teachersActivityFrom");
    const to = document.getElementById("teachersActivityTo");
    if (from && !from.value) from.value = today;
    if (to && !to.value) to.value = today;
    loadReport();
  });

  function installComplianceModernUI() {
    if (document.getElementById("teacherComplianceModernStyles")) return;
    const style = document.createElement("style");
    style.id = "teacherComplianceModernStyles";
    style.textContent = "#teachersActivityReportHeader{direction:rtl;text-align:center;padding:16px 12px;margin:0 0 14px;border:1px solid #dbe4ee;border-radius:16px;background:linear-gradient(145deg,#fff,#f4f8fc);color:#17324d}#teachersActivityReportHeader .official-lines{font-size:clamp(12px,2vw,16px);font-weight:800;line-height:1.85}#teachersActivityReportHeader h2{font-size:clamp(18px,2.5vw,24px);font-weight:900;margin:8px 0 2px;color:#123653}#teachersActivityReportHeader .report-period{font-size:12px;color:#64748b;font-weight:700}#teachersActivityKpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 14px;direction:rtl}#teachersActivityKpis .kpi{border:1px solid;border-radius:14px;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:8px}#teachersActivityKpis .kpi-label{font-size:12px;font-weight:800;line-height:1.5}#teachersActivityKpis .kpi-value{font-size:28px;font-weight:900;line-height:1}#teachersActivityKpis .kpi--full{background:#ecfdf5;border-color:#a7f3d0;color:#065f46}#teachersActivityKpis .kpi--partial{background:#fffbeb;border-color:#fde68a;color:#92400e}#teachersActivityKpis .kpi--zero{background:#fff1f2;border-color:#fecdd3;color:#9f1239}#teachersActivityTableBody tr.compliance-row--full{background:#ecfdf5!important}#teachersActivityTableBody tr.compliance-row--partial{background:#fffbeb!important}#teachersActivityTableBody tr.compliance-row--zero{background:#fff1f2!important}#teachersActivityTableBody .compliance-status{display:inline-flex;border-radius:99px;padding:5px 9px;font-size:11px;font-weight:900;white-space:nowrap}#teachersActivityTableBody .compliance-status--full{background:#d1fae5;color:#065f46}#teachersActivityTableBody .compliance-status--partial{background:#fef3c7;color:#92400e}#teachersActivityTableBody .compliance-status--zero{background:#ffe4e6;color:#9f1239}#teachersActivityTableBody .compliance-progress{height:5px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin-top:7px;min-width:60px}#teachersActivityTableBody .compliance-progress>span{display:block;height:100%;border-radius:99px}#teachersActivityTableBody .compliance-row--full .compliance-progress>span{background:#059669}#teachersActivityTableBody .compliance-row--partial .compliance-progress>span{background:#d97706}#teachersActivityTableBody .compliance-row--zero .compliance-progress>span{background:#e11d48}.teachers-activity-table-scroll{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}.teachers-activity-table-scroll table{min-width:850px;width:100%}#teachersActivityTableBody td{overflow-wrap:anywhere;line-height:1.7}@media(max-width:640px){#teachersActivityKpis{gap:6px}#teachersActivityKpis .kpi{display:block;text-align:center;padding:9px 6px}#teachersActivityKpis .kpi-label{font-size:10px;min-height:30px;display:flex;align-items:center;justify-content:center}#teachersActivityKpis .kpi-value{font-size:24px;margin-top:5px}#teachersActivityReportHeader{padding:12px 8px}#teachersActivityReportHeader .official-lines{font-size:11px}}@media print{#teachersActivityReportHeader{box-shadow:none;border:1.5px solid #183653;border-radius:0;padding:7px;margin-bottom:7px}#teachersActivityKpis{gap:6px;margin-bottom:7px}#teachersActivityKpis .kpi{padding:6px 8px;border-radius:5px}.teachers-activity-table-scroll{overflow:visible!important}.teachers-activity-table-scroll table{min-width:0!important;width:100%!important}#teachersActivityTableBody tr{break-inside:avoid;page-break-inside:avoid}}";
    style.textContent += "#teachersActivityTableBody td{font-size:14px!important;padding:8px 9px!important;line-height:1.55!important}#teachersActivityTableBody td:first-child{font-size:16px!important;font-weight:900!important;color:#172b45!important}#teachersActivityTableBody .compliance-status{font-size:12px!important;padding:5px 10px!important}#teachersActivityTableBody .compliance-empty{font-size:14px;color:#64748b}#teachersActivityTableBody .compliance-lesson-list{display:flex;flex-direction:column;align-items:stretch;gap:4px;list-style:none;margin:0;padding:0}#teachersActivityTableBody .compliance-lesson-list li{display:flex;align-items:flex-start;gap:7px;font-size:14px;line-height:1.45;padding:2px 0;overflow-wrap:anywhere}#teachersActivityTableBody .lesson-marker{flex:0 0 17px;font-weight:900;color:#047857}#teachersActivityTableBody td:nth-child(4) .lesson-marker{color:#be123c}#teachersActivityKpis .kpi-label{font-size:14px!important;line-height:1.45!important}#teachersActivityKpis .kpi{min-height:76px;padding:12px 14px!important}@media(max-width:640px){#teachersActivityTableBody td{font-size:14px!important;padding:8px!important}#teachersActivityTableBody td:first-child{font-size:16px!important}#teachersActivityKpis .kpi-label{font-size:12px!important;min-height:42px}#teachersActivityKpis .kpi{min-height:84px}}@media print{#teachersActivityTableBody td{font-size:14px!important}#teachersActivityTableBody td:first-child{font-size:16px!important}}";
    style.textContent += "#teachersActivityTableBody{font-size:14px!important}#teachersActivityTableBody tr{height:auto}#teachersActivityTableBody td.compliance-cell{padding:5px 6px!important;vertical-align:top!important;font-size:14px!important;line-height:1.45!important;min-width:0!important}#teachersActivityTableBody td.compliance-cell--name{width:23%;min-width:135px;font-size:16px!important;font-weight:900!important;line-height:1.55!important}#teachersActivityTableBody td.compliance-cell--count{width:8%;min-width:48px;white-space:nowrap}#teachersActivityTableBody td.compliance-cell--lessons{min-width:0}#teachersActivityTableBody td.compliance-cell--lessons:nth-child(3){width:25%}#teachersActivityTableBody td.compliance-cell--lessons:nth-child(4){width:31%}#teachersActivityTableBody td.compliance-cell--percentage{width:13%;min-width:76px;white-space:nowrap}#teachersActivityTableBody .compliance-lesson-list{gap:2px!important;margin:0!important;padding:0!important}#teachersActivityTableBody .compliance-lesson-list li{gap:4px!important;padding:1px 0!important;font-size:14px!important;line-height:1.4!important}#teachersActivityTableBody .lesson-marker{flex-basis:13px!important}#teachersActivityTableBody .compliance-status{padding:4px 7px!important;font-size:12px!important}#teachersActivityTableBody .compliance-progress{margin-top:5px!important;height:4px!important}.teachers-activity-table-scroll table{width:100%!important;min-width:620px!important;table-layout:fixed!important;border-collapse:collapse!important}.teachers-activity-table-scroll th{padding:7px 5px!important;font-size:13px!important;line-height:1.35!important;white-space:normal!important}.teachers-activity-table-scroll th:nth-child(1){width:23%!important}.teachers-activity-table-scroll th:nth-child(2){width:8%!important}.teachers-activity-table-scroll th:nth-child(3){width:25%!important}.teachers-activity-table-scroll th:nth-child(4){width:31%!important}.teachers-activity-table-scroll th:nth-child(5){width:13%!important}@media(max-width:640px){.teachers-activity-table-scroll table{min-width:620px!important}.teachers-activity-table-scroll{overflow-x:auto!important}.teachers-activity-table-scroll th{font-size:13px!important}#teachersActivityTableBody td.compliance-cell{padding:5px!important}#teachersActivityTableBody td.compliance-cell--name{min-width:135px;font-size:16px!important}}@media print{.teachers-activity-table-scroll{overflow:visible!important}.teachers-activity-table-scroll table{min-width:0!important;width:100%!important;table-layout:fixed!important}#teachersActivityTableBody td.compliance-cell{padding:4px 5px!important;font-size:14px!important}#teachersActivityTableBody td.compliance-cell--name{font-size:16px!important}#teachersActivityTableBody .compliance-lesson-list li{font-size:13px!important;line-height:1.35!important}}";
    document.head.appendChild(style);
    const summary = document.getElementById("teachersActivitySummary");
    if (!summary) return;
    if (!document.getElementById("teachersActivityReportHeader")) {
      const header = document.createElement("section");
      header.id = "teachersActivityReportHeader";
      header.innerHTML = '<div class="official-lines">سلطنة عمان<br>وزارة التعليم<br>المديرية العامة للتعليم بمحافظة شمال الباطنة<br>إدارة التعليم بالسويق<br>مدرسة أبو دجانة الأنصاري للبنين ( 9 - 12 )</div><h2>تقرير الالتزام برصد الغياب</h2><div class="report-period" id="teachersActivityHeaderPeriod"></div>';
      summary.parentElement.insertBefore(header, summary);
    }
    if (!document.getElementById("teachersActivityKpis")) {
      const kpis = document.createElement("section");
      kpis.id = "teachersActivityKpis";
      kpis.innerHTML = '<div class="kpi kpi--full"><div class="kpi-label">المعلمون الملتزمون بالكامل</div><div class="kpi-value" id="teachersActivityFullCount">0</div></div><div class="kpi kpi--partial"><div class="kpi-label">المعلمون برصد جزئي</div><div class="kpi-value" id="teachersActivityPartialCount">0</div></div><div class="kpi kpi--zero"><div class="kpi-label">المعلمون الذين لم يرصدوا الغياب</div><div class="kpi-value" id="teachersActivityZeroCount">0</div></div>';
      summary.parentElement.insertBefore(kpis, summary);
    }
    const table = document.getElementById("teachersActivityTableBody")?.closest("table");
    if (table && table.parentElement && !table.parentElement.classList.contains("teachers-activity-table-scroll")) {
      const wrap = document.createElement("div");
      wrap.className = "teachers-activity-table-scroll";
      table.parentElement.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
  }
  render = function(report) {
    installComplianceModernUI();
    const body = document.getElementById("teachersActivityTableBody");
    if (!body) return;
    const rows = report.rows;
    const full = rows.filter(r => r.percentage === 100).length;
    const zero = rows.filter(r => r.complete.length === 0).length;
    const partial = rows.length - full - zero;
    const setCount = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    setCount("teachersActivityFullCount", full);
    setCount("teachersActivityPartialCount", partial);
    setCount("teachersActivityZeroCount", zero);
    const period = report.from === report.to ? report.from : report.from + " إلى " + report.to;
    setCount("teachersActivityHeaderPeriod", "الفترة: " + period);
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-500">لا توجد حصص تدريس أو احتياط مطلوبة ضمن الفترة المحددة.</td></tr>';
    } else {
      body.innerHTML = rows.map(row => {
        const status = row.percentage === 100 ? "full" : row.complete.length === 0 ? "zero" : "partial";
        const label = status === "full" ? "التزام كامل" : status === "zero" ? "لم يسجل" : "رصد جزئي";
        return '<tr class="align-top compliance-row--' + status + '"><td class="compliance-cell compliance-cell--name font-black text-slate-800">' + esc(row.name) + '<div class="mt-2"><span class="compliance-status compliance-status--' + status + '">' + label + '</span></div></td><td class="compliance-cell compliance-cell--count text-center font-black tabular-nums">' + row.total + '</td><td class="compliance-cell compliance-cell--lessons">' + listHtml(row.complete,"complete") + '</td><td class="compliance-cell compliance-cell--lessons">' + listHtml(row.pending,"pending") + '</td><td class="compliance-cell compliance-cell--percentage text-center"><span class="compliance-status compliance-status--' + status + '">' + row.percentage.toFixed(1) + '%</span><div class="compliance-progress"><span style="width:' + row.percentage + '%"></span></div></td></tr>';
      }).join("");
    }
    const summaryEl = document.getElementById("teachersActivitySummary");
    if (summaryEl) summaryEl.innerHTML = '<span class="rounded-xl bg-slate-100 px-3 py-2">الفترة: <b>' + esc(period) + '</b></span><span class="rounded-xl bg-slate-100 px-3 py-2">إجمالي الحصص: <b>' + report.totalLessons + '</b></span><span class="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-800">رُصدت: <b>' + report.completeLessons + '</b></span><span class="rounded-xl bg-rose-50 px-3 py-2 text-rose-800">لم تُرصد: <b>' + report.pendingLessons + '</b></span>';
    const button = document.getElementById("teachersActivityPrintBtn");
    if (button) button.disabled = !rows.length;
  };
  document.addEventListener("DOMContentLoaded", installComplianceModernUI);

})();