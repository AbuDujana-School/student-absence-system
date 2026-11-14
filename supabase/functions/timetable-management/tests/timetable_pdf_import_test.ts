import { extractHorizontalLinesFromOperatorList, normalizePdfSubject, parseTimetablePdfPages } from "../../../../timetable_pdf_import.js";

function verticalText(str: string, x: number, y: number, width = 50) {
  return { str, transform: [0, 1, -1, 0, x, y], width, height: 9 };
}
function makeLines(dayX: number[], timeY: number[], merged: Array<[number, number]> = []) {
  const edges = [dayX[0] - (dayX[1]-dayX[0])/2];
  for (let i=1;i<5;i++) edges.push((dayX[i-1]+dayX[i])/2);
  edges.push(dayX[4] + (dayX[4]-dayX[3])/2);
  const mergedKeys = new Set(merged.map(([day, after]) => day+":"+after));
  const lines: Array<{x1:number;x2:number;y:number}> = [];
  for (let day=0;day<5;day++) for (let after=1;after<=6;after++) {
    if (mergedKeys.has(day+":"+after)) continue;
    lines.push({x1:edges[day],x2:edges[day+1],y:(timeY[after-1]+timeY[after])/2});
  }
  return lines;
}
function makeTeacherPage(pageNumber = 2, cellItems: any[] = [], merged: Array<[number, number]> = [], teacherName = "أحمد خالد محمد السالمي") {
  const items: any[] = [];
  const days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
  const dayX = [155, 246, 337, 429, 520];
  days.forEach((day, i) => items.push(verticalText(day, dayX[i] + 4.5, 780, 60)));
  const times = ["7:10 - 7:45", "7:50 - 8:25", "8:30 - 9:05", "9:10 - 9:45", "10:05 - 10:40", "10:45 - 11:20", "11:25 - 12:00"];
  const timeY = [700, 595, 490, 385, 280, 175, 70];
  times.forEach((time, i) => items.push(verticalText(time, 100, timeY[i] - 15, 30)));
  items.push(verticalText(teacherName, 15, 400, 340));
  items.push(...cellItems);
  return { pageNumber, width: 595, height: 842, items, horizontalLines: makeLines(dayX,timeY,merged) };
}

Deno.test("PDF parser preserves multi-class groups as one lesson in one period", () => {
  const page = makeTeacherPage(2, [
    verticalText("الرياضيات", 114, 675, 50),
    verticalText("1/12/6/12", 143, 675, 40),
    verticalText("مجموعة مادة اختيارية", 185, 675, 60),
  ]);
  const parsed = parseTimetablePdfPages([page]);
  const rows = parsed.sheets["الحصص"]! as Array<Array<string|number>>;
  if (rows.length !== 2) throw new Error("Expected one lesson row plus the header; multiple groups must not duplicate the period");
  if (rows[1][1] !== "1/12، 6/12") throw new Error("Both class groups were not retained");
  if (Number(rows[1][4]) !== 1) throw new Error("The class groups should occupy one period only");
  if (rows[1][3] !== "الأحد") throw new Error("Weekday mapping is incorrect");
  if (parsed.weeklyDays.length !== 5 || parsed.weeklyDays[0]!.teachers[0]!.cells.length !== 7) throw new Error("The weekly preview must contain five days and seven cells per teacher");
  if (parsed.weeklyDays[0]!.teachers[0]!.cells[0].classSections.length !== 2) throw new Error("The weekly cell did not retain both groups as one slot");
});

Deno.test("PDF parser expands a merged two-period cell from missing grid dividers", () => {
  const page = makeTeacherPage(2, [
    verticalText("العلوم", 114, 177.5, 100),
    verticalText("5/10", 143, 177.5, 100),
  ], [[0,5]]);
  const parsed = parseTimetablePdfPages([page]);
  const rows = parsed.sheets["الحصص"]! as Array<Array<string|number>>;
  if (rows.length !== 3) throw new Error("A two-period merged cell must create two separate period records");
  if (Number(rows[1][4]) !== 5 || Number(rows[2][4]) !== 6) throw new Error("Merged cell did not expand into consecutive periods");
  if (rows[1][1] !== rows[2][1] || rows[1][2] !== rows[2][2]) throw new Error("Extended periods must retain the same class and subject");
  if (parsed.diagnostics.expandedPeriodCount !== 2) throw new Error("The merged-cell diagnostic was not recorded");
  const weeklyCells = parsed.weeklyDays[0]!.teachers[0]!.cells;
  if (weeklyCells[4].period !== 5 || weeklyCells[5].period !== 6 || weeklyCells[4].classSections[0] !== "5/10" || weeklyCells[5].classSections[0] !== "5/10") throw new Error("The weekly preview did not expand the same cell into two periods");
});

Deno.test("PDF parser detects several merged cells across different days", () => {
  const merged: Array<[number,number]> = [[0,5],[1,3],[2,6],[3,6],[4,1]];
  const dayX=[155,246,337,429,520], timeY=[700,595,490,385,280,175,70];
  const centers=[(timeY[4]+timeY[5])/2,(timeY[2]+timeY[3])/2,(timeY[5]+timeY[6])/2,(timeY[5]+timeY[6])/2,(timeY[0]+timeY[1])/2];
  const items:any[]=[];
  merged.forEach(([day],i)=>{const y=centers[i]-50;items.push(verticalText("تقنية المعلومات",dayX[day]-40,y,100),verticalText((i+1)+"/9",dayX[day]-10,y,100));});
  const secondPage=makeTeacherPage(60,[verticalText("تقنية المعلومات",480,72.5,100),verticalText("6/9",510,72.5,100)],[[4,6]],"حسان محمد عبدالله الجابري");
  const parsed=parseTimetablePdfPages([makeTeacherPage(59,items,merged),secondPage]);
  if(parsed.diagnostics.expandedPeriodCount!==12||parsed.diagnostics.mergedCells.length!==6)throw new Error("The six merged cells must expand into twelve period records");
  if(parsed.sheets["الحصص"]!.length!==13)throw new Error("Expected twelve period rows from six merged source cells");
  for(const [day,after] of merged){
    const teacher=parsed.weeklyDays[day]!.teachers[0]!;
    if(teacher.cells[after-1].status!=="teaching"||teacher.cells[after].status!=="teaching")throw new Error("Merged periods were not copied to both weekly slots");
    if(teacher.cells[after-1].classSections[0]!==teacher.cells[after].classSections[0])throw new Error("Merged period class data changed between slots");
  }
  const thursday=parsed.weeklyDays[4]!.teachers[1]!;
  if(thursday.cells[5].classSections[0]!=="6/9"||thursday.cells[6].classSections[0]!=="6/9")throw new Error("The second teacher's Thursday extension was not expanded");
});

Deno.test("PDF parser normalizes the two science-discharge spellings", () => {
  if (normalizePdfSubject("E العلوم") !== "تفريغ العلوم") throw new Error("E العلوم was not normalized");
  if (normalizePdfSubject("E علوم") !== "تفريغ العلوم") throw new Error("E علوم was not normalized");
  if (normalizePdfSubject("إ علوم") !== "تفريغ العلوم") throw new Error("Arabic PDF glyph variant was not normalized");
});

Deno.test("PDF parser skips the aggregate first page but blocks a missing teacher page", () => {
  const summary = makeTeacherPage(1);
  summary.items = summary.items.filter(item => !item.str.includes("أحمد خالد"));
  const parsed = parseTimetablePdfPages([summary, makeTeacherPage(2, [
    verticalText("الرياضيات", 114, 675, 50), verticalText("1/12", 143, 675, 40),
  ])]);
  if (parsed.diagnostics.skippedPages[0] !== 1) throw new Error("Aggregate page was not identified");
  const broken = parseTimetablePdfPages([makeTeacherPage(2), { pageNumber: 3, width: 595, height: 842, items: [] }]);
  if (!broken.diagnostics.blockingErrors.length) throw new Error("A page without a teacher identity must block the import");
});

Deno.test("PDF parser preserves subject-only special cells for manual class review", () => {
  const page = makeTeacherPage(2, [verticalText("إ العلوم", 114, 675, 50), verticalText("إ علوم", 143, 675, 40)]);
  const parsed = parseTimetablePdfPages([page]);
  const rows = parsed.sheets["الحصص"]! as Array<Array<string|number>>;
  if (rows.length !== 2) throw new Error("A special subject cell without a numeric class must be preserved, not discarded");
  if (rows[1][2] !== "تفريغ العلوم") throw new Error("Science discharge variants were not unified");
  if (rows[1][1] !== "") throw new Error("An unknown class must remain blank rather than be guessed");
  if (!parsed.diagnostics.warnings.some(item => item.includes("لم يتحدد الصف/المجموعة"))) throw new Error("The missing class must be explicitly flagged for review");
});

Deno.test("PDF vector path reader extracts horizontal cell dividers", () => {
  const OPS={constructPath:99,moveTo:1,lineTo:2,rectangle:3,curveTo:4,curveTo2:5,curveTo3:6,closePath:7};
  const operatorList={fnArray:[99],argsArray:[[new Uint8Array([1,2,2]),new Float32Array([110,643,201,643,201,538])]]};
  const lines=extractHorizontalLinesFromOperatorList(operatorList,OPS);
  if(lines.length!==1||lines[0].x1!==110||lines[0].x2!==201||lines[0].y!==643)throw new Error("The PDF path operator was not converted into a horizontal divider");
});
