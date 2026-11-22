import { academicYearKey, isWithinTeacherRegistrationWindow, isTeacherEligibleForMorningLateness, latenessAbsenceDays, canUseMorningLateness } from "./policy.ts";

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

Deno.test("teacher needs permission and the actual assigned weekday", () => {
  const base = { permission:true, dutyToday:true, weekday:"الأربعاء", assignedDutyDay:"الأربعاء", minutes:480 };
  if (!isTeacherEligibleForMorningLateness(base)) throw new Error("Assigned teacher should be eligible");
  if (isTeacherEligibleForMorningLateness({...base,permission:false})) throw new Error("Permission is mandatory");
  if (isTeacherEligibleForMorningLateness({...base,assignedDutyDay:"الخميس"})) throw new Error("Non-duty day must be denied");
  if (isTeacherEligibleForMorningLateness({...base,weekday:"الجمعة"})) throw new Error("Friday must be denied");
  if (isTeacherEligibleForMorningLateness({...base,dutyToday:false})) throw new Error("Explicitly disabled daily duty must be denied");
  if (!isTeacherEligibleForMorningLateness({...base,dutyToday:undefined as unknown as boolean})) throw new Error("An unset optional disable flag must preserve the existing duty-day rule");
});

Deno.test("four lateness events equal one separate absence day", () => {
  const cases: [number,number][] = [[0,0],[3,0],[4,1],[7,1],[8,2],[12,3],[16,4]];
  for (const [count,expected] of cases) {
    if (latenessAbsenceDays(count) !== expected) throw new Error("Unexpected absence conversion for " + count);
  }
});

Deno.test("only the general administrator can access morning assembly lateness", () => {
  const common = { permission:true, dutyToday:true, weekday:"الأحد", assignedDutyDay:"الأحد", minutes:480 };
  if (!canUseMorningLateness({ principalType:"admin", ...common })) throw new Error("General administrator must always have access");
  if (canUseMorningLateness({ principalType:"custom", ...common })) throw new Error("Custom users must not access the morning assembly module");
  if (canUseMorningLateness({ principalType:"teacher", ...common })) throw new Error("Teachers must not access the morning assembly module");
});
