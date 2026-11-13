/** Availability rules for a complete, explicit weekly timetable grid. */
export interface SubstitutionTeacher { id:string; name:string; departmentId:string; }
export type TimetableCellStatus="teaching"|"free"|"meeting"|"activity"|"other"|"unclear";
export interface TimetableEntry { teacherId:string; weekday:string; period:number; className:string; subject?:string; status?:TimetableCellStatus; }
export interface SubstitutionAssignment { substituteTeacherId:string; weekday:string; period:number; assignmentDate?:string|null; status?:"assigned"|"confirmed"|"cancelled"|"completed"; }
export interface SubstitutionLesson { weekday:string; period:number; className:string; subject?:string; }
export interface CandidateQuery {
  teachers:SubstitutionTeacher[]; timetable:TimetableEntry[]; assignments:SubstitutionAssignment[];
  absentTeacherId:string; weekday:string; period:number; departmentId:string; includeOtherDepartments?:boolean;
}
function sameCell(a:{weekday:string;period:number},b:{weekday:string;period:number}):boolean {
  return a.weekday===b.weekday && a.period===b.period;
}
/** Only explicit teaching cells are lessons that need a replacement. */
export function getAbsentTeacherLessons(timetable:TimetableEntry[],teacherId:string,weekday:string):SubstitutionLesson[] {
  return timetable.filter(e=>e.teacherId===teacherId && e.weekday===weekday && (e.status??"teaching")==="teaching")
    .map(e=>({weekday:e.weekday,period:e.period,className:e.className,...(e.subject?{subject:e.subject}:{})}))
    .sort((a,b)=>a.period-b.period);
}
/** Missing, duplicated, meeting, activity, other and unclear cells are never treated as free. */
export function getAvailableSubstitutionCandidates(query:CandidateQuery):SubstitutionTeacher[] {
  const {teachers,timetable,assignments,absentTeacherId,weekday,period,departmentId,includeOtherDepartments=false,assignmentDate}=query;
  const cells=new Map<string,{count:number;isFree:boolean}>();
  for(const entry of timetable.filter(e=>sameCell(e,{weekday,period}))){
    const current=cells.get(entry.teacherId)??{count:0,isFree:true};
    current.count+=1;
    if((entry.status??"teaching")!=="free") current.isFree=false;
    cells.set(entry.teacherId,current);
  }
  const activeAssignments=assignments.filter(a=>a.status!=="cancelled");
  const assigned=new Set(activeAssignments.filter(a=>sameCell(a,{weekday,period})&&(!assignmentDate||!a.assignmentDate||a.assignmentDate===assignmentDate)).map(a=>a.substituteTeacherId));
  const workload=new Map<string,number>();
  for(const assignment of activeAssignments) workload.set(assignment.substituteTeacherId,(workload.get(assignment.substituteTeacherId)??0)+1);
  return teachers.filter(t=>t.id!==absentTeacherId)
    .filter(t=>includeOtherDepartments||t.departmentId===departmentId)
    .filter(t=>{const cell=cells.get(t.id);return !!cell&&cell.count===1&&cell.isFree;})
    .filter(t=>!assigned.has(t.id)).slice().sort((a,b)=>(workload.get(a.id)??0)-(workload.get(b.id)??0)||a.name.localeCompare(b.name,"ar"));
}
