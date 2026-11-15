export interface ClassTimetableSourceCell {
  weekday: string; period: number; cell_status?: string; class_sections?: unknown;
  subject?: string | null; matched_teacher_name?: string | null; teacher_source_name?: string | null; source_group_note?: string | null;
}
export interface ClassTimetableSlot {
  weekday: string; period: number; subject: string; teacherName: string; status: string;
  coTeachingCount?: number; sourceGroupNote?: string;
}
export interface ClassTimetableSummary {
  className: string; expected: boolean; entries: ClassTimetableSlot[];
  vacancies: Array<{weekday:string;period:number}>;
  conflicts: Array<{weekday:string;period:number;assignments:ClassTimetableSlot[]}>;
  parallelGroups: Array<{weekday:string;period:number;assignments:ClassTimetableSlot[]}>;
  freePeriods: Array<{weekday:string;period:number}>;
  meetingPeriods: Array<{weekday:string;period:number}>;
  unclearPeriods: Array<{weekday:string;period:number}>;
  teachingCount: number; coveredCount: number; complete: boolean;
}
function key(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").replace(/\s+/g," ").trim();
}
function isPlaceholderClassName(value: string): boolean {
  const compact = value.normalize("NFKC").replace(/\s+/g, "");
  // Teacher-only free cells commonly use a dash instead of a class name.
  // These are not real class labels and must not create phantom class rows.
  return !compact || /^[-‐‑‒–—―−]+$/u.test(compact);
}
function classOrder(value: string): {grade:number;section:number} | null {
  const normalized=String(value||"").normalize("NFKC").replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).trim();
  const match=normalized.match(/^(\d+)\s*\/\s*(\d+)$/);
  if(!match)return null;
  const first=Number(match[1]),second=Number(match[2]);
  if(second>=9&&second<=12&&first>=1&&first<=12)return {grade:second,section:first};
  if(first>=9&&first<=12&&second>=1&&second<=12)return {grade:first,section:second};
  return {grade:second,section:first};
}
function compareClassNames(left:string,right:string):number {
  const a=classOrder(left),b=classOrder(right);
  if(a&&b)return a.grade-b.grade||a.section-b.section||left.localeCompare(right,"ar");
  if(a)return -1;
  if(b)return 1;
  return left.localeCompare(right,"ar");
}
function isOptionalGroup(slot:ClassTimetableSlot):boolean {
  return key(slot.sourceGroupNote||"").includes("مجموعه ماده اختياريه");
}
function slotIdentity(slot: ClassTimetableSlot): string {
  return key(slot.status)+"|"+key(slot.subject);
}
/**
 * Build a class-first weekly audit. expectedClassNames comes from the school's
 * canonical classes table, so classes with no imported lessons are still audited.
 * A shared lesson (same class, period, teaching status and subject) is one class
 * slot even when multiple teachers are assigned to it.
 */
export function aggregateClassTimetables(
  cells: ClassTimetableSourceCell[],
  weekdays: string[],
  periodCount: number,
  expectedClassNames: string[] = [],
): ClassTimetableSummary[] {
  if (!Array.isArray(weekdays) || weekdays.length !== 5 || ![7,8].includes(periodCount)) {
    throw new Error("Invalid timetable dimensions");
  }
  const expected = new Set(expectedClassNames.map(value=>String(value||"").trim()).filter(Boolean));
  const classMap = new Map<string, Map<string, ClassTimetableSlot[]>>();
  for (const name of expected) classMap.set(name,new Map());
  for (const cell of cells || []) {
    if (!weekdays.includes(cell.weekday) || !Number.isInteger(Number(cell.period)) ||
        Number(cell.period)<1 || Number(cell.period)>periodCount) continue;
    const sections = Array.isArray(cell.class_sections) ? cell.class_sections : [];
    for (const sectionValue of sections) {
      const className = String(sectionValue || "").trim();
      if (isPlaceholderClassName(className)) continue;
      if (!classMap.has(className)) classMap.set(className,new Map());
      const slots = classMap.get(className)!;
      const slotKey = cell.weekday + ":" + Number(cell.period);
      if (!slots.has(slotKey)) slots.set(slotKey,[]);
      slots.get(slotKey)!.push({
        weekday:cell.weekday, period:Number(cell.period), subject:String(cell.subject||""),
        teacherName:String(cell.matched_teacher_name||""),
        sourceGroupNote:String(cell.source_group_note||""),
        status:String(cell.cell_status||"unclear")==="teaching"&&!String(cell.subject||"").trim()?"unclear":String(cell.cell_status||"unclear"),
      });
    }
  }
  return Array.from(classMap.entries()).sort((a,b)=>compareClassNames(a[0],b[0])).map(([className,slots])=>{
    const entries:ClassTimetableSlot[]=[];
    const vacancies:Array<{weekday:string;period:number}>=[];
    const conflicts:Array<{weekday:string;period:number;assignments:ClassTimetableSlot[]}>= [];
    const parallelGroups:Array<{weekday:string;period:number;assignments:ClassTimetableSlot[]}>= [];
    const freePeriods:Array<{weekday:string;period:number}>=[];
    const meetingPeriods:Array<{weekday:string;period:number}>=[];
    const unclearPeriods:Array<{weekday:string;period:number}>=[];
    let teachingCount=0,coveredCount=0;
    for(const weekday of weekdays)for(let period=1;period<=periodCount;period++){
      const assignments=slots.get(weekday+":"+period)||[];
      const position={weekday,period};
      if(!assignments.length){vacancies.push(position);continue;}
      // Multiple teachers teaching the same subject to the same class at the
      // same time are co-teachers, not duplicate lessons or a timetable clash.
      const identities=new Set(assignments.map(slotIdentity));
      if(assignments.length>1 && identities.size>1){
        if(assignments.every(item=>item.status==="teaching"&&isOptionalGroup(item))){
          parallelGroups.push({...position,assignments});
          coveredCount++;
          teachingCount++;
          continue;
        }
        conflicts.push({...position,assignments});
        coveredCount++;
        continue;
      }
      const first=assignments[0];
      const teacherNames=Array.from(new Set(assignments.map(item=>item.teacherName).filter(Boolean)));
      const entry:ClassTimetableSlot={
        ...first,
        teacherName:teacherNames.join("، "),
        ...(teacherNames.length>1?{coTeachingCount:teacherNames.length}:{})
      };
      entries.push(entry);
      coveredCount++;
      if(first.status!=="free"&&first.status!=="meeting"&&first.status!=="unclear")teachingCount++;
      else if(first.status==="free")freePeriods.push(position);
      else if(first.status==="meeting")meetingPeriods.push(position);
      else if(first.status==="unclear")unclearPeriods.push(position);
    }
    return {
      className,expected:expected.has(className),entries,vacancies,conflicts,parallelGroups,freePeriods,meetingPeriods,unclearPeriods,
      teachingCount,coveredCount,
      complete:vacancies.length===0&&conflicts.length===0&&unclearPeriods.length===0,
    };
  });
}
