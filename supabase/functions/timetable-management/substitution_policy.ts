/** Availability rules for a complete, explicit weekly timetable grid. */
export interface SubstitutionTeacher {
  id:string; name:string; departmentId:string; weeklyQuota?:number;
  pointsBalance?:number; compensationBalance?:number; dailyTeachingCount?:number; dailySubstitutionCount?:number;
  substitutionsCount?:number; workloadScore?:number; historicalWorkloadScore?:number;
  proximityScore?:number; wouldCreateTriple?:boolean; occupiedPeriods?:number[];
  candidateScore?:number; effortPoints?:number; streakPenalty?:number; sameDayPenalty?:number;
  streakStatus?:string; loadLabel?:string; reasons?:string[]; emergencyFallback?:boolean;
}
export type TimetableCellStatus="teaching"|"free"|"meeting"|"activity"|"other"|"unclear";
export interface TimetableEntry { teacherId:string; weekday:string; period:number; className:string; subject?:string; status?:TimetableCellStatus; }
export interface SubstitutionAssignment {
  substituteTeacherId:string; absentTeacherId?:string; weekday:string; period:number;
  assignmentDate?:string|null; versionId?:string; assignmentType?:string; absenceReason?:string;
  status?:"assigned"|"confirmed"|"cancelled"|"completed";
}
export interface SubstitutionLesson { weekday:string; period:number; className:string; subject?:string; }
export interface CandidateQuery {
  teachers:SubstitutionTeacher[]; timetable:TimetableEntry[]; assignments:SubstitutionAssignment[];
  absentTeacherId:string; weekday:string; period:number; departmentId:string; includeOtherDepartments?:boolean; otherDepartmentTeacherIds?:string[];
  assignmentDate?:string; versionId?:string; excludedTeacherIds?:string[]; maxDailySubstitutions?:number;
}
function sameCell(a:{weekday:string;period:number},b:{weekday:string;period:number}):boolean {
  return a.weekday===b.weekday && a.period===b.period;
}

/** School-approved points for a single substitute lesson (periods 1–8). */
export function getSubstitutionPeriodPoints(period:number):number {
  return ({1:1,2:1,3:1.5,4:1.5,5:3,6:2.5,7:4,8:5} as Record<number,number>)[period] ?? 0;
}

export function getSubstitutionDailyLoadFactor(periodCount:number):{factor:number;label:string;overloaded:boolean} {
  const count=Math.max(0,Math.floor(Number(periodCount)||0));
  if(count<=2)return {factor:1,label:"نصاب خفيف (حصتان أو أقل)",overloaded:false};
  if(count===3)return {factor:1.25,label:"نصاب متوسط (3 حصص)",overloaded:false};
  if(count===4)return {factor:1.6,label:"نصاب مرتفع (4 حصص)",overloaded:false};
  return {factor:2.2,label:"نصاب ثقيل ("+count+" حصص) — طوارئ فقط",overloaded:true};
}

const STREAK_PENALTY_3=15;
const STREAK_PENALTY_4_PLUS=50;
const SAME_DAY_PENALTY=10;
const OVERLOAD_EMERGENCY_PENALTY=1000;


/** Strict ISO calendar-date validation; rejects normalized invalid dates such as February 30. */
export function isValidSubstitutionDate(value:unknown):value is string {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed=new Date(value+"T00:00:00.000Z");
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}

function assignmentBelongsToDate(
  assignment:SubstitutionAssignment, weekday:string, assignmentDate?:string, versionId?:string,
):boolean {
  if(assignment.weekday!==weekday) return false;
  if(assignmentDate && assignment.assignmentDate) return assignment.assignmentDate===assignmentDate;
  return !versionId || !assignment.versionId || assignment.versionId===versionId;
}

function getStreakMetrics(periods:Set<number>,target:number):{maxStreak:number;createdBridge:boolean} {
  const occupied=new Set(periods); occupied.add(Number(target));
  let maxStreak=0,current=0;
  for(let period=1;period<=8;period++){
    if(occupied.has(period)){current++;maxStreak=Math.max(maxStreak,current);}
    else current=0;
  }
  return {maxStreak,createdBridge:occupied.has(target-1)&&occupied.has(target+1)};
}
/** Only explicit teaching cells are lessons that need a replacement. */
export function getAbsentTeacherLessons(timetable:TimetableEntry[],teacherId:string,weekday:string):SubstitutionLesson[] {
  const byPeriod=new Map<number,{classNames:Set<string>;subjects:Set<string>}>();
  for(const entry of timetable.filter(e=>e.teacherId===teacherId&&e.weekday===weekday&&(e.status??"teaching")==="teaching")){
    const group=byPeriod.get(entry.period)??{classNames:new Set<string>(),subjects:new Set<string>()};
    if(entry.className)group.classNames.add(entry.className);
    if(entry.subject)group.subjects.add(entry.subject);
    byPeriod.set(entry.period,group);
  }
  return Array.from(byPeriod.entries()).sort((a,b)=>a[0]-b[0]).map(([period,group])=>({
    weekday,period,className:Array.from(group.classNames).join("، "),
    ...(group.subjects.size?{subject:Array.from(group.subjects).join("، ")}:{})
  }));
}

/** Counts distinct teacher/day/period teaching slots; shared-class duplicate rows count once. */
export function countTeacherTeachingPeriods(entries:TimetableEntry[]):Map<string,number> {
  const seen=new Set<string>();
  const counts=new Map<string,number>();
  for(const entry of entries){
    if(!entry.teacherId||!entry.weekday||(entry.status??"teaching")!=="teaching")continue;
    const key=entry.teacherId+"\\u0000"+entry.weekday+"\\u0000"+entry.period;
    if(seen.has(key))continue;
    seen.add(key);
    counts.set(entry.teacherId,(counts.get(entry.teacherId)||0)+1);
  }
  return counts;
}
/** Availability is a hard gate; eligible teachers are ranked by transparent cumulative effort. */
export function getAvailableSubstitutionCandidates(query:CandidateQuery):SubstitutionTeacher[] {
  const {teachers,timetable,assignments,absentTeacherId,weekday,period,departmentId,
    includeOtherDepartments=false,otherDepartmentTeacherIds=[],assignmentDate,versionId,
    excludedTeacherIds=[],maxDailySubstitutions=2}=query;
  const cells=new Map<string,{count:number;isFree:boolean}>();
  for(const entry of timetable.filter(e=>sameCell(e,{weekday,period}))){
    const current=cells.get(entry.teacherId)??{count:0,isFree:true};
    current.count++;
    if((entry.status??"teaching")!=="free")current.isFree=false;
    cells.set(entry.teacherId,current);
  }
  const activeAssignments=assignments.filter(a=>a.status!=="cancelled");
  const assigned=new Set(activeAssignments.filter(a=>sameCell(a,{weekday,period})&&
    (assignmentDate&&a.assignmentDate?a.assignmentDate===assignmentDate:(!versionId||!a.versionId||a.versionId===versionId)))
    .map(a=>a.substituteTeacherId));
  const historyFor=(teacherId:string)=>activeAssignments.filter(a=>
    a.substituteTeacherId===teacherId&&(a.assignmentType==="substitution"||!a.assignmentType)&&
    (!assignmentDate||!a.assignmentDate||a.assignmentDate<=assignmentDate));
  const sameDayAssignments=(teacherId:string)=>activeAssignments.filter(a=>
    a.substituteTeacherId===teacherId&&(a.assignmentType==="substitution"||!a.assignmentType)&&
    assignmentBelongsToDate(a,weekday,assignmentDate,versionId));
  const raw=teachers.filter(t=>t.id!==absentTeacherId&&!excludedTeacherIds.includes(t.id))
    .filter(t=>t.departmentId===departmentId||(includeOtherDepartments&&otherDepartmentTeacherIds.includes(t.id)))
    .filter(t=>{const cell=cells.get(t.id);return !!cell&&cell.count===1&&cell.isFree;})
    .filter(t=>!assigned.has(t.id))
    .map(t=>{
      const history=historyFor(t.id),today=sameDayAssignments(t.id);
      const dailyTeachingPeriods=new Set(timetable.filter(e=>e.teacherId===t.id&&e.weekday===weekday&&
        (e.status??"teaching")==="teaching").map(e=>Number(e.period)));
      const occupied=new Set(dailyTeachingPeriods);
      for(const assignment of today)occupied.add(Number(assignment.period));
      const dailyTeachingCount=dailyTeachingPeriods.size;
      const dailySubstitutionCount=today.length;
      const load=getSubstitutionDailyLoadFactor(dailyTeachingCount);
      const streak=getStreakMetrics(occupied,period);
      const periodWeight=getSubstitutionPeriodPoints(period);
      const effortPoints=Number((periodWeight*load.factor).toFixed(2));
      const cumulativePoints=Number(t.pointsBalance)||0;
      const compensationBalance=Math.max(0,Number(t.compensationBalance)||0);
      const compensationAdjustment=-Math.min(compensationBalance,6)*0.75;
      const streakPenalty=streak.maxStreak>=4?STREAK_PENALTY_4_PLUS:streak.maxStreak===3?STREAK_PENALTY_3:streak.createdBridge?4:0;
      const sameDayPenalty=dailySubstitutionCount>0?SAME_DAY_PENALTY:0;
      const reasons:string[]=[];
      if(load.overloaded)reasons.push("نصاب 5 حصص فأكثر؛ يُستخدم فقط عند انعدام البدائل");
      else reasons.push(load.label);
      reasons.push("الجهد الفعلي للحصة: "+effortPoints.toFixed(2)+" نقطة");
      reasons.push("الرصيد التراكمي: "+cumulativePoints.toFixed(2)+" نقطة");
      if(streak.maxStreak>=4)reasons.push("تتالي مرهق: "+streak.maxStreak+" حصص (+"+STREAK_PENALTY_4_PLUS+")");
      else if(streak.maxStreak===3)reasons.push("يسبب 3 حصص متتالية (+"+STREAK_PENALTY_3+")");
      else if(streak.createdBridge)reasons.push("يربط حصتين متجاورتين (+4)");
      else reasons.push("متاح بسلاسة دون تتالٍ مرهق");
      if(sameDayPenalty)reasons.push("لديه احتياط سابق اليوم (+"+SAME_DAY_PENALTY+")");
      if(compensationBalance>0)reasons.push("رصيد تعويض طارئ متبقٍ: "+compensationBalance.toFixed(2)+" (أفضلية)");
      const candidateScore=Number((cumulativePoints+effortPoints+streakPenalty+sameDayPenalty+
        compensationAdjustment+(load.overloaded?OVERLOAD_EMERGENCY_PENALTY:0)).toFixed(2));
      return {
        ...t,dailyTeachingCount,dailySubstitutionCount,substitutionsCount:history.length,
        occupiedPeriods:[...occupied].sort((x,y)=>x-y),
        proximityScore:occupied.has(period-1)||occupied.has(period+1)?1:0,
        wouldCreateTriple:streak.maxStreak>=3,workloadScore:(Number(t.weeklyQuota)||0)+history.length*2,
        historicalWorkloadScore:calculateSubstitutionWorkloadScore(history,assignmentDate,period),
        candidateScore,effortPoints,streakPenalty,sameDayPenalty,
        streakStatus:streak.maxStreak>=4?"تتالي مرهق ("+streak.maxStreak+" حصص)":streak.maxStreak===3
          ?"يسبب 3 حصص متتالية":streak.createdBridge?"يربط حصتين متجاورتين":"متاح بسلاسة",
        loadLabel:load.label,reasons,emergencyFallback:load.overloaded,
      } as SubstitutionTeacher;
    })
    .filter(t=>(t.dailySubstitutionCount??0)<maxDailySubstitutions);

  // Five or more teaching periods are considered only when no lighter-load candidate exists.
  const normalLoad=raw.filter(t=>!getSubstitutionDailyLoadFactor(t.dailyTeachingCount||0).overloaded);
  const loadPool=normalLoad.length?normalLoad:raw;
  // Four or more consecutive periods stay below every non-exhausting option.
  const nonExhausting=loadPool.filter(t=>(Number(t.streakPenalty)||0)<STREAK_PENALTY_4_PLUS);
  const streakPool=nonExhausting.length?nonExhausting:loadPool;
  return streakPool.sort((x,y)=>
    (Number(x.candidateScore)||0)-(Number(y.candidateScore)||0)||
    (Number(x.dailySubstitutionCount)||0)-(Number(y.dailySubstitutionCount)||0)||
    (Number(x.dailyTeachingCount)||0)-(Number(y.dailyTeachingCount)||0)||
    x.name.localeCompare(y.name,"ar"));
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
    if(reference && assignment.assignmentDate && /^\d{4}-\d{2}-\d{2}$/.test(assignment.assignmentDate)){
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


export interface BatchAbsentTeacher { id:string; name:string; departmentId:string; }
export interface BatchSubstitutionPlanQuery {
  teachers:SubstitutionTeacher[]; timetable:TimetableEntry[]; assignments:SubstitutionAssignment[];
  absentTeachers:BatchAbsentTeacher[]; weekday:string; assignmentDate:string; versionId:string;
  includeOtherDepartments?:boolean; otherDepartmentTeacherIds?:string[]; manualAssignments?:Record<string,string>;
}
export interface BatchSubstitutionPlan {
  assignments:Array<{
    absentTeacherName:string; substituteTeacherName:string; weekday:string; period:number;
    className:string; subject?:string; points:number; pointsBalanceAfter:number; absentPointsBalanceAfter:number;
    substituteDailyTeachingCount:number; createsThreeConsecutive:boolean;
    candidateOptions:Array<{teacherName:string;pointsBalance:number;compensationBalance:number;candidateScore:number;effortPoints:number;streakPenalty:number;sameDayPenalty:number;weeklyQuota:number;dailyTeachingCount:number;dailySubstitutionCount:number;occupiedPeriods:number[];adjacent:boolean;createsThreeConsecutive:boolean;streakStatus:string;loadLabel:string;reasons:string[]}>;
  }>;
  unassigned:Array<{absentTeacherName:string;weekday:string;period:number;className:string;subject?:string}>;
  assignedCount:number; unassignedCount:number;
}

/** Whole-morning allocator: one lesson per substitute first, two only if needed. */
export function buildBatchSubstitutionPlan(query:BatchSubstitutionPlanQuery):BatchSubstitutionPlan {
  const absentById=new Map(query.absentTeachers.map(t=>[t.id,t]));
  const excludedTeacherIds=Array.from(absentById.keys());
  // Preserve the coordinator's selected absent-teacher order. Finish every lesson
  // for the first absent teacher before moving to the next teacher.
  const orderedLessons=query.absentTeachers.flatMap(absent=>
    getAbsentTeacherLessons(query.timetable,absent.id,query.weekday)
      .sort((a,b)=>a.period-b.period)
      .map(lesson=>({absent,lesson}))
  );
  const simulatedAssignments=[...query.assignments];
  const mutableTeachers=query.teachers.map(t=>({...t,pointsBalance:Number(t.pointsBalance)||0}));
  const assignments:BatchSubstitutionPlan["assignments"]=[];
  const unassigned:BatchSubstitutionPlan["unassigned"]=[];
  for(const {absent,lesson} of orderedLessons){
    const alreadyAssigned=simulatedAssignments.some(a=>
      a.absentTeacherId===absent.id&&a.weekday===query.weekday&&a.period===lesson.period&&
      a.status!=="cancelled"&&assignmentBelongsToDate(a,query.weekday,query.assignmentDate,query.versionId)
    );
    if(alreadyAssigned) continue;
    const candidatesFor=(limit:number)=>getAvailableSubstitutionCandidates({
      teachers:mutableTeachers,timetable:query.timetable,assignments:simulatedAssignments,
      absentTeacherId:absent.id,weekday:query.weekday,period:lesson.period,
      departmentId:absent.departmentId,
      includeOtherDepartments:query.includeOtherDepartments===true,
      otherDepartmentTeacherIds:query.otherDepartmentTeacherIds??[],
      assignmentDate:query.assignmentDate,versionId:query.versionId,
      excludedTeacherIds,maxDailySubstitutions:limit,
    });
    const firstPass=candidatesFor(1);
    const allCandidates=candidatesFor(2);
    // Subject/department teachers always take priority. Cross-department
    // support is a fallback only when no eligible same-department teacher
    // can take the lesson within the one-per-day first pass.
    const sameDepartment=(candidate:SubstitutionTeacher)=>candidate.departmentId===absent.departmentId;
    const firstPassSameDepartment=firstPass.filter(sameDepartment);
    const firstPassOtherDepartments=firstPass.filter(candidate=>!sameDepartment(candidate));
    const allSameDepartment=allCandidates.filter(sameDepartment);
    const allOtherDepartments=allCandidates.filter(candidate=>!sameDepartment(candidate));
    const rankedCandidates=firstPassSameDepartment.length?firstPassSameDepartment:
      firstPassOtherDepartments.length?firstPassOtherDepartments:
      allSameDepartment.length?allSameDepartment:allOtherDepartments;
    // Keep the manual dropdown in the exact same priority tiers as automatic allocation:
    // same-department first cover, cross-department first cover, then second daily cover.
    // Each tier already carries the fairness ordering from getAvailableSubstitutionCandidates.
    const rankedOptions=[
      ...firstPassSameDepartment,
      ...firstPassOtherDepartments,
      ...allSameDepartment.filter(option=>(option.dailySubstitutionCount??0)>=1),
      ...allOtherDepartments.filter(option=>(option.dailySubstitutionCount??0)>=1),
    ];
    const manualKey=absent.name+"\\u0000"+lesson.period;
    const manualName=query.manualAssignments?.[manualKey];
    const manualCandidate=manualName?rankedOptions.find(option=>option.name===manualName):undefined;
    const candidate=manualCandidate||rankedCandidates[0];
    if(!candidate){
      unassigned.push({absentTeacherName:absent.name,weekday:lesson.weekday,period:lesson.period,className:lesson.className,...(lesson.subject?{subject:lesson.subject}:{})});
      continue;
    }
    const points=Number(candidate.effortPoints??(getSubstitutionPeriodPoints(lesson.period)*getSubstitutionDailyLoadFactor(candidate.dailyTeachingCount||0).factor));
    const teacher=mutableTeachers.find(t=>t.id===candidate.id)!;
    teacher.pointsBalance=Number(((teacher.pointsBalance??0)+points).toFixed(2));
    assignments.push({
      absentTeacherName:absent.name,substituteTeacherName:candidate.name,weekday:lesson.weekday,
      period:lesson.period,className:lesson.className,...(lesson.subject?{subject:lesson.subject}:{}),
      points,pointsBalanceAfter:teacher.pointsBalance??0,absentPointsBalanceAfter:Number(mutableTeachers.find(t=>t.id===absent.id)?.pointsBalance)||0,
      substituteDailyTeachingCount:candidate.dailyTeachingCount??0,
      createsThreeConsecutive:candidate.wouldCreateTriple===true,
      candidateOptions:rankedOptions.map(option=>({
        teacherName:option.name,pointsBalance:option.pointsBalance??0,compensationBalance:option.compensationBalance??0,
        candidateScore:option.candidateScore??0,effortPoints:option.effortPoints??0,
        streakPenalty:option.streakPenalty??0,sameDayPenalty:option.sameDayPenalty??0,weeklyQuota:option.weeklyQuota??0,
        dailyTeachingCount:option.dailyTeachingCount??0,dailySubstitutionCount:option.dailySubstitutionCount??0,
        occupiedPeriods:option.occupiedPeriods??[],adjacent:option.proximityScore===1,
        createsThreeConsecutive:option.wouldCreateTriple===true,streakStatus:option.streakStatus||"متاح بسلاسة",
        loadLabel:option.loadLabel||"",reasons:option.reasons||[],
      })),
    });
    simulatedAssignments.push({
      substituteTeacherId:candidate.id,absentTeacherId:absent.id,weekday:query.weekday,
      period:lesson.period,assignmentDate:query.assignmentDate,versionId:query.versionId,
      assignmentType:"substitution",status:"assigned",
    });
  }
  return {assignments,unassigned,assignedCount:assignments.length,unassignedCount:unassigned.length};
}
