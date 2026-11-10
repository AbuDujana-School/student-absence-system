import { authorizeReportMode, isValidIsoDate, filterAttendanceRecordMap, filterBehaviorRecordMap, behaviorTypesFromRecord, areClassesAllowed } from "./report_policy.ts";
Deno.test("attendance print requires both read and print permission", () => {
  if (authorizeReportMode({ can_print_attendance: true }, "print_attendance")?.status !== 403) throw new Error("print bypass");
  if (authorizeReportMode({ can_read_attendance: true, can_print_attendance: true }, "print_attendance") !== null) throw new Error("valid attendance print denied");
});
Deno.test("behavior print is independent from attendance", () => {
  if (authorizeReportMode({ can_read_behavior: true, can_print_behavior: true }, "print_behavior") !== null) throw new Error("valid behavior print denied");
  if (authorizeReportMode({ can_read_attendance: true, can_print_attendance: true }, "print_behavior")?.status !== 403) throw new Error("attendance permission leaked into behavior");
});
Deno.test("combined print requires both report read and print permissions", () => {
  const p = { can_read_attendance: true, can_read_behavior: true, can_print_attendance: true, can_print_behavior: true, can_print_combined: true };
  if (authorizeReportMode(p, "print_combined") !== null) throw new Error("valid combined print denied");
  if (authorizeReportMode({ ...p, can_print_combined: false }, "print_combined")?.status !== 403) throw new Error("combined print bypass");
  if (authorizeReportMode({ ...p, can_read_behavior: false }, "print_combined")?.status !== 403) throw new Error("combined read bypass");
});
Deno.test("analytics and view permissions remain separate", () => {
  if (authorizeReportMode({ can_view_analytics: true }, "analytics") !== null) throw new Error("analytics denied");
  if (authorizeReportMode({ can_view_analytics: true }, "view")?.status !== 403) throw new Error("analytics granted report reads");
  if (authorizeReportMode({ can_read_behavior: true }, "view") !== null) throw new Error("behavior view denied");
});
Deno.test("unknown report mode is rejected", () => {
  if (authorizeReportMode({}, "admin_dump")?.status !== 400) throw new Error("unknown mode accepted");
});

Deno.test("ISO date validation rejects impossible calendar dates", () => {
  if (!isValidIsoDate("2024-02-29")) throw new Error("valid leap day rejected");
  if (isValidIsoDate("2025-02-29")) throw new Error("invalid leap day accepted");
  if (isValidIsoDate("2026-02-31")) throw new Error("overflow date accepted");
  if (isValidIsoDate("2026/11/09")) throw new Error("wrong date format accepted");
});

Deno.test("attendance report filtering excludes present and disallowed statuses", () => {
  const records = { A: "present", B: "absent", C: "late", D: "escape", E: "outside" };
  const filtered = filterAttendanceRecordMap(records, ["absent", "late"]);
  if (Object.keys(filtered).join(",") !== "B,C") throw new Error("attendance status permissions leaked");
});
Deno.test("attendance report can be narrowed to one permitted status", () => {
  const records = { A: "absent", B: "late", C: "escape" };
  const filtered = filterAttendanceRecordMap(records, ["absent", "late"], "late");
  if (Object.keys(filtered).join(",") !== "B") throw new Error("single status filter failed");
  if (Object.keys(filterAttendanceRecordMap(records, ["absent"], "late")).length) throw new Error("unpermitted selected status leaked");
});
Deno.test("behavior report excludes normal students and keeps violation details", () => {
  const records = { A: { type: "normal", note: "" }, B: { type: "eating", note: "داخل الفصل" }, C: { type: "homework", note: "لم يحضر الواجب" } };
  const filtered = filterBehaviorRecordMap(records);
  if (Object.keys(filtered).join(",") !== "B,C") throw new Error("normal behavior record was not excluded");
});
Deno.test("record filters reject malformed record payloads", () => {
  if (Object.keys(filterAttendanceRecordMap(null, ["absent"])).length) throw new Error("null attendance accepted");
  if (Object.keys(filterBehaviorRecordMap(["normal"])).length) throw new Error("array behavior payload accepted");
});

Deno.test("class scope rejects any requested class outside the assignment", () => {
  if (!areClassesAllowed(["9/1", "9/2"], ["9/1", "9/2", "9/3"])) throw new Error("valid assigned classes rejected");
  if (areClassesAllowed(["9/1", "10/1"], ["9/1", "9/2"])) throw new Error("unassigned class accepted");
  if (!areClassesAllowed([], ["9/1"])) throw new Error("empty selection should be allowed");
});

Deno.test("attendance report filtering supports multiple selected permitted statuses", () => {
  const records = { A: "absent", B: "late", C: "escape", D: "outside", E: "present" };
  const filtered = filterAttendanceRecordMap(records, ["absent", "late", "escape"], ["absent", "escape"]);
  if (Object.keys(filtered).join(",") !== "A,C") throw new Error("multi-status filter failed");
  if (Object.keys(filterAttendanceRecordMap(records, ["absent"], ["late"])).length) throw new Error("unpermitted multi-status filter leaked");
  if (Object.keys(filterAttendanceRecordMap(records, ["absent", "late"], [])).length) throw new Error("empty status selection should return no records");
});

Deno.test("behavior reports preserve and expand multiple violation types while supporting legacy records", () => {
  const records = {
    A: { types: ["eating", "talking"], type: "eating", note: "" },
    B: { type: "sleeping", note: "" },
    C: { types: [], type: "normal", note: "" }
  };
  const filtered = filterBehaviorRecordMap(records);
  if (Object.keys(filtered).join(",") !== "A,B") throw new Error("multi behavior filtering failed");
  if (behaviorTypesFromRecord(filtered.A).join(",") !== "eating,talking") throw new Error("multiple types were not preserved");
  if (behaviorTypesFromRecord(filtered.B).join(",") !== "sleeping") throw new Error("legacy behavior record was not preserved");
});
