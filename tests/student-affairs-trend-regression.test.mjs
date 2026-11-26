import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("index.html", "utf8");
const helperMatch = html.match(/function saFilterSupervisionTrendRows\(rows\)\{[^\n]*\}/);
assert.ok(helperMatch, "weekend filtering helper must exist");
const filterRows = vm.runInNewContext("(" + helperMatch[0] + ")");
test("supervision trends exclude Friday and Saturday but retain Sunday-Thursday", () => {
  const input = [
    { date: "2026-11-22" },
    { date: "2026-11-23" },
    { date: "2026-11-26" },
    { date: "2026-11-27" },
    { date: "2026-11-28" },
    { date: "not-a-date" },
  ];
  assert.deepEqual(Array.from(filterRows(input), row => row.date), [
    "2026-11-22", "2026-11-23", "2026-11-26"
  ]);
});
test("chaos chart and legend use a distinct amber color", () => {
  assert.match(html, /\["الفوضى","chaos","#a16207"\]/);
  assert.match(html, /style="background:#a16207"><\/i>الفوضى/);
});
test("attendance and behavior saves refresh a visible competition panel", () => {
  assert.match(html, /loadSessionAttendance\(\); saRefreshCompetitionAfterRecordSave\(\);/);
  assert.match(html, /loadSessionBehavior\(\); saRefreshCompetitionAfterRecordSave\(\);/);
});
test("visible competition refreshes when the app returns without polling", () => {
  assert.match(html, /function saRefreshCompetitionOnReturn\(\)/);
  assert.match(html, /document\.addEventListener\("visibilitychange"/);
  assert.match(html, /window\.addEventListener\("focus",saRefreshCompetitionOnReturn\)/);
  assert.match(html, /window\.addEventListener\("online",saRefreshCompetitionOnReturn\)/);
  assert.match(html, /now-saCompetitionLastResumeRefreshAt<1500/);
  assert.doesNotMatch(html, /setInterval\([^\n]*saLoadCompetition/);
});

test("competition refresh is scheduled for Thursday after the 13:51 Oman cutoff", () => {
  assert.match(html, /function saScheduleCompetitionCutoffRefresh\(\)/);
  assert.match(html, /let targetMinutes=13\*60\+56/);
  assert.match(html, /targetMinutes=14\*60\+6/);
  assert.match(html, /saScheduleCompetitionCutoffRefresh\(\);/);
  assert.match(html, /setTimeout\(\(\)=>\{/);
  assert.doesNotMatch(html, /setInterval\([^\n]*saLoadCompetition/);
});
test("competition cutoff refresh remains limited to the visible authorized panel", () => {
  assert.match(html, /if\(!panel\|\|panel\.classList\.contains\("hidden"\)\|\|!saCanViewCompetition\(\)\)return;/);
  assert.match(html, /navigator\.onLine&&saCanViewCompetition\(\)\)saLoadCompetition\(\)/);
});


test("competition API complete snapshots are normalized to the UI approved contract", () => {
  const helperStart = html.indexOf("function saNormalizeCompetitionResponse(data){");
  const helperEnd = html.indexOf("async function saLoadCompetition(){", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "competition response normalizer must exist before the loader");
  const normalize = vm.runInNewContext("(" + html.slice(helperStart, helperEnd).trim() + ")");
  const complete = { status: "complete", period: "weekly", teams: [{ teamId: "synthetic", rank: 1 }] };
  assert.equal(normalize(complete).status, "approved");
  assert.equal(normalize(complete).teams.length, 1);
  assert.equal(normalize({ status: "complete", teams: [] }).status, "complete", "empty snapshots must not be promoted to approved");
  assert.equal(normalize({ status: "no_completed_weeks", teams: [] }).status, "no_completed_weeks");
  assert.ok(html.includes('const response=await saRequest(request);' + String.fromCharCode(10) + '    const data=saNormalizeCompetitionResponse(response);'));
});


function getElementById(source,id){
  const openPattern = new RegExp('<([A-Za-z][\\w:-]*)\\b(?=[^>]*\\bid="' + id + '")[^>]*>',"i");
  const open = openPattern.exec(source);
  assert.ok(open, "missing element #" + id);
  const tag = open[1].toLowerCase();
  const token = new RegExp('<\\/?' + tag + '\\b[^>]*>',"gi");
  token.lastIndex = open.index;
  let depth = 0, match;
  while((match = token.exec(source))){
    if(/^<\//.test(match[0])) depth--;
    else if(!/\/>$/.test(match[0])) depth++;
    if(depth === 0) return source.slice(open.index, token.lastIndex);
  }
  assert.fail("unclosed element #" + id);
}

test("four main sections are presentation-only and retain the original report controls",()=>{
  const content = getElementById(html,"saContent");
  const nav = getElementById(content,"saMainNav");
  assert.equal((nav.match(/class="sa-nav-card/g)||[]).length,4);
  for(const sec of ["1","2","3","4"]) assert.ok(nav.includes('data-sec="' + sec + '"'));
  const first = getElementById(content,"saSec1");
  for(const id of ["saAttendanceTab","saBehaviorTab","saDatePreset","saFrom","saTo","saReportClass","saReportClassPicker","saStatusFilterWrap","saStatusCheckboxesContainer","saSummary","saResults"]) assert.ok(first.includes('id="' + id + '"'), "#" + id + " remains in reports");
  assert.ok(first.includes("saSetDomain('attendance')"));
  assert.ok(first.includes("saSetDomain('behavior')"));
  const second = getElementById(content,"saSec2");
  for(const id of ["saSupervisionPanel","saSupervisionTeamBtn","saSupervisionTeacherWrap","saSupervisionStatus","saSupervisionTrendChart","saSupervisionBehaviorChart","saCompetitionPanel","saCompetitionStatus","saCompetitionPodium","saCompetitionOtherRanksSection","saCompetitionOtherRanksList"]) assert.ok(second.includes('id="' + id + '"'), "#" + id + " remains in indicators");
  const third = getElementById(content,"saSec3");
  assert.ok(third.includes('id="saAutomaticNotices"'));
  assert.ok(third.includes('onclick="saOpenNoticeModal()"'));
  const fourth = getElementById(content,"saSec4");
  for(const id of ["saStudentProfileClass","saStudentProfileName","saStudentProfileNames","saStudentProfileStatus","saStudentProfileResult","saStudentProfilePrintRoot"]) assert.ok(fourth.includes('id="' + id + '"'), "#" + id + " remains in student profile");
});

test("main menu access gates and original Student Affairs permission logic remain intact",()=>{
  assert.ok(html.includes('const showStudentAffairs = !localOnlySession && (isAdmin || activeUser.permissions?.studentAffairs === true) && !distronDashboardStagePending(15000);'));
  assert.ok(html.includes('const allowed = isGeneralAdminUser(activeUser) ||\n    activeUser?.permissions?.studentAffairs === true;'));
  const controller = getElementById(html,"sa-four-section-navigation-controller");
  assert.doesNotMatch(controller,/saRequest|saReportPermissions|activeUser|saLoadReport|saLoadCompetition|saLoadStudentProfileDirectory/);
});

test("notice modal and print entry points remain present outside the four tab panes",()=>{
  const content = getElementById(html,"saContent");
  assert.ok(!content.includes('id="saNoticeModal"'));
  const modal = getElementById(html,"saNoticeModal");
  for(const id of ["saNoticeTargetWrap","saNoticeThreshold","saNoticeIssueMode","saNoticeTypeFilters","saNoticePreviewPanel","saNoticePreviewSummary","saNoticePrintRoot"]) assert.ok(modal.includes('id="' + id + '"'));
  for(const fn of ["saOpenNoticeModal","saCloseNoticeModal","saGenerateAutomaticNotices","saNoticeBackToConfig","saNoticeHandlePrint","saPrint","saBuildPrintHtml","saStudentProfilePrintableHtml"]) {
    assert.ok(html.includes("function " + fn + "(") || html.includes("async function " + fn + "("), "original function " + fn + " remains");
  }
});


test("Student Affairs navigation is four independent square cards with responsive 4/2-column layout",()=>{
  const content = getElementById(html,"saContent");
  const nav = getElementById(content,"saMainNav");
  assert.equal((nav.match(/class="sa-nav-card/g)||[]).length,4);
  for(const label of [
    "متابعة الغياب والسلوكيات",
    "مؤشرات الغياب والسلوكيات",
    "طباعة التنبيهات",
    "السجل التفصيلي للطالب"
  ]) assert.ok(nav.includes(label), "missing card title: " + label);
  assert.equal((nav.match(/class="sa-nav-icon"/g)||[]).length,4);
  assert.ok(nav.includes('role="group"'));
  const styleStart = html.indexOf('<style id="sa-four-section-navigation-ui">');
  const styleEnd = html.indexOf("</style>", styleStart);
  const navCss = html.slice(styleStart, styleEnd);
  const compactCss = navCss.replace(/\s+/g, "");
  assert.ok(compactCss.includes("grid-template-columns:repeat(4,minmax(0,1fr))"));
  assert.ok(compactCss.includes("@mediascreenand(max-width:760px)"));
  assert.ok(compactCss.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));
  assert.ok(compactCss.includes("aspect-ratio:1/1"));
  assert.ok(compactCss.includes("flex-direction:column"));
  const dashboard = getElementById(html,"dashboardSelectionView");
  const dashboardCard = getElementById(dashboard,"studentAffairsDashboardCard");
  assert.ok(dashboardCard.includes('onclick="openStudentAffairsView(true)"'));
  assert.ok(dashboardCard.includes('role="button"') && dashboardCard.includes('tabindex="0"'));
  assert.ok(dashboardCard.includes("شؤون الطلبة"));
  assert.ok(dashboardCard.includes("class=\"hidden hero-card"));
  assert.ok(dashboard.indexOf('id="behaviorDashboardCard"') < dashboard.indexOf('id="studentAffairsDashboardCard"'));
  assert.ok(dashboard.indexOf('id="studentAffairsDashboardCard"') < dashboard.indexOf('id="dutyDashboardCard"'));
  assert.match(html,/studentAffairsDashboardCard[\s\S]{0,140}classList\.toggle\(['"]hidden['"], !allowed\)/);
  assert.match(html,/studentAffairsDashboardCard[\s\S]{0,160}classList\.toggle\(["']hidden["'], !showStudentAffairs\)/);
});

test("only the selected Student Affairs pane can remain visible, including indicators pane",()=>{
  const styleStart = html.indexOf('<style id="sa-four-section-navigation-ui">');
  const styleEnd = html.indexOf("</style>", styleStart);
  const compactCss = html.slice(styleStart, styleEnd).replace(/\s+/g, "");
  assert.ok(compactCss.includes(".sa-main-pane.hidden{display:none!important"));
  assert.ok(compactCss.includes("#saSec2:not(.hidden){display:flex"));
  const controller = getElementById(html,"sa-four-section-navigation-controller");
  assert.match(controller,/pane\.classList\.toggle\("hidden",pane\.id!==\"saSec\"\+selected\)/);
  assert.match(controller,/button\.setAttribute\("aria-selected",active\?\"true\":\"false\"\)/);
  assert.match(controller,/button\.setAttribute\("aria-pressed",active\?\"true\":\"false\"\)/);
  assert.match(controller,/saSupervisionTrendChart/);
  assert.match(controller,/saSupervisionBehaviorChart/);
});


test("Student Affairs navigation stylesheet is in the live document head, not the print HTML template",()=>{
  const styleStart = html.indexOf('<style id="sa-four-section-navigation-ui">');
  const headEnd = html.indexOf("</head>");
  const styleEnd = html.indexOf("</style>",styleStart);
  assert.ok(styleStart >= 0 && styleStart < headEnd, "navigation CSS must be parsed by the actual application document");
  assert.ok(styleEnd > styleStart && styleEnd < headEnd, "navigation stylesheet must close inside the actual head");
  assert.equal((html.match(/id="sa-four-section-navigation-ui"/g)||[]).length,1);
  const css = html.slice(styleStart,styleEnd);
  assert.match(css,/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css,/aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(css,/\.sa-main-pane\.hidden\s*\{\s*display:\s*none\s*!important/);
  assert.match(css,/@media screen and \(max-width:\s*760px\)[\s\S]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});
