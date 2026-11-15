/** Availability rules for a complete, explicit weekly timetable grid. */
export interface SubstitutionTeacher {
  id:string; name:string; departmentId:string; dutyDay?:string; weeklyQuota?:number;
  pointsBalance?:number; dailyTeachingCount?:number; dailySubstitutionCount?:number;
  substitutionsCount?:number; workloadScore?:number; historicalWorkloadScore?:number;
  proximityScore?:number; wouldCreateTriple?:boolean; occupiedPeriods?:number[];
}
export type TimetableCellStatus="teaching"|"free"|"meeting"|"activity"|"other"|"unclear";
export interface TimetableEntry { teacherId:string; weekday:string; period:number; className:string; subject?:string; status?:TimetableCellStatus; }
export interface SubstitutionAssignment {
  substituteTeacherId:string; absentTeacherId?:string; weekday:string; period:number;
  assignmentDate?:string|null; versionId?:string; assignmentType?:string;
  status?:"assigned"|"confirmed"|"cancelled"|"completed";
}
export interface SubstitutionLesson { weekday:string; period:number; className:string; subject?:string; }
export interface CandidateQuery {
  teachers:SubstitutionTeacher[]; timetable:TimetableEntry[]; assignments:SubstitutionAssignment[];
  absentTeacherId:string; weekday:string; period:number; departmentId:string; includeOtherDepartments?:boolean;
  assignmentDate?:string; versionId?:string; excludedTeacherIds?:string[]; maxDailySubstitutions?:number;
}
function sameCell(a:{weekday:string;period:number},b:{weekday:string;period:number}):boolean {
  return a.weekday===b.weekday && a.period===b.period;
}

/** School-approved points for a single substitute lesson (periods 1–8). */
export function getSubstitutionPeriodPoints(period:number):number {
  return ({1:1,2:1,3:2,4:2,5:4,6:3,7:5,8:7} as Record<number,number>)[period] ?? 0;
}

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

function hasThreeConsecutive(periods:Set<number>, target:number):boolean {
  const occupied=new Set(periods); occupied.add(target);
  for(let start=Math.max(1,target-2);start<=target;start++){
    if(occupied.has(start)&&occupied.has(start+1)&&occupied.has(start+2)) return true;
  }
  return false;
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
/** Missing, duplicated, meeting, activity, other and unclear cells are never treated as free. */
export function getAvailableSubstitutionCandidates(query:CandidateQuery):SubstitutionTeacher[] {
  const {teachers,timetable,assignments,absentTeacherId,weekday,period,departmentId,includeOtherDepartments=false,assignmentDate,versionId,excludedTeacherIds=[],maxDailySubstitutions=2}=query;
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
  const sameDayAssignments=(teacherId:string)=>activeAssignments.filter(a=>
    a.substituteTeacherId===teacherId &&
    (a.assignmentType==="substitution"||!a.assignmentType) &&
    assignmentBelongsToDate(a,weekday,assignmentDate,versionId)
  );
  const historicalScore=(history:SubstitutionAssignment[]):number=>
    calculateSubstitutionWorkloadScore(history,assignmentDate,period);
  const hasPointBalances=teachers.some(t=>typeof t.pointsBalance==="number");
  return teachers.filter(t=>t.id!==absentTeacherId&&!excludedTeacherIds.includes(t.id))
    .filter(t=>!t.dutyDay||t.dutyDay!==weekday)
    .filter(t=>includeOtherDepartments||!!departmentId&&t.departmentId===departmentId)
    .filter(t=>{const cell=cells.get(t.id);return !!cell&&cell.count===1&&cell.isFree;})
    .filter(t=>!assigned.has(t.id)).map(t=>{
      const history=historyFor(t.id);
      const today=sameDayAssignments(t.id);
      const dailyTeachingPeriods=new Set(timetable.filter(e=>e.teacherId===t.id&&e.weekday===weekday&&(e.status??"teaching")==="teaching").map(e=>e.period));
      const teachingPeriods=new Set(dailyTeachingPeriods);
      for(const a of today) teachingPeriods.add(a.period);
      const dailyTeachingCount=dailyTeachingPeriods.size;
      const adjacent=teachingPeriods.has(period-1)||teachingPeriods.has(period+1);
      const triple=hasThreeConsecutive(teachingPeriods,period);
      const substitutionsCount=history.length;
      const dailySubstitutionCount=today.length;
      const weeklyQuota=Math.max(0,Number(t.weeklyQuota)||0);
      return {
        ...t,dailyTeachingCount,dailySubstitutionCount,substitutionsCount,
        occupiedPeriods:[...teachingPeriods].sort((a,b)=>a-b),
        proximityScore:adjacent?1:0,wouldCreateTriple:triple,
        workloadScore:weeklyQuota+substitutionsCount*2,
        historicalWorkloadScore:historicalScore(history),
      };
    })
    .filter(t=>(t.dailySubstitutionCount??0)<maxDailySubstitutions)
    .sort((a,b)=>{
      if(hasPointBalances){
        const points=(a.pointsBalance??0)-(b.pointsBalance??0);
        if(points!==0) return points;
        const dailySubs=(a.dailySubstitutionCount??0)-(b.dailySubstitutionCount??0);
        if(dailySubs!==0) return dailySubs;
        const weeklyLoad=(a.weeklyQuota??0)-(b.weeklyQuota??0);
        if(weeklyLoad!==0) return weeklyLoad;
        const dailyLoad=(a.dailyTeachingCount??0)-(b.dailyTeachingCount??0);
        if(dailyLoad!==0) return dailyLoad;
        const triple=Number(a.wouldCreateTriple)-Number(b.wouldCreateTriple);
        if(triple!==0) return triple;
        const proximity=(b.proximityScore??0)-(a.proximityScore??0);
        if(proximity!==0) return proximity;
      }
      return (a.workloadScore??0)-(b.workloadScore??0)||
        (a.historicalWorkloadScore??0)-(b.historicalWorkloadScore??0)||
        a.name.localeCompare(b.name,"ar");
    });
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
  includeOtherDepartments?:boolean;
}
export interface BatchSubstitutionPlan {
  assignments:Array<{
    absentTeacherName:string; substituteTeacherName:string; weekday:string; period:number;
    className:string; subject?:string; points:number; pointsBalanceAfter:number; absentPointsBalanceAfter:number;
    substituteDailyTeachingCount:number; createsThreeConsecutive:boolean;
    candidateOptions:Array<{teacherName:string;pointsBalance:number;weeklyQuota:number;dailyTeachingCount:number;dailySubstitutionCount:number;occupiedPeriods:number[];adjacent:boolean;createsThreeConsecutive:boolean}>;
  }>;
  unassigned:Array<{absentTeacherName:string;weekday:string;period:number;className:string;subject?:string;blockReason:"daily_limit"|"period_capacity"|"no_available_teacher";blockedCandidateCount:number}>;
  assignedCount:number; unassignedCount:number;
}

/** Whole-morning allocator: one lesson per substitute first, two only if needed. */

interface FlowEdge { to:number; rev:number; cap:number; cost:number; }
function addFlowEdge(graph:FlowEdge[][],from:number,to:number,cap:number,cost:number):FlowEdge {
  const forward:FlowEdge={to,rev:graph[to].length,cap,cost};
  const reverse:FlowEdge={to:from,rev:graph[from].length,cap:0,cost:-cost};
  graph[from].push(forward); graph[to].push(reverse);
  return forward;
}
function heapPush(heap:Array<[number,number]>,item:[number,number]):void {
  heap.push(item);
  let index=heap.length-1;
  while(index>0){
    const parent=Math.floor((index-1)/2);
    if(heap[parent][0]<=heap[index][0])break;
    [heap[parent],heap[index]]=[heap[index],heap[parent]];
    index=parent;
  }
}
function heapPop(heap:Array<[number,number]>):[number,number]|undefined {
  if(!heap.length)return undefined;
  const first=heap[0],last=heap.pop()!;
  if(heap.length){
    heap[0]=last;
    let index=0;
    while(true){
      const left=index*2+1,right=left+1;
      let smallest=index;
      if(left<heap.length&&heap[left][0]<heap[smallest][0])smallest=left;
      if(right<heap.length&&heap[right][0]<heap[smallest][0])smallest=right;
      if(smallest===index)break;
      [heap[index],heap[smallest]]=[heap[smallest],heap[index]];
      index=smallest;
    }
  }
  return first;
}
function minCostFlow(graph:FlowEdge[][],source:number,sink:number,wanted:number):number {
  const n=graph.length, potential=new Array<number>(n).fill(0);
  let flow=0;
  while(flow<wanted){
    const dist=new Array<number>(n).fill(Number.POSITIVE_INFINITY);
    const prevNode=new Array<number>(n).fill(-1), prevEdge=new Array<number>(n).fill(-1);
    const used=new Array<boolean>(n).fill(false);
    dist[source]=0;
    const heap:Array<[number,number]>=[[0,source]];
    while(heap.length){
      const nextItem=heapPop(heap)!;
      const [current,node]=nextItem;
      if(used[node]||current!==dist[node])continue;
      used[node]=true;
      if(node===sink)break;
      for(let i=0;i<graph[node].length;i++){
        const edge=graph[node][i];
        if(edge.cap<=0)continue;
        const next=edge.to, nextDist=current+edge.cost+potential[node]-potential[next];
        if(nextDist<dist[next]){
          dist[next]=nextDist;prevNode[next]=node;prevEdge[next]=i;
          heapPush(heap,[nextDist,next]);
        }
      }
    }
    if(!Number.isFinite(dist[sink]))break;
    for(let i=0;i<n;i++)if(Number.isFinite(dist[i]))potential[i]+=dist[i];
    let add=wanted-flow;
    for(let node=sink;node!==source;node=prevNode[node]){
      if(prevNode[node]<0){add=0;break;}
      add=Math.min(add,graph[prevNode[node]][prevEdge[node]].cap);
    }
    if(add<=0)break;
    for(let node=sink;node!==source;node=prevNode[node]){
      const edge=graph[prevNode[node]][prevEdge[node]];
      edge.cap-=add;graph[node][edge.rev].cap+=add;
    }
    flow+=add;
  }
  return flow;
}

/** Global daily allocator: optimize all absent-teacher lessons together. */
export function buildBatchSubstitutionPlan(query:BatchSubstitutionPlanQuery):BatchSubstitutionPlan {
  const absentById=new Map(query.absentTeachers.map(t=>[t.id,t]));
  const excludedTeacherIds=Array.from(absentById.keys());
  const allLessons=query.absentTeachers.flatMap(absent=>
    getAbsentTeacherLessons(query.timetable,absent.id,query.weekday).map(lesson=>({absent,lesson}))
  ).sort((a,b)=>a.lesson.period-b.lesson.period||a.absent.name.localeCompare(b.absent.name,"ar"));
  const alreadyAssigned=(item:{absent:BatchAbsentTeacher;lesson:SubstitutionLesson})=>
    query.assignments.some(a=>a.absentTeacherId===item.absent.id&&a.weekday===query.weekday&&a.period===item.lesson.period&&
      a.status!=="cancelled"&&assignmentBelongsToDate(a,query.weekday,query.assignmentDate,query.versionId));
  const pending=allLessons.filter(item=>!alreadyAssigned(item));
  const candidateLists=pending.map(item=>getAvailableSubstitutionCandidates({
    teachers:query.teachers,timetable:query.timetable,assignments:query.assignments,
    absentTeacherId:item.absent.id,weekday:query.weekday,period:item.lesson.period,
    departmentId:query.includeOtherDepartments?"":item.absent.departmentId,
    includeOtherDepartments:query.includeOtherDepartments===true,
    assignmentDate:query.assignmentDate,versionId:query.versionId,
    excludedTeacherIds,maxDailySubstitutions:2,
  }));
  const solve=(dailyLimit:number)=>{
    const resourceKeys=new Set<string>();
    for(let i=0;i<pending.length;i++)for(const c of candidateLists[i]){
      if((c.dailySubstitutionCount??0)<dailyLimit)resourceKeys.add(c.id+"\u0000"+pending[i].lesson.period);
    }
    const resourceList=Array.from(resourceKeys);
    const resourceIndex=new Map(resourceList.map((key,i)=>[key,i]));
    const teacherIds=Array.from(new Set(candidateLists.flatMap(list=>list
      .filter(c=>(c.dailySubstitutionCount??0)<dailyLimit).map(c=>c.id))));
    const teacherIndex=new Map(teacherIds.map((id,i)=>[id,i]));
    const source=0, lessonBase=1, resourceBase=lessonBase+pending.length;
    const teacherBase=resourceBase+resourceList.length, sink=teacherBase+teacherIds.length;
    const graph:FlowEdge[][]=Array.from({length:sink+1},()=>[]);
    const choiceEdges:Array<Array<{candidate:SubstitutionTeacher;edge:FlowEdge}>>=pending.map(()=>[]);
    pending.forEach((item,i)=>{
      addFlowEdge(graph,source,lessonBase+i,1,0);
      candidateLists[i].forEach((candidate,rank)=>{
        if((candidate.dailySubstitutionCount??0)>=dailyLimit)return;
        const key=candidate.id+"\u0000"+item.lesson.period;
        const ri=resourceIndex.get(key),ti=teacherIndex.get(candidate.id);
        if(ri===undefined||ti===undefined)return;
        const cost=rank*100000+Math.max(0,Number(candidate.pointsBalance)||0)*100+
          Math.max(0,Number(candidate.dailyTeachingCount)||0)*10+
          (candidate.wouldCreateTriple?500:0)+(candidate.proximityScore?20:0);
        const edge=addFlowEdge(graph,lessonBase+i,resourceBase+ri,1,cost);
        choiceEdges[i].push({candidate,edge});
      });
    });
    resourceList.forEach((key,i)=>{
      const teacherId=key.split("\u0000")[0],ti=teacherIndex.get(teacherId)!;
      addFlowEdge(graph,resourceBase+i,teacherBase+ti,1,0);
    });
    teacherIds.forEach((id,i)=>{
      const used=Number(candidateLists.flat().find(c=>c.id===id)?.dailySubstitutionCount)||0;
      const remaining=Math.max(0,dailyLimit-used);
      // Prefer giving a first cover to another eligible teacher before assigning
      // a second daily cover to the same person. The second slot remains available
      // when it is needed to achieve full coverage.
      if(remaining>0)addFlowEdge(graph,teacherBase+i,sink,1,used>0?1000000:0);
      if(remaining>1)addFlowEdge(graph,teacherBase+i,sink,1,1000000);
    });
    const flow=minCostFlow(graph,source,sink,pending.length);
    const selected=new Map<number,SubstitutionTeacher>();
    choiceEdges.forEach((items,i)=>{
      const chosen=items.find(item=>item.edge.cap===0);
      if(chosen)selected.set(i,chosen.candidate);
    });
    return {flow,selected};
  };
  let solved=solve(1);
  if(solved.flow<pending.length)solved=solve(2);

  // Re-check consecutive-period impact against the complete proposed day, not
  // only against the timetable as it existed before the batch was generated.
  const plannedPeriodsByTeacher=new Map<string,Set<number>>();
  const plannedCountsByTeacher=new Map<string,number>();
  const finalTripleByIndex=new Map<number,boolean>();
  pending.forEach((item,i)=>{
    let candidate=solved.selected.get(i);
    if(!candidate)return;
    const plannedPeriods=plannedPeriodsByTeacher.get(candidate.id)??new Set<number>();
    const basePeriods=new Set<number>(candidate.occupiedPeriods??[]);
    const combined=new Set<number>([...basePeriods,...plannedPeriods]);
    const createsTriple=hasThreeConsecutive(combined,item.lesson.period);
    if(createsTriple){
      const alternatives=candidateLists[i].filter(option=>{
        if(option.id===candidate!.id)return false;
        const alreadyPlanned=plannedPeriodsByTeacher.get(option.id)??new Set<number>();
        const alreadyCount=plannedCountsByTeacher.get(option.id)??0;
        if(Number(option.dailySubstitutionCount??0)+alreadyCount>=2)return false;
        if(alreadyPlanned.has(item.lesson.period))return false;
        const occupied=new Set<number>([...(option.occupiedPeriods??[]),...alreadyPlanned]);
        return !hasThreeConsecutive(occupied,item.lesson.period);
      });
      if(alternatives.length)candidate=alternatives[0];
      solved.selected.set(i,candidate);
    }
    const finalPeriods=plannedPeriodsByTeacher.get(candidate.id)??new Set<number>();
    const finalOccupied=new Set<number>([...(candidate.occupiedPeriods??[]),...finalPeriods]);
    finalTripleByIndex.set(i,hasThreeConsecutive(finalOccupied,item.lesson.period));
    finalPeriods.add(item.lesson.period);
    plannedPeriodsByTeacher.set(candidate.id,finalPeriods);
    plannedCountsByTeacher.set(candidate.id,(plannedCountsByTeacher.get(candidate.id)??0)+1);
  });

  const mutableTeachers=query.teachers.map(t=>({...t,pointsBalance:Number(t.pointsBalance)||0}));
  const assignments:BatchSubstitutionPlan["assignments"]=[];
  const unassigned:BatchSubstitutionPlan["unassigned"]=[];
  pending.forEach((item,i)=>{
    const candidate=solved.selected.get(i);
    if(!candidate){
      const otherwiseEligible=getAvailableSubstitutionCandidates({
        teachers:query.teachers,timetable:query.timetable,assignments:query.assignments,
        absentTeacherId:item.absent.id,weekday:query.weekday,period:item.lesson.period,
        departmentId:query.includeOtherDepartments?"":item.absent.departmentId,
        includeOtherDepartments:query.includeOtherDepartments===true,
        assignmentDate:query.assignmentDate,versionId:query.versionId,
        excludedTeacherIds,maxDailySubstitutions:100,
      });
      const blockedCandidateCount=otherwiseEligible.filter(option=>Number(option.dailySubstitutionCount??0)>=2).length;
      unassigned.push({absentTeacherName:item.absent.name,weekday:item.lesson.weekday,period:item.lesson.period,
        className:item.lesson.className,blockReason:candidateLists[i].length?"period_capacity":blockedCandidateCount?"daily_limit":"no_available_teacher",
        blockedCandidateCount,...(item.lesson.subject?{subject:item.lesson.subject}:{})});
      return;
    }
    const points=getSubstitutionPeriodPoints(item.lesson.period);
    const teacher=mutableTeachers.find(t=>t.id===candidate.id);
    if(teacher)teacher.pointsBalance=(teacher.pointsBalance??0)+points;
    const absentTeacher=mutableTeachers.find(t=>t.id===item.absent.id);
    if(absentTeacher)absentTeacher.pointsBalance=(absentTeacher.pointsBalance??0)-points;
    assignments.push({
      absentTeacherName:item.absent.name,substituteTeacherName:candidate.name,weekday:item.lesson.weekday,
      period:item.lesson.period,className:item.lesson.className,...(item.lesson.subject?{subject:item.lesson.subject}:{}),
      points,pointsBalanceAfter:teacher?.pointsBalance??candidate.pointsBalance??0,
      absentPointsBalanceAfter:absentTeacher?.pointsBalance??0,
      substituteDailyTeachingCount:candidate.dailyTeachingCount??0,
      createsThreeConsecutive:finalTripleByIndex.get(i)??(candidate.wouldCreateTriple===true),
      candidateOptions:candidateLists[i].map(option=>({
        teacherName:option.name,pointsBalance:option.pointsBalance??0,weeklyQuota:option.weeklyQuota??0,
        dailyTeachingCount:option.dailyTeachingCount??0,dailySubstitutionCount:option.dailySubstitutionCount??0,
        occupiedPeriods:option.occupiedPeriods??[],adjacent:option.proximityScore===1,
        createsThreeConsecutive:option.wouldCreateTriple===true,
      })),
    });
  });
  return {assignments,unassigned,assignedCount:assignments.length,unassignedCount:unassigned.length};
}
