
(function () {
  'use strict';

  const PORTAL_PERMISSION = 'canViewAdminRecords';
  const MOVED_MODULE_IDS = [
    'dashboardMetricsSection',
    'dashboardUrgentSection',
    'sec-reports',
    'sec-behaviorstats',
    'dashboardTeachersActivity',
    'sec-studstats'
  ];
  const movedModules = new Map();
  let activeModalType = '';
  let previousBodyOverflow = '';
  let reportTabInitialized = false;

  function currentUser() {
    try { return typeof activeUser !== 'undefined' ? activeUser : null; }
    catch (_) { return null; }
  }
  function hasPortalPermission(user) {
    const target = user || currentUser();
    return target?.permissions?.[PORTAL_PERMISSION] === true;
  }
  function canAdminTab(key) {
    try { return typeof window.canAccessAdminTab === 'function' && window.canAccessAdminTab(key, currentUser()); }
    catch (_) { return false; }
  }
  function canReport(key) {
    try { return typeof window.canAccessReport === 'function' && window.canAccessReport(key, currentUser()); }
    catch (_) { return false; }
  }
  function canAnyReport() {
    try { return typeof window.canAccessAnyReport === 'function' && window.canAccessAnyReport(currentUser()); }
    catch (_) { return false; }
  }
  function notify(message, kind) {
    if (typeof window.showToast === 'function') window.showToast(message, kind || 'info');
    else window.alert(message);
  }
  function localDate() {
    try { return typeof window.getOmanLocalDate === 'function' ? window.getOmanLocalDate() : new Date().toISOString().slice(0, 10); }
    catch (_) { return new Date().toISOString().slice(0, 10); }
  }
  function textNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(text ?? '');
    return node;
  }
  function setModalHeader(kicker, title, intro) {
    const badge = document.getElementById('adminPortalModalKicker');
    const heading = document.getElementById('adminPortalModalTitle');
    const description = document.getElementById('adminPortalModalIntro');
    if (badge) badge.textContent = kicker;
    if (heading) heading.textContent = title;
    if (description) description.textContent = intro || '';
  }
  function createEmptyMessage(message) {
    return textNode('div', 'admin-portal-empty', message);
  }
  function syncPortalVisibility() {
    const allowed = hasPortalPermission();
    const banner = document.getElementById('adminPortalBanner');
    if (banner) banner.classList.toggle('hidden', !allowed);
    if (!allowed && !document.getElementById('adminSectionView')?.classList.contains('hidden')) {
      closeAdminSection();
    }
  }

  function installPermissionControl() {
    const modal = document.getElementById('teacherPermissionsModal');
    if (!modal || modal.dataset.adminRecordsPermissionInstalled === '1') return;
    const saveButton = modal.querySelector('button[onclick="saveTeacherPermissions()"]');
    const footer = saveButton?.parentElement;
    if (!footer || !footer.parentElement) return;

    const section = document.createElement('section');
    section.className = 'admin-portal-permission-control';
    section.innerHTML =
      '<label for="perm_p_canViewAdminRecords">' +
        '<input id="perm_p_canViewAdminRecords" type="checkbox">' +
        '<span><strong>الاطلاع على السجلات الإدارية</strong>' +
        '<small>تُظهر هذه الصلاحية بوابة القسم الإداري في الشاشة الرئيسية. وهي لا تمنح تلقائياً صلاحيات الغياب أو السلوكيات أو التقارير أو الإحصائيات؛ تبقى كل وظيفة خاضعة لصلاحيتها الأصلية.</small></span>' +
      '</label>';
    footer.parentElement.insertBefore(section, footer);
    modal.dataset.adminRecordsPermissionInstalled = '1';

    const syncCheckbox = function () {
      const teacherName = String(document.getElementById('permTeacherName')?.textContent || '').trim();
      let teacher = null;
      try {
        teacher = typeof db !== 'undefined' && Array.isArray(db.teachers)
          ? db.teachers.find(item => String(item?.name || '').trim() === teacherName)
          : null;
      } catch (_) {}
      const checkbox = document.getElementById('perm_p_canViewAdminRecords');
      if (checkbox) checkbox.checked = teacher?.permissions?.[PORTAL_PERMISSION] === true;
    };

    if (typeof window.openPermissionsModal === 'function' && !window.openPermissionsModal.__adminRecordsPortalWrapped) {
      const originalOpen = window.openPermissionsModal;
      const wrappedOpen = function (...args) {
        const result = originalOpen.apply(this, args);
        syncCheckbox();
        return result;
      };
      wrappedOpen.__adminRecordsPortalWrapped = true;
      wrappedOpen.__original = originalOpen;
      window.openPermissionsModal = wrappedOpen;
    }

    if (typeof window.saveTeacherPermissions === 'function' && !window.saveTeacherPermissions.__adminRecordsPortalWrapped) {
      const originalSave = window.saveTeacherPermissions;
      const wrappedSave = async function (...args) {
        const teacherName = String(document.getElementById('permTeacherName')?.textContent || '').trim();
        const checkbox = document.getElementById('perm_p_canViewAdminRecords');
        const checked = checkbox?.checked === true;
        let teacher = null;
        try {
          teacher = typeof db !== 'undefined' && Array.isArray(db.teachers)
            ? db.teachers.find(item => String(item?.name || '').trim() === teacherName)
            : null;
        } catch (_) {}
        if (teacher) {
          if (!teacher.permissions || typeof teacher.permissions !== 'object') teacher.permissions = {};
          teacher.permissions[PORTAL_PERMISSION] = checked;
        }
        const result = await originalSave.apply(this, args);
        const user = currentUser();
        if (user && user.name === teacherName) {
          if (!user.permissions || typeof user.permissions !== 'object') user.permissions = {};
          user.permissions[PORTAL_PERMISSION] = checked;
        }
        syncPortalVisibility();
        return result;
      };
      wrappedSave.__adminRecordsPortalWrapped = true;
      wrappedSave.__original = originalSave;
      window.saveTeacherPermissions = wrappedSave;
    }
  }

  function createPortalBanner(dashboardView) {
    if (document.getElementById('adminPortalBanner')) return;
    const grid = Array.from(dashboardView.children).find(child => child.classList.contains('grid'));
    if (!grid) return;
    const banner = document.createElement('section');
    banner.id = 'adminPortalBanner';
    banner.className = 'hidden';
    banner.setAttribute('aria-label', 'بوابة القسم الإداري');
    banner.innerHTML =
      '<button type="button" class="admin-portal-banner-button" id="adminPortalOpenButton">' +
        '<span class="admin-portal-orb one"></span><span class="admin-portal-orb two"></span>' +
        '<span class="admin-portal-banner-copy">' +
          '<span class="admin-portal-kicker"><span class="admin-portal-live-dot"></span> القيادة المدرسية · السجلات الإدارية</span>' +
          '<span class="admin-portal-banner-title block">القسم الإداري</span>' +
          '<span class="admin-portal-banner-desc block">مركز قيادة موحّد لمتابعة نبض اليوم المدرسي، التقارير المعتمدة، والإحصائيات والاتجاهات — دون الدخول إلى لوحة التحكم الفنية.</span>' +
        '</span>' +
        '<span class="admin-portal-banner-cta"><span>دخول القسم الإداري</span><i class="fa-solid fa-arrow-left"></i></span>' +
      '</button>';
    dashboardView.insertBefore(banner, grid);
    document.getElementById('adminPortalOpenButton')?.addEventListener('click', openAdminSection);
  }

  function createPortalView(dashboardView) {
    if (document.getElementById('adminSectionView')) return;
    const view = document.createElement('section');
    view.id = 'adminSectionView';
    view.className = 'admin-portal-view hidden';
    view.setAttribute('dir', 'rtl');
    view.innerHTML =
      '<div class="admin-portal-hero">' +
        '<div class="admin-portal-hero-copy">' +
          '<span class="admin-portal-kicker"><span class="admin-portal-live-dot"></span> منظومة القيادة المدرسية</span>' +
          '<h2>القسم الإداري</h2>' +
          '<p>كل ما تحتاجه إدارة المدرسة في مساحة واحدة: متابعة المؤشرات اليومية، الوصول إلى التقارير الرسمية، وقراءة اتجاهات الأداء لاتخاذ القرار.</p>' +
          '<div class="admin-portal-hero-meta" id="adminPortalTodayLabel"></div>' +
        '</div>' +
        '<div class="admin-portal-hero-actions">' +
          '<button type="button" id="adminPortalHomeButton"><i class="fa-solid fa-house ml-1"></i> الشاشة الرئيسية</button>' +
          '<button type="button" id="adminPortalLogoutButton"><i class="fa-solid fa-right-from-bracket ml-1"></i> خروج</button>' +
        '</div>' +
      '</div>' +
      '<div class="admin-portal-section-label"><span>مراكز المتابعة الإدارية</span><span>اختر المركز لفتح نافذة مستقلة</span></div>' +
      '<div class="admin-portal-grid">' +
        '<button type="button" class="admin-portal-card" data-admin-portal-open="pulse">' +
          '<span class="admin-portal-card-top"><span class="admin-portal-card-icon"><i class="fa-solid fa-wave-square"></i></span><span class="admin-portal-card-tag">متابعة اليوم</span></span>' +
          '<span><h3>نبض اليوم المدرسي</h3><p>الغياب، التسرب، التأخر الصباحي، المخالفات، تغطية الرصد، وتوزيع الاحتياط؛ مع كشوف تفصيلية من السجلات الفعلية.</p></span>' +
          '<span class="admin-portal-card-footer"><span>فتح مؤشرات اليوم</span><span class="admin-portal-card-arrow"><i class="fa-solid fa-arrow-left"></i></span></span>' +
        '</button>' +
        '<button type="button" class="admin-portal-card" data-admin-portal-open="reports">' +
          '<span class="admin-portal-card-top"><span class="admin-portal-card-icon"><i class="fa-solid fa-file-circle-check"></i></span><span class="admin-portal-card-tag">تقارير معتمدة</span></span>' +
          '<span><h3>مركز التقارير والطباعة</h3><p>تقارير الغياب والطابور والاحتياط والسلوكيات ونشاط المعلمين، باستخدام أدوات العرض والطباعة الأصلية وصلاحياتها الحالية.</p></span>' +
          '<span class="admin-portal-card-footer"><span>فتح مركز التقارير</span><span class="admin-portal-card-arrow"><i class="fa-solid fa-arrow-left"></i></span></span>' +
        '</button>' +
        '<button type="button" class="admin-portal-card" data-admin-portal-open="stats">' +
          '<span class="admin-portal-card-top"><span class="admin-portal-card-icon"><i class="fa-solid fa-chart-line"></i></span><span class="admin-portal-card-tag">تحليل واتجاهات</span></span>' +
          '<span><h3>مرصد الإحصاء والاتجاهات</h3><p>مقارنات الغياب والسلوك، أكثر الطلاب تكراراً للمخالفات، انتظام الصفوف، ومخططات تفاعلية مبنية على بيانات المدرسة.</p></span>' +
          '<span class="admin-portal-card-footer"><span>فتح المرصد الإحصائي</span><span class="admin-portal-card-arrow"><i class="fa-solid fa-arrow-left"></i></span></span>' +
        '</button>' +
      '</div>' +
      '<div class="admin-portal-note"><i class="fa-solid fa-shield-halved ml-1"></i> بوابة القسم الإداري لا توسّع صلاحيات الحساب. كل تقرير أو سجل أو إحصائية يظهر وفق الصلاحية الأصلية الممنوحة للمستخدم.</div>';
    dashboardView.parentElement.insertBefore(view, dashboardView.nextSibling);
    document.getElementById('adminPortalHomeButton')?.addEventListener('click', closeAdminSection);
    document.getElementById('adminPortalLogoutButton')?.addEventListener('click', function () {
      closeAdminSection();
      if (typeof window.logoutUser === 'function') window.logoutUser();
    });
    view.querySelectorAll('[data-admin-portal-open]').forEach(button => {
      button.addEventListener('click', () => openAdminSubModal(button.getAttribute('data-admin-portal-open')));
    });
  }

  function createSubModal() {
    if (document.getElementById('adminSubModal')) return;
    const modal = document.createElement('div');
    modal.id = 'adminSubModal';
    modal.className = 'admin-portal-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'adminPortalModalTitle');
    modal.innerHTML =
      '<section class="admin-portal-dialog" role="document" tabindex="-1">' +
        '<header class="admin-portal-modal-head">' +
          '<div><span id="adminPortalModalKicker" class="admin-portal-modal-kicker">القسم الإداري</span><h3 id="adminPortalModalTitle" class="admin-portal-modal-title">نافذة المتابعة</h3></div>' +
          '<div class="admin-portal-modal-actions">' +
            '<button type="button" id="adminPortalModalBack" class="primary"><i class="fa-solid fa-arrow-right ml-1"></i> العودة للقسم الإداري</button>' +
            '<button type="button" id="adminPortalModalClose"><i class="fa-solid fa-xmark ml-1"></i> إغلاق</button>' +
          '</div>' +
        '</header>' +
        '<p id="adminPortalModalIntro" class="admin-portal-modal-intro"></p>' +
        '<div id="adminPortalModalBody"></div>' +
      '</section>';
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
      if (event.target === modal) closeAdminSection();
    });
    document.getElementById('adminPortalModalBack')?.addEventListener('click', closeAdminSubModal);
    document.getElementById('adminPortalModalClose')?.addEventListener('click', closeAdminSection);
  }

  function openAdminSection() {
    if (!hasPortalPermission()) {
      notify('لا تملك صلاحية الاطلاع على السجلات الإدارية.', 'error');
      return;
    }
    restoreMovedModules();
    closeAdminSubModal();
    const home = document.getElementById('dashboardSelectionView');
    const view = document.getElementById('adminSectionView');
    if (!home || !view) return;
    home.classList.add('hidden');
    view.classList.remove('hidden');
    const dateLabel = document.getElementById('adminPortalTodayLabel');
    if (dateLabel) {
      const date = localDate();
      let formatted = date;
      try { formatted = new Intl.DateTimeFormat('ar-OM', { dateStyle: 'full', timeZone: 'Asia/Muscat' }).format(new Date(date + 'T12:00:00+04:00')); } catch (_) {}
      dateLabel.textContent = 'اليوم الدراسي · ' + formatted;
    }
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  function closeAdminSection() {
    closeAdminSubModal();
    restoreMovedModules();
    document.getElementById('adminSectionView')?.classList.add('hidden');
    document.getElementById('dashboardSelectionView')?.classList.remove('hidden');
    document.body.classList.remove('admin-portal-lock');
    if (previousBodyOverflow) document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = '';
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  function setActiveModal(type, kicker, title, intro) {
    activeModalType = type;
    setModalHeader(kicker, title, intro);
    const modal = document.getElementById('adminSubModal');
    if (!modal) return;
    if (modal.classList.contains('hidden')) {
      previousBodyOverflow = document.body.style.overflow || '';
      document.body.classList.add('admin-portal-lock');
    }
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.querySelector('.admin-portal-dialog')?.focus());
  }

  function mountModule(id, host) {
    const node = document.getElementById(id);
    if (!node || !host) return null;
    if (!movedModules.has(id)) {
      const placeholder = document.createComment('admin-portal-home-slot:' + id);
      const parent = node.parentNode;
      if (!parent) return null;
      parent.insertBefore(placeholder, node);
      movedModules.set(id, {
        node,
        placeholder,
        parent,
        className: node.className
      });
    }
    host.appendChild(node);
    node.classList.remove('hidden');
    return node;
  }

  function restoreMovedModules() {
    const entries = Array.from(movedModules.entries()).reverse();
    entries.forEach(([id, state]) => {
      if (state.placeholder?.parentNode) {
        state.placeholder.parentNode.insertBefore(state.node, state.placeholder.nextSibling);
        state.placeholder.remove();
      } else if (state.parent) {
        state.parent.appendChild(state.node);
      }
      state.node.className = state.className;
    });
    movedModules.clear();
  }

  function closeAdminSubModal() {
    const modal = document.getElementById('adminSubModal');
    if (modal) modal.classList.add('hidden');
    restoreMovedModules();
    activeModalType = '';
    reportTabInitialized = false;
    document.body.classList.remove('admin-portal-lock');
    if (previousBodyOverflow) document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = '';
  }

  function bindPulseCard(node, callback, label) {
    if (!node || node.dataset.adminPortalBound === '1') return;
    node.dataset.adminPortalBound = '1';
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', label || 'عرض التفاصيل');
    node.classList.add('cursor-pointer');
    node.addEventListener('click', callback);
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        callback();
      }
    });
  }

  function buildDetailList(title, rows, getName, getMeta, emptyMessage) {
    const host = document.getElementById('adminPortalPulseDetailHost');
    if (!host) return;
    host.replaceChildren();
    const card = document.createElement('section');
    card.className = 'admin-portal-detail';
    card.appendChild(textNode('h4', '', title));
    if (!Array.isArray(rows) || !rows.length) {
      card.appendChild(createEmptyMessage(emptyMessage || 'لا توجد سجلات متاحة لهذا اليوم.'));
      host.appendChild(card);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'admin-portal-detail-list';
    rows.forEach(row => {
      const item = document.createElement('li');
      item.appendChild(textNode('span', '', getName(row)));
      const meta = getMeta(row);
      if (meta) item.appendChild(textNode('small', '', meta));
      list.appendChild(item);
    });
    card.appendChild(list);
    host.appendChild(card);
    card.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }

  async function showMorningAssemblyDetails() {
    const today = localDate();
    const cache = window.__adminPortalDailyMetricsCache;
    const canReadMorning = canReport('reportMorningAssemblyLateness');
    if (canReadMorning && (cache?.date !== today || cache?.morningAssemblyLoaded !== true) &&
        typeof window.refreshDashboardDailyMetrics === 'function') {
      try { await window.refreshDashboardDailyMetrics(true); } catch (_) {}
    }
    const latest = window.__adminPortalDailyMetricsCache;
    const rows = latest?.date === today && latest.morningAssemblyLoaded === true
      ? latest.morningAssemblyRows || []
      : [];
    buildDetailList(
      'كشف المتأخرين عن الطابور الصباحي اليوم',
      rows,
      row => String(row?.student_name_snapshot || 'طالب غير محدد'),
      row => String(row?.class_name_snapshot || 'صف غير محدد'),
      canReport('reportMorningAssemblyLateness')
        ? 'لا توجد حالات تأخر صباحي مسجلة اليوم.'
        : 'لا تتوفر صلاحية قراءة تفاصيل سجل الطابور الصباحي لهذا الحساب.'
    );
  }

  async function showReserveDetails() {
    const today = localDate();
    let cache = window.__adminPortalDailyMetricsCache;
    const canReadReserve = currentUser()?.permissions?.schoolwideReserveArchive === true ||
      (typeof window.isGeneralAdminUser === 'function' && window.isGeneralAdminUser(currentUser()));
    if (canReadReserve && (cache?.date !== today || cache?.reserveArchiveLoaded !== true) &&
        typeof window.refreshDashboardDailyMetrics === 'function') {
      try { await window.refreshDashboardDailyMetrics(true); } catch (_) {}
      cache = window.__adminPortalDailyMetricsCache;
    }
    const rows = cache?.date === today && cache.reserveArchiveLoaded === true
      ? cache.reserveArchive || []
      : [];
    const unique = new Map();
    rows.filter(row => String(row?.status || 'assigned') !== 'cancelled').forEach(row => {
      const name = String(row?.absentTeacherName || '').trim();
      if (!name) return;
      if (!unique.has(name)) unique.set(name, { name, department: row?.absentTeacherDepartment || row?.subject || '', periods: new Set(), classes: new Set() });
      const item = unique.get(name);
      if (row?.period) item.periods.add(String(row.period));
      if (row?.className) item.classes.add(String(row.className));
    });
    const list = Array.from(unique.values()).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    buildDetailList(
      'المعلمون الغائبون المدرجون فعلياً في توزيع الاحتياط اليوم',
      list,
      row => row.name,
      row => [row.department, row.periods.size ? 'الحصص: ' + Array.from(row.periods).join('، ') : '', row.classes.size ? 'الصفوف: ' + Array.from(row.classes).join('، ') : ''].filter(Boolean).join(' · '),
      cache?.reserveArchiveLoaded === true
        ? 'لا توجد توزيعات احتياط مسجلة لهذا اليوم.'
        : 'تعذر قراءة أرشيف الاحتياط الشامل أو لا يملك الحساب صلاحية الاطلاع عليه.'
    );
  }

  function openPulseModal() {
    if (!canAdminTab('studstats')) {
      setActiveModal('pulse', 'الصندوق الأول · نبض اليوم', 'نبض اليوم المدرسي', 'يتطلب هذا الملخص صلاحية الإحصائيات وقراءة السجلات المرتبطة بها.');
      document.getElementById('adminPortalModalBody').replaceChildren(createEmptyMessage('لا تملك صلاحية الاطلاع على مؤشرات اليوم المدرسي. اطلب تفعيل صلاحية الإحصائيات المناسبة من إدارة المستفيدين.'));
      return;
    }
    setActiveModal('pulse', 'الصندوق الأول · متابعة يومية', 'نبض اليوم المدرسي', 'مؤشرات مستمدة من سجلات المدرسة الفعلية. اضغط على المؤشرات القابلة للتفصيل لفتح الكشف المرتبط بها.');
    const body = document.getElementById('adminPortalModalBody');
    body.replaceChildren();
    const host = document.createElement('div');
    host.id = 'adminPortalPulseHost';
    body.appendChild(host);
    const detailHost = document.createElement('div');
    detailHost.id = 'adminPortalPulseDetailHost';
    body.appendChild(detailHost);
    mountModule('dashboardMetricsSection', host);
    mountModule('dashboardUrgentSection', host);
    if (typeof window.renderAdminOverview === 'function') {
      try { window.renderAdminOverview(); } catch (error) { console.warn('Leadership portal daily summary render failed.', error); }
    }
    if (typeof window.refreshDashboardDailyMetrics === 'function') {
      const hasDailyRead = canReport('reportMorningAssemblyLateness') ||
        currentUser()?.permissions?.schoolwideReserveArchive === true ||
        (typeof window.isGeneralAdminUser === 'function' && window.isGeneralAdminUser(currentUser()));
      if (hasDailyRead) void window.refreshDashboardDailyMetrics();
    }
    const absentCard = document.getElementById('dashAbsentToday')?.closest('.group');
    bindPulseCard(absentCard, () => {
      if (typeof window.toggleUrgentCategory === 'function') window.toggleUrgentCategory('absent');
      document.getElementById('dashboardUrgentSection')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 'عرض كشف الغياب اليوم');
    const behaviorCard = document.getElementById('dashBehaviorToday')?.closest('.group');
    bindPulseCard(behaviorCard, () => {
      closeAdminSubModal();
      openAdminSubModal('stats');
      setTimeout(() => {
        if (typeof window.switchStatsSubTab === 'function') window.switchStatsSubTab('behaviors');
      }, 80);
    }, 'فتح إحصائيات السلوك');
    const coverageCard = document.getElementById('dashPeriodsRecorded')?.closest('.group');
    bindPulseCard(coverageCard, () => {
      closeAdminSubModal();
      openAdminSubModal('reports');
      setTimeout(() => activateReportTab('teachers'), 80);
    }, 'فتح تقرير نشاط المعلمين');
    const lateNode = document.getElementById('dashMorningAssemblyLateCount');
    bindPulseCard(lateNode?.parentElement, () => { void showMorningAssemblyDetails(); }, 'عرض المتأخرين عن الطابور الصباحي');
    const reserveNode = document.getElementById('dashReserveTeachersCount');
    bindPulseCard(reserveNode?.parentElement, () => { void showReserveDetails(); }, 'عرض المعلمين الغائبين الموزعين احتياط');
  }

  function availableReportTabs() {
    const tabs = [];
    if (canAnyReport()) tabs.push({ id: 'records', label: 'تقارير الغياب والطابور والاحتياط', nodeId: 'sec-reports' });
    if (canAdminTab('behaviorstats')) tabs.push({ id: 'behavior', label: 'تقارير السلوكيات', nodeId: 'sec-behaviorstats' });
    if (canAdminTab('teachers')) tabs.push({ id: 'teachers', label: 'نشاط المعلمين', nodeId: 'dashboardTeachersActivity' });
    return tabs;
  }

  function activateReportTab(tabId) {
    const tab = availableReportTabs().find(item => item.id === tabId);
    if (!tab) return;
    document.querySelectorAll('[data-admin-report-panel]').forEach(panel => panel.classList.add('hidden'));
    document.querySelectorAll('[data-admin-report-tab]').forEach(button => {
      const active = button.getAttribute('data-admin-report-tab') === tabId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const panel = document.querySelector('[data-admin-report-panel="' + tabId + '"]');
    panel?.classList.remove('hidden');
    if (tabId === 'records') initializeRecordsReportModule();
    if (tabId === 'behavior') initializeBehaviorReportModule();
    if (tabId === 'teachers') initializeTeacherActivityModule();
  }

  function initializeRecordsReportModule() {
    if (typeof window.refreshReportPanelsVisibility === 'function') window.refreshReportPanelsVisibility();
    if (canReport('reportComprehensiveAbsence')) {
      if (typeof window.populateReportClassSelect === 'function') window.populateReportClassSelect();
      if (typeof window.resetReportFilters === 'function') window.resetReportFilters();
      else if (typeof window.renderReportsSection === 'function') window.renderReportsSection();
    }
    if (canReport('reportClassLatenessFollowup') && typeof window.renderLateFollowupReport === 'function') {
      try { window.renderLateFollowupReport(); } catch (_) {}
    }
    if (canReport('reportSubstitutionDistribution') && typeof window.initSubstitutionDistributionReport === 'function') {
      window.initSubstitutionDistributionReport();
    }
    if (canReport('reportStudentAffairs') && !reportTabInitialized && typeof window.repInitStudentAffairsReports === 'function') {
      reportTabInitialized = true;
      Promise.resolve(window.repInitStudentAffairsReports()).catch(error => console.warn('Student Affairs report initialization deferred.', error));
    }
  }

  function initializeBehaviorReportModule() {
    if (typeof window.populateBehaviorReportClassSelect === 'function') window.populateBehaviorReportClassSelect();
    if (typeof window.resetBehaviorReportFilters === 'function') window.resetBehaviorReportFilters();
    else if (typeof window.renderBehaviorReportsSection === 'function') window.renderBehaviorReportsSection();
  }

  function initializeTeacherActivityModule() {
    if (typeof window.renderTeachersActivity === 'function') window.renderTeachersActivity();
  }

  function openReportsModal() {
    const tabs = availableReportTabs();
    if (typeof window.renderAdminOverview === 'function') {
      try { window.renderAdminOverview(); } catch (_) {}
    }
    setActiveModal('reports', 'الصندوق الثاني · التقارير والطباعة', 'مركز التقارير والطباعة', 'جميع أدوات التقارير الأصلية في مكان واحد. لن يظهر أي تقرير إلا إذا كانت صلاحية قراءته أو طباعته ممنوحة للحساب.');
    const body = document.getElementById('adminPortalModalBody');
    body.replaceChildren();
    if (!tabs.length) {
      body.appendChild(createEmptyMessage('لا توجد صلاحيات تقارير أو نشاط معلمين مفعّلة لهذا الحساب.'));
      return;
    }
    const tabBar = document.createElement('div');
    tabBar.className = 'admin-portal-tabs';
    tabBar.setAttribute('role', 'tablist');
    const hosts = document.createElement('div');
    hosts.className = 'space-y-5';
    tabs.forEach(tab => {
      const button = textNode('button', 'admin-portal-tab', tab.label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', 'false');
      button.setAttribute('data-admin-report-tab', tab.id);
      button.addEventListener('click', () => activateReportTab(tab.id));
      tabBar.appendChild(button);
      const panel = document.createElement('section');
      panel.className = 'admin-portal-panel hidden';
      panel.setAttribute('data-admin-report-panel', tab.id);
      const moduleHost = document.createElement('div');
      moduleHost.id = 'adminPortalReportsHost_' + tab.id;
      panel.appendChild(moduleHost);
      hosts.appendChild(panel);
      mountModule(tab.nodeId, moduleHost);
    });
    body.appendChild(tabBar);
    body.appendChild(hosts);
    if (typeof window.refreshReportPanelsVisibility === 'function') window.refreshReportPanelsVisibility();
    activateReportTab(tabs[0].id);
  }

  function openStatsModal() {
    if (!canAdminTab('studstats')) {
      setActiveModal('stats', 'الصندوق الثالث · الإحصائيات', 'مرصد الإحصاء والاتجاهات', 'يتطلب هذا المرصد صلاحية الإحصائيات المدرسية.');
      document.getElementById('adminPortalModalBody').replaceChildren(createEmptyMessage('لا تملك صلاحية الاطلاع على الإحصائيات المدرسية.'));
      return;
    }
    setActiveModal('stats', 'الصندوق الثالث · التحليل المدرسي', 'مرصد الإحصاء والاتجاهات', 'تحليلات ومخططات النظام الأصلية، معتمدة على السجلات الفعلية والفترة التي تختارها.');
    const body = document.getElementById('adminPortalModalBody');
    body.replaceChildren();
    const host = document.createElement('div');
    host.id = 'adminPortalStatsHost';
    body.appendChild(host);
    mountModule('sec-studstats', host);
    if (typeof window.switchStatsSubTab === 'function') window.switchStatsSubTab('absence');
    if (typeof window.renderStudentStatsDashboard === 'function') {
      try { window.renderStudentStatsDashboard(); } catch (error) { console.warn('Leadership portal statistics render failed.', error); }
    }
    if (typeof window.updateAdvancedAnalytics === 'function') {
      try { window.updateAdvancedAnalytics(); } catch (error) { console.warn('Leadership portal charts render failed.', error); }
    }
    requestAnimationFrame(() => {
      try { Object.values(window.chartInstances || {}).forEach(chart => chart?.resize?.()); } catch (_) {}
    });
  }

  function openAdminSubModal(type) {
    if (!hasPortalPermission()) {
      notify('لا تملك صلاحية الاطلاع على السجلات الإدارية.', 'error');
      closeAdminSection();
      return;
    }
    restoreMovedModules();
    createSubModal();
    if (type === 'pulse') openPulseModal();
    else if (type === 'reports') openReportsModal();
    else if (type === 'stats') openStatsModal();
    else {
      notify('القسم المطلوب غير معروف.', 'error');
      return;
    }
  }

  function wrapExistingNavigation() {
    if (typeof window.renderAuthenticatedDashboardShell === 'function' && !window.renderAuthenticatedDashboardShell.__adminPortalWrapped) {
      const originalShell = window.renderAuthenticatedDashboardShell;
      const wrappedShell = function (...args) {
        const result = originalShell.apply(this, args);
        syncPortalVisibility();
        return result;
      };
      wrappedShell.__adminPortalWrapped = true;
      wrappedShell.__original = originalShell;
      window.renderAuthenticatedDashboardShell = wrappedShell;
    }
    if (typeof window.openAdminModal === 'function' && !window.openAdminModal.__adminPortalWrapped) {
      const originalOpen = window.openAdminModal;
      const wrappedOpen = async function (...args) {
        const portalView = document.getElementById('adminSectionView');
        const portalIsOpen = !!portalView && !portalView.classList.contains('hidden');
        closeAdminSubModal();
        restoreMovedModules();
        if (portalIsOpen) closeAdminSection();
        return await originalOpen.apply(this, args);
      };
      wrappedOpen.__adminPortalWrapped = true;
      wrappedOpen.__original = originalOpen;
      window.openAdminModal = wrappedOpen;
    }
    if (typeof window.logoutUser === 'function' && !window.logoutUser.__adminPortalWrapped) {
      const originalLogout = window.logoutUser;
      const wrappedLogout = function (...args) {
        closeAdminSection();
        restoreMovedModules();
        return originalLogout.apply(this, args);
      };
      wrappedLogout.__adminPortalWrapped = true;
      wrappedLogout.__original = originalLogout;
      window.logoutUser = wrappedLogout;
    }
  }

  function installKeyboardAndFocusHandling() {
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const modal = document.getElementById('adminSubModal');
      if (modal && !modal.classList.contains('hidden')) {
        closeAdminSection();
      } else if (!document.getElementById('adminSectionView')?.classList.contains('hidden')) {
        closeAdminSection();
      }
    });
  }

  function install() {
    const dashboardView = document.getElementById('dashboardSelectionView');
    if (!dashboardView || document.documentElement.dataset.adminLeadershipPortalInstalled === '1') return;
    document.documentElement.dataset.adminLeadershipPortalInstalled = '1';
    installPermissionControl();
    createPortalBanner(dashboardView);
    createPortalView(dashboardView);
    createSubModal();
    wrapExistingNavigation();
    installKeyboardAndFocusHandling();
    syncPortalVisibility();
  }

  if (document.readyState === 'loading' || document.readyState === 'interactive') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
