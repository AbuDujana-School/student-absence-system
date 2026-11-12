import { buildNoticeCandidates } from "./notice_policy.ts";

const session = (class_name: string, date_str: string, period: number, records: Record<string, unknown>) =>
  ({ class_name, date_str, period, records });

Deno.test("first official notice starts at number one after threshold", () => {
  const result = buildNoticeCandidates({
    attendance: [session("9/1", "2026-11-02", 1, { "طالب تجريبي": "late" }), session("9/1", "2026-11-03", 2, { "طالب تجريبي": "escape" })],
    behaviors: [], history: [], roster: [], selected_types: ["late", "escape"], threshold: 2, period_end: "2026-11-03"
  });
  if (result.length !== 1 || result[0].issue_number !== 1 || result[0].events.length !== 2) throw new Error("first notice calculation failed");
});

Deno.test("previously issued events are excluded and next notice number increments", () => {
  const prior = { class_name: "9/1", student_name: "طالب تجريبي", issue_number: 1, issued_on: "2026-11-02", events: [{ type: "late", date: "2026-11-02", period: "1", note: "" }] };
  const result = buildNoticeCandidates({
    attendance: [session("9/1", "2026-11-02", 1, { "طالب تجريبي": "late" }), session("9/1", "2026-11-03", 2, { "طالب تجريبي": "escape" }), session("9/1", "2026-11-04", 1, { "طالب تجريبي": "late" })],
    behaviors: [], history: [prior], roster: [], selected_types: ["late", "escape"], threshold: 2, period_end: "2026-11-04"
  });
  if (result.length !== 1 || result[0].issue_number !== 2 || result[0].events.length !== 2) throw new Error("incremental notice calculation failed");
});

Deno.test("absence is counted once per day while a new period on the same day is retained for other types", () => {
  const result = buildNoticeCandidates({
    attendance: [session("9/1", "2026-11-02", 1, { "طالب": "absent" }), session("9/1", "2026-11-02", 2, { "طالب": "absent" }), session("9/1", "2026-11-02", 3, { "طالب": "late" })],
    behaviors: [], history: [], roster: [], selected_types: ["absent", "late"], threshold: 2, period_end: "2026-11-02"
  });
  if (result.length !== 1 || result[0].events.length !== 2) throw new Error("daily absence dedupe failed");
});

Deno.test("selected types filter unrelated attendance and behavior records", () => {
  const result = buildNoticeCandidates({
    attendance: [session("9/1", "2026-11-02", 1, { "طالب": "late" })],
    behaviors: [session("9/1", "2026-11-02", 2, { "طالب": { type: "chaos", note: "" } })],
    history: [], roster: [], selected_types: ["chaos"], threshold: 1, period_end: "2026-11-02"
  });
  if (result.length !== 1 || result[0].events[0].type !== "chaos") throw new Error("selected type filter failed");
});

Deno.test("a previously notified student receives no next notice below the new-period threshold", () => {
  const prior = { class_name: "9/1", student_name: "طالب تجريبي", issue_number: 1, issued_on: "2026-11-02", events: [{ type: "late", date: "2026-11-02", period: "1", note: "" }] };
  const result = buildNoticeCandidates({
    attendance: [session("9/1", "2026-11-02", 1, { "طالب تجريبي": "late" }), session("9/1", "2026-11-10", 2, { "طالب تجريبي": "escape" })],
    behaviors: [], history: [prior], roster: [], selected_types: ["late", "escape"], threshold: 2, period_end: "2026-11-12"
  });
  if (result.length !== 0) throw new Error("a below-threshold new period incorrectly issued a second notice");
});

Deno.test("new notice window excludes all pre-issue events, even if an earlier notice used different filters", () => {
  const prior = { class_name: "9/1", student_name: "طالب تجريبي", issue_number: 1, issued_on: "2026-11-02", events: [{ type: "late", date: "2026-11-02", period: "1", note: "" }] };
  const result = buildNoticeCandidates({
    attendance: [
      session("9/1", "2026-10-30", 1, { "طالب تجريبي": "escape" }),
      session("9/1", "2026-11-02", 2, { "طالب تجريبي": "escape" }),
      session("9/1", "2026-11-03", 1, { "طالب تجريبي": "escape" }),
      session("9/1", "2026-11-04", 2, { "طالب تجريبي": "late" })
    ],
    behaviors: [], history: [prior], roster: [], selected_types: ["late", "escape"], threshold: 2, period_end: "2026-11-04"
  });
  if (result.length !== 1 || result[0].issue_number !== 2 || result[0].events.length !== 2) throw new Error("new monitoring window did not begin after prior official issue");
  if (result[0].period_start !== "2026-11-03") throw new Error("next monitoring period start date is incorrect");
});
