import { parseTimetableDay } from "./timetable_grid.ts";
const sample=`جدول يوم الخميس
1. معلم تجريبي (صفحة PDF: 2)
الحصة الأولى:
- الصف والشعبة: 3/12
- المادة: التربية الاسلامية
- الحالة: تدريس
الحصة الثانية:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة الثالثة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة الرابعة:
- الصف والشعبة: 6/11، 7/11
- المادة: الجغرافيا الاقتصادية
- الحالة: تدريس
الحصة الخامسة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة السادسة:
- الصف والشعبة: غير واضح
- المادة: إ العلوم
- الحالة: غير واضح
الحصة السابعة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ`;
Deno.test("parses seven explicit cells and retains free and unclear statuses",()=>{
 const result=parseTimetableDay("الخميس",sample);
 if(result.teachers.length!==1||result.totalCells!==7)throw new Error("One complete teacher grid should produce seven cells");
 if(result.totals.teaching!==2||result.totals.free!==4||result.totals.unclear!==1)throw new Error("Cell status totals are incorrect");
 if(result.teachers[0].cells[0].subject!=="التربية الإسلامية")throw new Error("Approved Islamic Education subject name was not normalized");
 if(result.teachers[0].cells[3].classSections.join("|")!=="6/11|7/11")throw new Error("Parallel class groups were not retained");
 if(result.teachers[0].cells[5].status!=="unclear")throw new Error("Unclear source value must not be converted to free");
});
Deno.test("rejects a teacher when one period is missing",()=>{
 const incomplete=sample.replace(/الحصة السابعة:[\s\S]*$/,"");
 let rejected=false;
 try{parseTimetableDay("الخميس",incomplete);}catch(error){rejected=String(error).includes("السبع");}
 if(!rejected)throw new Error("A six-period teacher record must be rejected");
});
Deno.test("rejects incomplete cell fields rather than filling them with defaults",()=>{
 const incomplete=sample.replace("- الحالة: تدريس","");
 let rejected=false;
 try{parseTimetableDay("الخميس",incomplete);}catch(error){rejected=String(error).includes("الحالة");}
 if(!rejected)throw new Error("Missing status should fail validation");
});
Deno.test("rejects duplicate teacher names and invalid weekdays",()=>{
 const duplicate=sample+"\n"+sample.slice(sample.indexOf("1. معلم"));
 let rejectedDuplicate=false,rejectedDay=false;
 try{parseTimetableDay("الخميس",duplicate);}catch{rejectedDuplicate=true;}
 try{parseTimetableDay("الجمعة",sample);}catch{rejectedDay=true;}
 if(!rejectedDuplicate||!rejectedDay)throw new Error("Duplicate teachers and unsupported days must be rejected");
});

const schoolMessageFormat=`اليوم الثاني: الاثنين
اسم المعلم: أحمد خالد محمد السالمي
الحصة الأولى:
- الصف والشعبة: 2/12
- المادة: التربية الاسلامية
- الحالة: تدريس
الحصة الثانية:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة الثالثة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة الرابعة:
- الصف والشعبة: 1/12
- المادة: التربية الاسلامية
- الحالة: تدريس
الحصة الخامسة:
- الصف والشعبة: اجتماع المادة
- المادة: التربية الاسلامية
- الحالة: اجتماع المادة
الحصة السادسة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة السابعة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ

اسم المعلم: معلم ثانٍ
الحصة الأولى:
- الصف والشعبة: 3/12
- المادة: اللغة العربية
- الحالة: تدريس
الحصة الثانية:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة الثالثة:
- الصف والشعبة: 4/12
- المادة: اللغة العربية
- الحالة: تدريس
الحصة الرابعة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة الخامسة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة السادسة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ
الحصة السابعة:
- الصف والشعبة: فراغ
- المادة: فراغ
- الحالة: فراغ`;
Deno.test("parses the original school message format with named teachers and day heading",()=>{
 const result=parseTimetableDay("الاثنين",schoolMessageFormat);
 if(result.teachers.length!==2||result.totalCells!==14)throw new Error("Expected two teachers and fourteen explicit cells");
 if(result.teachers[0].sourceName!=="أحمد خالد محمد السالمي")throw new Error("Full teacher source name was not preserved");
 if(result.teachers[0].pdfPage!==null)throw new Error("Missing PDF page should remain unknown, not fabricated");
 if(result.teachers[0].cells[4].status!=="meeting")throw new Error("Subject meeting should be classified as meeting");
 if(result.teachers[0].cells[1].status!=="free")throw new Error("Explicit free period was not recognized");
});
Deno.test("rejects a daily message whose heading conflicts with the selected day",()=>{
 let rejected=false;
 try{parseTimetableDay("الأحد",schoolMessageFormat);}catch(error){rejected=String(error).includes("اليوم المختار");}
 if(!rejected)throw new Error("A weekday mismatch must not be silently accepted");
});

const tabSeparatedDay=`اليوم: الأحد
اسم المعلم	اليوم	الحصة	الصف والشعبة	المادة	الحالة	الملاحظات
عبدالهادي عبدالله محمد البلوشي	الأحد	1	1-Dec	الرياضيات المتقدمة	تدريس	مجموعة اختيارية 1
عبدالهادي عبدالله محمد البلوشي	الأحد	2	فراغ	فراغ	فارغ	حصة فراغ
عبدالهادي عبدالله محمد البلوشي	الأحد	3	3/12	الرياضيات المتقدمة	تدريس	
عبدالهادي عبدالله محمد البلوشي	الأحد	4	اجتماع المادة	الرياضيات المتقدمة	اجتماع المادة	اجتماع القسم
عبدالهادي عبدالله محمد البلوشي	الأحد	5	5/12	الرياضيات المتقدمة	تدريس	
عبدالهادي عبدالله محمد البلوشي	الأحد	6	غير واضح	غير واضح	غير واضح	راجع المصدر
عبدالهادي عبدالله محمد البلوشي	الأحد	7	فراغ	فراغ	فارغ	حصة فراغ`;
Deno.test("parses the original tab-separated timetable rows and preserves optional notes",()=>{
 const result=parseTimetableDay("الأحد",tabSeparatedDay);
 const teacher=result.teachers[0];
 if(result.teachers.length!==1||result.totalCells!==7)throw new Error("Expected one teacher and seven weekly-grid cells");
 if(teacher.sourceName!=="عبدالهادي عبدالله محمد البلوشي")throw new Error("Full teacher name must be retained");
 if(teacher.cells[0].classSections[0]!=="1-Dec")throw new Error("Class section source value was not retained");
 if(teacher.cells[0].sourceNote!=="مجموعة اختيارية 1")throw new Error("Optional group note was not retained");
 if(teacher.cells[1].status!=="free")throw new Error("Explicit empty status should be free");
 if(teacher.cells[3].status!=="meeting")throw new Error("Subject meeting should be classified as meeting");
 if(teacher.cells[5].status!=="unclear")throw new Error("Unclear cells must remain unclear");
});
Deno.test("merges multiple tab-separated classes for the same teacher period only when the subject and status agree",()=>{
 const rows=tabSeparatedDay.replace("عبدالهادي عبدالله محمد البلوشي\tالأحد\t2\tفراغ\tفراغ\tفارغ\tحصة فراغ",
   "عبدالهادي عبدالله محمد البلوشي\tالأحد\t1\t2-Dec\tالرياضيات المتقدمة\tتدريس\tمجموعة اختيارية 2\nعبدالهادي عبدالله محمد البلوشي\tالأحد\t2\tفراغ\tفراغ\tفارغ\tحصة فراغ");
 const result=parseTimetableDay("الأحد",rows);
 const first=result.teachers[0].cells.find(cell=>cell.period===1)!;
 if(first.classSections.join("|")!=="1-Dec|2-Dec")throw new Error("Parallel class sections should be retained in one period cell");
 if(!first.sourceNote?.includes("مجموعة اختيارية 2"))throw new Error("Notes from merged group rows should be retained");
});
Deno.test("rejects tab-separated rows with a conflicting weekday or conflicting period assignment",()=>{
 const wrongDay=tabSeparatedDay.replace("\tالأحد\t1\t","\tالاثنين\t1\t");
 const conflict=tabSeparatedDay.replace("عبدالهادي عبدالله محمد البلوشي\tالأحد\t2\tفراغ\tفراغ\tفارغ\tحصة فراغ",
   "عبدالهادي عبدالله محمد البلوشي\tالأحد\t1\t2-Dec\tاللغة العربية\tتدريس\tمجموعة أخرى");
 let rejectedDay=false,rejectedConflict=false;
 try{parseTimetableDay("الأحد",wrongDay);}catch(error){rejectedDay=String(error).includes("ليس يوم");}
 try{parseTimetableDay("الأحد",conflict);}catch(error){rejectedConflict=String(error).includes("متعارض");}
 if(!rejectedDay||!rejectedConflict)throw new Error("Mismatched day and conflicting same-period rows must be rejected");
});

Deno.test("splits concatenated parallel class codes while preserving the original source text",()=>{
 const combined=sample
   .replace("6/11، 7/11","6/11/7/11");
 const result=parseTimetableDay("الخميس",combined);
 const cell=result.teachers[0].cells.find(value=>value.period===4);
 if(!cell||cell.classSections.join("|")!=="6/11|7/11")throw new Error("Concatenated class codes should be parsed as two parallel sections");
 if(cell.sourceClass!=="6/11/7/11")throw new Error("Original source class text must remain unchanged");
 const three=combined.replace("6/11/7/11","1/12/6/12/7/12/8/12");
 const threeResult=parseTimetableDay("الخميس",three).teachers[0].cells.find(value=>value.period===4);
 if(!threeResult||threeResult.classSections.join("|")!=="1/12|6/12|7/12|8/12")throw new Error("Multiple concatenated class pairs should all be retained");
});
