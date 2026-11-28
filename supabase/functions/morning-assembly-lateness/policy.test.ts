import { academicYearKey, isWithinTeacherRegistrationWindow, isTeacherEligibleForMorningLateness, isNonDutyTeacherEligibleForMorningLateness, latenessAbsenceDays, canUseMorningLateness, canViewMorningLatenessReport } from "./policy.ts";

Deno.test("Oman academic year starts on September 1", () => {
  if (academicYearKey("2026-08-31") !== "2025/2026") throw new Error("August must remain in the ending academic year");
  if (academicYearKey("2026-09-01") !== "2026/2027") throw new Error("September 1 must start a new academic year");
  if (academicYearKey("2027-06-30") !== "2026/2027") throw new Error("June 30 must remain in the current academic year");
});

Deno.test("teacher registration window includes 07:00 and 08:30 only", () => {
  const cases: [number,boolean][] = [[419,false],[420,true],[509,true],[510,true],[511,false]];
  for (const [minute,expected] of cases) {
    if (isWithinTeacherRegistrationWindow(minute) !== expected) throw new Error("Unexpected registration-window result at minute " + minute);
  }
});

Deno.test("assigned duty teachers can record on their assigned weekday without a separate permission toggle", () => {
  const base = { dutyToday:true, weekday:"الثلاثاء", assignedDutyDay:"الثلاثاء", minutes:480 };
  if (!isTeacherEligibleForMorningLateness(base)) throw new Error("Assigned teacher should be eligible");
  if (isTeacherEligibleForMorningLateness({...base,assignedDutyDay:"الخميس"})) throw new Error("Non-duty day must be denied");
  if (isTeacherEligibleForMorningLateness({...base,weekday:"الجمعة"})) throw new Error("Friday must be denied");
  if (isTeacherEligibleForMorningLateness({...base,dutyToday:false})) throw new Error("Explicitly disabled daily duty must be denied");
  if (!isTeacherEligibleForMorningLateness({...base,dutyToday:undefined as unknown as boolean})) throw new Error("An unset optional disable flag must preserve the existing duty-day rule");
});
Deno.test("non-duty teachers require the separate permission and retain the same time window", () => {
  const base = { permission:true, weekday:"الثلاثاء", minutes:480 };
  if (!isNonDutyTeacherEligibleForMorningLateness(base)) throw new Error("Explicit non-duty permission should allow recording");
  if (isNonDutyTeacherEligibleForMorningLateness({...base,permission:false})) throw new Error("Non-duty permission must be mandatory");
  if (isNonDutyTeacherEligibleForMorningLateness({...base,weekday:"الجمعة"})) throw new Error("Friday must be denied");
  if (isNonDutyTeacherEligibleForMorningLateness({...base,minutes:511})) throw new Error("The time window must remain unchanged");
});

Deno.test("four lateness events equal one separate absence day", () => {
  const cases: [number,number][] = [[0,0],[3,0],[4,1],[7,1],[8,2],[12,3],[16,4]];
  for (const [count,expected] of cases) {
    if (latenessAbsenceDays(count) !== expected) throw new Error("Unexpected absence conversion for " + count);
  }
});

Deno.test("admin and explicitly authorized custom users have independent access", () => {
  const common = { permission:false, dutyToday:false, weekday:"الجمعة", assignedDutyDay:"الأحد", minutes:100 };
  if (!canUseMorningLateness({ principalType:"admin", ...common })) throw new Error("Admin must bypass duty and time gates");
  if (canUseMorningLateness({ principalType:"custom", ...common, permission:true })) {
    // custom access does not depend on weekday, duty day, or registration time.
  } else throw new Error("Authorized custom user must bypass duty and time gates");
  if (canUseMorningLateness({ principalType:"custom", ...common, permission:false })) throw new Error("Custom permission must remain explicit");
  if (!canUseMorningLateness({principalType:"teacher",permission:false,nonDutyPermission:true,dutyToday:true,weekday:"الثلاثاء",assignedDutyDay:"الأربعاء",minutes:480})) throw new Error("Non-duty teacher with explicit permission should be allowed");
  if (!canUseMorningLateness({principalType:"teacher",permission:false,dutyToday:true,weekday:"الثلاثاء",assignedDutyDay:"الثلاثاء",minutes:480})) throw new Error("Duty teacher should be allowed without legacy permission");
  if (canUseMorningLateness({principalType:"teacher",permission:false,dutyToday:true,weekday:"الثلاثاء",assignedDutyDay:"الأربعاء",minutes:480})) throw new Error("Non-duty teacher without explicit permission must be denied");
});

Deno.test("cumulative report is visible only to users with permanent morning-lateness access", () => {
  if (!canViewMorningLatenessReport({principalType:"admin"})) throw new Error("Admin must view the report");
  if (!canViewMorningLatenessReport({principalType:"teacher",nonDutyPermission:true})) throw new Error("Permanent non-duty access must view the report");
  if (canViewMorningLatenessReport({principalType:"teacher",nonDutyPermission:false})) throw new Error("Duty-only teacher must not view the report");
  if (!canViewMorningLatenessReport({principalType:"custom",customPermission:true})) throw new Error("Authorized custom user must view the report");
  if (canViewMorningLatenessReport({principalType:"custom",customPermission:false})) throw new Error("Custom user without permanent access must not view the report");
  if (!canViewMorningLatenessReport({principalType:"teacher",nonDutyPermission:false,adminRecordsCenterAccess:true})) throw new Error("Explicit admin-records center access must allow report-only viewing");
  if (canViewMorningLatenessReport({principalType:"teacher",nonDutyPermission:false,adminRecordsCenterAccess:false})) throw new Error("Report-only access must remain explicit");
});
