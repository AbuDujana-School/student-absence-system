import { academicYearKey, isWithinTeacherRegistrationWindow, isTeacherEligibleForMorningLateness, latenessAbsenceDays } from "./policy.ts";
Deno.test("academic year starts on September 1 and keeps June in the same year",()=>{
  if(academicYearKey("2026-09-01")!=="2026/2027") throw new Error("September boundary failed");
  if(academicYearKey("2027-06-30")!=="2026/2027") throw new Error("June boundary failed");
  if(academicYearKey("2026-08-31")!=="2025/2026") throw new Error("August boundary failed");
});
Deno.test("teacher registration window includes 07:00 and 08:30 only",()=>{
  for(const [minute,expected] of [[419,false],[420,true],[509,true],[510,true],[511,false]] as const){
    if(isWithinTeacherRegistrationWindow(minute)!==expected) throw new Error("Window mismatch at "+minute);
  }
});
Deno.test("teacher must have explicit permission and match today's duty",()=>{
  const base={permission:true,dutyToday:true,weekday:"الأربعاء",assignedDutyDay:"الأربعاء",minutes:480};
  if(!isTeacherEligibleForMorningLateness(base)) throw new Error("Eligible teacher rejected");
  if(isTeacherEligibleForMorningLateness({...base,permission:false})) throw new Error("Missing permission accepted");
  if(isTeacherEligibleForMorningLateness({...base,assignedDutyDay:"الخميس"})) throw new Error("Wrong duty day accepted");
  if(isTeacherEligibleForMorningLateness({...base,weekday:"الجمعة",assignedDutyDay:"الجمعة"})) throw new Error("Friday accepted");
  if(isTeacherEligibleForMorningLateness({...base,minutes:511})) throw new Error("Late access accepted");
});
Deno.test("each four late days count as one separate absence day",()=>{
  const cases=[[0,0],[3,0],[4,1],[7,1],[8,2],[12,3],[16,4]] as const;
  for(const [late,expected] of cases) if(latenessAbsenceDays(late)!==expected) throw new Error("Count mismatch: "+late);
});
