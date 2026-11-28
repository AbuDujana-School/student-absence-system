/* Independent, read-only adapters for the Administrative Reports Center.
 * This registry owns report metadata and dispatch only. The original sections keep
 * their own data readers, authorization checks, templates, and print functions.
 */
(function (root) {
  'use strict';
  const definitions = [
    { key:'absence', title:'تقرير الغياب الشامل', desc:'كشف الغياب والحالات اليومية وفق التسطيرة الأصلية المعتمدة.', category:'students', label:'شؤون الطلاب', icon:'fa-user-xmark', tone:'#be3b56', permission:{type:'report',key:'reportComprehensiveAbsence'}, source:{module:'student-attendance',reader:'db.attendance',authority:'سجلات الغياب الأصلية'}, handler:'absence', pdfRenderer:'printHorizontalReport', range:'inclusive-date-range', output:'original-pdf', readOnly:true },
    { key:'behavior', title:'تقرير السلوكيات', desc:'كشف السلوكيات حسب الحصص والصفوف بالقالب الأصلي.', category:'students', label:'شؤون الطلاب', icon:'fa-scale-balanced', tone:'#b88932', permission:{type:'tab',key:'behaviorstats'}, source:{module:'student-behavior',reader:'db.behaviors + normalizeBehaviorRecord',authority:'سجلات السلوكيات الأصلية'}, handler:'behavior', pdfRenderer:'printHorizontalBehaviorReport', range:'inclusive-date-range', output:'original-pdf', readOnly:true },
    { key:'late', title:'متابعة التأخر عن الحصص', desc:'كشف حالات التأخر بين الحصص من السجلات الفعلية.', category:'students', label:'شؤون الطلاب', icon:'fa-clock', tone:'#0284c7', permission:{type:'report',key:'reportClassLatenessFollowup'}, source:{module:'class-lateness-followup',reader:'getLateFollowupRows',authority:'سجلات متابعة التأخر بين الحصص'}, handler:'late', pdfRenderer:'printLateFollowupReport', range:'inclusive-date-range', output:'original-pdf', readOnly:true },
    { key:'morning', title:'تقرير التأخر عن الطابور الصباحي', desc:'كشف تراكمي لتأخر الطلاب وتواريخه وفق سجل الطابور المعتمد.', category:'students', label:'شؤون الطلاب', icon:'fa-person-circle-exclamation', tone:'#b88932', permission:{type:'report',key:'reportMorningAssemblyLateness'}, source:{module:'morning-assembly-lateness',reader:"callMorningAssemblyLatenessApi({ action: 'report' })",authority:'سجل الطابور الصباحي المعتمد'}, handler:'morning', pdfRenderer:'printMorningAssemblyLatenessReport', range:'inclusive-date-range-same-academic-year', output:'original-pdf', readOnly:true },
    { key:'reserve', title:'توزيع حصص الاحتياط', desc:'سجل التوزيعات وتغطية الغياب وفق قالب الاحتياط الأصلي.', category:'staff', label:'المعلمون والاحتياط', icon:'fa-arrows-rotate', tone:'#168c85', permission:{type:'report',key:'reportSubstitutionDistribution'}, source:{module:'timetable-management',reader:"action: 'timetable_substitution_report'",authority:'أرشيف تكليفات الاحتياط المعتمد'}, handler:'reserve', pdfRenderer:'printSubstitutionDistributionReport', range:'inclusive-date-range', output:'original-pdf', readOnly:true },
    { key:'sa', title:'تقارير شؤون الطلبة', desc:'تقارير الغياب والسلوك وفق الصفوف والصلاحيات المسندة.', category:'students', label:'شؤون الطلاب', icon:'fa-people-group', tone:'#183653', permission:{type:'report',key:'reportStudentAffairs'}, source:{module:'student-affairs',reader:'repInitStudentAffairsReports + repLoadReport',authority:'قارئات تقارير شؤون الطلبة الأصلية'}, handler:'sa', pdfRenderer:'repPrint (original Student Affairs verified PDF renderer)', range:'inclusive-date-range', output:'original-report-template', readOnly:true },
    { key:'teachers', title:'تقرير الالتزام برصد الغياب', desc:'مطابقة الحصص التدريسية وتكليفات الاحتياط مع كشوف الرصد المحفوظة.', category:'staff', label:'المعلمون والاحتياط', icon:'fa-chart-column', tone:'#b88932', permission:{type:'tab',key:'teachers'}, source:{module:'teacher-attendance-compliance.js',reader:'loadTeachersActivityCompliance',authority:'الجدول الأسبوعي + تكليفات الاحتياط النشطة + كشوف الرصد المحفوظة'}, handler:'teachers', pdfRenderer:'window.printTeachersActivityPDF (original compliance PDF renderer)', range:'inclusive-date-range', output:'original-compliance-report', readOnly:true }
  ];
  const byKey = new Map(definitions.map(item => [item.key, item]));
  function copy(item) { return { ...item, permission:{...item.permission}, source:{...item.source} }; }
  function list(canAccess) {
    if (typeof canAccess !== 'function') throw new TypeError('Report permission resolver is required.');
    return definitions.map(item => ({ ...copy(item), allowed:!!canAccess({...item.permission},copy(item)) }));
  }
  function get(key) { const item=byKey.get(String(key||'')); return item?copy(item):null; }
  async function execute(key, context, handlers) {
    const item=byKey.get(String(key||''));
    if (!item || !item.readOnly) throw new Error('التقرير غير معروف أو غير متاح في مركز التقارير.');
    const handler=handlers&&handlers[item.handler];
    if (typeof handler!=='function') throw new Error('محوّل التقرير غير محمّل: '+item.key);
    return handler(context||{},copy(item));
  }
  root.AdminReportCenterAdapters=Object.freeze({version:1,list,get,execute,keys:Object.freeze(definitions.map(item=>item.key))});
})(window);
