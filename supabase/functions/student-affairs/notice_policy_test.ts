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

Deno.test("absence already recorded in a prior notice stays daily-deduplicated across periods", () => {
  const prior = { class_name: "9/1", student_name: "طالب", issue_number: 1, issued_on: "2026-11-02", events: [{ type: "absent", date: "2026-11-02", period: "1", note: "" }] };
  const result = buildNoticeCandidates({
    attendance: [session("9/1", "2026-11-03", 1, { "طالب": "absent" }), session("9/1", "2026-11-03", 2, { "طالب": "absent" })],
    behaviors: [], history: [prior], roster: [], selected_types: ["absent"], threshold: 1, period_end: "2026-11-03"
  });
  if (result.length !== 1 || result[0].events.length !== 1) throw new Error("daily absence count was not preserved");
});

import { validateNoticeIssueItem } from "./notice_policy.ts";

const validNoticeItem = () => ({
  class_name: "9/1", student_name: "طالب تجريبي", issued_on: "2026-11-20",
  issued_by_type: "teacher", issued_by_name: "معلم تجريبي", delivered: false,
  threshold: 2, period_start: "2026-11-01", period_end: "2026-11-20",
  selected_types: ["late", "chaos"],
  events: [
    { type: "late", date: "2026-11-03", period: "1", note: "" },
    { type: "chaos", date: "2026-11-04", period: "2", note: "ملاحظة" }
  ]
});

Deno.test("official notice payload accepts a complete valid item", () => {
  if (validateNoticeIssueItem(validNoticeItem()) !== null) throw new Error("valid official notice rejected");
});

Deno.test("official notice payload rejects unsupported principal types before RPC", () => {
  const item = validNoticeItem(); item.issued_by_type = "visitor";
  if (!validateNoticeIssueItem(item)?.includes("نوع حساب")) throw new Error("unsupported principal type was not identified");
});

Deno.test("official notice payload rejects malformed date windows", () => {
  const item = validNoticeItem(); item.period_end = "2026-11-19";
  if (!validateNoticeIssueItem(item)?.includes("نهاية فترة")) throw new Error("period end before issue date was accepted");
  const impossible = validNoticeItem(); impossible.issued_on = "2026-02-31";
  if (!validateNoticeIssueItem(impossible)?.includes("تاريخ إصدار")) throw new Error("impossible issue date was accepted");
});

Deno.test("official notice payload rejects invalid selected types and empty events", () => {
  const typeItem = validNoticeItem(); typeItem.selected_types = ["present"];
  if (!validateNoticeIssueItem(typeItem)?.includes("قائمة أنواع")) throw new Error("unsupported selected type accepted");
  const eventItem = validNoticeItem(); eventItem.events = [];
  if (!validateNoticeIssueItem(eventItem)?.includes("لا توجد وقائع")) throw new Error("empty event list accepted");
});

Deno.test("official notice payload rejects event dates and categories outside the selected window", () => {
  const dateItem = validNoticeItem(); dateItem.events[0].date = "2026-11-21";
  if (!validateNoticeIssueItem(dateItem)?.includes("تاريخ إحدى الوقائع")) throw new Error("event after period end accepted");
  const typeItem = validNoticeItem(); typeItem.events[0].type = "present";
  if (!validateNoticeIssueItem(typeItem)?.includes("نوع إحدى الوقائع")) throw new Error("event category mismatch accepted");
});

Deno.test("official notice payload rejects empty issuer, invalid threshold and missing period", () => {
  const issuer = validNoticeItem(); issuer.issued_by_name = " ";
  if (!validateNoticeIssueItem(issuer)?.includes("اسم مصدر")) throw new Error("empty issuer accepted");
  const threshold = validNoticeItem(); threshold.threshold = 0;
  if (!validateNoticeIssueItem(threshold)?.includes("حد المخالفات")) throw new Error("invalid threshold accepted");
  const period = validNoticeItem(); period.events[0].period = "";
  if (!validateNoticeIssueItem(period)?.includes("رقم الحصة")) throw new Error("empty event period accepted");
});
