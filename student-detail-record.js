/* Student Affairs detailed record: partial-name search + multi-student selection.
   Uses the existing report authorization, data API and official print template. */
(function () {
  'use strict';
  if (window.__saStudentDetailMultiSelectInstalled) return;
  window.__saStudentDetailMultiSelectInstalled = true;

  const selected = new Map();
  let matches = [];
  let loading = false;
  let selectionOwner = '';
  const normalize = value => String(value || '').normalize('NFC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('ar');
  const keyOf = item => item.className + '\u001f' + item.name;
  const allowed = () => saStudentProfileAllowedClasses();

  function currentSelectionOwner() {
    const principal = saSession?.principal || null;
    if (!principal) return '';
    return String(principal.type || '') + ':' + String(principal.name || '') +
      ':' + String(saSession?.expires_at || '');
  }

  function syncSelectionOwner() {
    const nextOwner = currentSelectionOwner();
    if (selectionOwner && nextOwner !== selectionOwner) {
      selected.clear();
      renderSelected();
      markSelectionChanged();
    }
    selectionOwner = nextOwner;
  }

  function resetSelectionOnLogout() {
    const originalLogout = window.saLogout;
    if (typeof originalLogout !== 'function' || originalLogout.__saStudentDetailReset) return;
    const wrappedLogout = async function (...args) {
      selected.clear();
      selectionOwner = '';
      renderSelected();
      markSelectionChanged();
      return originalLogout.apply(this, args);
    };
    wrappedLogout.__saStudentDetailReset = true;
    window.saLogout = wrappedLogout;
  }

  function styles() {
    if (document.getElementById('saStudentDetailMultiStyles')) return;
    const style = document.createElement('style');
    style.id = 'saStudentDetailMultiStyles';
    style.textContent = [
      '#saStudentProfileClass,#saStudentProfileName{min-height:54px!important;border-radius:18px!important;border:1px solid rgba(100,116,139,.28)!important;background:rgba(255,255,255,.8)!important;backdrop-filter:blur(14px);padding:14px 16px!important;font-size:16px!important;font-weight:800!important;box-shadow:0 8px 24px rgba(15,23,42,.06)}',
      '.dark #saStudentProfileClass,.dark #saStudentProfileName{background:rgba(15,23,42,.8)!important;color:#f8fafc!important}',
      '#saStudentDetailMultiPanel{margin-top:16px;padding:18px;border:1px solid rgba(99,102,241,.22);border-radius:24px;background:linear-gradient(135deg,rgba(224,242,254,.82),rgba(237,233,254,.78),rgba(255,255,255,.8));box-shadow:0 16px 40px rgba(30,64,175,.09);backdrop-filter:blur(18px)}',
      '.dark #saStudentDetailMultiPanel{background:linear-gradient(135deg,rgba(15,45,68,.9),rgba(49,35,83,.86),rgba(15,23,42,.9))}',
      '.sa-sdm-heading{font-size:16px;font-weight:900;color:#1e293b}.dark .sa-sdm-heading{color:#f8fafc}.sa-sdm-hint{font-size:12px;line-height:1.8;color:#475569}.dark .sa-sdm-hint{color:#cbd5e1}',
      '#saStudentDetailSearchResults{display:grid;gap:9px;margin-top:12px;max-height:340px;overflow:auto;padding:2px}',
      '.sa-sdm-result{display:flex;align-items:center;gap:12px;width:100%;min-height:64px;padding:12px 14px;border-radius:17px;text-align:right;border:1px solid rgba(148,163,184,.25);background:rgba(255,255,255,.86);color:#0f172a;box-shadow:0 5px 14px rgba(15,23,42,.05);cursor:pointer}',
      '.sa-sdm-result.is-selected{border-color:#0d9488;background:rgba(204,251,241,.85)}.dark .sa-sdm-result{background:rgba(15,23,42,.78);color:#f8fafc}.dark .sa-sdm-result.is-selected{background:rgba(15,118,110,.3)}',
      '.sa-sdm-check{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;border:2px solid #94a3b8;border-radius:9px;color:white;font-size:15px}.is-selected .sa-sdm-check{background:#0d9488;border-color:#0d9488}',
      '.sa-sdm-name{display:block;font-size:15px;font-weight:900}.sa-sdm-class{display:block;margin-top:4px;font-size:11px;color:#64748b;font-weight:800}.dark .sa-sdm-class{color:#cbd5e1}',
      '#saStudentDetailSelectedList{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}',
      '.sa-sdm-chip{display:inline-flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid rgba(13,148,136,.25);border-radius:999px;background:rgba(204,251,241,.85);color:#115e59;font-size:12px;font-weight:900}.dark .sa-sdm-chip{background:rgba(15,118,110,.28);color:#ccfbf1}',
      '.sa-sdm-chip button{width:24px;height:24px;border-radius:50%;background:rgba(13,148,136,.16);font-size:17px;line-height:1}',
      '#saStudentDetailCount{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:30px;padding:0 10px;border-radius:999px;background:#4338ca;color:white;font-size:12px;font-weight:900}',
      '.sa-sdm-empty{padding:16px;border:1px dashed rgba(100,116,139,.35);border-radius:16px;text-align:center;font-size:12px;color:#64748b;background:rgba(255,255,255,.4)}',
      '#saStudentProfileResult .sa-sdm-profile-card{overflow:hidden;margin-top:14px;border:1px solid rgba(99,102,241,.2);border-radius:22px;background:rgba(255,255,255,.9);box-shadow:0 12px 30px rgba(15,23,42,.07)}',
      '.dark #saStudentProfileResult .sa-sdm-profile-card{background:rgba(15,23,42,.86);border-color:rgba(129,140,248,.25)}',
      '.sa-sdm-profile-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;padding:17px 18px;color:white;background:linear-gradient(115deg,#0f766e,#2563eb 60%,#6d28d9)}.sa-sdm-profile-head h4{font-size:17px;font-weight:900}',
      '.sa-sdm-profile-body{padding:16px}.sa-sdm-table-wrap{overflow-x:auto;border-radius:14px}.sa-sdm-table{width:100%;min-width:520px;border-collapse:collapse;font-size:12px}.sa-sdm-table th{background:#eef2ff;color:#334155;font-weight:900}.dark .sa-sdm-table th{background:#1e293b;color:#e2e8f0}.sa-sdm-table td,.sa-sdm-table th{padding:11px 10px;text-align:right;border-bottom:1px solid rgba(148,163,184,.2)}',
      '.sa-sdm-print-all{min-height:52px;padding:13px 22px;border-radius:16px;color:white;font-size:15px;font-weight:900;background:linear-gradient(110deg,#0f766e,#2563eb);box-shadow:0 10px 22px rgba(37,99,235,.18)}',
      '.sa-sdm-load-button{min-height:56px!important;padding:14px 22px!important;border-radius:17px!important;font-size:15px!important;font-weight:900!important;background:linear-gradient(110deg,#0f766e,#2563eb)!important;box-shadow:0 10px 22px rgba(37,99,235,.18)!important}',
      '@media(max-width:640px){#saStudentDetailMultiPanel{padding:14px;border-radius:20px}.sa-sdm-result{min-height:68px}.sa-sdm-name{font-size:14px}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function setup() {
    const select = document.getElementById('saStudentProfileClass');
    const input = document.getElementById('saStudentProfileName');
    if (!select || !input) return false;
    if (document.getElementById('saStudentDetailMultiPanel')) return true;
    input.removeAttribute('list');
    input.placeholder = 'اكتب جزءاً من اسم الطالب للبحث الفوري...';
    input.setAttribute('aria-label', 'ابحث عن طالب بجزء من اسمه');
    const datalist = document.getElementById('saStudentProfileNames');
    if (datalist) datalist.remove();
    const label = input.closest('label');
    if (label && label.firstChild && label.firstChild.nodeType === Node.TEXT_NODE) {
      label.firstChild.textContent = 'البحث عن الطلاب (جزء من الاسم)';
    }
    const panel = document.createElement('div');
    panel.id = 'saStudentDetailMultiPanel';
    panel.innerHTML =
      '<div class="flex flex-wrap items-center justify-between gap-3"><div><div class="sa-sdm-heading"><i class="fa-solid fa-users-viewfinder ml-2 text-indigo-600"></i>اختيار عدة طلاب</div><p class="sa-sdm-hint mt-1">اكتب اسماً أو جزءاً منه، ثم ضع علامة صح. امسح البحث وأضف أسماء أخرى دون فقدان اختياراتك.</p></div><div class="flex items-center gap-2"><span class="sa-sdm-hint font-black">المحددون</span><span id="saStudentDetailCount">0</span></div></div>' +
      '<div id="saStudentDetailSelectedList" aria-live="polite"><div class="sa-sdm-empty w-full">لم تحدد أي طالب بعد</div></div>' +
      '<div id="saStudentDetailSearchResults"><div class="sa-sdm-empty">ابدأ بكتابة جزء من اسم الطالب لعرض النتائج</div></div>';
    const grid = input.closest('.grid');
    if (grid) grid.insertAdjacentElement('afterend', panel);
    else input.parentElement.insertAdjacentElement('afterend', panel);
    const button = document.querySelector('button[onclick="saLoadStudentNoticeProfile()"]');
    if (button) button.innerHTML = '<i class="fa-solid fa-file-circle-check ml-2"></i> عرض السجلات التفصيلية للطلاب المحددين';
    input.addEventListener('input', renderMatches);
    panel.addEventListener('change', function (event) {
      const checkbox = event.target.closest('input[data-sdm-index]');
      if (!checkbox) return;
      const item = matches[Number(checkbox.dataset.sdmIndex)];
      if (!item) return;
      if (checkbox.checked) {
        selected.set(keyOf(item), item);
        input.value = '';
      } else selected.delete(keyOf(item));
      renderSelected();
      renderMatches();
      markSelectionChanged();
    });
    panel.addEventListener('click', function (event) {
      const remove = event.target.closest('button[data-sdm-remove]');
      if (!remove) return;
      const entry = Array.from(selected.entries())[Number(remove.dataset.sdmRemove)];
      if (entry) selected.delete(entry[0]);
      renderSelected();
      renderMatches();
      markSelectionChanged();
    });
    return true;
  }

  function setLoadingState(isLoading) {
    const controls = document.querySelectorAll(
      '#saStudentProfileClass, #saStudentProfileName, ' +
      'button[onclick="saLoadStudentNoticeProfile()"], ' +
      '#saStudentDetailMultiPanel input, #saStudentDetailMultiPanel button'
    );
    controls.forEach(control => {
      if (isLoading) {
        control.dataset.sdmWasDisabled = control.disabled ? '1' : '0';
        control.disabled = true;
        control.setAttribute('aria-disabled', 'true');
      } else {
        const prior = control.dataset.sdmWasDisabled;
        if (prior !== undefined) {
          control.disabled = prior === '1';
          delete control.dataset.sdmWasDisabled;
        }
        control.removeAttribute('aria-disabled');
      }
    });
  }

  function markSelectionChanged() {
    const host = document.getElementById('saStudentProfileResult');
    const printRoot = document.getElementById('saStudentProfilePrintRoot');
    if (host) { host.innerHTML = ''; host.classList.add('hidden'); }
    if (printRoot) printRoot.innerHTML = '';
    saStudentProfileCanPrint = false;
    saStudentProfileStatus('تم تحديث قائمة الطلاب المحددين. اضغط عرض السجلات لتحديث النتائج والطباعة.');
  }

  function renderSelected() {
    const host = document.getElementById('saStudentDetailSelectedList');
    const count = document.getElementById('saStudentDetailCount');
    if (!host || !count) return;
    const items = Array.from(selected.values());
    count.textContent = String(items.length);
    if (!items.length) {
      host.innerHTML = '<div class="sa-sdm-empty w-full">لم تحدد أي طالب بعد</div>';
      return;
    }
    host.innerHTML = items.map(function (item, index) {
      return '<span class="sa-sdm-chip"><i class="fa-solid fa-user-check"></i>' +
        escapeHtml(item.name) + ' · ' + escapeHtml(formatClassName(item.className)) +
        '<button type="button" data-sdm-remove="' + index + '" aria-label="إزالة الطالب">×</button></span>';
    }).join('');
  }

  function renderMatches() {
    const input = document.getElementById('saStudentProfileName');
    const host = document.getElementById('saStudentDetailSearchResults');
    const select = document.getElementById('saStudentProfileClass');
    if (!input || !host || !select) return;
    const query = normalize(input.value);
    if (!query) {
      matches = [];
      host.innerHTML = '<div class="sa-sdm-empty">ابدأ بكتابة جزء من اسم الطالب، ثم اختره بعلامة الصح</div>';
      return;
    }
    const classes = allowed();
    const scope = select.value === '__all__' ? classes : classes.filter(name => name === select.value);
    const candidates = [];
    scope.forEach(function (className) {
      const roster = Array.isArray(db?.students?.[className]) ? db.students[className] : [];
      roster.forEach(function (rawName) {
        const name = String(rawName || '').trim();
        const rank = normalize(name).indexOf(query);
        if (name && rank >= 0) candidates.push({ className: className, name: name, rank: rank });
      });
    });
    candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'ar') || a.className.localeCompare(b.className, 'ar'));
    matches = candidates.slice(0, 60);
    if (!candidates.length) {
      host.innerHTML = '<div class="sa-sdm-empty"><i class="fa-solid fa-magnifying-glass mb-2 block text-lg"></i>لا توجد أسماء مطابقة. جرّب جزءاً آخر من الاسم.</div>';
      return;
    }
    host.innerHTML = matches.map(function (item, index) {
      const checked = selected.has(keyOf(item));
      return '<label class="sa-sdm-result' + (checked ? ' is-selected' : '') + '">' +
        '<input class="sr-only" type="checkbox" data-sdm-index="' + index + '" ' + (checked ? 'checked' : '') + '>' +
        '<span class="sa-sdm-check">' + (checked ? '<i class="fa-solid fa-check"></i>' : '') + '</span>' +
        '<span class="min-w-0 flex-1"><span class="sa-sdm-name">' + escapeHtml(item.name) + '</span>' +
        '<span class="sa-sdm-class"><i class="fa-solid fa-school ml-1"></i>' + escapeHtml(formatClassName(item.className)) + '</span></span>' +
        '<span class="text-[11px] font-black ' + (checked ? 'text-teal-700' : 'text-indigo-600') + '">' +
        (checked ? 'تم الاختيار' : 'اضغط للتحديد') + '</span></label>';
    }).join('') + (candidates.length > matches.length
      ? '<div class="sa-sdm-hint text-center">تظهر أول ' + matches.length + ' نتيجة من أصل ' + candidates.length + '؛ أضف حروفاً أخرى لتضييق البحث.</div>' : '');
  }

  window.saLoadStudentProfileDirectory = function () {
    syncSelectionOwner();
    const select = document.getElementById('saStudentProfileClass');
    if (!select) return;
    const classes = allowed();
    const allowedSet = new Set(classes);
    for (const [key, item] of selected) {
      if (!allowedSet.has(item.className)) selected.delete(key);
    }
    renderSelected();
    const prior = select.value;
    if (!classes.length) {
      selected.clear();
      renderSelected();
      select.innerHTML = '<option value="">لا توجد صفوف مصرح بها</option>';
      saStudentProfileStatus('لا توجد صلاحية لعرض سجلات الطلاب.', true);
      return;
    }
    select.innerHTML = '<option value="__all__">جميع صفوف المدرسة</option>' +
      classes.map(className => '<option value="' + escapeHtml(className) + '">' + escapeHtml(formatClassName(className)) + '</option>').join('');
    select.value = prior === '__all__' || classes.includes(prior) ? prior : '__all__';
    const input = document.getElementById('saStudentProfileName');
    if (input) input.value = '';
    renderSelected();
    renderMatches();
    saStudentProfileStatus('تم تجهيز البحث في ' + classes.length + ' صفاً ضمن نطاق صلاحياتك. اكتب جزءاً من اسم الطالب.');
  };

  function profileCard(item, rows, notices) {
    const counts = new Map();
    rows.forEach(row => counts.set(row.type, (counts.get(row.type) || 0) + 1));
    const summary = Array.from(counts.entries()).map(entry =>
      '<span class="inline-block rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2 m-1 text-xs font-black text-indigo-800">' +
      escapeHtml(SA_NOTICE_LABELS[entry[0]] || entry[0]) + ' · ' + entry[1] + '</span>').join('');
    const detailRows = rows.length ? rows.map(row =>
      '<tr><td>' + escapeHtml(row.date) + '</td><td>' + escapeHtml(row.period) + '</td><td>' +
      escapeHtml(SA_NOTICE_LABELS[row.type] || row.type) + '</td><td>' + escapeHtml(row.note || '—') + '</td></tr>').join('')
      : '<tr><td colspan="4" class="text-center text-slate-500">لا توجد وقائع مسجلة ضمن الصلاحيات والفترة المتاحة</td></tr>';
    const noticeRows = notices.length ? notices.map(notice => {
      const details = (Array.isArray(notice.events) ? notice.events : []).map(event =>
        escapeHtml(SA_NOTICE_LABELS[event.type] || event.type) + ' · ' + escapeHtml(String(event.date || '')) +
        ' · الحصة ' + escapeHtml(saNoticePeriodLabel(event.period))).join('، ');
      return '<div class="rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800"><strong>تنبيه رقم (' +
        escapeHtml(String(notice.issue_number)) + ')</strong> · ' + escapeHtml(notice.issued_on || '') +
        ' · ' + (notice.delivered ? 'تم التسليم' : 'لم يؤكد التسليم') +
        '<div class="mt-1 text-slate-500">أصدره: ' + escapeHtml(notice.issued_by_name || '—') +
        ' · ' + (notice.events || []).length + ' واقعة</div><div class="mt-2 leading-6">' +
        (details || 'لا تتوفر تفاصيل ظاهرة ضمن صلاحياتك.') + '</div></div>';
    }).join('') : '<p class="text-xs text-slate-500">لا توجد تنبيهات رسمية مسجلة لهذا الطالب.</p>';
    return '<article class="sa-sdm-profile-card"><div class="sa-sdm-profile-head"><div><h4>' +
      escapeHtml(item.name) + '</h4><p class="mt-1 text-xs text-white/85">' + escapeHtml(formatClassName(item.className)) +
      ' · ' + rows.length + ' واقعة · ' + notices.length + ' تنبيه رسمي</p></div><span class="rounded-xl bg-white/15 px-3 py-2 text-xs font-black">ملف طالب</span></div>' +
      '<div class="sa-sdm-profile-body"><div class="mb-3 flex flex-wrap gap-1">' + summary + '</div>' +
      '<div class="sa-sdm-table-wrap"><table class="sa-sdm-table"><thead><tr><th>التاريخ</th><th>الحصة</th><th>المخالفة</th><th>التفاصيل</th></tr></thead><tbody>' +
      detailRows + '</tbody></table></div><h5 class="mt-5 mb-2 font-black">التنبيهات السابقة</h5><div class="space-y-2">' +
      noticeRows + '</div></div></article>';
  }

  function combinePrintDocuments(documents) {
    if (!documents.length) return '';
    const head = (documents[0].match(/<head>([\s\S]*?)<\/head>/i) || [null, ''])[1];
    const bodies = documents.map(html => (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1]);
    const body = bodies.map((html, index) =>
      (index ? '<div style="break-before:page;page-break-before:always"></div>' : '') + html).join('');
    return '<!doctype html><html lang="ar" dir="rtl"><head>' + head + '</head><body>' + body + '</body></html>';
  }

  window.saLoadStudentNoticeProfile = async function () {
    if (loading) return;
    const items = Array.from(selected.values());
    const host = document.getElementById('saStudentProfileResult');
    const printRoot = document.getElementById('saStudentProfilePrintRoot');
    const p = saReportPermissions || {};
    if (!host || !printRoot) {
      saStudentProfileStatus('تعذر تهيئة مساحة عرض السجل التفصيلي.', true);
      return;
    }
    if (!items.length) {
      saStudentProfileStatus('ابحث عن طالب وحدد اسمه بعلامة الصح أولاً. يمكنك اختيار أكثر من طالب.', true);
      return;
    }
    if (p.can_read_attendance !== true && p.can_read_behavior !== true) {
      saStudentProfileStatus('لا تملك صلاحية قراءة سجلات الحضور أو السلوك.', true);
      return;
    }
    const permitted = allowed();
    const attendanceScope = p.can_read_attendance === true && (p.attendance_statuses || []).length
      ? saGetAllowedReportClasses('attendance') : [];
    const behaviorScope = p.can_read_behavior === true ? saGetAllowedReportClasses('behavior') : [];
    const classNames = Array.from(new Set(items.map(item => item.className)));
    const access = new Map();
    loading = true;
    setLoadingState(true);
    host.classList.remove('hidden');
    host.innerHTML = '<div class="rounded-2xl border border-indigo-100 bg-indigo-50 p-5 text-center font-black text-indigo-800 dark:bg-slate-800 dark:text-indigo-200"><i class="fa-solid fa-spinner fa-spin ml-2"></i>جارٍ جمع سجلات ' + items.length + ' طلاب والتحقق من الصلاحيات...</div>';
    printRoot.innerHTML = '';
    try {
      for (const className of classNames) {
        if (!permitted.includes(className)) throw new Error('يوجد صف خارج نطاق صلاحياتك.');
        const canAttendance = attendanceScope.includes(className);
        const canBehavior = behaviorScope.includes(className);
        if (!canAttendance && !canBehavior) throw new Error('لا تتوفر صلاحية قراءة سجلات أحد الصفوف المحددة.');
        access.set(className, {
          attendance: canAttendance, behavior: canBehavior,
          canPrint: (!canAttendance || p.can_print_attendance === true) && (!canBehavior || p.can_print_behavior === true)
        });
      }
      saStudentProfileCanPrint = Array.from(access.values()).every(item => item.canPrint);
      const today = getOmanLocalDate();
      const currentYear = Number(today.slice(0, 4));
      const attendanceClasses = classNames.filter(name => access.get(name).attendance);
      const behaviorClasses = classNames.filter(name => access.get(name).behavior);
      const attendance = [];
      const behaviors = [];
      for (let year = 2000; year <= currentYear; year++) {
        const from = year + '-01-01';
        const to = year === currentYear ? today : year + '-12-31';
        const result = await saRequest({
          action: 'reports', report_mode: 'view',
          attendance_classes: attendanceClasses, behavior_classes: behaviorClasses,
          attendance_status_filters: attendanceClasses.length
            ? (p.attendance_statuses || []).filter(type => ['absent', 'late', 'escape', 'outside'].includes(type)) : [],
          from, to
        });
        const a = Array.isArray(result?.attendance) ? result.attendance : [];
        const b = Array.isArray(result?.behaviors) ? result.behaviors : [];

        // The Reports API caps each table response at 5,000 rows. If a school-wide
        // aggregate reaches that cap, retry that year class-by-class so one busy
        // class does not cause an incomplete or falsely rejected multi-class report.
        if (a.length >= 5000 || b.length >= 5000) {
          for (const className of classNames) {
            const scope = access.get(className);
            const classResult = await saRequest({
              action: 'reports', report_mode: 'view',
              attendance_classes: scope.attendance ? [className] : [],
              behavior_classes: scope.behavior ? [className] : [],
              attendance_status_filters: scope.attendance
                ? (p.attendance_statuses || []).filter(type => ['absent', 'late', 'escape', 'outside'].includes(type)) : [],
              from, to
            });
            const classAttendance = Array.isArray(classResult?.attendance) ? classResult.attendance : [];
            const classBehaviors = Array.isArray(classResult?.behaviors) ? classResult.behaviors : [];
            if (classAttendance.length >= 5000 || classBehaviors.length >= 5000) {
              throw new Error('تجاوزت سجلات الصف ' + formatClassName(className) + ' في سنة ' + year + ' الحد الآمن. لم نعرض ملفاً قد يكون ناقصاً.');
            }
            if (classAttendance.some(row => String(row.class_name || '') !== className) ||
                classBehaviors.some(row => String(row.class_name || '') !== className)) {
              throw new Error('تضمن رد السجلات بيانات من صف آخر غير الصف المطلوب.');
            }
            attendance.push.apply(attendance, classAttendance);
            behaviors.push.apply(behaviors, classBehaviors);
          }
          continue;
        }

        if (a.some(row => !attendanceClasses.includes(String(row.class_name || ''))) ||
            b.some(row => !behaviorClasses.includes(String(row.class_name || '')))) {
          throw new Error('تضمن الرد سجلات من صف خارج نطاق الاختيار المصرح.');
        }
        attendance.push.apply(attendance, a);
        behaviors.push.apply(behaviors, b);
      }
      // Read official notice history once per selected class, scoped server-side
      // to the selected student names. No other students' notices are returned.
      const namesByClass = new Map();
      for (const item of items) {
        const names = namesByClass.get(item.className) || [];
        if (!names.includes(item.name)) names.push(item.name);
        namesByClass.set(item.className, names);
      }
      const noticeHistoryByClass = new Map();
      for (const className of classNames) {
        const history = await saRequest({
          action: 'reports', report_mode: 'notice_history',
          notice_classes: [className], student_names: namesByClass.get(className) || [], to: today
        });
        noticeHistoryByClass.set(
          className,
          Array.isArray(history?.notices) ? history.notices : []
        );
      }

      const cards = [];
      const printDocs = [];
      for (const item of items) {
        const roster = Array.isArray(db?.students?.[item.className]) ? db.students[item.className] : [];
        if (!roster.some(name => String(name || '').trim() === item.name)) {
          throw new Error('تعذر التحقق من وجود الطالب ' + item.name + ' في الصف ' + formatClassName(item.className) + '.');
        }
        const scope = access.get(item.className);
        const a = scope.attendance ? attendance.filter(row => String(row.class_name || '') === item.className) : [];
        const b = scope.behavior ? behaviors.filter(row => String(row.class_name || '') === item.className) : [];
        saNoticeProfileSelectedName = item.name;
        const rows = saBuildStudentProfileRows(a, b);
        const notices = (noticeHistoryByClass.get(item.className) || []).filter(row =>
          String(row.student_name || '').trim() === item.name &&
          String(row.class_name || item.className) === item.className);
        cards.push(profileCard(item, rows, notices));
        printDocs.push(saStudentProfilePrintableHtml(item.className, item.name, rows, notices));
      }
      host.innerHTML =
        '<div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-teal-200 bg-teal-50 p-4 dark:bg-teal-950/30">' +
        '<div><div class="font-black text-teal-900 dark:text-teal-100">تم تجهيز ' + items.length + ' ملفات طلابية</div>' +
        '<p class="mt-1 text-xs text-teal-800 dark:text-teal-200">كل طالب مع صفه وسجلاته وتنبيهاته السابقة بصورة مستقلة.</p></div>' +
        (saStudentProfileCanPrint
          ? '<button type="button" onclick="saPrintStudentProfile()" class="sa-sdm-print-all"><i class="fa-solid fa-print ml-2"></i> طباعة جميع السجلات / PDF</button>'
          : '<span class="text-xs font-black text-slate-500">عرض فقط — لا تتوفر صلاحية طباعة جميع المصادر المحددة</span>') +
        '</div>' + cards.join('');
      printRoot.innerHTML = combinePrintDocuments(printDocs);
      saStudentProfileStatus('اكتمل عرض السجلات التفصيلية لـ ' + items.length + ' طلاب. يمكنك متابعة البحث وإضافة أسماء أخرى ثم إعادة العرض.');
    } catch (error) {
      host.innerHTML = '';
      printRoot.innerHTML = '';
      saStudentProfileStatus(error?.message || 'تعذر تحميل السجلات التفصيلية للطلاب المحددين.', true);
    } finally {
      loading = false;
      setLoadingState(false);
    }
  };

  function init() {
    styles();
    if (!setup()) return;
    resetSelectionOnLogout();
    window.saLoadStudentProfileDirectory();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();