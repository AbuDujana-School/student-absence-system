(function () {
  "use strict";
  const ROOT_ID = "saActivityMonitor";
  const EVENT_LABELS = {
    student_affairs_open: "دخول شؤون الطلبة",
    absence_report_view: "الاطلاع على تقرير الغياب",
    behavior_report_view: "الاطلاع على تقرير السلوكيات",
    formal_warning_issued: "إصدار إنذار رسمي"
  };
  let lastReport = null;
  let loading = false;

  function canMonitor() {
    const user = typeof activeUser !== "undefined" ? activeUser : null;
    return !!(user && (
      user.type === "admin" ||
      user.permissions?.studstats === true
    ));
  }
  function token() {
    try { return window.readAppAuthToken?.() || ""; } catch (_) { return ""; }
  }
  async function request(body) {
    const authToken = token();
    if (!authToken || typeof window.appAuthRequest !== "function") throw new Error("انتهت جلسة الدخول الآمن. أعد تسجيل الدخول.");
    return window.appAuthRequest(body, authToken);
  }
  function root() { return document.getElementById(ROOT_ID); }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }
  function localDate() {
    try { return window.getOmanLocalDate?.() || new Date().toISOString().slice(0, 10); }
    catch (_) { return new Date().toISOString().slice(0, 10); }
  }
  function shiftDate(date, days) {
    const d = new Date(String(date) + "T12:00:00+04:00");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function ensureDates() {
    const from = document.getElementById("saActivityFrom");
    const to = document.getElementById("saActivityTo");
    if (!from || !to) return;
    const today = localDate();
    if (!to.value) to.value = today;
    if (!from.value) from.value = shiftDate(today, -29);
    from.max = today;
    to.max = today;
  }
  function showForAuthorizedUser() {
    const el = root();
    if (!el) return;
    el.classList.toggle("hidden", !canMonitor());
  }
  async function logReportView(type) {
    const user = typeof activeUser !== "undefined" ? activeUser : null;
    if (!user) return;
    if (type === "student_affairs_open" && user.type !== "admin" && user.permissions?.studentAffairs !== true) return;
    if (type !== "student_affairs_open" && !canMonitor()) return;
    try {
      await request({ action: "activity_log", event_type: type, metadata: { source: type === "student_affairs_open" ? "student_affairs_module" : "statistics_dashboard" } });
    } catch (error) {
      console.warn("Student Affairs activity event was not recorded:", error?.message || error);
    }
  }
  function aggregate(report) {
    const teachers = Array.isArray(report?.teachers) ? report.teachers : [];
    const events = Array.isArray(report?.events) ? report.events : [];
    const byName = new Map();
    teachers.forEach(teacher => byName.set(teacher.name, {
      name: teacher.name, events: [], student_affairs_open: 0,
      absence_report_view: 0, behavior_report_view: 0, formal_warning_issued: 0
    }));
    events.forEach(event => {
      const row = byName.get(event.actor_name);
      if (!row || !Object.prototype.hasOwnProperty.call(row, event.event_type)) return;
      row.events.push(event);
      row[event.event_type] += 1;
    });
    const rows = Array.from(byName.values()).map(row => ({
      ...row,
      total: row.events.length,
      last: row.events.reduce((latest, event) => !latest || event.occurred_at > latest ? event.occurred_at : latest, null)
    })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ar"));
    return { rows, events };
  }
  function formatDateTime(value) {
    try { return new Intl.DateTimeFormat("ar-OM", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Muscat" }).format(new Date(value)); }
    catch (_) { return String(value || "—"); }
  }
  function render(report) {
    const summary = document.getElementById("saActivitySummary");
    const table = document.getElementById("saActivityReportTable");
    const status = document.getElementById("saActivityReportStatus");
    const note = document.getElementById("saActivityTrackingNote");
    if (!summary || !table || !status || !note) return;
    const { rows, events } = aggregate(report);
    Object.keys(EVENT_LABELS).forEach(type => {
      const count = events.filter(event => event.event_type === type).length;
      const el = summary.querySelector('[data-summary="' + type + '"]');
      if (el) el.textContent = String(count);
    });
    const start = report.tracking_started_at ? formatDateTime(report.tracking_started_at) : "غير متاح";
    note.textContent = "بدأ التسجيل المركزي من: " + start + ". لا تتوفر سجلات تاريخية للأنشطة التي حدثت قبل بدء التسجيل.";
    const from = document.getElementById("saActivityFrom")?.value || "";
    const to = document.getElementById("saActivityTo")?.value || "";
    const dayCount = Math.max(1, Math.round((new Date(to + "T12:00:00Z") - new Date(from + "T12:00:00Z")) / 86400000) + 1);
    const weeklyFactor = 7 / dayCount;
    const head = '<div class="min-w-[950px]"><table class="w-full text-right text-xs"><thead class="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"><tr>' +
      '<th class="p-3">المعلم</th><th class="p-3 text-center">زيارات شؤون الطلبة</th><th class="p-3 text-center">تقارير الغياب</th><th class="p-3 text-center">تقارير السلوكيات</th><th class="p-3 text-center">الإنذارات الرسمية</th><th class="p-3 text-center">إجمالي النشاط</th><th class="p-3 text-center">متوسط زيارات يومي</th><th class="p-3 text-center">متوسط زيارات أسبوعي</th><th class="p-3">آخر نشاط</th><th class="p-3">التفاصيل</th></tr></thead><tbody class="divide-y divide-slate-100 dark:divide-slate-800">';
    const body = rows.map(row => {
      const details = row.events.slice().sort((a,b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).map(event =>
        '<div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800"><span class="font-bold">' + escapeHtml(EVENT_LABELS[event.event_type] || event.event_type) + '</span><time class="text-slate-500">' + escapeHtml(formatDateTime(event.occurred_at)) + '</time></div>'
      ).join("") || '<p class="py-2 text-slate-400">لا توجد أنشطة مسجلة خلال الفترة.</p>';
      return '<tr class="align-top hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20"><td class="p-3 font-black">' + escapeHtml(row.name) + '</td>' +
        '<td class="p-3 text-center font-bold">' + row.student_affairs_open + '</td><td class="p-3 text-center font-bold text-emerald-700">' + row.absence_report_view + '</td>' +
        '<td class="p-3 text-center font-bold text-teal-700">' + row.behavior_report_view + '</td><td class="p-3 text-center font-bold text-rose-700">' + row.formal_warning_issued + '</td>' +
        '<td class="p-3 text-center font-black">' + row.total + '</td><td class="p-3 text-center">' + (row.student_affairs_open / dayCount).toFixed(2) + '</td><td class="p-3 text-center">' + (row.student_affairs_open * weeklyFactor).toFixed(2) + '</td>' +
        '<td class="p-3 whitespace-nowrap">' + escapeHtml(row.last ? formatDateTime(row.last) : "—") + '</td><td class="p-3"><details class="min-w-48"><summary class="cursor-pointer rounded-lg bg-indigo-50 px-3 py-2 font-black text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-200">عرض ' + row.events.length + ' سجل</summary><div class="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-200 px-2 dark:border-slate-700">' + details + '</div></details></td></tr>';
    }).join("");
    table.innerHTML = head + (body || '<tr><td colspan="10" class="p-6 text-center text-slate-400">لا يوجد معلمون مستوفون لصلاحية شؤون الطلبة في دليل المستخدمين.</td></tr>') + '</tbody></table></div>';
    status.textContent = "عدد المعلمين: " + rows.length + " | عدد الأنشطة المسجلة: " + events.length + " | الفترة: " + from + " إلى " + to + " | المتوسطات محسوبة على أيام الفترة التقويمية.";
    lastReport = { report, rows, events, from, to };
  }
  async function load() {
    if (!canMonitor()) { showForAuthorizedUser(); return; }
    if (loading) return;
    const status = document.getElementById("saActivityReportStatus");
    const from = document.getElementById("saActivityFrom")?.value;
    const to = document.getElementById("saActivityTo")?.value;
    if (!from || !to || from > to) {
      if (status) status.textContent = "تحقق من تاريخ البداية والنهاية.";
      return;
    }
    loading = true;
    if (status) status.textContent = "جارٍ تحميل سجل الأنشطة المركزي...";
    try {
      const data = await request({ action: "activity_report", from, to });
      render(data);
    } catch (error) {
      if (status) status.textContent = error?.message || "تعذر تحميل تقرير المراقبة.";
    } finally { loading = false; }
  }
  function printReport() {
    if (!lastReport) { window.saActivityLoad?.(); return; }
    const { rows, events, from, to, report } = lastReport;
    const htmlRows = rows.map(row => {
      const details = row.events.slice().sort((a,b)=>String(a.occurred_at).localeCompare(String(b.occurred_at))).map(event =>
        '<tr><td>' + escapeHtml(EVENT_LABELS[event.event_type] || event.event_type) + '</td><td>' + escapeHtml(formatDateTime(event.occurred_at)) + '</td></tr>'
      ).join("");
      return '<tr><td>' + escapeHtml(row.name) + '</td><td>' + row.student_affairs_open + '</td><td>' + row.absence_report_view + '</td><td>' + row.behavior_report_view + '</td><td>' + row.formal_warning_issued + '</td><td>' + row.total + '</td><td>' + (row.student_affairs_open / Math.max(1, Math.round((new Date(to+"T12:00:00Z")-new Date(from+"T12:00:00Z"))/86400000)+1)).toFixed(2) + '</td></tr>' +
        (details ? '<tr><td colspan="7"><table class="details"><thead><tr><th>نوع النشاط</th><th>التاريخ والوقت</th></tr></thead><tbody>' + details + '</tbody></table></td></tr>' : '');
    }).join("");
    const w = window.open("", "_blank");
    if (!w) { window.alert("يرجى السماح بالنوافذ المنبثقة لتصدير التقرير."); return; }
    w.document.write('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير مراقبة أداء معلمي شؤون الطلبة</title><style>' +
      '@page{size:A4 landscape;margin:12mm}body{font-family:Tahoma,Arial,sans-serif;color:#172033}h1{text-align:center;font-size:20px;margin:0 0 6px}p{font-size:11px;text-align:center;color:#475569}.meta{display:flex;justify-content:space-between;border-block:1px solid #cbd5e1;padding:8px 0;margin:12px 0;font-size:11px}table{width:100%;border-collapse:collapse;font-size:10px;margin:8px 0}th{background:#e8eef8}th,td{border:1px solid #cbd5e1;padding:6px;text-align:right}.details{width:100%;font-size:9px}.details th{background:#f1f5f9}tr{break-inside:avoid}footer{margin-top:12px;font-size:9px;color:#64748b;text-align:center}@media print{button{display:none}}' +
      '</style></head><body><h1>تقرير مراقبة أداء معلمي شؤون الطلبة</h1><p>مدرسة أبو دجانة — تقرير إداري موثق</p><div class="meta"><span>الفترة: ' + escapeHtml(from) + ' إلى ' + escapeHtml(to) + '</span><span>تاريخ إعداد التقرير: ' + escapeHtml(formatDateTime(new Date().toISOString())) + '</span><span>عدد الأنشطة: ' + events.length + '</span></div>' +
      '<table><thead><tr><th>المعلم</th><th>زيارات شؤون الطلبة</th><th>تقارير الغياب</th><th>تقارير السلوكيات</th><th>الإنذارات الرسمية</th><th>إجمالي النشاط</th><th>متوسط يومي</th></tr></thead><tbody>' + htmlRows + '</tbody></table><footer>يحتوي هذا التقرير على الأنشطة المسجلة منذ تاريخ بدء التسجيل المركزي فقط، ولا يعيد بناء أنشطة سابقة.</footer><script>window.onload=()=>window.print();<\/script></body></html>');
    w.document.close();
  }
  window.saActivityLoad = load;
  window.saActivityPrint = printReport;
  window.saActivityRefreshVisibility = showForAuthorizedUser;

  const originalOpenStudentAffairs = window.openStudentAffairsView;
  if (typeof originalOpenStudentAffairs === "function") {
    window.openStudentAffairsView = function () {
      void logReportView("student_affairs_open");
      return originalOpenStudentAffairs.apply(this, arguments);
    };
  }
  const originalSwitch = window.switchStatsSubTab;
  if (typeof originalSwitch === "function") {
    window.switchStatsSubTab = function (tab) {
      const result = originalSwitch.apply(this, arguments);
      if (tab === "absence") void logReportView("absence_report_view");
      if (tab === "behaviors") void logReportView("behavior_report_view");
      showForAuthorizedUser();
      return result;
    };
  }
  const originalFinalize = window.finalizeLoginState;
  if (typeof originalFinalize === "function") {
    window.finalizeLoginState = async function () {
      const result = await originalFinalize.apply(this, arguments);
      showForAuthorizedUser();
      return result;
    };
  }
  document.addEventListener("DOMContentLoaded", function () {
    ensureDates();
    showForAuthorizedUser();
  });
  ensureDates();
  showForAuthorizedUser();
})();