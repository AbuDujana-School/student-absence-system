/** Availability rules for a complete, explicit weekly timetable grid. */
export interface SubstitutionTeacher { id:string; name:string; departmentId:string; dutyDay?:string; weeklyQuota?:number; substitutionsCount?:number; workloadScore?:number; historicalWorkloadScore?:number; }
export type TimetableCellStatus="teaching"|"free"|"meeting"|"activity"|"other"|"unclear";
export interface TimetableEntry { teacherId:string; weekday:string; period:number; className:string; subject?:string; status?:TimetableCellStatus; }
export interface SubstitutionAssignment { substituteTeacherId:string; weekday:string; period:number; assignmentDate?:string|null; versionId?:string; assignmentType?:string; status?:"assigned"|"confirmed"|"cancelled"|"completed"; }
export interface SubstitutionLesson { weekday:string; period:number; className:string; subject?:string; }
export interface CandidateQuery {
  teachers:SubstitutionTeacher[]; timetable:TimetableEntry[]; assignments:SubstitutionAssignment[];
  absentTeacherId:string; weekday:string; period:number; departmentId:string; includeOtherDepartments?:boolean; assignmentDate?:string; versionId?:string;
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
  const {teachers,timetable,assignments,absentTeacherId,weekday,period,departmentId,includeOtherDepartments=false,assignmentDate,versionId}=query;
  const cells=new Map<string,{count:number;isFree:boolean}>();
  for(const entry of timetable.filter(e=>sameCell(e,{weekday,period}))){
    const current=cells.get(entry.teacherId)??{count:0,isFree:true};
    current.count+=1;
    if((entry.status??"teaching")!=="free") current.isFree=false;
    cells.set(entry.teacherId,current);
  }
  const activeAssignments=assignments.filter(a=>a.status!=="cancelled");
  const assigned=new Set(activeAssignments.filter(a=>sameCell(a,{weekday,period})&&(assignmentDate&&a.assignmentDate? a.assignmentDate===assignmentDate : (!versionId||!a.versionId||a.versionId===versionId))).map(a=>a.substituteTeacherId));
  const historyFor=(teacherId:string)=>activeAssignments.filter(a=>
    a.substituteTeacherId===teacherId&&
    (a.assignmentType==="substitution"||!a.assignmentType)&&
    (!assignmentDate||!a.assignmentDate||a.assignmentDate<=assignmentDate)
  );
  const historicalScore=(history:SubstitutionAssignment[]):number=>
    calculateSubstitutionWorkloadScore(history,assignmentDate,period);
  return teachers.filter(t=>t.id!==absentTeacherId)
    // Teachers assigned to a school/category duty day are unavailable for substitution that day.
    .filter(t=>!t.dutyDay||t.dutyDay!==weekday)
    .filter(t=>includeOtherDepartments||!!departmentId&&t.departmentId===departmentId)
    .filter(t=>{const cell=cells.get(t.id);return !!cell&&cell.count===1&&cell.isFree;})
    .filter(t=>!assigned.has(t.id)).map(t=>{
      const history=historyFor(t.id);
      const substitutionsCount=history.length;
      const weeklyQuota=Math.max(0,Number(t.weeklyQuota)||0);
      return {...t,substitutionsCount,workloadScore:weeklyQuota+substitutionsCount*2,historicalWorkloadScore:historicalScore(history)};
    })
    .sort((a,b)=>(a.workloadScore??0)-(b.workloadScore??0)||(a.historicalWorkloadScore??0)-(b.historicalWorkloadScore??0)||a.name.localeCompare(b.name,"ar"));
}


/**
 * Cumulative fairness score. Availability remains a hard gate; this score only
 * orders eligible teachers. Older assignments still count, while recent load
 * has greater influence to prevent repeatedly burdening the same teachers.
 */
export function calculateSubstitutionWorkloadScore(
  assignments:SubstitutionAssignment[],
  referenceDate?:string,
  targetPeriod?:number,
):number {
  const active=assignments.filter(a=>a.status!=="cancelled"&&(a.assignmentType==="substitution"||!a.assignmentType));
  const reference=referenceDate && /^\d{4}-\d{2}-\d{2}$/.test(referenceDate)
    ? new Date(referenceDate+"T12:00:00Z") : null;
  const dayMs=86400000;
  let total=0, last90=0, last30=0, last7=0, sameDay=0, adjacent=0;
  for(const assignment of active){
    if(reference && assignment.assignmentDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(assignment.assignmentDate)){
      const assignedAt=new Date(assignment.assignmentDate+"T12:00:00Z");
      const age=Math.floor((reference.getTime()-assignedAt.getTime())/dayMs);
      if(age<0) continue; // Future assignments must never affect a past/current fairness decision.
      total++;
      if(age<90) last90++;
      if(age<30) last30++;
      if(age<7) last7++;
      if(age===0) { sameDay++; if(targetPeriod && Math.abs(assignment.period-targetPeriod)===1) adjacent++; }
    } else {
      total++; // Undated legacy substitution rows remain part of cumulative history.
    }
  }
  // Total history prevents gaming by waiting out a short rolling window.
  return total + last90*2 + last30*3 + last7*4 + sameDay*8 + adjacent*4;
}

/** List only absent teachers the current coordinator is allowed to see. */
export function getVisibleAbsentTeachers(
  cells: Array<{ matchedTeacherName: string | null; status: string }>,
  directory: Array<{ name: string; role: string; departmentId: string }>,
  actorDepartmentId: string,
  isAdmin: boolean,
): string[] {
  const teachers = new Map(directory.map((teacher) => [teacher.name, teacher]));
  return Array.from(new Set(cells
    .filter((cell) => cell.status === "teaching" && !!cell.matchedTeacherName)
    .filter((cell) => {
      const teacher = teachers.get(cell.matchedTeacherName as string);
      return !!teacher && teacher.role === "teacher" &&
        (isAdmin || (!!actorDepartmentId && teacher.departmentId === actorDepartmentId));
    })
    .map((cell) => String(cell.matchedTeacherName))))
    .sort((a, b) => a.localeCompare(b, "ar"));
}
