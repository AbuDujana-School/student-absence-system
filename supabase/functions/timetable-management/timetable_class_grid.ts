export interface ClassTimetableSourceCell {
  weekday: string; period: number; cell_status?: string; class_sections?: unknown;
  subject?: string | null; matched_teacher_name?: string | null; teacher_source_name?: string | null;
}
export interface ClassTimetableSlot { weekday: string; period: number; subject: string; teacherName: string; status: string; }
export interface ClassTimetableSummary {
  className: string; entries: ClassTimetableSlot[];
  vacancies: Array<{weekday:string;period:number}>;
  conflicts: Array<{weekday:string;period:number;assignments:ClassTimetableSlot[]}>;
  complete: boolean;
}
export function aggregateClassTimetables(cells: ClassTimetableSourceCell[], weekdays: string[], periodCount: number): ClassTimetableSummary[] {
  if (!Array.isArray(weekdays) || weekdays.length !== 5 || ![7,8].includes(periodCount)) throw new Error("Invalid timetable dimensions");
  const classMap = new Map<string, Map<string, ClassTimetableSlot[]>>();
  for (const cell of cells || []) {
    if (!weekdays.includes(cell.weekday) || !Number.isInteger(Number(cell.period)) || Number(cell.period)<1 || Number(cell.period)>periodCount) continue;
    const sections = Array.isArray(cell.class_sections) ? cell.class_sections : [];
    for (const sectionValue of sections) {
      const className = String(sectionValue || "").trim(); if (!className) continue;
      if (!classMap.has(className)) classMap.set(className, new Map());
      const slotKey = cell.weekday + ":" + Number(cell.period), slots = classMap.get(className)!;
      if (!slots.has(slotKey)) slots.set(slotKey, []);
      slots.get(slotKey)!.push({weekday:cell.weekday,period:Number(cell.period),subject:String(cell.subject||""),teacherName:String(cell.matched_teacher_name||cell.teacher_source_name||""),status:String(cell.cell_status||"unclear")});
    }
  }
  return Array.from(classMap.entries()).sort((a,b)=>a[0].localeCompare(b[0],"ar")).map(([className,slots])=>{
    const entries:ClassTimetableSlot[]=[], vacancies:Array<{weekday:string;period:number}>=[], conflicts:Array<{weekday:string;period:number;assignments:ClassTimetableSlot[]}>= [];
    for(const weekday of weekdays)for(let period=1;period<=periodCount;period++){
      const assignments=slots.get(weekday+":"+period)||[];
      if(!assignments.length)vacancies.push({weekday,period});
      else if(assignments.length>1)conflicts.push({weekday,period,assignments});
      else entries.push(assignments[0]);
    }
    return {className,entries,vacancies,conflicts,complete:vacancies.length===0&&conflicts.length===0};
  });
}
