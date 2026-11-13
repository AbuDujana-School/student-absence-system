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
