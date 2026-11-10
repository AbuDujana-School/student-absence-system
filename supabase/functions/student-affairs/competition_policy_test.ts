import {
  awardWeeklyCompetitionPoints, buildTeamRates, calculateRelativeCompetitionScores,
  countAttendanceIncidents, countBehaviorIncidents, getSchoolDays, getSchoolWeekRange,
  gradeForClassName, isTeamDayComplete, getSessionCoverage
} from "./competition_policy.ts";

const periods = [1,2,3,4,5,6,7,8];
function sessions(className: string, records: Record<string, unknown> = {}, date = "2026-11-08") {
  return periods.map(period => ({ date_str: date, class_name: className, period, records: period === 1 ? records : {} }));
}
Deno.test("grade names and Oman school week remain stable", () => {
  if (gradeForClassName("1/9") !== "9" || gradeForClassName("8/12") !== "12" || gradeForClassName("التاسع 2") !== "9") throw new Error("grade parsing failed");
  if (gradeForClassName("قسم الإدارة") !== null) throw new Error("invalid grade parsed");
  const week = getSchoolWeekRange("2026-11-10");
  if (week.start !== "2026-11-08" || week.end !== "2026-11-12" || getSchoolDays(week.start,week.end).length !== 5) throw new Error("school week must be Sunday-Thursday");
});
Deno.test("attendance events are deduplicated per student, class, date and status", () => {
  const rows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":"absent","طالب ب":"late"} },
    { date_str:"2026-11-08", class_name:"1/9", period:2, records:{"طالب أ":"absent","طالب ب":"escape"} }
  ];
  if (countAttendanceIncidents(rows) !== 3) throw new Error("attendance deduplication failed");
});
Deno.test("behavior events are deduplicated per student, class, date and type", () => {
  const rows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":{type:"talking"},"طالب ب":{type:"normal"}} },
    { date_str:"2026-11-08", class_name:"1/9", period:2, records:{"طالب أ":{type:"talking"},"طالب ب":{type:"sleeping"}} }
  ];
  if (countBehaviorIncidents(rows) !== 2) throw new Error("behavior deduplication failed");
});
Deno.test("a team day requires all eight periods for every assigned class in both domains", () => {
  const attendance = getSessionCoverage([...sessions("1/9"),...sessions("2/9")]);
  const behavior = getSessionCoverage(sessions("1/9"));
  if (isTeamDayComplete(["1/9","2/9"],"2026-11-08",attendance,behavior)) throw new Error("missing class sessions must not count as zero");
  const full = getSessionCoverage([...sessions("1/9"),...sessions("2/9")]);
  if (!isTeamDayComplete(["1/9","2/9"],"2026-11-08",attendance,full)) throw new Error("complete day rejected");
});
Deno.test("team rates are the unweighted average of class rates, not student-weighted rates", () => {
  const team = buildTeamRates({
    grade:"فريق أ", classNames:["1/9","2/9"], from:"2026-11-08", to:"2026-11-08",
    attendanceRows:[...sessions("1/9",{"طالب أ":"absent"}),...sessions("2/9",{"طالب ب":"absent","طالب ج":"late","طالب د":"escape"})],
    behaviorRows:[...sessions("1/9",{"طالب أ":{type:"talking"}}),...sessions("2/9",{"طالب ب":{type:"talking"},"طالب ج":{type:"sleeping"}})]
  });
  if (!team.complete || team.classCount !== 2 || team.attendanceRate !== 2 || team.behaviorRate !== 1.5) throw new Error("class-equal mean is incorrect");
  if (team.classMetrics.length !== 2 || team.classMetrics[0].attendanceRate !== 1 || team.classMetrics[1].attendanceRate !== 3) throw new Error("class metrics missing");
});
Deno.test("relative performance ranks lower attendance and behavior rates higher", () => {
  const result = calculateRelativeCompetitionScores([
    { teamName:"أ", complete:true, attendanceRate:1, behaviorRate:2 },
    { teamName:"ب", complete:true, attendanceRate:2, behaviorRate:4 },
    { teamName:"ج", complete:true, attendanceRate:3, behaviorRate:6 }
  ]);
  if (result[0].teamName !== "أ" || result[0].score !== 100 || result[2].score !== 0) throw new Error("relative ranking failed");
});
Deno.test("only first, second and third places receive unequal weekly points", () => {
  const awards = awardWeeklyCompetitionPoints([
    {rank:1,complete:true},{rank:2,complete:true},{rank:3,complete:true},{rank:4,complete:true},{rank:5,complete:true}
  ]);
  const points = awards.map(item => item.weeklyAwardPoints).join(",");
  if (points !== "10,6,3,0,0") throw new Error("weekly awards must be 10, 6, 3, 0, 0");
});
Deno.test("tied ranks share the same award and incomplete teams receive no points", () => {
  const awards = awardWeeklyCompetitionPoints([
    {rank:1,complete:true},{rank:1,complete:true},{rank:3,complete:true},{rank:4,complete:false}
  ]);
  if (awards[0].weeklyAwardPoints !== 10 || awards[1].weeklyAwardPoints !== 10 || awards[2].weeklyAwardPoints !== 3 || awards[3].weeklyAwardPoints !== null) throw new Error("tie or incomplete award handling failed");
});
Deno.test("incomplete competition never publishes rank or score", () => {
  const result = calculateRelativeCompetitionScores([
    {teamName:"أ",complete:true,attendanceRate:0,behaviorRate:0},
    {teamName:"ب",complete:false,attendanceRate:null,behaviorRate:null}
  ]);
  if (result.some(team=>team.score!==null||team.rank!==null||team.resultStatus!=="incomplete")) throw new Error("incomplete competition leaked ranks");
});
Deno.test("invalid rates are rejected", () => {
  let rejected=false;
  try { calculateRelativeCompetitionScores([{complete:true,attendanceRate:-1,behaviorRate:0},{complete:true,attendanceRate:1,behaviorRate:1}]); } catch { rejected=true; }
  if (!rejected) throw new Error("negative rates accepted");
});
