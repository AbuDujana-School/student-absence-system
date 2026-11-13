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
  "السادسة":6,"السادسه":6,"السابعة":7,"السابعه":7
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
  if (["فراغ","فارغ","فارغه","حصة فراغ","حصة فارغه"].includes(key)) return "free";
  if (["اجتماع","اجتماع قسم","اجتماع اداري","اجتماع الماده","اجتماع القسم","اجتماع المواد"].includes(key)) return "meeting";
  if (["نشاط","نشاط مدرسي","مناوبة"].includes(key)) return "activity";
  if (["اخري","حاله اخري","ارتباط"].includes(key)) return "other";
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
  if (/^[1-7]$/.test(text)) return Number(text);
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
function validateTeacherGrid(teacher: ParsedTimetableTeacher): void {
  const periods=teacher.cells.map(v=>v.period).sort((a,b)=>a-b);
  if (periods.length!==7 || periods.some((v,i)=>v!==i+1))
    throw new Error("المعلم «"+teacher.sourceName+"» لا يحتوي على الحصص السبع كاملة. الموجود: "+(periods.join(", ")||"لا توجد حصص")+".");
}
function parseTabularTimetableDay(day: SchoolWeekday, sourceText: string): ParsedTimetableDay | null {
  const teachers: ParsedTimetableTeacher[]=[];
  const byName=new Map<string,ParsedTimetableTeacher>();
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
    if(rowDay!==day) throw new Error("السطر "+(index+1)+" يخص يوم "+rowDay+" وليس يوم "+day+".");
    const sourceName=fields[0];
    const period=parsePeriod(fields[2]||"");
    if(!sourceName) throw new Error("اسم المعلم فارغ في السطر "+(index+1)+".");
    if(!period) throw new Error("رقم الحصة غير معروف في السطر "+(index+1)+": "+(fields[2]||"فارغ")+".");
    if(fields[3]===undefined||fields[4]===undefined||fields[5]===undefined||!fields[3]||!fields[4]||!fields[5]){
      throw new Error("بيانات الصف أو المادة أو الحالة ناقصة في السطر "+(index+1)+". لا أملأ البيانات الناقصة بالتخمين.");
    }
    const key=normalizedKey(sourceName);
    let teacher=byName.get(key);
    if(!teacher){teacher={sourceName,pdfPage:null,cells:[]};byName.set(key,teacher);teachers.push(teacher);}
    const sourceClass=fields[3],sourceSubject=fields[4],sourceStatus=fields[5],sourceNote=fields.slice(6).filter(Boolean).join(" | ");
    const status=statusFromSource(sourceStatus);
    const existing=teacher.cells.find(cell=>cell.period===period);
    if(existing){
      if(existing.status!==status || normalizedKey(existing.sourceSubject)!==normalizedKey(sourceSubject) || normalizedKey(existing.sourceStatus)!==normalizedKey(sourceStatus)){
        throw new Error("للمعلم «"+sourceName+"» أكثر من تكليف متعارض في الحصة "+period+" يوم "+day+". راجع الصفوف قبل الاستيراد.");
      }
      existing.classSections=Array.from(new Set([...existing.classSections,...parseClassSections(sourceClass)]));
      if(!existing.sourceClass.split(" | ").includes(sourceClass)) existing.sourceClass+=" | "+sourceClass;
      if(sourceNote && !existing.sourceNote?.split(" | ").includes(sourceNote)) existing.sourceNote=[existing.sourceNote,sourceNote].filter(Boolean).join(" | ");
      continue;
    }
    teacher.cells.push({period,classSections:parseClassSections(sourceClass),subject:subjectFromSource(sourceSubject),status,sourceClass,sourceSubject,sourceStatus,...(sourceNote?{sourceNote}:{})});
  }
  if(!recognizedRows) return null;
  for(const teacher of teachers){teacher.cells.sort((a,b)=>a.period-b.period);validateTeacherGrid(teacher);}
  const totals=emptyTotals();
  for(const teacher of teachers)for(const cell of teacher.cells)totals[cell.status]++;
  const totalCells=teachers.reduce((sum,teacher)=>sum+teacher.cells.length,0);
  return {weekday:day,teachers,totals,totalCells,warnings:[]};
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
  if (typeof sourceText!=="string" || !sourceText.trim()) throw new Error("لم يتم إدخال نص الجدول.");
  if (sourceText.length>500000) throw new Error("نص الجدول أكبر من الحد المسموح.");
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
    if(missing.length)throw new Error("بيانات الحصة قرب السطر "+cellStartLine+" غير مكتملة: "+missing.join("، "));
    if(!teacher)throw new Error("تعذر ربط الحصة بمعلم قرب السطر "+cellStartLine+".");
    const sourceClass=cell.sourceClass!,sourceSubject=cell.sourceSubject!,sourceStatus=cell.sourceStatus!;
    const status=statusFromSource(sourceStatus);
    teacher.cells.push({period:cell.period!,classSections:parseClassSections(sourceClass),subject:subjectFromSource(sourceSubject),status,sourceClass,sourceSubject,sourceStatus,...(cell.sourceNote?{sourceNote:cell.sourceNote}:{})});
    totals[status]+=1;cell=null;
  };
  const finishTeacher=()=>{
    finishCell();
    if(!teacher)return;
    teacher.cells.sort((a,b)=>a.period-b.period);validateTeacherGrid(teacher);teachers.push(teacher);teacher=null;
  };
  const lines=sourceText.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const line=cleanLine(lines[i]);if(!line)continue;
    const dayHeading=line.match(/^(?:جدول\s+)?اليوم(?:\s+\S+)?\s*:\s*(.+)$/)||line.match(/^جدول\s+يوم\s+(.+)$/);
    if(dayHeading){
      const declaredDay=weekdayFromSource(dayHeading[1]);
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
      seenNames.add(key);teacher={sourceName:name,pdfPage:numberedTeacher&&numberedTeacher[2]?Number(numberedTeacher[2]):null,cells:[]};continue;
    }
    const pageOnly=line.match(/^صفحة\s*PDF\s*:\s*(\d+)$/i);
    if(pageOnly&&teacher&&!teacher.cells.length&&!cell){teacher.pdfPage=Number(pageOnly[1]);continue;}
    const periodLine=line.match(/^الحصة\s+(.+?)\s*:\s*$/);
    if(periodLine){
      finishCell();
      if(!teacher)throw new Error("ظهرت حصة قبل اسم المعلم عند السطر "+(i+1)+".");
      const period=parsePeriod(periodLine[1]);
      if(!period)throw new Error("رقم الحصة غير معروف عند السطر "+(i+1)+": "+periodLine[1]);
      if(teacher.cells.some(v=>v.period===period))throw new Error("الحصة "+period+" مكررة للمعلم «"+teacher.sourceName+"».");
      cellStartLine=i+1;cell={period};continue;
    }
    const field=line.match(/^[-•]?\s*(الصف\s*والشعبة|الصف|الشعبة|المادة|الحالة|الملاحظة|ملاحظات)\s*:\s*(.*)$/);
    if(field){
      if(!cell||!teacher)throw new Error("وجدت خانة بيانات دون عنوان حصة عند السطر "+(i+1)+".");
      const key=normalizedKey(field[1]),value=cleanLine(field[2]);
      if(key.startsWith("الصف")||key==="الشعبه")cell.sourceClass=value;
      else if(key==="الماده")cell.sourceSubject=value;
      else if(key==="الحاله")cell.sourceStatus=value;
      else cell.sourceNote=value;
    }
  }
  finishTeacher();
  if(!teachers.length)throw new Error("لم أتعرف على أسماء المعلمين. استخدم «اسم المعلم: الاسم» أو صفوفاً مفصولة بعلامات تبويب.");
  const totalCells=teachers.reduce((sum,v)=>sum+v.cells.length,0);
  if(totalCells!==teachers.length*7)throw new Error("عدد خانات الجدول لا يساوي سبع حصص لكل معلم.");
  return {weekday:day,teachers,totals,totalCells,warnings};
}
