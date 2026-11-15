import { extractHorizontalLinesFromOperatorList, extractVerticalLinesFromOperatorList, normalizePdfArabic, normalizePdfSubject, parseTimetablePdfPages, transformPdfTextItem, transformPdfGridLines } from "../../../../timetable_pdf_import.js";

const DAYS=["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
const TIMES=["7:10 - 7:45","7:50 - 8:25","8:30 - 9:05","9:10 - 9:45","10:05 - 10:40","10:45 - 11:20","11:25 - 12:00","12:05 - 12:40"];
const PX=[500,440,380,320,260,200,140,80];
const DY=[700,600,500,400,300];
function textAt(str:string,x:number,y:number,width=48){return {str,transform:[1,0,0,1,x-width/2,y-4],width,height:9};}
function rotatedName(str:string){return {str,transform:[0,1,-1,0,15,400],width:340,height:9};}
function rotatedNamePart(str:string,y:number,width=60){return {str,transform:[0,1,-1,0,15,y],width,height:9};}
function makeTeacherPage(pageNumber=2,entries:any[]=[],periodCount=7,merged:Array<[number,number]>=[],teacherName="أحمد خالد محمد السالمي"){
 const items:any[]=[rotatedName(teacherName)];
 DAYS.forEach((day,i)=>items.push(textAt(day,560,DY[i],55)));
 for(let p=0;p<periodCount;p++){items.push(textAt(TIMES[p],PX[p],790,48));items.push(textAt(String(p+1),PX[p],815,10));}
 items.push(...entries);
 const verticalLines:any[]=[];
 const dayEdges=[750,650,550,450,350,250];
 for(let day=0;day<5;day++)for(let p=0;p<periodCount-1;p++){
  if(merged.some(([d,after])=>d===day&&after===p+1))continue;
  const x=(PX[p]+PX[p+1])/2;
  verticalLines.push({x,y1:dayEdges[day+1],y2:dayEdges[day]});
 }
 return {pageNumber,width:595,height:842,items,verticalLines,horizontalLines:[]};
}
function cell(period:number,day:number,subject:string,groups="1/12"){return [textAt(subject,PX[period-1],DY[day],50),...(groups?[textAt(groups,PX[period-1]+3,DY[day]-13,40)]:[])];}
const ROTATE_90=[0,1,1,0,0,0] as const;
function rawRotatedText(str:string,x:number,y:number,width=58,height=8){
 return {str,transform:[0,height,-height,0,x,y],width,height};
}
function makeRotatedTeacherPage(pageNumber=2,withLesson=true){
 const raw:any[]=[];
 const dayX=[167,257,348,439,527],periodY=[681,576,470,365,257,152,46];
 const teacherParts=[["السالمي",258,118],["محمد",380,77],["خالد",459,91],["أحمد",522,58]] as const;
 for(const [name,y,width] of teacherParts)raw.push(rawRotatedText(name,41.76,y,width,29.9));
 DAYS.forEach((day,i)=>raw.push(rawRotatedText(day,dayX[i],754,70,27)));
 for(let p=0;p<7;p++){
  raw.push(rawRotatedText(TIMES[p],106,periodY[p],58,5.8));
  raw.push(rawRotatedText(String(p+1),87,periodY[p],8,8));
 }
 if(withLesson)raw.push(rawRotatedText("الرياضيات",dayX[0],periodY[0],45,8),rawRotatedText("1/12",dayX[0]+18,periodY[0]-13,24,8));
 const items=raw.map(item=>transformPdfTextItem(item,ROTATE_90));
 const verticalLines:any[]=[];
 const dayEdges=[dayX[0]-45-13.5, ...dayX.slice(0,4).map((x,i)=>(x+dayX[i+1])/2-13.5), dayX[4]+45-13.5];
 for(let day=0;day<5;day++)for(let p=0;p<6;p++){
  const boundary=((periodY[p]+29)+(periodY[p+1]+29))/2;
  verticalLines.push({x:boundary,y1:dayEdges[day],y2:dayEdges[day+1]});
 }
 return {pageNumber,width:842,height:595,items,verticalLines,horizontalLines:[]};
}
function makeRotatedOverviewPage(){
 const page=makeRotatedTeacherPage(1,false);
 page.items=page.items.filter((item:any)=>!["السالمي","محمد","خالد","أحمد",...DAYS].includes(item.str));
 for(let i=0;i<100;i++)page.items.push({str:"1/11",transform:[1,0,0,1,220+(i%10)*4,220+Math.floor(i/10)*4],width:12,height:8});
 return page;
}



Deno.test("PDF parser normalizes rotated aSc pages and skips the aggregate cover",()=>{
 const parsed=parseTimetablePdfPages([makeRotatedOverviewPage(),makeRotatedTeacherPage()]);
 if(parsed.diagnostics.blockingErrors.length)throw new Error(parsed.diagnostics.blockingErrors.join(" | "));
 if(parsed.diagnostics.pageCount!==2||parsed.diagnostics.skippedPages.length!==1||parsed.diagnostics.skippedPages[0]!==1)throw new Error("The aggregate first page was not identified and skipped");
 if(parsed.diagnostics.teacherPageCount!==1||parsed.weeklyDays[0]!.teachers.length!==1)throw new Error("The rotated teacher page was not imported");
 const rows=parsed.sheets["الحصص"]! as Array<Array<string|number>>;
 if(rows.length!==2||rows[1][3]!=="الأحد"||Number(rows[1][4])!==1)throw new Error("Rotated page lesson coordinates were mapped to the wrong day or period");
 if(parsed.weeklyDays[0]!.teachers[0]!.sourceName!=="احمد خالد محمد السالمي")throw new Error("Rotated teacher-name fragments were not reconstructed");
});
Deno.test("PDF viewport transforms rotate text matrices and horizontal grid dividers",()=>{
 const textItem=transformPdfTextItem({str:"الرياضيات",transform:[0,8,-8,0,167,681],width:50,height:8},ROTATE_90);
 if(textItem.transform[0]!==8||textItem.transform[1]!==0||textItem.transform[4]!==681||textItem.transform[5]!==167)throw new Error("Text matrix was not rotated into landscape coordinates");
 const lines=transformPdfGridLines([{x1:100,x2:500,y:300}],[],ROTATE_90);
 if(lines.verticalLines.length!==1||lines.verticalLines[0].x!==300||lines.verticalLines[0].y1!==100||lines.verticalLines[0].y2!==500)throw new Error("Horizontal PDF divider was not converted to a vertical timetable divider");
});
Deno.test("PDF parser rebuilds a teacher name split into vertically stacked fragments",()=>{
 const page=makeTeacherPage();
 page.items=page.items.filter((item:any)=>item.str!=="أحمد خالد محمد السالمي");
 page.items.unshift(
  rotatedNamePart("السالمي",228,118),
  rotatedNamePart("محمد",350,77),
  rotatedNamePart("خالد",429,190),
  rotatedNamePart("أحمد",492,58),
 );
 const parsed=parseTimetablePdfPages([page]);
 if(parsed.diagnostics.blockingErrors.length)throw new Error(parsed.diagnostics.blockingErrors.join(" | "));
 const teacher=parsed.weeklyDays[0]!.teachers[0]!;
 if(teacher.sourceName!=="احمد خالد محمد السالمي")throw new Error("Teacher name fragments were not joined in canonical reading order: "+teacher.sourceName);
 if(normalizePdfArabic(teacher.sourceNameOriginal)!==teacher.sourceName)throw new Error("Original teacher name fragments were not retained");
});

Deno.test("PDF parser follows the real RTL layout: weekdays are rows and periods are columns",()=>{
 const page=makeTeacherPage(2,cell(1,0,"الرياضيات","1/12/6/12"));
 const parsed=parseTimetablePdfPages([page]);
 if(parsed.diagnostics.blockingErrors.length)throw new Error(parsed.diagnostics.blockingErrors.join(" | "));
 const rows=parsed.sheets["الحصص"]! as Array<Array<string|number>>;
 if(rows.length!==2||rows[1][3]!=="الأحد"||Number(rows[1][4])!==1)throw new Error("The first right-to-left period was not mapped to Sunday");
 if(rows[1][1]!=="1/12، 6/12")throw new Error("Multiple class groups were not preserved");
 if(parsed.weeklyDays[0]!.teachers[0]!.cells.length!==7)throw new Error("Seven-period grid size is incorrect");
});

Deno.test("PDF parser detects eight periods dynamically",()=>{
 const page=makeTeacherPage(2,cell(8,4,"اللغة العربية","5/9"),8);
 const parsed=parseTimetablePdfPages([page]);
 if(parsed.diagnostics.blockingErrors.length)throw new Error(parsed.diagnostics.blockingErrors.join(" | "));
 if(parsed.diagnostics.periodCount!==8||parsed.weeklyDays[4]!.teachers[0]!.cells.length!==8)throw new Error("The eighth period was not detected");
 const rows=parsed.sheets["الحصص"]! as Array<Array<string|number>>;
 if(Number(rows[1][4])!==8||rows[1][3]!=="الخميس")throw new Error("The eighth period was assigned to the wrong day or slot");
});

Deno.test("A missing vertical divider expands a merged cell into two periods",()=>{
 const page=makeTeacherPage(2,cell(5,0,"العلوم","5/10"),7,[[0,5]]);
 const parsed=parseTimetablePdfPages([page]);
 if(parsed.diagnostics.blockingErrors.length)throw new Error(parsed.diagnostics.blockingErrors.join(" | "));
 const rows=parsed.sheets["الحصص"]! as Array<Array<string|number>>;
 if(rows.length!==3||Number(rows[1][4])!==5||Number(rows[2][4])!==6)throw new Error("Merged periods were not expanded");
 if(parsed.diagnostics.expandedPeriodCount!==2)throw new Error("Merged-cell diagnostics are incorrect");
});

Deno.test("Variable teacher counts are accepted without a fixed school-wide count",()=>{
 const parsed=parseTimetablePdfPages([makeTeacherPage(2,cell(1,0,"الرياضيات")),makeTeacherPage(3,cell(2,1,"العلوم"),7,[],"حسان محمد عبدالله الجابري")]);
 if(parsed.diagnostics.blockingErrors.length||parsed.diagnostics.teacherPageCount!==2)throw new Error("The parser incorrectly assumes a fixed teacher count");
});

Deno.test("Science release spellings normalize while original source text is retained",()=>{
 for(const source of ["E العلوم","E علوم","إ علوم"])if(normalizePdfSubject(source)!=="تفريغ العلوم")throw new Error(source+" was not normalized");
 const parsed=parseTimetablePdfPages([makeTeacherPage(2,[textAt("إ علوم",PX[0],DY[0])])]);
 const rows=parsed.sheets["الحصص"]! as Array<Array<string|number>>;
 if(rows[1][2]!=="تفريغ العلوم"||rows[1][7]!=="إ علوم")throw new Error("Normalized subject or original source text was lost");
});

Deno.test("PDF vector path readers extract horizontal and vertical dividers",()=>{
 const OPS={constructPath:99,moveTo:1,lineTo:2,rectangle:3,curveTo:4,curveTo2:5,curveTo3:6,closePath:7};
 const horizontal=extractHorizontalLinesFromOperatorList({fnArray:[99],argsArray:[[new Uint8Array([1,2]),new Float32Array([110,643,201,643])]]},OPS);
 if(horizontal.length!==1||horizontal[0].x1!==110||horizontal[0].x2!==201)throw new Error("Horizontal divider extraction failed");
 const vertical=extractVerticalLinesFromOperatorList({fnArray:[99],argsArray:[[new Uint8Array([1,2]),new Float32Array([310,643,310,538])]]},OPS);
 if(vertical.length!==1||vertical[0].x!==310||vertical[0].y1!==538||vertical[0].y2!==643)throw new Error("Vertical divider extraction failed");
});

Deno.test("PDF parser blocks pages with missing or unverifiable grid geometry",()=>{
 const page=makeTeacherPage();page.verticalLines=[];
 const parsed=parseTimetablePdfPages([page]);
 if(!parsed.diagnostics.blockingErrors.some(item=>item.includes("حدود الخانات")))throw new Error("Missing grid geometry must block import");
});
