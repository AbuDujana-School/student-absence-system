/** Lossless parser for copy/pasted day-by-day timetable extraction. Every teacher must have seven explicit cells. */
export const SCHOOL_WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"] as const;
export type SchoolWeekday = typeof SCHOOL_WEEKDAYS[number];
export type TimetableCellStatus = "teaching" | "free" | "meeting" | "activity" | "other" | "unclear";
export interface ParsedTimetableCell {
  period: number; classSections: string[]; subject: string; status: TimetableCellStatus;
  sourceClass: string; sourceSubject: string; sourceStatus: string;
}
export interface ParsedTimetableTeacher { sourceName: string; pdfPage: number | null; cells: ParsedTimetableCell[]; }
export interface ParsedTimetableDay {
  weekday: SchoolWeekday; teachers: ParsedTimetableTeacher[];
  totals: Record<TimetableCellStatus, number>; totalCells: number; warnings: string[];
}
const PERIOD_WORDS: Record<string, number> = {
  "الاولى":1,"الأولى":1,"الاول":1,"الأول":1,"الثانية":2,"الثانيه":2,
  "الثالثة":3,"الثالثه":3,"الرابعة":4,"الرابعه":4,"الخامسة":5,"الخامسه":5,
  "السادسة":6,"السادسه":6,"السابعة":7,"السابعه":7
};
function cleanLine(value: string): string {
  return value.replace(/\u00a0/g," ").replace(/[\u200e\u200f\u202a-\u202e]/g,"").trim();
}
function normalizedKey(value: string): string {
  return value.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").replace(/\s+/g," ").trim();
}
function statusFromSource(value: string): TimetableCellStatus {
  const key=normalizedKey(value);
  if (["تدريس","درس","حصة تدريس"].includes(key)) return "teaching";
  if (["فراغ","فارغ","فارغه","حصة فراغ"].includes(key)) return "free";
  if (["اجتماع","اجتماع قسم","اجتماع اداري","اجتماع الماده","اجتماع القسم","اجتماع المواد"].includes(key)) return "meeting";
  if (["نشاط","نشاط مدرسي","مناوبة"].includes(key)) return "activity";
  if (["غير واضح","غير واضحه","غير مقروء","غير مقروءه"].includes(key)) return "unclear";
  return "other";
}
function subjectFromSource(value: string): string {
  const key=normalizedKey(value);
  if (["التربيه الاسلاميه","تربيه اسلاميه","حصه دينيه","دينيه"].includes(key)) return "التربية الإسلامية";
  if (["اللغه العربيه","عربي"].includes(key)) return "اللغة العربية";
  if (["اللغه الانجليزيه","انجليزي","انجليزيه"].includes(key)) return "اللغة الإنجليزية";
  return value.trim();
}
function parsePeriod(value: string): number | null {
  const text=normalizedKey(value).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  if (/^[1-7]$/.test(text)) return Number(text);
  const normalizedWords = new Map(Object.entries(PERIOD_WORDS).map(([word, number]) => [normalizedKey(word), number]));
  return normalizedWords.get(text) ?? null;
}
function parseClassSections(value: string): string[] {
  const text=value.trim();
  if (!text || ["فراغ","فارغ","غير واضح","-"].includes(normalizedKey(text))) return [];
  return Array.from(new Set(text.split(/[،,؛;\n]+/).map(v=>v.trim()).filter(Boolean)));
}
/** Parse teacher-by-teacher text with explicit class, subject and status fields. */
export function parseTimetableDay(weekday: string, sourceText: string): ParsedTimetableDay {
  const day=SCHOOL_WEEKDAYS.find(v=>normalizedKey(v)===normalizedKey(weekday));
  if (!day) throw new Error("يجب تحديد يوم دراسي صحيح من الأحد إلى الخميس.");
  if (typeof sourceText!=="string" || !sourceText.trim()) throw new Error("لم يتم إدخال نص الجدول.");
  if (sourceText.length>500000) throw new Error("نص الجدول أكبر من الحد المسموح.");
  const teachers:ParsedTimetableTeacher[]=[];
  const seenNames=new Set<string>();
  const totals:Record<TimetableCellStatus,number>={teaching:0,free:0,meeting:0,activity:0,other:0,unclear:0};
  const warnings:string[]=[];
  let teacher:ParsedTimetableTeacher|null=null;
  let cell:Partial<ParsedTimetableCell>|null=null;
  let cellStartLine=0;
  const finishCell=()=>{
    if (!cell) return;
    const missing:string[]=[];
    if (cell.period===undefined) missing.push("رقم الحصة");
    if (cell.sourceClass===undefined) missing.push("الصف والشعبة");
    if (cell.sourceSubject===undefined) missing.push("المادة");
    if (cell.sourceStatus===undefined) missing.push("الحالة");
    if (missing.length) throw new Error("بيانات الحصة قرب السطر "+cellStartLine+" غير مكتملة: "+missing.join("، "));
    if (!teacher) throw new Error("تعذر ربط الحصة بمعلم قرب السطر "+cellStartLine+".");
    const sourceClass=cell.sourceClass!,sourceSubject=cell.sourceSubject!,sourceStatus=cell.sourceStatus!;
    const status=statusFromSource(sourceStatus);
    teacher.cells.push({period:cell.period!,classSections:parseClassSections(sourceClass),subject:subjectFromSource(sourceSubject),status,sourceClass,sourceSubject,sourceStatus});
    totals[status]+=1; cell=null;
  };
  const finishTeacher=()=>{
    finishCell();
    if (!teacher) return;
    const periods=teacher.cells.map(v=>v.period).sort((a,b)=>a-b);
    if (periods.length!==7 || periods.some((v,i)=>v!==i+1))
      throw new Error("المعلم «"+teacher.sourceName+"» (صفحة "+teacher.pdfPage+") لا يحتوي على الحصص السبع كاملة. الموجود: "+(periods.join(", ")||"لا توجد حصص")+".");
    teacher.cells.sort((a,b)=>a.period-b.period);teachers.push(teacher);teacher=null;
  };
  const lines=sourceText.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=cleanLine(lines[i]);if(!line)continue;
    // Accept the daily export headings used in the school's five source messages.
    const dayHeading=line.match(/^(?:جدول\s+)?اليوم(?:\s+\S+)?\s*:\s*(.+)$/)
      || line.match(/^جدول\s+يوم\s+(.+)$/);
    if(dayHeading){
      const declaredDay=SCHOOL_WEEKDAYS.find(value=>normalizedKey(value)===normalizedKey(dayHeading[1]));
      if(!declaredDay)throw new Error("اسم اليوم في العنوان غير معروف عند السطر "+(i+1)+": "+dayHeading[1]);
      if(declaredDay!==day)throw new Error("النص يحتوي على جدول يوم "+declaredDay+" بينما اليوم المختار هو "+day+".");
      continue;
    }
    const namedTeacher=line.match(/^[-•]?\s*اسم\s*المعلم\s*:\s*(.+?)\s*$/);
    const numberedTeacher=line.match(/^\s*\d+[.)]\s*(.+?)(?:\s*\(\s*صفحة\s*PDF\s*:\s*(\d+)\s*\))?\s*$/i);
    const teacherHeader=namedTeacher||numberedTeacher;
    if(teacherHeader){
      finishTeacher();
      const name=cleanLine(namedTeacher?namedTeacher[1]:numberedTeacher![1]),key=normalizedKey(name);
      if(!name||seenNames.has(key))throw new Error("اسم المعلم فارغ أو مكرر عند السطر "+(i+1)+": "+name);
      seenNames.add(key);
      teacher={sourceName:name,pdfPage:numberedTeacher&&numberedTeacher[2]?Number(numberedTeacher[2]):null,cells:[]};
      continue;
    }
    const pageOnly=line.match(/^صفحة\s*PDF\s*:\s*(\d+)$/i);
    if(pageOnly&&teacher&&!teacher.cells.length&&!cell){teacher.pdfPage=Number(pageOnly[1]);continue;}
    const p=line.match(/^الحصة\s+(.+?)\s*:\s*$/);
    if(p){
      finishCell();
      if(!teacher)throw new Error("ظهرت حصة قبل اسم المعلم عند السطر "+(i+1)+".");
      const period=parsePeriod(p[1]);
      if(!period)throw new Error("رقم الحصة غير معروف عند السطر "+(i+1)+": "+p[1]);
      if(teacher.cells.some(v=>v.period===period))throw new Error("الحصة "+period+" مكررة للمعلم «"+teacher.sourceName+"».");
      cellStartLine=i+1;cell={period};continue;
    }
    const f=line.match(/^[-•]?\s*(الصف\s*والشعبة|الصف|الشعبة|المادة|الحالة)\s*:\s*(.*)$/);
    if(f){
      if(!cell||!teacher)throw new Error("وجدت خانة بيانات دون عنوان حصة عند السطر "+(i+1)+".");
      const key=normalizedKey(f[1]),value=cleanLine(f[2]);
      if(key.startsWith("الصف")||key==="الشعبه")cell.sourceClass=value;
      else if(key==="الماده")cell.sourceSubject=value;
      else if(key==="الحاله")cell.sourceStatus=value;
    }
  }
  finishTeacher();
  if(!teachers.length)throw new Error("لم أتعرف على أسماء المعلمين. استخدم «اسم المعلم: الاسم» أو «1. الاسم»، ثم أدرج الحصص السبع.");
  const totalCells=teachers.reduce((sum,v)=>sum+v.cells.length,0);
  if(totalCells!==teachers.length*7)throw new Error("عدد خانات الجدول لا يساوي سبع حصص لكل معلم.");
  return {weekday:day,teachers,totals,totalCells,warnings};
}
