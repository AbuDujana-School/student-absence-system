import {
  getAbsentTeacherLessons,getAvailableSubstitutionCandidates,
  type SubstitutionTeacher,type TimetableEntry,type SubstitutionAssignment,
} from "./substitution_policy.ts";
const teachers:SubstitutionTeacher[]=[
  {id:"absent",name:"أحمد السالمي",departmentId:"arabic"},
  {id:"free",name:"خالد السالمي",departmentId:"arabic"},
  {id:"busy",name:"سعيد",departmentId:"arabic"},
  {id:"assigned",name:"ماجد",departmentId:"arabic"},
  {id:"other",name:"علي",departmentId:"islamic"},
  {id:"meeting",name:"ناصر",departmentId:"arabic"},
  {id:"unknown",name:"سالم",departmentId:"arabic"},
  {id:"missing",name:"فهد",departmentId:"arabic"},
];
const timetable:TimetableEntry[]=[
  {teacherId:"absent",weekday:"الأحد",period:4,className:"11 أول",subject:"العربية",status:"teaching"},
  {teacherId:"absent",weekday:"الأحد",period:7,className:"10/2",status:"teaching"},
  {teacherId:"free",weekday:"الأحد",period:4,className:"",status:"free"},
  {teacherId:"busy",weekday:"الأحد",period:4,className:"11/2",status:"teaching"},
  {teacherId:"assigned",weekday:"الأحد",period:4,className:"",status:"free"},
  {teacherId:"other",weekday:"الأحد",period:4,className:"",status:"free"},
  {teacherId:"meeting",weekday:"الأحد",period:4,className:"",status:"meeting"},
  {teacherId:"unknown",weekday:"الأحد",period:4,className:"",status:"unclear"},
];
const assignments:SubstitutionAssignment[]=[
  {substituteTeacherId:"assigned",weekday:"الأحد",period:4,status:"confirmed"},
];
Deno.test("only an explicit free cell is eligible",()=>{
 const result=getAvailableSubstitutionCandidates({teachers,timetable,assignments,absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"});
 if(result.length!==1||result[0].id!=="free")throw new Error("Only the explicitly free teacher should be available");
});
Deno.test("a missing timetable cell is not assumed to be free",()=>{
 const result=getAvailableSubstitutionCandidates({teachers,timetable,assignments,absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"});
 if(result.some(t=>t.id==="missing"))throw new Error("A missing cell was incorrectly offered");
});
Deno.test("teaching, meeting and unclear cells are ineligible",()=>{
 const result=getAvailableSubstitutionCandidates({teachers,timetable,assignments,absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"});
 for(const id of ["busy","meeting","unknown"])if(result.some(t=>t.id===id))throw new Error(id+" should not be eligible");
});
Deno.test("active assignment blocks a free teacher but cancelled assignment does not",()=>{
 const base={teachers,timetable,assignments,absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"};
 const active=getAvailableSubstitutionCandidates(base);
 if(active.some(t=>t.id==="assigned"))throw new Error("Already assigned teacher was offered again");
 const cancelled=getAvailableSubstitutionCandidates({...base,assignments:[{substituteTeacherId:"free",weekday:"الأحد",period:4,status:"cancelled"}]});
 if(!cancelled.some(t=>t.id==="free"))throw new Error("Cancelled assignment incorrectly blocked the teacher");
});
Deno.test("department scope is strict unless explicitly expanded",()=>{
 const base={teachers,timetable,assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"};
 const local=getAvailableSubstitutionCandidates(base);
 if(local.some(t=>t.id==="other"))throw new Error("Cross-department teacher appeared without opt-in");
 const expanded=getAvailableSubstitutionCandidates({...base,includeOtherDepartments:true});
 if(!expanded.some(t=>t.id==="other"))throw new Error("Cross-department free teacher did not appear after opt-in");
});
Deno.test("absent teacher lesson extraction ignores non-teaching cells",()=>{
 const data=[...timetable,{teacherId:"absent",weekday:"الأحد",period:2,className:"",status:"free" as const}];
 const lessons=getAbsentTeacherLessons(data,"absent","الأحد");
 if(lessons.length!==2||lessons[0].period!==4||lessons[1].period!==7)throw new Error("Only teaching cells should appear in absent lessons");
});
Deno.test("status-less legacy cells are conservatively occupied",()=>{
 const result=getAvailableSubstitutionCandidates({teachers,timetable:[{teacherId:"free",weekday:"الأحد",period:4,className:""}],assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"});
 if(result.some(t=>t.id==="free"))throw new Error("A legacy record without an explicit free status must not be offered");
});

Deno.test("eligible candidates are ranked by the lowest active substitution load",()=>{
 const balanced=[...timetable,
  {teacherId:"free2",weekday:"الأحد",period:4,className:"",status:"free" as const}
 ];
 const load:SubstitutionAssignment[]=[
  {substituteTeacherId:"free",weekday:"الاثنين",period:1,status:"confirmed"},
  {substituteTeacherId:"free",weekday:"الثلاثاء",period:2,status:"assigned"},
  {substituteTeacherId:"free2",weekday:"الأربعاء",period:3,status:"cancelled"},
 ];
 const candidates=getAvailableSubstitutionCandidates({
  teachers:[...teachers,{id:"free2",name:"أحمد",departmentId:"arabic"}],
  timetable:balanced,assignments:load,absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"
 });
 if(candidates[0]?.id!=="free2"||candidates[1]?.id!=="free")throw new Error("Candidates should be ranked by active assignment load, ignoring cancelled assignments");
});

Deno.test("a substitution from another date does not block the same weekly period",()=>{
 const query={teachers,timetable,absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic",assignmentDate:"2026-11-15"};
 const previousDate=getAvailableSubstitutionCandidates({...query,assignments:[
  {substituteTeacherId:"free",weekday:"الأحد",period:4,assignmentDate:"2026-11-08",status:"confirmed"}
 ]});
 if(!previousDate.some(t=>t.id==="free"))throw new Error("A prior week's assignment incorrectly blocked this date");
 const sameDate=getAvailableSubstitutionCandidates({...query,assignments:[
  {substituteTeacherId:"free",weekday:"الأحد",period:4,assignmentDate:"2026-11-15",status:"confirmed"}
 ]});
 if(sameDate.some(t=>t.id==="free"))throw new Error("An assignment on the selected date did not block the candidate");
});

Deno.test("explicit other and unclear cells are never offered as free",()=>{
 const nonFree=[...timetable,
  {teacherId:"other-status",weekday:"الأحد",period:4,className:"",status:"other" as const}
 ];
 const candidates=getAvailableSubstitutionCandidates({
  teachers:[...teachers,{id:"other-status",name:"حسن",departmentId:"arabic"}],
  timetable:nonFree,assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"
 });
 if(candidates.some(t=>["other-status","meeting","unknown"].includes(t.id))) {
  throw new Error("Other, meeting, and unclear cells must never be treated as free");
 }
});
Deno.test("duplicate cells for one teacher are not considered a confirmed free period",()=>{
 const duplicated=[...timetable,
  {teacherId:"free",weekday:"الأحد",period:4,className:"duplicate",status:"free" as const}
 ];
 const candidates=getAvailableSubstitutionCandidates({
  teachers,timetable:duplicated,assignments:[],absentTeacherId:"absent",weekday:"الأحد",period:4,departmentId:"arabic"
 });
 if(candidates.some(t=>t.id==="free"))throw new Error("A duplicated timetable cell was offered as a free candidate");
});
