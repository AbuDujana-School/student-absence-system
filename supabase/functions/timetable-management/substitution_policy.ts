/** Availability and fair workload rules for the explicit weekly timetable grid. */
export interface SubstitutionTeacher { id:string; name:string; departmentId:string; }
export type TimetableCellStatus="teaching"|"free"|"meeting"|"activity"|"other"|"unclear";
export interface TimetableEntry { teacherId:string; weekday:string; period:number; className:string; subject?:string; status?:TimetableCellStatus; }
export interface SubstitutionAssignment {
  substituteTeacherId:string; weekday:string; period:number; assignmentDate?:string|null;
  status?:"assigned"|"confirmed"|"cancelled"|"completed"; assignmentType?:string;
}
export interface SubstitutionLesson { weekday:string; period:number; className:string; subject?:string; }
export interface CandidateQuery {
  teachers:SubstitutionTeacher[]; timetable:TimetableEntry[]; assignments:SubstitutionAssignment[];
  absentTeacherId:string; weekday:string; period:number; departmentId:string;
  includeOtherDepartments?:boolean; assignmentDate?:string;
}
function sameCell(a:{weekday:string;period:number},b:{weekday:string;period:number}):boolean {
  return a.weekday===b.weekday && a.period===b.period;
}
function isoWeekStart(date:string):string {
  const d=new Date(date+"T12:00:00.000Z");
  d.setUTCDate(d.getUTCDate()-d.getUTCDay());
  return d.toISOString().slice(0,10);
}
function monthStart(date:string):string { return date.slice(0,7)+"-01"; }
function active(a:SubstitutionAssignment):boolean {
  return a.status!=="cancelled";
}
function assignmentAppliesToDate(a:SubstitutionAssignment,date:string|undefined,weekday:string):boolean {
  if(a.weekday!==weekday)return false;
  if(!date)return true;
  return !a.assignmentDate || a.assignmentDate===date;
}
/** Only explicit teaching cells are lessons that need a replacement. */
export function getAbsentTeacherLessons(timetable:TimetableEntry[],teacherId:string,weekday:string):SubstitutionLesson[] {
  return timetable.filter(e=>e.teacherId===teacherId && e.weekday===weekday && (e.status??"teaching")==="teaching")
    .map(e=>({weekday:e.weekday,period:e.period,className:e.className,...(e.subject?{subject:e.subject}:{})}))
    .sort((a,b)=>a.period-b.period);
}
/**
 * Lexicographic fairness: minimize today's assignments first, then this school
 * week, this month, and finally all active historical assignments. Assignment
 * rows of every type (including registered duty) count toward load and block
 * the same teacher/date/period; availability always outranks fairness.
 */
export function getSubstitutionWorkloadScore(
  teacherId:string, assignments:SubstitutionAssignment[], date?:string,
):[number,number,number,number] {
  const own=assignments.filter(a=>active(a)&&a.substituteTeacherId===teacherId);
  const today=date?own.filter(a=>a.assignmentDate===date||(!a.assignmentDate&&a.weekday===new Date(date+"T12:00:00Z").toLocaleDateString("ar",{weekday:"long"}))).length:0;
  const weekStart=date?isoWeekStart(date):"";
  const weekEnd=date?new Date(new Date(weekStart+"T12:00:00Z").getTime()+4*86400000).toISOString().slice(0,10):"";
  const week=date?own.filter(a=>!a.assignmentDate||(a.assignmentDate>=weekStart&&a.assignmentDate<=weekEnd)).length:own.length;
  const month=date?own.filter(a=>!a.assignmentDate||a.assignmentDate.slice(0,7)===date.slice(0,7)).length:own.length;
  return [today,week,month,own.length];
}
/** Missing, duplicated, meeting, activity, other and unclear cells are never treated as free. */
export function getAvailableSubstitutionCandidates(query:CandidateQuery):SubstitutionTeacher[] {
  const {teachers,timetable,assignments,absentTeacherId,weekday,period,departmentId,includeOtherDepartments=false,assignmentDate}=query;
  const cells=new Map<string,{count:number;isFree:boolean}>();
  for(const entry of timetable.filter(e=>sameCell(e,{weekday,period}))){
    const current=cells.get(entry.teacherId)??{count:0,isFree:true};
    current.count+=1;
    if((entry.status??"teaching")!=="free")current.isFree=false;
    cells.set(entry.teacherId,current);
  }
  const activeAssignments=assignments.filter(active);
  const alreadyBooked=new Set(activeAssignments
    .filter(a=>a.weekday===weekday&&a.period===period&&assignmentAppliesToDate(a,assignmentDate,weekday))
    .map(a=>a.substituteTeacherId));
  const eligible=teachers.filter(t=>t.id!==absentTeacherId)
    .filter(t=>includeOtherDepartments||!!departmentId&&t.departmentId===departmentId)
    .filter(t=>{const cell=cells.get(t.id);return !!cell&&cell.count===1&&cell.isFree;})
    .filter(t=>!alreadyBooked.has(t.id));
  return eligible.sort((a,b)=>{
    const as=getSubstitutionWorkloadScore(a.id,activeAssignments,assignmentDate);
    const bs=getSubstitutionWorkloadScore(b.id,activeAssignments,assignmentDate);
    for(let i=0;i<as.length;i++)if(as[i]!==bs[i])return as[i]-bs[i];
    return a.name.localeCompare(b.name,"ar");
  });
}

/** List only absent teachers the current coordinator is allowed to see. */
export function getVisibleAbsentTeachers(
  cells:Array<{matchedTeacherName:string|null;status:string}>,
  directory:Array<{name:string;role:string;departmentId:string}>,
  actorDepartmentId:string,isAdmin:boolean,
):string[] {
  const teachers=new Map(directory.map(teacher=>[teacher.name,teacher]));
  return Array.from(new Set(cells
    .filter(cell=>cell.status==="teaching"&&!!cell.matchedTeacherName)
    .filter(cell=>{
      const teacher=teachers.get(cell.matchedTeacherName as string);
      return !!teacher&&teacher.role==="teacher"&&(isAdmin||(!!actorDepartmentId&&teacher.departmentId===actorDepartmentId));
    })
    .map(cell=>String(cell.matchedTeacherName))))
    .sort((a,b)=>a.localeCompare(b,"ar"));
}
