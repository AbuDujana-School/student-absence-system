import { canReadStudentAffairsActivityReport, isStudentAffairsActivityTeacher, validActivityEventType } from "./activity_monitor_policy.ts";
Deno.test("activity report is restricted to statistics-enabled teachers and admin principals", () => {
  if (!canReadStudentAffairsActivityReport({type:"teacher",permissions:{studstats:true}})) throw new Error("statistics teacher should be allowed");
  if (canReadStudentAffairsActivityReport({type:"teacher",permissions:{studstats:false}})) throw new Error("teacher without statistics must be denied");
  if (canReadStudentAffairsActivityReport({type:"custom",permissions:{studstats:true}})) throw new Error("custom principal must be denied");
  if (!canReadStudentAffairsActivityReport({type:"admin",permissions:{}})) throw new Error("admin principals should be allowed");
  if (canReadStudentAffairsActivityReport(null)) throw new Error("missing principal must be denied");
});
Deno.test("only active Student Affairs teachers appear in the monitored directory", () => {
  if (!isStudentAffairsActivityTeacher({role:"teacher",permissions:{studentAffairs:true}})) throw new Error("active Student Affairs teacher missing");
  if (isStudentAffairsActivityTeacher({role:"teacher",permissions:{student_affairs_role:"team_leader"}})) throw new Error("inactive role assignment must not be treated as an active Student Affairs member");
  if (isStudentAffairsActivityTeacher({role:"custom",permissions:{studentAffairs:true}})) throw new Error("custom account must not be included");
  if (isStudentAffairsActivityTeacher({role:"teacher",permissions:{}})) throw new Error("ordinary teacher must not be included");
});
Deno.test("client event API accepts only user-visible audited activity types", () => {
  for (const type of ["section_access","absence_report_view","behavior_report_view","official_warning_print"]) if (!validActivityEventType(type)) throw new Error("expected allowed type "+type);
  for (const type of ["official_warning_issued","preview","delete","anything"]) if (validActivityEventType(type)) throw new Error("unexpected allowed type "+type);
});
