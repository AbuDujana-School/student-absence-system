import { authorizeReportMode } from "./report_policy.ts";
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
