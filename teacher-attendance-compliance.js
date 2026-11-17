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

    const scheduleByDay = new Map();
    cells.filter(cell => cell.status === "teaching").forEach(cell => {
      const key = String(cell.weekday || "");
      if (!scheduleByDay.has(key)) scheduleByDay.set(key, []);
      scheduleByDay.get(key).push(cell);
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
      for (const cell of scheduleByDay.get(weekday) || []) {
        const teacher = ensure(cell.teacherName);
        if (!teacher) continue;
        for (const className of classValues(cell.classSections)) {
          const key = slotKey(dateStr, cell.period, className);
          teacher.slots.set(key, { date: dateStr, period: Number(cell.period), className, source: "teaching" });
        }
      }
      for (const item of assignments) {
        if (item.assignmentDate !== dateStr || item.assignmentType !== "substitution") continue;
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
      rows, totalLessons: rows.reduce((sum,row)=>sum+row.total,0),
      completeLessons: rows.reduce((sum,row)=>sum+row.complete.length,0),
      pendingLessons: rows.reduce((sum,row)=>sum+row.pending.length,0),
      from, to, version: data.version,
    };
  }
  function listHtml(items, tone) {
    if (!items.length) return '<span class="text-slate-400 text-[11px]">—</span>';
    const classes = tone === "complete"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-rose-200 bg-rose-50 text-rose-800";
    return '<div class="flex flex-wrap gap-1.5">' + items.map(item =>
      '<span class="inline-flex rounded-lg border px-2 py-1 text-[10px] font-bold '+classes+'">'+esc(item)+'</span>'
    ).join("") + '</div>';
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
        '<td class="p-3 min-w-[150px] font-black text-slate-800">'+esc(row.name)+'</td>'+
        '<td class="p-3 text-center font-black tabular-nums">'+row.total+'</td>'+
        '<td class="p-3 min-w-[210px]">'+listHtml(row.complete,"complete")+'</td>'+
        '<td class="p-3 min-w-[210px]">'+listHtml(row.pending,"pending")+'</td>'+
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
  async function loadReport() {
    const requestId = ++state.requestId;
    const dates = getDates();
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
      const data = await appAuthRequest({ action:"timetable_activity_report_data", dateFrom:dates.from, dateTo:dates.to }, token);
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
    const w = window.open("", "_blank");
    if (!w) { setStatus("يرجى السماح بالنوافذ المنبثقة لفتح تقرير PDF.", "error"); return; }
    const rows = report.rows.map(row => {
      const chunkSize = 6;
      const chunks = values => {
        const result = [];
        for (let i = 0; i < values.length; i += chunkSize) result.push(values.slice(i, i + chunkSize));
        return result.length ? result : [[]];
      };
      const completeChunks = chunks(row.complete);
      const pendingChunks = chunks(row.pending);
      const count = Math.max(completeChunks.length, pendingChunks.length);
      return Array.from({ length: count }, (_, index) => {
        const complete = completeChunks[index] || [];
        const pending = pendingChunks[index] || [];
        const first = index === 0;
        return '<tr><td class="name">'+(first ? esc(row.name) : '<span class="continuation">تكملة</span>')+'</td>'+
          '<td class="num">'+(first ? row.total : '')+'</td>'+
          '<td>'+complete.map(esc).join("<br>")+'</td><td>'+pending.map(esc).join("<br>")+'</td>'+
          '<td class="pct">'+(first ? row.percentage.toFixed(1)+'%' : '')+'</td></tr>';
      }).join("");
    }).join("");
    const period = report.from === report.to ? report.from : report.from + " — " + report.to;
    const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير الالتزام برصد الغياب</title>'+
      '<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet"><style>'+
      '@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}'+
      'body{font-family:Tajawal,Arial,sans-serif;color:#172b35;font-size:10px;margin:0}header{text-align:center;border:2px solid #183653;padding:10px 12px;margin-bottom:10px}'+
      'header strong{display:block;font-size:13px;line-height:1.8}header h1{font-size:17px;margin:5px 0;color:#183653}header p{margin:3px 0;color:#475569;font-weight:700}'+
      '.summary{display:flex;gap:8px;justify-content:space-between;margin:8px 0 12px}.summary span{flex:1;text-align:center;border:1px solid #dbe4ea;background:#f8fafc;border-radius:7px;padding:7px;font-weight:800}'+
      'table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:7px 6px;vertical-align:top;overflow-wrap:anywhere}th{background:#eaf1f6;color:#183653;font-weight:900;text-align:center}'+
      'td.num,td.pct{text-align:center;font-weight:900}.continuation{color:#64748b;font-size:9px}td.name{font-weight:900}td.pct{background:#eff6ff;color:#1d4ed8;font-size:11px}tbody tr:nth-child(even){background:#f8fafc}'+
      'tr{break-inside:avoid;page-break-inside:avoid}thead{display:table-header-group}td{line-height:1.65} .continuation{color:#64748b;font-size:9px}.signatures{display:flex;justify-content:space-between;margin-top:22px;font-weight:800}.signatures span{width:45%}'+
      '@media print{header,tbody tr{break-inside:avoid;page-break-inside:avoid}}'+
      '</style></head><body><header><strong>سلطنة عُمان<br>وزارة التربية والتعليم<br>المديرية العامة لمحافظة شمال الباطنة<br>إدارة السويق<br>مدرسة أبو دجانة</strong>'+
      '<h1>تقرير الالتزام برصد الغياب</h1><p>الفترة: '+esc(period)+'</p></header>'+
      '<div class="summary"><span>إجمالي الحصص: '+report.totalLessons+'</span><span>رُصدت: '+report.completeLessons+'</span><span>لم تُرصد: '+report.pendingLessons+'</span><span>عدد المعلمين: '+report.rows.length+'</span></div>'+
      '<table><thead><tr><th style="width:19%">المعلم</th><th style="width:10%">عدد الحصص</th><th style="width:27%">رصد الغياب</th><th style="width:32%">لم يرصد الغياب</th><th style="width:12%">نسبة الالتزام</th></tr></thead><tbody>'+rows+'</tbody></table>'+
      '<div class="signatures"><span>مساعد مدير المدرسة: ....................................</span><span>مدير المدرسة: ....................................</span></div>'+
      '<script>window.onload=()=>setTimeout(()=>window.print(),300);<\\/script></body></html>';
    w.document.open(); w.document.write(html); w.document.close();
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
})();