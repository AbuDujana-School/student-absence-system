/** Lossless parser for daily timetable text. Supports both labelled teacher blocks and the school's tab-separated row export. */
export const SCHOOL_WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"] as const;
export type SchoolWeekday = typeof SCHOOL_WEEKDAYS[number];
export type TimetableCellStatus = "teaching" | "free" | "meeting" | "activity" | "other" | "unclear";
export interface ParsedTimetableCell {
  period: number; classSections: string[]; subject: string; status: TimetableCellStatus;
  sourceClass: string; sourceSubject: string; sourceStatus: string; sourceNote?: string;
}
export interface ParsedTimetableTeacher { sourceName: string; pdfPage: number | null; cells: ParsedTimetableCell[]; }
export interface ParsedTimetableDay {
  weekday: SchoolWeekday; teachers: ParsedTimetableTeacher[];
  totals: Record<TimetableCellStatus, number>; totalCells: number; warnings: string[];
}
const PERIOD_WORDS: Record<string, number> = {
  "الاولى":1,"الأولى":1,"الاول":1,"الأول":1,"الثانية":2,"الثانيه":2,
  "الثالثة":3,"الثالثه":3,"الرابعة":4,"الرابعه":4,"الخامسة":5,"الخامسه":5,
  "السادسة":6,"السادسه":6,"السابعة":7,"السابعه":7,"الثامنة":8,"الثامنه":8,"الثامن":8
};
function cleanLine(value: string): string {
  return value.replace(/\u00a0/g," ").replace(/[\u200e\u200f\u202a-\u202e]/g,"").trim();
}
function normalizedKey(value: string): string {
  return value.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").replace(/\s+/g," ").trim();
}
function weekdayFromSource(value: string): SchoolWeekday | null {
  return SCHOOL_WEEKDAYS.find((day)=>normalizedKey(day)===normalizedKey(value)) ?? null;
}
function statusFromSource(value: string): TimetableCellStatus {
  const key=normalizedKey(value);
  if (["تدريس","درس","حصة تدريس"].includes(key)) return "teaching";
  if (key.includes("فراغ") || key.includes("فارغ")) return "free";
  if (key.includes("اجتماع")) return "meeting";
  if (["نشاط","نشاط مدرسي","مناوبة"].includes(key)) return "activity";
  if (["اخرى","حاله اخرى","ارتباط"].includes(key)) return "other";
  if (["غير واضح","غير واضحه","غير مقروء","غير مقروءه"].includes(key)) return "unclear";
  // Unknown source labels are not safely classifiable; preserve their raw value
  // and keep them out of free-period substitution eligibility.
  return "unclear";
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
  if (/^[1-8]$/.test(text)) return Number(text);
  const normalizedWords = new Map(Object.entries(PERIOD_WORDS).map(([word, number]) => [normalizedKey(word), number]));
  return normalizedWords.get(text) ?? null;
}
function parseClassSections(value: string): string[] {
  const text=value.trim();
  if (!text || ["فراغ","فارغ","غير واضح","-"].includes(normalizedKey(text))) return [];
  const sections = text.split(/[،,؛;\n]+/).map(v=>v.trim()).filter(Boolean).flatMap((part) => {
    // Some source rows concatenate two class codes without punctuation, e.g. 6/11/7/11.
    // Interpret an even sequence of 4+ numeric slash-separated tokens as adjacent pairs.
    // Preserve ordinary two-part codes (e.g. 6/11) and any non-numeric/ambiguous source verbatim.
    const tokens = part.split("/").map(token => token.trim());
    if (tokens.length >= 4 && tokens.length % 2 === 0 && tokens.every(token => /^\d+$/.test(token))) {
      const pairs: string[] = [];
      for (let index = 0; index < tokens.length; index += 2) pairs.push(tokens[index] + "/" + tokens[index + 1]);
      return pairs;
    }
    return [part];
  });
  return Array.from(new Set(sections));
}
function emptyTotals(): Record<TimetableCellStatus,number> {
  return {teaching:0,free:0,meeting:0,activity:0,other:0,unclear:0};
}
function fillMissingPeriods(teacher: ParsedTimetableTeacher, periodCount: number, warnings: string[]): void {
  const periods = new Set<number>();
  for (const cell of teacher.cells) {
    if (!Number.isInteger(cell.period) || cell.period < 1 || cell.period > periodCount) {
      throw new Error("رقم حصة خارج النطاق للمعلم «"+teacher.sourceName+"»: "+cell.period+".");
    }
    if (periods.has(cell.period)) throw new Error("الحصة "+cell.period+" مكررة للمعلم «"+teacher.sourceName+"».");
    periods.add(cell.period);
  }
  const missing: number[] = [];
  for (let period=1; period<=periodCount; period++) if (!periods.has(period)) {
    missing.push(period);
    teacher.cells.push({
      period, classSections:[], subject:"", status:"unclear",
      sourceClass:"", sourceSubject:"", sourceStatus:"غير مستخرج",
      sourceNote:"لم يتم استخراج بيانات هذه الحصة من المصدر؛ يلزم مراجعتها يدوياً.",
    });
  }
  teacher.cells.sort((a,b)=>a.period-b.period);
  if (missing.length) warnings.push("المعلم «"+teacher.sourceName+"»: لم تُستخرج بيانات الحصص "+missing.join("، ")+"؛ أُضيفت كخانات غير واضحة للحفظ والمراجعة.");
}
function parseTabularTimetableDay(day: SchoolWeekday, sourceText: string): ParsedTimetableDay | null {
  const teachers: ParsedTimetableTeacher[]=[];
  const byName=new Map<string,ParsedTimetableTeacher>();
  const warnings:string[]=[];
  let recognizedRows=0;
  const lines=sourceText.split(/\r?\n/);
  for(let index=0;index<lines.length;index++){
    const raw=cleanLine(lines[index]);
    if(!raw.includes("\t")) continue;
    const fields=raw.split("\t").map(cleanLine);
    if(fields.length<6) continue;
    const rowDay=weekdayFromSource(fields[1]||"");
    if(!rowDay) continue;
    recognizedRows++;
    if(rowDay!==day){warnings.push("السطر "+(index+1)+" يخص يوم "+rowDay+" وليس اليوم المحدد "+day+"؛ تم تجاوزه.");continue;}
    const sourceName=fields[0];
    const period=parsePeriod(fields[2]||"");
    if(!sourceName){warnings.push("السطر "+(index+1)+": اسم المعلم فارغ؛ تم تجاوز السطر.");continue;}
    if(!period){warnings.push("السطر "+(index+1)+": رقم الحصة غير معروف؛ تم تجاوز السطر.");continue;}
    if(fields[3]===undefined||fields[4]===undefined||fields[5]===undefined||!fields[3]||!fields[4]||!fields[5]){
      warnings.push("السطر "+(index+1)+": بيانات الصف أو المادة أو الحالة ناقصة؛ تم تجاوز السطر دون تخمين.");
      continue;
    }
    const key=normalizedKey(sourceName);
    let teacher=byName.get(key);
    if(!teacher){teacher={sourceName,pdfPage:null,cells:[]};byName.set(key,teacher);teachers.push(teacher);}
    const sourceClass=fields[3],sourceSubject=fields[4],sourceStatus=fields[5],sourceNote=fields.slice(6).filter(Boolean).join(" | ");
    const status=statusFromSource(sourceStatus);
    const existing=teacher.cells.find(cell=>cell.period===period);
    if(existing){
      if(existing.status!==status || normalizedKey(existing.sourceSubject)!==normalizedKey(sourceSubject) || normalizedKey(existing.sourceStatus)!==normalizedKey(sourceStatus)){
        warnings.push("المعلم «"+sourceName+"» لديه تكليفان متعارضان في الحصة "+period+" يوم "+day+"؛ تم الاحتفاظ بأول سجل.");
      } else {
        existing.classSections=Array.from(new Set([...existing.classSections,...parseClassSections(sourceClass)]));
        if(!existing.sourceClass.split(" | ").includes(sourceClass)) existing.sourceClass+=" | "+sourceClass;
        if(sourceNote && !existing.sourceNote?.split(" | ").includes(sourceNote)) existing.sourceNote=[existing.sourceNote,sourceNote].filter(Boolean).join(" | ");
      }
      continue;
    }
    teacher.cells.push({period,classSections:parseClassSections(sourceClass),subject:subjectFromSource(sourceSubject),status,sourceClass,sourceSubject,sourceStatus,...(sourceNote?{sourceNote}:{})});
  }
  if(!recognizedRows) return null;
  const periodCount=Math.max(7,...teachers.flatMap(teacher=>teacher.cells.map(cell=>cell.period)));
  for(const teacher of teachers)fillMissingPeriods(teacher,periodCount,warnings);
  const totals=emptyTotals();
  for(const teacher of teachers)for(const cell of teacher.cells)totals[cell.status]++;
  const totalCells=teachers.reduce((sum,teacher)=>sum+teacher.cells.length,0);
  return {weekday:day,teachers,totals,totalCells,warnings};
}
/** Parse a single day. Input may use one teacher section with seven labelled cells or one tab-separated row per teacher/period:
 * teacher name, weekday, period, class, subject, status, optional note.
 */

/** Enforce the school's reviewed teacher roster size at the import boundary. */
export function validateSchoolTeacherCount(day: ParsedTimetableDay, expectedCount: number): void {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error("عدد المعلمين المتوقع غير صالح.");
  }
  if (day.teachers.length !== expectedCount) {
    throw new Error("يجب أن يحتوي يوم " + day.weekday + " على " + expectedCount +
      " معلماً بالضبط؛ الموجود " + day.teachers.length + ". راجع التفريغ قبل الحفظ.");
  }
}

export function parseTimetableDay(weekday: string, sourceText: string): ParsedTimetableDay {
  const day=weekdayFromSource(weekday);
  if (!day) throw new Error("يجب تحديد يوم دراسي صحيح من الأحد إلى الخميس.");
  if (typeof sourceText!=="string") throw new Error("نص الجدول غير صالح.");
  if (sourceText.length>500000) throw new Error("نص الجدول أكبر من الحد المسموح.");
  if (!sourceText.trim()) return {
    weekday:day,teachers:[],totals:emptyTotals(),totalCells:0,
    warnings:["لم يُرفق محتوى لهذا اليوم؛ حُفظ اليوم فارغاً ليظهر نقص التغطية في التقرير."]
  };
  const tabular=parseTabularTimetableDay(day,sourceText);
  if(tabular) return tabular;

  const teachers:ParsedTimetableTeacher[]=[];
  const seenNames=new Set<string>();
  const totals=emptyTotals();
  const warnings:string[]=[];
  let teacher:ParsedTimetableTeacher|null=null;
  let cell:Partial<ParsedTimetableCell>|null=null;
  let cellStartLine=0;
  const finishCell=()=>{
    if(!cell)return;
    const missing:string[]=[];
    if(cell.period===undefined)missing.push("رقم الحصة");
    if(cell.sourceClass===undefined)missing.push("الصف والشعبة");
    if(cell.sourceSubject===undefined)missing.push("المادة");
    if(cell.sourceStatus===undefined)missing.push("الحالة");
    if(missing.length){warnings.push("بيانات الحصة قرب السطر "+cellStartLine+" غير مكتملة ("+missing.join("، ")+")؛ تم تجاوزها.");cell=null;return;}
    if(!Number.isInteger(cell.period)||cell.period!<1||cell.period!>8){warnings.push("رقم الحصة قرب السطر "+cellStartLine+" غير صالح؛ تم تجاوز الخانة.");cell=null;return;}
    if(!teacher){warnings.push("تعذر ربط الحصة بمعلم قرب السطر "+cellStartLine+"؛ تم تجاوز الخانة.");cell=null;return;}
    const sourceClass=cell.sourceClass!,sourceSubject=cell.sourceSubject!,sourceStatus=cell.sourceStatus!;
    const status=statusFromSource(sourceStatus);
    teacher.cells.push({period:cell.period!,classSections:parseClassSections(sourceClass),subject:subjectFromSource(sourceSubject),status,sourceClass,sourceSubject,sourceStatus,...(cell.sourceNote?{sourceNote:cell.sourceNote}:{})});
    totals[status]+=1;cell=null;
  };
  const finishTeacher=()=>{
    finishCell();
    if(!teacher)return;
    teacher.cells.sort((a,b)=>a.period-b.period);if(!teachers.includes(teacher))teachers.push(teacher);teacher=null;
  };
  const lines=sourceText.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=cleanLine(lines[i]);if(!line)continue;
    const dayHeading=line.match(/^(?:جدول\s+)?اليوم(?:\s+\S+)?\s*:\s*(.+)$/)||line.match(/^جدول\s+يوم\s+(.+)$/);
    if(dayHeading){
      const declaredDay=weekdayFromSource(dayHeading[1]);
      if(!declaredDay)warnings.push("السطر "+(i+1)+": عنوان اليوم غير معروف ("+dayHeading[1]+").");
      else if(declaredDay!==day)warnings.push("السطر "+(i+1)+": عنوان اليوم "+declaredDay+" لا يطابق اليوم المحدد "+day+".");
      continue;
    }
    const namedTeacher=line.match(/^[-•]?\s*اسم\s*المعلم\s*:\s*(.+?)\s*$/);
    const numberedTeacher=line.match(/^\s*\d+[.)]\s*(.+?)(?:\s*\(\s*صفحة\s*PDF\s*:\s*(\d+)\s*\))?\s*$/i);
    const teacherHeader=namedTeacher||numberedTeacher;
    if(teacherHeader){
      finishTeacher();
      const name=cleanLine(namedTeacher?namedTeacher[1]:numberedTeacher![1]),key=normalizedKey(name);
      if(!name){warnings.push("السطر "+(i+1)+": اسم المعلم فارغ؛ تم تجاوز العنوان.");teacher=null;continue;}
      const existingTeacher=teachers.find(item=>normalizedKey(item.sourceName)===key);
      if(existingTeacher){warnings.push("اسم المعلم «"+name+"» مكرر؛ جُمعت سجلاته في سجل واحد.");teacher=existingTeacher;}
      else{seenNames.add(key);teacher={sourceName:name,pdfPage:numberedTeacher&&numberedTeacher[2]?Number(numberedTeacher[2]):null,cells:[]};}
      continue;
    }
    const pageOnly=line.match(/^صفحة\s*PDF\s*:\s*(\d+)$/i);
    if(pageOnly&&teacher&&!teacher.cells.length&&!cell){teacher.pdfPage=Number(pageOnly[1]);continue;}
    const periodLine=line.match(/^الحصة\s+(.+?)\s*:\s*$/);
    if(periodLine){
      finishCell();
      if(!teacher){warnings.push("ظهرت حصة قبل اسم المعلم عند السطر "+(i+1)+"؛ تم تجاوزها.");cell=null;continue;}
      const period=parsePeriod(periodLine[1]);
      if(!period){warnings.push("رقم الحصة غير معروف عند السطر "+(i+1)+": "+periodLine[1]+"؛ تم تجاوزها.");cellStartLine=i+1;cell={period:0};continue;}
      if(teacher.cells.some(v=>v.period===period)){warnings.push("الحصة "+period+" مكررة للمعلم «"+teacher.sourceName+"»؛ تم تجاوز النسخة اللاحقة.");cellStartLine=i+1;cell={period:0};continue;}
      cellStartLine=i+1;cell={period};continue;
    }
    const field=line.match(/^[-•]?\s*(الصف\s*والشعبة|الصف|الشعبة|المادة|الحالة|الملاحظة|ملاحظات)\s*:\s*(.*)$/);
    if(field){
      if(!cell||!teacher){warnings.push("السطر "+(i+1)+": بيانات دون عنوان حصة أو اسم معلم؛ تم تجاوزها.");continue;}
      const key=normalizedKey(field[1]),value=cleanLine(field[2]);
      if(key.startsWith("الصف")||key==="الشعبه")cell.sourceClass=value;
      else if(key==="الماده")cell.sourceSubject=value;
      else if(key==="الحاله")cell.sourceStatus=value;
      else cell.sourceNote=value;
    }
  }
  finishTeacher();
  if(!teachers.length){
    warnings.push("لم يتم استخراج سجلات معلمين من النص؛ حُفظ اليوم فارغاً ليظهر نقصه في تقرير التغطية.");
    return {weekday:day,teachers,totals:emptyTotals(),totalCells:0,warnings};
  }
  const periodCount=Math.max(7,...teachers.flatMap(item=>item.cells.map(cell=>cell.period)));
  for(const item of teachers)fillMissingPeriods(item,periodCount,warnings);
  const finalTotals=emptyTotals();
  for(const item of teachers)for(const cell of item.cells)finalTotals[cell.status]++;
  const totalCells=teachers.reduce((sum,v)=>sum+v.cells.length,0);
  return {weekday:day,teachers,totals:finalTotals,totalCells,warnings};
}
