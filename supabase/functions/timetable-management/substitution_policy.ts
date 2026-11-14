/** Availability and fairness rules for an explicit weekly timetable. */
export interface SubstitutionTeacher { id:string; name:string; departmentId:string; }
export type TimetableCellStatus="teaching"|"free"|"meeting"|"activity"|"other"|"unclear";
export interface TimetableEntry { teacherId:string; weekday:string; period:number; className:string; subject?:string; status?:TimetableCellStatus; }
export interface SubstitutionAssignment {
  substituteTeacherId:string; weekday:string; period:number; assignmentDate?:string|null;
  status?:"assigned"|"confirmed"|"cancelled"|"completed";
  /** Includes supervision/duty records as well as substitutions when supplied by the API. */
  assignmentType?:string; versionId?:string;
}
export interface SubstitutionLesson { weekday:string; period:number; className:string; subject?:string; }
export interface CandidateQuery {
  teachers:SubstitutionTeacher[]; timetable:TimetableEntry[]; assignments:SubstitutionAssignment[];
  absentTeacherId:string; weekday:string; period:number; departmentId:string;
  includeOtherDepartments?:boolean; assignmentDate?:string; activeVersionId?:string;
}
export interface WorkloadBreakdown {
  historicalAssignments:number; weeklyAssignments:number; dailyAssignments:number; lastAssignmentDate:string|null;
  adjacentPeriodAssignments:number; score:number;
}
function sameCell(a:{weekday:string;period:number},b:{weekday:string;period:number}):boolean {
  return a.weekday===b.weekday && a.period===b.period;
}
function isActive(a:SubstitutionAssignment):boolean {
  return a.status!=="cancelled";
}
function appliesToDate(a:SubstitutionAssignment,date?:string,activeVersionId?:string):boolean {
  if(!date) return true;
  // Legacy rows without a date are scoped to the active timetable version only.
  return a.assignmentDate ? a.assignmentDate===date : !!activeVersionId&&a.versionId===activeVersionId;
}
export function calculateTeacherWorkload(
  teacherId:string, assignments:SubstitutionAssignment[], weekday:string, period:number, assignmentDate?:string
):WorkloadBreakdown {
  const active=assignments.filter(a=>a.substituteTeacherId===teacherId&&isActive(a));
  const daily=active.filter(a=>a.weekday===weekday&&(assignmentDate ? a.assignmentDate===assignmentDate : true));
  const adjacent=daily.filter(a=>Math.abs(a.period-period)===1).length;
  const historicalAssignments=active.length;
  const datedAssignments=active.map(a=>a.assignmentDate||null).filter((value):value is string=>!!value).sort();
  const lastAssignmentDate=datedAssignments.length?datedAssignments[datedAssignments.length-1]:null;
  const weeklyAssignments=assignmentDate
    ? active.filter(a=>!!a.assignmentDate&&a.assignmentDate>=weekStart(assignmentDate)&&a.assignmentDate<=weekEnd(assignmentDate)).length
    : active.filter(a=>a.weekday===weekday).length;
  const dailyAssignments=daily.length;
  // Duty/supervision and substitution both count toward workload. Cancelled rows do not.
  const score=historicalAssignments*10+weeklyAssignments*4+dailyAssignments*3+adjacent*5;
  return {historicalAssignments,weeklyAssignments,dailyAssignments,adjacentPeriodAssignments:adjacent,lastAssignmentDate,score};
}
function weekStart(date:string):string {
  const d=new Date(date+"T12:00:00"); d.setDate(d.getDate()-d.getDay());
  return localIso(d);
}
function weekEnd(date:string):string {
  const d=new Date(date+"T12:00:00"); d.setDate(d.getDate()-d.getDay()+4);
  return localIso(d);
}
function localIso(d:Date):string {
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
/** Only explicit teaching cells are lessons that need a replacement. */
export function getAbsentTeacherLessons(timetable:TimetableEntry[],teacherId:string,weekday:string):SubstitutionLesson[] {
  return timetable.filter(e=>e.teacherId===teacherId&&e.weekday===weekday&&(e.status??"teaching")==="teaching")
    .map(e=>({weekday:e.weekday,period:e.period,className:e.className,...(e.subject?{subject:e.subject}:{})}))
    .sort((a,b)=>a.period-b.period);
}
/**
 * A candidate must have exactly one explicit free cell. Any active assignment
 * (substitution, supervision, or other duty) in the same dated slot blocks them.
 * Workload ranking uses all supplied historical assignment rows, not just this week.
 */
export function getAvailableSubstitutionCandidates(query:CandidateQuery):SubstitutionTeacher[] {
  const {teachers,timetable,assignments,absentTeacherId,weekday,period,departmentId,includeOtherDepartments=false,assignmentDate,activeVersionId}=query;
  const cells=new Map<string,{count:number;isFree:boolean}>();
  for(const entry of timetable.filter(e=>sameCell(e,{weekday,period}))){
    const current=cells.get(entry.teacherId)??{count:0,isFree:true};
    current.count+=1;
    if((entry.status??"teaching")!=="free") current.isFree=false;
    cells.set(entry.teacherId,current);
  }
  const activeAssignments=assignments.filter(isActive);
  const alreadyBooked=new Set(activeAssignments
    .filter(a=>sameCell(a,{weekday,period})&&appliesToDate(a,assignmentDate,activeVersionId))
    .map(a=>a.substituteTeacherId));
  return teachers.filter(t=>t.id!==absentTeacherId)
    .filter(t=>includeOtherDepartments||!!departmentId&&t.departmentId===departmentId)
    .filter(t=>{const cell=cells.get(t.id);return !!cell&&cell.count===1&&cell.isFree;})
    .filter(t=>!alreadyBooked.has(t.id))
    .map(t=>({...t,workload:calculateTeacherWorkload(t.id,activeAssignments,weekday,period,assignmentDate)} as SubstitutionTeacher & {workload:WorkloadBreakdown}))
    .sort((a,b)=>{
      const aw=(a as SubstitutionTeacher & {workload:WorkloadBreakdown}).workload;
      const bw=(b as SubstitutionTeacher & {workload:WorkloadBreakdown}).workload;
      return aw.score-bw.score||(aw.lastAssignmentDate||"").localeCompare(bw.lastAssignmentDate||"")||a.name.localeCompare(b.name,"ar")||a.id.localeCompare(b.id);
    });
}
/** List only absent teachers the current coordinator is allowed to see. */
export function getVisibleAbsentTeachers(
  cells:Array<{matchedTeacherName:string|null;status:string}>,
  directory:Array<{name:string;role:string;departmentId:string}>,
  actorDepartmentId:string,isAdmin:boolean
):string[] {
  const teachers=new Map(directory.map(teacher=>[teacher.name,teacher]));
  return Array.from(new Set(cells
    .filter(cell=>cell.status==="teaching"&&!!cell.matchedTeacherName)
    .filter(cell=>{
      const teacher=teachers.get(cell.matchedTeacherName as string);
      return !!teacher&&teacher.role==="teacher"&&(isAdmin||!!actorDepartmentId&&teacher.departmentId===actorDepartmentId);
    }).map(cell=>String(cell.matchedTeacherName))))
    .sort((a,b)=>a.localeCompare(b,"ar"));
}
