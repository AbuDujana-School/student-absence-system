import {
  awardWeeklyCompetitionPoints, rankCompetitionTeamsByAccumulatedPoints, buildTeamRates, calculateRelativeCompetitionScores,
  countAttendanceIncidents, countBehaviorIncidents, countAttendanceByStatus, countBehaviorByType, countRepeatStudents, getSchoolDays, getSchoolWeekRange, isCompleteSchoolWeekRange,
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
Deno.test("only an exact Sunday-to-Thursday range is a complete award week", () => {
  if (!isCompleteSchoolWeekRange("2026-11-08", "2026-11-12")) throw new Error("complete school week was rejected");
  if (isCompleteSchoolWeekRange("2026-11-08", "2026-11-10")) throw new Error("partial week was accepted");
  if (isCompleteSchoolWeekRange("2026-11-09", "2026-11-12")) throw new Error("late-start week was accepted");
  if (isCompleteSchoolWeekRange("2026-11-08", "2026-11-19")) throw new Error("multi-week range was accepted as one week");
  if (isCompleteSchoolWeekRange("invalid", "2026-11-12")) throw new Error("invalid date was accepted");
});
Deno.test("attendance events are deduplicated per student, class, date and status", () => {
  const rows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":"absent","طالب ب":"late"} },
    { date_str:"2026-11-08", class_name:"1/9", period:2, records:{"طالب أ":"absent","طالب ب":"escape"} }
  ];
  if (countAttendanceIncidents(rows) !== 3) throw new Error("attendance deduplication failed");
});
Deno.test("absence counts once per day but escape and other attendance events count per period", () => {
  const rows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":"absent","طالب ب":"escape","طالب ج":"late"} },
    { date_str:"2026-11-08", class_name:"1/9", period:2, records:{"طالب أ":"absent","طالب ب":"escape","طالب ج":"late"} }
  ];
  if (countAttendanceIncidents(rows) !== 5) throw new Error("daily absence or per-period attendance counting failed");
  const counts = countAttendanceByStatus(rows);
  if (counts.absent !== 1 || counts.escape !== 2 || counts.late !== 2) throw new Error("attendance status totals do not follow daily/per-period rules");
});
Deno.test("behavior violations are counted separately for each class period", () => {
  const rows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":{type:"talking"}} },
    { date_str:"2026-11-08", class_name:"1/9", period:2, records:{"طالب أ":{type:"talking"}} }
  ];
  if (countBehaviorIncidents(rows) !== 2 || countBehaviorByType(rows).talking !== 2) throw new Error("per-period behavior counting failed");
});
Deno.test("behavior events are counted per student, class, date, period and type", () => {
  const rows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":{type:"talking"},"طالب ب":{type:"normal"}} },
    { date_str:"2026-11-08", class_name:"1/9", period:2, records:{"طالب أ":{type:"talking"},"طالب ب":{type:"sleeping"}} }
  ];
  if (countBehaviorIncidents(rows) !== 3) throw new Error("behavior period counting failed");
});
Deno.test("a team day requires all eight attendance periods, while missing behavior records mean zero", () => {
  const attendance = getSessionCoverage([...sessions("1/9"),...sessions("2/9")]);
  const noBehavior = getSessionCoverage([]);
  if (!isTeamDayComplete(["1/9","2/9"],"2026-11-08",attendance,noBehavior)) throw new Error("missing behavior must be treated as zero");
  const partialAttendance = getSessionCoverage(sessions("1/9").slice(0,7));
  if (isTeamDayComplete(["1/9"],"2026-11-08",partialAttendance,noBehavior)) throw new Error("unsaved attendance period must remain incomplete");
  const full = getSessionCoverage([...sessions("1/9"),...sessions("2/9")]);
  if (!isTeamDayComplete(["1/9","2/9"],"2026-11-08",full,noBehavior)) throw new Error("complete attendance day rejected");
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
Deno.test("missing behavior sessions contribute zero without blocking completed attendance", () => {
  const result = buildTeamRates({
    grade:"فريق أ", classNames:["1/9"], from:"2026-11-08", to:"2026-11-08",
    attendanceRows:sessions("1/9"),
    behaviorRows:[]
  });
  if (!result.complete || result.behaviorIncidents !== 0 || result.behaviorRate !== 0) throw new Error("missing behavior data must be zero, not incomplete");
});
Deno.test("weekly podium ties share places without giving away a skipped award", () => {
  const result = calculateRelativeCompetitionScores([
    { teamName:"أ", complete:true, attendanceRate:0, behaviorRate:0 },
    { teamName:"ب", complete:true, attendanceRate:0, behaviorRate:0 },
    { teamName:"ج", complete:true, attendanceRate:2, behaviorRate:2 },
    { teamName:"د", complete:true, attendanceRate:4, behaviorRate:4 }
  ]);
  if (result[0].score !== 100 || result[1].rank !== 1 || result[2].rank !== 2) throw new Error("weekly competition ranking failed");
  const awards = awardWeeklyCompetitionPoints(result);
  if (awards.map(team => team.weeklyAwardPoints).join(",") !== "10,10,6,3") throw new Error("tied first place must skip second-place award");
});
Deno.test("monthly and term standings rank by accumulated weekly points", () => {
  const ranked = rankCompetitionTeamsByAccumulatedPoints([
    { teamId: "A", teamName: "أ", score: 20 },
    { teamId: "B", teamName: "ب", score: 100 },
    { teamId: "C", teamName: "ج", score: 50 },
    { teamId: "D", teamName: "د", score: 10 }
  ], { A: 16, B: 10, C: 16, D: 0 });
  const byId = Object.fromEntries(ranked.map(team => [team.teamId, team.rank]));
  if (byId.A !== 1 || byId.C !== 1 || byId.B !== 2 || byId.D !== 3) {
    throw new Error("cumulative points must determine standings; ties share a rank");
  }
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

Deno.test("coaching metrics count real attendance and behavior types without exposing student identities", () => {
  const attendanceRows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":"late","طالب ب":"absent"} },
    { date_str:"2026-11-09", class_name:"1/9", period:1, records:{"طالب أ":"late","طالب ج":"escape"} },
    { date_str:"2026-11-09", class_name:"1/9", period:2, records:{"طالب أ":"late"} }
  ];
  const behaviorRows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":{type:"talking"},"طالب ب":{type:"tools"}} },
    { date_str:"2026-11-09", class_name:"1/9", period:1, records:{"طالب أ":{type:"talking"},"طالب ج":{type:"sleeping"}} },
    { date_str:"2026-11-09", class_name:"1/9", period:2, records:{"طالب أ":{type:"talking"}} }
  ];
  const a = countAttendanceByStatus(attendanceRows);
  const b = countBehaviorByType(behaviorRows);
  if (a.late !== 3 || a.absent !== 1 || a.escape !== 1) throw new Error("attendance coaching breakdown must count absence daily and other events per period");
  if (b.talking !== 3 || b.tools !== 1 || b.sleeping !== 1) throw new Error("behavior coaching breakdown must count each period");
  if (countRepeatStudents(attendanceRows, "attendance") !== 1) throw new Error("repeat attendance students must require multiple days");
  if (countRepeatStudents(behaviorRows, "behavior") !== 1) throw new Error("repeat behavior students must require multiple days");
});

Deno.test("competition behavior metrics count every selected type in array records", () => {
  const rows = [
    { date_str:"2026-11-08", class_name:"1/9", period:1, records:{"طالب أ":{types:["eating","talking"],type:"eating"},"طالب ب":{types:[],type:"normal"}} },
    { date_str:"2026-11-09", class_name:"1/9", period:1, records:{"طالب أ":{types:["talking","chaos"],type:"talking"}} }
  ];
  const counts = countBehaviorByType(rows);
  if (countBehaviorIncidents(rows) !== 4) throw new Error("all selected behavior types must count as incidents");
  if (counts.eating !== 1 || counts.talking !== 2 || counts.chaos !== 1) throw new Error("array behavior type breakdown failed");
  if (countRepeatStudents(rows,"behavior") !== 1) throw new Error("repeat behavior students must recognize array records");
});
