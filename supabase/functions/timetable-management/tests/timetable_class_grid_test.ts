import { aggregateClassTimetables } from "../timetable_class_grid.ts";
const DAYS=["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس"];
Deno.test("class timetable aggregates subjects and teachers into five-day grid",()=>{
 const cells:any[]=[];
 for(const day of DAYS)for(let period=1;period<=7;period++)cells.push({weekday:day,period,cell_status:"teaching",class_sections:["11 أول"],subject:"الرياضيات",matched_teacher_name:"أحمد"});
 const result=aggregateClassTimetables(cells,DAYS,7);
 if(result.length!==1||result[0].entries.length!==35||!result[0].complete)throw new Error("A complete 7-period class grid should contain 35 assignments");
 if(result[0].entries[0].teacherName!=="أحمد")throw new Error("Teacher name was not preserved");
});
Deno.test("class timetable reports missing periods as vacancies",()=>{
 const cells:any[]=[{weekday:"الأحد",period:1,cell_status:"teaching",class_sections:["11 أول"],subject:"العلوم",matched_teacher_name:"معلم"}];
 const result=aggregateClassTimetables(cells,DAYS,8)[0];
 if(result.vacancies.length!==39||result.vacancies[0].weekday!=="الأحد"||result.vacancies[0].period!==2)throw new Error("Missing class periods must be reported exactly");
});
Deno.test("class timetable exposes collisions instead of overwriting one teacher",()=>{
 const cells:any[]=[
  {weekday:"الأحد",period:1,class_sections:["11 أول"],subject:"رياضيات",matched_teacher_name:"أحمد"},
  {weekday:"الأحد",period:1,class_sections:["11 أول"],subject:"علوم",matched_teacher_name:"خالد"}
 ];
 const result=aggregateClassTimetables(cells,DAYS,7)[0];
 if(result.conflicts.length!==1||result.conflicts[0].assignments.length!==2)throw new Error("Both conflicting assignments must remain visible");
});
Deno.test("class aggregation preserves separate groups in one teacher cell",()=>{
 const result=aggregateClassTimetables([{weekday:"الأحد",period:1,class_sections:["11 أول","11 ثاني"],subject:"اللغة العربية",matched_teacher_name:"أحمد"}],DAYS,7);
 if(result.length!==2||!result.some(item=>item.className==="11 أول")||!result.some(item=>item.className==="11 ثاني"))throw new Error("Parallel groups must each receive their own schedule");
});

Deno.test("class timetable never displays an unlinked PDF source abbreviation as a teacher name",()=>{
 const result=aggregateClassTimetables([{weekday:"الأحد",period:1,class_sections:["11 أول"],subject:"الرياضيات",teacher_source_name:"أ.م."}],DAYS,7)[0];
 if(result.entries[0].teacherName!=="")throw new Error("Unlinked source abbreviations must not be displayed as teacher names");
 if(result.entries[0].subject!=="الرياضيات")throw new Error("Subject must remain available when teacher is not linked");
});

Deno.test("class timetable sorts grade 9 through 12 numerically, then sections",()=>{
 const result=aggregateClassTimetables([],DAYS,7,["1/10","2/10","1/9","2/9","1/12","1/11"]);
 const names=result.map(item=>item.className);
 const expected=["1/9","2/9","1/10","2/10","1/11","1/12"];
 if(JSON.stringify(names)!==JSON.stringify(expected))throw new Error("Class order must be grade-first and numeric: "+names.join(", "));
});
Deno.test("class timetable sorts Arabic-Indic class digits numerically",()=>{
 const result=aggregateClassTimetables([],DAYS,7,["١/١٠","١/٩","١/١٢","١/١١"]);
 const names=result.map(item=>item.className);
 const expected=["١/٩","١/١٠","١/١١","١/١٢"];
 if(JSON.stringify(names)!==JSON.stringify(expected))throw new Error("Arabic-Indic class order is incorrect: "+names.join(", "));
});


Deno.test("class timetable renders explicitly marked elective groups separately from real conflicts",()=>{
 const cells:any[]=[
  {weekday:"الأحد",period:1,cell_status:"teaching",class_sections:["1/12"],subject:"الأحياء",matched_teacher_name:"معلم أ",source_group_note:"مجموعة مادة اختيارية"},
  {weekday:"الأحد",period:1,cell_status:"teaching",class_sections:["1/12"],subject:"الفنون التشكيلية",matched_teacher_name:"معلم ب",source_group_note:"مجموعة مادة اختيارية"},
  {weekday:"الأحد",period:2,cell_status:"teaching",class_sections:["1/12"],subject:"الرياضيات",matched_teacher_name:"معلم ج"},
  {weekday:"الأحد",period:2,cell_status:"teaching",class_sections:["1/12"],subject:"العلوم",matched_teacher_name:"معلم د"}
 ];
 const result=aggregateClassTimetables(cells,DAYS,7,["1/12"])[0];
 if(result.parallelGroups.length!==1)throw new Error("An explicitly marked elective slot must be a parallel group");
 if(result.conflicts.length!==1)throw new Error("An unmarked double assignment must remain a real conflict");
 if(result.parallelGroups[0].assignments.length!==2)throw new Error("All elective group subjects must remain visible");
});
