const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
const MAX_PAGES = 150;
const MAX_ROWS = 5000;
function normalizeDigits(value) {
  return String(value || "").replace(/[٠-٩۰-۹]/g, digit => String("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹".indexOf(digit) % 10));
}
export function normalizePdfArabic(value) {
  return normalizeDigits(String(value || "").normalize("NFKC"))
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/\s+/g, " ").trim();
}
function itemPosition(item) {
  const t = item.transform || [];
  const x = Number(t[4]), y = Number(t[5]);
  const width = Math.max(0, Number(item.width) || 0);
  const height = Math.max(0, Number(item.height) || 0);
  const firstLength = Math.hypot(Number(t[0]) || 0, Number(t[1]) || 0) || 1;
  const secondLength = Math.hypot(Number(t[2]) || 0, Number(t[3]) || 0) || 1;
  const dx = ((Number(t[0]) || 0) / firstLength) * width + ((Number(t[2]) || 0) / secondLength) * height;
  const dy = ((Number(t[1]) || 0) / firstLength) * width + ((Number(t[3]) || 0) / secondLength) * height;
  return { x: x + dx / 2, y: y + dy / 2 };
}
function dayIndex(text) {
  const key = normalizePdfArabic(text).replace(/[\sـ]/g, "");
  return ["الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس"].findIndex(alias => key === alias);
}
function parseTimes(text) {
  const matches = normalizeDigits(text).replace(/[٫،]/g, ":").match(/\d{1,2}:\d{2}/g) || [];
  return matches.length >= 2 ? [matches[0], matches[1]] : [];
}
function nearestIndex(value, centers) {
  let index = -1, distance = Number.POSITIVE_INFINITY;
  centers.forEach((center, i) => {
    const current = Math.abs(value - center);
    if (current < distance) { index = i; distance = current; }
  });
  return { index, distance };
}
function extractClassGroups(text) {
  const normalized = normalizeDigits(normalizePdfArabic(text)).replace(/\s+/g, "");
  const matches = normalized.match(/\d{1,2}(?:\/\d{1,2})+/g) || [];
  const groups = [];
  for (const match of matches) {
    const parts = match.split("/");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const pair = parts[i] + "/" + parts[i + 1];
      if (!groups.includes(pair)) groups.push(pair);
    }
  }
  return groups;
}
export function normalizePdfSubject(value) {
  const normalized = normalizePdfArabic(value).replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/\s+/g, "").toLocaleLowerCase("en");
  if (/^(?:e|ا)العلوم?$/.test(compact) || /^(?:e|ا)علوم$/.test(compact)) return "تفريغ العلوم";
  return normalized;
}
function dedupeReciprocalClassGroups(groups) {
  const result = [];
  for (const group of groups) {
    const [left, right] = group.split("/");
    const reverse = right + "/" + left;
    const existingReverse = result.indexOf(reverse);
    if (existingReverse >= 0) {
      if (Number(right) >= 9 && Number(right) <= 12) result.splice(existingReverse, 1, group);
      continue;
    }
    if (!result.includes(group)) result.push(group);
  }
  return result;
}
function isGroupMarker(value) {
  return normalizePdfArabic(value).replace(/[\sـ]/g, "").includes("مجموعةمادةاختيارية");
}
function isOnlyDigitsOrPunctuation(value) {
  return /^[\d\s/.,،؛:()\-]+$/.test(normalizeDigits(normalizePdfArabic(value)));
}
function teacherNameInfoFromItems(items) {
  const candidates = items.map(item => ({ item, pos: itemPosition(item), normalized: normalizePdfArabic(item.str) }))
    .filter(({ pos, normalized }) => Number.isFinite(pos.x) && Number.isFinite(pos.y) && pos.x >= 0 && pos.x < 58 && /[\u0600-\u06ff]/.test(normalized))
    .filter(({ normalized }) => normalized.length >= 3 && !normalized.includes("تم إنشاء الجدول"));
  candidates.sort((a, b) => b.normalized.length - a.normalized.length);
  return candidates[0] ? { name: candidates[0].normalized, original: String(candidates[0].item.str || "").trim() } : { name: "", original: "" };
}
export function extractHorizontalLinesFromOperatorList(operatorList, OPS) {
  const lines = [];
  if (!operatorList || !OPS || OPS.constructPath === undefined) return lines;
  const addLine = (x1, y1, x2, y2) => {
    if (![x1, y1, x2, y2].every(Number.isFinite) || Math.abs(y1-y2)>1.5 || Math.abs(x2-x1)<60) return;
    lines.push({x1:Math.min(x1,x2),x2:Math.max(x1,x2),y:(y1+y2)/2});
  };
  for (let index=0; index<(operatorList.fnArray||[]).length; index++) {
    if (operatorList.fnArray[index] !== OPS.constructPath) continue;
    const args=operatorList.argsArray[index]||[], commands=args[0]||[], coordinates=args[1]||[];
    let cursor=0,current=null,subpathStart=null;
    for (const command of commands) {
      if (command===OPS.moveTo) {
        current=[Number(coordinates[cursor++]),Number(coordinates[cursor++])]; subpathStart=current;
      } else if (command===OPS.lineTo) {
        const next=[Number(coordinates[cursor++]),Number(coordinates[cursor++])];
        if(current)addLine(current[0],current[1],next[0],next[1]);
        current=next;
      } else if (command===OPS.rectangle) {
        const x=Number(coordinates[cursor++]),y=Number(coordinates[cursor++]),w=Number(coordinates[cursor++]),h=Number(coordinates[cursor++]);
        addLine(x,y,x+w,y); addLine(x,y+h,x+w,y+h); current=[x,y]; subpathStart=current;
      } else if (command===OPS.curveTo) {
        cursor+=4; current=[Number(coordinates[cursor++]),Number(coordinates[cursor++])];
      } else if (command===OPS.curveTo2 || command===OPS.curveTo3) {
        cursor+=2; current=[Number(coordinates[cursor++]),Number(coordinates[cursor++])];
      } else if (command===OPS.closePath) {
        if(current&&subpathStart)addLine(current[0],current[1],subpathStart[0],subpathStart[1]);
        current=subpathStart;
      }
    }
  }
  const unique=new Map();
  for(const line of lines)unique.set([line.x1,line.x2,line.y].map(v=>Math.round(v*10)/10).join(":"),line);
  return Array.from(unique.values());
}
function buildPeriodSpans(page, dayCenters, periodCenters) {
  const lines=Array.isArray(page.horizontalLines)?page.horizontalLines:[];
  const edges=new Array(6);
  for(let i=1;i<5;i++)edges[i]=(dayCenters[i-1]+dayCenters[i])/2;
  edges[0]=dayCenters[0]-(dayCenters[1]-dayCenters[0])/2;
  edges[5]=dayCenters[4]+(dayCenters[4]-dayCenters[3])/2;
  const spansByDay=[];
  let valid=lines.length>=20;
  for(let day=0;day<5;day++){
    const missing=new Set();let visible=0;
    for(let period=1;period<=6;period++){
      const y=(periodCenters[period-1]+periodCenters[period])/2,left=edges[day],right=edges[day+1];
      const found=lines.some(line=>Math.abs(line.y-y)<=3&&line.x1<=left+3&&line.x2>=right-3);
      if(found)visible++;else missing.add(period);
    }
    if(visible<4)valid=false;
    const spans=new Array(7);let start=1;
    for(let period=1;period<=6;period++){
      if(!missing.has(period)){for(let current=start;current<=period;current++)spans[current-1]={start,end:period};start=period+1;}
    }
    for(let current=start;current<=7;current++)spans[current-1]={start,end:7};
    spansByDay.push(spans);
  }
  return {spansByDay,valid};
}
function makePageGrid(page) {
  const dayItems=page.items.map(item=>({item,pos:itemPosition(item),day:dayIndex(item.str)}))
    .filter(entry=>entry.day>=0&&Number.isFinite(entry.pos.x));
  const dayCenters=WEEKDAYS.map((_,day)=>{
    const positions=dayItems.filter(entry=>entry.day===day).map(entry=>entry.pos.x);
    return positions.length?positions.reduce((a,b)=>a+b,0)/positions.length:Number.NaN;
  });
  const timeItems=page.items.map(item=>({item,pos:itemPosition(item),times:parseTimes(item.str)}))
    .filter(entry=>entry.times.length===2&&Number.isFinite(entry.pos.y)&&entry.pos.x>=65&&entry.pos.x<=125);
  const periodTimes=timeItems.sort((a,b)=>b.pos.y-a.pos.y).slice(0,7);
  const periodCenters=periodTimes.map(entry=>entry.pos.y);
  const orderedTimes=periodTimes.map((entry,index)=>({period:index+1,time:entry.times[0]+"–"+entry.times[1]}));
  return {dayCenters,periodCenters,orderedTimes,...buildPeriodSpans(page,dayCenters,periodCenters)};
}
/**
 * @typedef {{period:number,status:string,classSections:string[],subject:string,sourceClass:string,sourceSubject:string,sourceStatus:string,sourceNote:string}} PdfCell
 * @typedef {{sourceName:string,sourceNameOriginal:string,pdfPage:number,matchStatus?:string,matchedTeacherName?:string|null,cells:PdfCell[]}} PdfTeacher
 * @typedef {{weekday:string,teachers:PdfTeacher[],totals:{teaching:number,free:number,meeting:number,activity:number,other:number,unclear:number},totalCells:number,warnings:string[],matchingTotals?:{matched:number,unmatched:number,ambiguous:number}}} PdfDay
 */
export function parseTimetablePdfPages(pages) {
  /** @type {{pageCount:number,teacherPageCount:number,skippedPages:number[],importedCellCount:number,importedGroupCount:number,expandedPeriodCount:number,mergedCells:Array<{page:number,teacher:string,weekday:string,startPeriod:number,endPeriod:number,subject:string,classGroups:string[]}>,warnings:string[],blockingErrors:string[],periodTimes:Array<{period:number,time:string}>,teachers:Array<{page:number,name:string,lessonCount:number}>}} */
  const diagnostics={pageCount:Array.isArray(pages)?pages.length:0,teacherPageCount:0,skippedPages:[],importedCellCount:0,importedGroupCount:0,expandedPeriodCount:0,mergedCells:[],warnings:[],blockingErrors:[],periodTimes:[],teachers:[]};
  if(!Array.isArray(pages)||!pages.length||pages.length>MAX_PAGES){diagnostics.blockingErrors.push("عدد صفحات PDF غير صالح أو يتجاوز الحد المسموح.");return {weeklyDays:[],sheets:{"المعلمون":[],"الحصص":[],"أوقات الحصص":[],"بيانات PDF":[]},diagnostics};}
  /** @type {Array<Array<string|number>>} */
  const teacherRows=[["الاسم","الاختصار","التفريغ"]];
  /** @type {Array<Array<string|number>>} */
  const lessonRows=[["المعلم","الشعبة","المادة","اليوم","الحصة","وقت الحصة","رقم الصفحة","النص الأصلي","المجموعات","عدد الفترات"]];
  /** @type {Array<Array<string|number>>} */
  const timeRows=[["رقم الحصة","الوقت"]];
  /** @type {Array<Array<string|number>>} */
  const metadataRows=[["رقم الصفحة","نوع الصفحة","اسم المعلم","عدد الخانات المستخرجة"]];
  /** @type {PdfDay[]} */
  const weeklyDays=WEEKDAYS.map(weekday=>({weekday,teachers:[],totals:{teaching:0,free:0,meeting:0,activity:0,other:0,unclear:0},totalCells:0,warnings:[]}));
  const teacherNames=new Set();let referenceTimes="";
  for(const page of pages){
    const teacherInfo=teacherNameInfoFromItems(page.items),teacherName=teacherInfo.name,teacherNameOriginal=teacherInfo.original,grid=makePageGrid(page);
    if(!teacherName){
      if(page.pageNumber===1&&grid.periodCenters.length>=7){diagnostics.skippedPages.push(page.pageNumber);metadataRows.push([page.pageNumber,"جدول إجمالي تم تجاوزه","",0]);continue;}
      diagnostics.blockingErrors.push("تعذر استخراج اسم المعلم من الصفحة "+page.pageNumber+". لم يتم تجاوزها أو تخمين اسمها.");continue;
    }
    if(grid.dayCenters.some(value=>!Number.isFinite(value))||grid.periodCenters.length!==7){diagnostics.blockingErrors.push("لم يتم التحقق من عناوين الأيام السبعة أو أوقات الحصص في صفحة المعلم "+page.pageNumber+".");continue;}
    if(!grid.valid){diagnostics.blockingErrors.push("تعذر التحقق من خطوط حدود الخانات في صفحة المعلم "+page.pageNumber+". لم يتم تخمين الخانات الممتدة.");continue;}
    const pageTimes=grid.orderedTimes.map(entry=>entry.time).join("|");
    if(!referenceTimes){referenceTimes=pageTimes;diagnostics.periodTimes=grid.orderedTimes;for(const entry of grid.orderedTimes)timeRows.push([entry.period,entry.time]);}
    else if(referenceTimes!==pageTimes)diagnostics.blockingErrors.push("أوقات الحصص في الصفحة "+page.pageNumber+" تختلف عن بقية صفحات الملف.");
    const teacherKey=normalizePdfArabic(teacherName).replace(/\s+/g," ");
    if(teacherNames.has(teacherKey)){diagnostics.blockingErrors.push("اسم المعلم مكرر في أكثر من صفحة: "+teacherName+" (الصفحة "+page.pageNumber+").");continue;}
    teacherNames.add(teacherKey);teacherRows.push([teacherName,teacherName,""]);diagnostics.teacherPageCount++;
    const cells=new Map(),weeklyTeacherCells=Array.from({length:5},()=>Array(7).fill(null));
    for(const item of page.items){
      const raw=String(item.str||"").trim();
      if(!raw||/aSc\s*Timetables/i.test(raw)||normalizePdfArabic(raw).includes("تم إنشاء الجدول")||parseTimes(raw).length===2||dayIndex(raw)>=0||/^[1-7]$/.test(normalizeDigits(normalizePdfArabic(raw))))continue;
      const pos=itemPosition(item);if(!Number.isFinite(pos.x)||!Number.isFinite(pos.y))continue;
      const day=nearestIndex(pos.x,grid.dayCenters),period=nearestIndex(pos.y,grid.periodCenters);
      if(day.index<0||period.index<0||day.distance>58||period.distance>66)continue;
      if(pos.x<Math.min(...grid.dayCenters)-55||pos.x>Math.max(...grid.dayCenters)+55)continue;
      const spanInfo=grid.spansByDay[day.index][period.index],key=day.index+":"+spanInfo.start;
      if(!cells.has(key))cells.set(key,[]);
      cells.get(key).push({item,spanInfo});
    }
    let pageLessonCount=0;
    for(const [key,entries] of cells){
      const [dayIndexValue,startPeriod]=key.split(":").map(Number);
      const rawText=entries.map(entry=>String(entry.item.str||"").trim()).filter(Boolean).join(" | ");
      if(!rawText.trim())continue;
      const groups=dedupeReciprocalClassGroups(Array.from(new Set(entries.flatMap(entry=>extractClassGroups(entry.item.str)))));
      const rawSubjectParts=entries.map(entry=>normalizePdfArabic(entry.item.str)).filter(text=>text&&!isGroupMarker(text))
        .map(text=>text.replace(/\d{1,2}(?:\s*\/\s*\d{1,2})+/g," ").replace(/مجموعة\s*مادة\s*اختيارية/g," ").trim())
        .filter(text=>text&&!isOnlyDigitsOrPunctuation(text));
      const sourceSubject=Array.from(new Set(rawSubjectParts)).join(" / ");
      const subject=Array.from(new Set(rawSubjectParts.map(normalizePdfSubject))).join(" / ");
      if(!subject&&!groups.length)diagnostics.warnings.push("صفحة "+page.pageNumber+"، "+WEEKDAYS[dayIndexValue]+"، الحصة "+startPeriod+": خانة نصها غير قابل للتصنيف؛ حُفظت كغير واضحة للمراجعة ("+rawText.slice(0,90)+").");
      if(!subject&&groups.length)diagnostics.warnings.push("صفحة "+page.pageNumber+"، "+WEEKDAYS[dayIndexValue]+"، الحصة "+startPeriod+": استُخرج الصف لكن لم يتحدد اسم المادة؛ حُفظت الخانة للمراجعة ("+rawText.slice(0,90)+").");
      if(!groups.length)diagnostics.warnings.push("صفحة "+page.pageNumber+"، "+WEEKDAYS[dayIndexValue]+"، الحصة "+startPeriod+": استُخرجت المادة لكن لم يتحدد الصف/المجموعة؛ تُركت الخانة دون صف للمراجعة ("+rawText.slice(0,90)+").");
      let status="unclear";const subjectKey=normalizePdfArabic(subject);
      if(subjectKey.includes("اجتماع"))status="meeting";else if(subjectKey.includes("نشاط"))status="activity";else if(subjectKey.includes("فراغ")||subjectKey.includes("فارغ"))status="free";else if(groups.length&&subject)status="teaching";
      const spanInfo=entries[0].spanInfo,startPeriodValue=spanInfo.start,span=spanInfo.end-spanInfo.start+1;
      if(span>1){diagnostics.expandedPeriodCount+=span;diagnostics.mergedCells.push({page:page.pageNumber,teacher:teacherName,weekday:WEEKDAYS[dayIndexValue],startPeriod:startPeriodValue,endPeriod:startPeriodValue+span-1,subject,classGroups:groups});}
      for(let offset=0;offset<span;offset++){
        const period=startPeriodValue+offset,periodTime=grid.orderedTimes[period-1]?.time||"";
        const cell={period,status,classSections:groups,subject:subject||"",sourceClass:groups.join("، "),sourceSubject,sourceStatus:rawText,sourceNote:"صفحة PDF "+page.pageNumber+" · "+periodTime+(span>1?" · خانة ممتدة عبر "+span+" فترتين":"")+" · "+rawText};
        if(weeklyTeacherCells[dayIndexValue][period-1])diagnostics.blockingErrors.push("تداخل خانتين في صفحة "+page.pageNumber+"، "+WEEKDAYS[dayIndexValue]+"، الحصة "+period+".");
        else weeklyTeacherCells[dayIndexValue][period-1]=cell;
        lessonRows.push([teacherName,groups.join("، "),subject,WEEKDAYS[dayIndexValue],period,periodTime,page.pageNumber,rawText,JSON.stringify(groups),span]);
        pageLessonCount++;diagnostics.importedGroupCount+=groups.length;
      }
      diagnostics.importedCellCount++;
    }
    for(let day=0;day<5;day++){
      const cellsForDay=weeklyTeacherCells[day].map((cell,index)=>cell||{period:index+1,status:"free",classSections:[],subject:"",sourceClass:"",sourceSubject:"",sourceStatus:"فراغ",sourceNote:""});
      weeklyDays[day].teachers.push({sourceName:teacherName,sourceNameOriginal:teacherNameOriginal,pdfPage:page.pageNumber,cells:cellsForDay});
    }
    diagnostics.teachers.push({page:page.pageNumber,name:teacherName,lessonCount:pageLessonCount});
    metadataRows.push([page.pageNumber,"جدول معلم",teacherName,pageLessonCount]);
    if(!pageLessonCount)diagnostics.warnings.push("لم تُستخرج حصص مؤكدة من صفحة المعلم "+page.pageNumber+" ("+teacherName+").");
  }
  if(!diagnostics.teacherPageCount)diagnostics.blockingErrors.push("لم يتم العثور على صفحات جداول فردية للمعلمين.");
  if(diagnostics.teacherPageCount>500)diagnostics.blockingErrors.push("عدد صفحات المعلمين يتجاوز الحد المسموح.");
  if(lessonRows.length-1>MAX_ROWS)diagnostics.blockingErrors.push("عدد سجلات الحصص المستخرجة يتجاوز الحد المسموح.");
  if(diagnostics.skippedPages.length)diagnostics.warnings.unshift("تم تجاوز صفحة الملخص رقم "+diagnostics.skippedPages.join("، ")+"؛ لم تُعامل كجدول معلم.");
  for(const day of weeklyDays){day.totalCells=day.teachers.length*7;for(const teacher of day.teachers)for(const cell of teacher.cells)day.totals[cell.status]++;}
  /** @type {Record<string,Array<Array<string|number>>>} */
  const sheets={"المعلمون":teacherRows,"الحصص":lessonRows,"أوقات الحصص":timeRows,"بيانات PDF":metadataRows};
  return {weeklyDays,sheets,diagnostics};
}
