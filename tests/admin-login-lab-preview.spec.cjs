const { test, expect, chromium } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const host = "abu-dujana-school-preview.localhost";
const port = 4173;
const baseUrl = `http://${host}:${port}/index.html?review=admin-login-lab`;
let server, browser, page;
const productionRequests = [];
const browserErrors = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end("Forbidden"); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end("Not found"); return; }
      const ext = path.extname(file);
      const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json", ".webmanifest":"application/manifest+json", ".png":"image/png" };
      res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "cache-control":"no-store" });
      res.end(data);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  browser = await chromium.launch({headless:true,args:["--no-sandbox"]});
  const context = await browser.newContext({serviceWorkers:"block"});
  page = await context.newPage();
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("request", request => {
    try { const url = new URL(request.url()); if (url.hostname === "ylsocrvwqibptuwfzbke.supabase.co") productionRequests.push({method:request.method(),url:request.url()}); } catch (_) {}
  });
  await page.route("https://**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith(".supabase.co")) return route.abort();
    return route.continue();
  });
});
test.afterAll(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function prepareAdmin() {
  await page.goto(baseUrl,{waitUntil:"domcontentloaded",timeout:60000});
  await expect(page.locator("#uiReviewLauncher")).toHaveCount(1);
  await page.evaluate(() => {
    uiReviewPrepare();
    localOnlySession = false;
    cloudDataLoadState = "ready";
    activeUser = {type:"admin",name:"مدير تجريبي",permissions:{admin:true,studentAffairs:true,duty:true,reports:true}};
    appAuthSession = {token:"a".repeat(64),expires_at:new Date(Date.now()+3600000).toISOString(),principal:activeUser};
    db.classes = (DEFAULT_CLASSES || []).slice();
    db.teachers = Array.from({length:120},(_,i)=>({name:"معلم تجريبي "+(i+1),role:"teacher",permissions:{studentAffairs:true,student_affairs_role:i%10===0?"team_leader":i%10===1?"supervisor":"",student_affairs_team_name:"فريق "+Math.floor(i/10),duty:true}}));
    db.students = Object.fromEntries(db.classes.map(c=>[c,Array.from({length:12},(_,i)=>"طالب تجريبي "+(i+1))]));
    db.dutyModule = normalizeDutyModule(db.dutyModule);
    db.dutyModule.periods = Array.from({length:8},(_,i)=>({start:"07:"+String(i*5).padStart(2,"0"),end:"07:"+String(i*5+4).padStart(2,"0")}));
    db.dutyModule.records = [];
    saSession = null;
    saAdminData = {teachers:db.teachers,permissions:[],classes:db.classes.map(name=>({name}))};
    saReportPermissions = {can_read_attendance:true,can_read_behavior:true,can_view_competition:true,can_view_analytics:true,role:"admin"};
    window.appAuthRequest = async body => {
      if(body.action==="timetable_check_access") return {canAccess:true,teacherPortalEnabled:false,teacherPortalCanAccess:false};
      if(body.action==="app_student_affairs_session") return {token:"b".repeat(64),expires_at:new Date(Date.now()+3600000).toISOString(),principal:{type:"admin",name:"مدير تجريبي"},permissions:saReportPermissions};
      if(body.action==="timetable_substitution_preview") return {active:true,absentTeachers:[]};
      if(body.action==="timetable_substitution_stats") return {stats:{}};
      return {};
    };
    window.saRequest = async body => {
      if(body.action==="get_permissions") return {teachers:db.teachers,permissions:[],classes:db.classes.map(name=>({name}))};
      if(body.action==="get_my_permissions") return {permissions:saReportPermissions};
      if(body.action==="competition_settings") return {terms:[],currentTermId:null,selectedTermId:null,showBothTerms:false};
      if(body.action==="competition") return {status:"no_participants",period:body.period||"weekly",teams:[],weeklyPoints:{},weeklyWins:{}};
      if(body.action==="supervision_team") return {teachers:db.teachers};
      if(body.action==="supervision_trend") return {series:[],class_count:db.classes.length};
      if(body.action==="reports") return {attendance:[],behaviors:[]};
      return {};
    };
    refreshActiveUserPermissions = async () => {};
    timetableRefreshAccess = async () => { timetableCanAccess=true; return true; };
    checkAndEnforcePinChange = async () => false;
    checkAndEnforceAdminPinChange = async () => false;
    window.refreshCombinedReportTabs = () => {};
  });
}

test("admin primary login finalization completes without starting optional modules", async () => {
  await prepareAdmin();
  const result = await page.evaluate(async () => {
    const t=performance.now();
    await finalizeLoginState();
    return {ms:Math.round(performance.now()-t),loginHidden:document.getElementById("loginView").classList.contains("hidden"),dashboardVisible:!document.getElementById("dashboardSelectionView").classList.contains("hidden"),saSessionCalls:0};
  });
  expect(result.loginHidden).toBe(true);
  expect(result.dashboardVisible).toBe(true);
  expect(result.ms).toBeLessThan(5000);
  expect(productionRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("admin dashboard post-login widgets do not block the page", async () => {
  await prepareAdmin();
  const result = await page.evaluate(() => {
    const run = (name, fn) => { const t=performance.now(); fn(); return {name,ms:Math.round(performance.now()-t)}; };
    return [
      run("duty-card",refreshDutyDashboardCard),
      run("reserve-card",refreshSubstitutionDashboardCard),
      run("duty-records",renderDutyTodayRecords),
      run("report-visibility",refreshReportPanelsVisibility),
      run("admin-dashboard-tab",()=>switchAdminTab("dashboard"))
    ];
  });
  expect(result.every(x=>x.ms<3000)).toBe(true);
  expect(productionRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("reserve, duty, morning assembly and timetable screens initialize with mock-only data", async () => {
  await prepareAdmin();
  const result = await page.evaluate(async () => {
    const measure=async(name,fn)=>{const t=performance.now();await fn();return {name,ms:Math.round(performance.now()-t)};};
    const out=[];
    out.push(await measure("reserve",()=>openSubstitutionView()));
    out.push(await measure("duty",()=>{openDutyView();initDutyAdminPanel();}));
    out.push(await measure("morning-assembly",()=>openMorningAssemblyLateness()));
    out.push(await measure("timetable-access",()=>timetableRefreshAccess({deferAdminPortalStatus:true})));
    return out;
  });
  expect(result.every(x=>x.ms<5000)).toBe(true);
  expect(productionRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("Student Affairs obtains its secondary session only after the admin opens the module", async () => {
  await prepareAdmin();
  const result = await page.evaluate(async () => {
    const t=performance.now();
    await openStudentAffairsView(true);
    return {ms:Math.round(performance.now()-t),hasSecondarySession:!!saSession?.token,contentVisible:!document.getElementById("saContent").classList.contains("hidden")};
  });
  expect(result.hasSecondarySession).toBe(true);
  expect(result.contentVisible).toBe(true);
  expect(result.ms).toBeLessThan(10000);
  expect(productionRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
