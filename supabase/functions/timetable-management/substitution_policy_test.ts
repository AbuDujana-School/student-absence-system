import {
  getAvailableSubstitutionCandidates,
  type SubstitutionTeacher,
  type TimetableEntry,
  type SubstitutionAssignment,
} from "./substitution_policy.ts";

const weekday = "الأحد";
const period = 3;
const timetable: TimetableEntry[] = [
  {teacherId:"absent",weekday,period,className:"8/1",status:"teaching"},
  {teacherId:"low",weekday,period,className:"",status:"free"},
  {teacherId:"high",weekday,period,className:"",status:"free"},
  {teacherId:"on-duty",weekday,period,className:"",status:"free"},
  {teacherId:"duty-assigned",weekday,period,className:"",status:"free"},
];
const teachers: SubstitutionTeacher[] = [
  {id:"absent",name:"الغائب",departmentId:"math"},
  {id:"low",name:"أقل نصاب",departmentId:"math",baseQuota:10},
  {id:"high",name:"أعلى نصاب",departmentId:"math",baseQuota:15},
  {id:"on-duty",name:"مناوب اليوم",departmentId:"math",baseQuota:2,dutyWeekday:weekday},
  {id:"duty-assigned",name:"عليه مناوبة مسجلة",departmentId:"math",baseQuota:3},
];
Deno.test("weekly quota plus twice active substitution count determines ranking",()=>{
  const assignments:SubstitutionAssignment[]=[
    {substituteTeacherId:"low",weekday,period:1,status:"assigned",assignmentType:"substitution"},
    {substituteTeacherId:"low",weekday,period:2,status:"completed",assignmentType:"substitution"},
  ];
  const result=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments,absentTeacherId:"absent",weekday,period,departmentId:"math",
  });
  const low=result.find(t=>t.id==="low");
  const high=result.find(t=>t.id==="high");
  if(low?.workloadScore!==14||high?.workloadScore!==15)throw new Error("Expected scores 10 + (2×2) = 14 and 15 + (0×2) = 15");
  if(result[0]?.id!=="low")throw new Error("The lowest calculated workload should rank first");
});
Deno.test("a teacher assigned a weekly duty day is never eligible that day",()=>{
  const result=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments:[],absentTeacherId:"absent",weekday,period,departmentId:"math",
  });
  if(result.some(t=>t.id==="on-duty"))throw new Error("Teacher with a matching duty weekday was offered");
});
Deno.test("a recorded active duty assignment blocks the same period",()=>{
  const assignments:SubstitutionAssignment[]=[
    {substituteTeacherId:"duty-assigned",weekday,period,status:"assigned",assignmentType:"duty"},
  ];
  const result=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments,absentTeacherId:"absent",weekday,period,departmentId:"math",
  });
  if(result.some(t=>t.id==="duty-assigned"))throw new Error("Teacher with an active same-period duty assignment was offered");
});
Deno.test("cancelled duty assignments do not block availability",()=>{
  const assignments:SubstitutionAssignment[]=[
    {substituteTeacherId:"duty-assigned",weekday,period,status:"cancelled",assignmentType:"duty"},
  ];
  const result=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments,absentTeacherId:"absent",weekday,period,departmentId:"math",
  });
  if(!result.some(t=>t.id==="duty-assigned"))throw new Error("Cancelled duty assignment should not block availability");
});

Deno.test("duty assignments block availability but do not inflate substitution workload",()=>{
  const assignments:SubstitutionAssignment[]=[
    {substituteTeacherId:"low",weekday,period:1,status:"assigned",assignmentType:"duty"},
    {substituteTeacherId:"low",weekday,period:2,status:"assigned",assignmentType:"substitution",assignmentDate:"2026-11-15"},
  ];
  const result=getAvailableSubstitutionCandidates({
    teachers,timetable,assignments,absentTeacherId:"absent",weekday,period,departmentId:"math",assignmentDate:"2026-11-14",
  });
  const low=result.find(t=>t.id==="low");
  if(low?.workloadScore!==10)throw new Error("Only previous substitution assignments should affect the base-quota score");
});
