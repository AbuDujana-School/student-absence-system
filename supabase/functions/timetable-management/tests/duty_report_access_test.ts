import {
  assignedDutyDay,
  canReadDutyReportPeriod,
  isDutyReportEligibleOnDay,
} from "../duty_report_access.ts";

const SETTINGS = {
  subjectDays: {
    "الرياضيات": "الأربعاء",
    "اللغة الإنجليزية": "الاثنين",
  },
  periods: [
    { start: "07:10", end: "07:45" },
    { start: "07:45", end: "08:25" },
    { start: "08:25", end: "09:05" },
    { start: "09:05", end: "09:45" },
    { start: "10:05", end: "10:40" },
    { start: "10:40", end: "11:25" },
    { start: "11:25", end: "12:00" },
    { start: "11:25", end: "12:00" },
  ],
  graceMinutes: 5,
};

const WEDNESDAY = new Date("2026-11-18T07:20:00+04:00");

Deno.test("personal duty day overrides the category rotation, matching the application", () => {
  const permissions = { dutyDay: "الخميس", category: "الرياضيات" };
  if (assignedDutyDay(permissions, SETTINGS.subjectDays) !== "الخميس") {
    throw new Error("Personal duty day did not override the category day");
  }
  if (isDutyReportEligibleOnDay("teacher", permissions, SETTINGS.subjectDays, "الأربعاء")) {
    throw new Error("Teacher assigned to Thursday was incorrectly authorized on Wednesday");
  }
  if (!isDutyReportEligibleOnDay("teacher", permissions, SETTINGS.subjectDays, "الخميس")) {
    throw new Error("Teacher assigned to their personal Thursday was denied");
  }
});

Deno.test("category-based duty day authorizes the teacher on the configured day", () => {
  const permissions = { category: "الرياضيات" };
  if (assignedDutyDay(permissions, SETTINGS.subjectDays) !== "الأربعاء") {
    throw new Error("Category duty day was not resolved");
  }
  if (!isDutyReportEligibleOnDay("teacher", permissions, SETTINGS.subjectDays, "الأربعاء")) {
    throw new Error("Category-assigned duty teacher was denied");
  }
  if (isDutyReportEligibleOnDay("teacher", permissions, SETTINGS.subjectDays, "الاثنين")) {
    throw new Error("Category-assigned teacher was authorized on the wrong day");
  }
});

Deno.test("disabled dutyToday flag blocks category-based duty access", () => {
  if (isDutyReportEligibleOnDay(
    "teacher",
    { category: "الرياضيات", dutyToday: false },
    SETTINGS.subjectDays,
    "الأربعاء",
  )) {
    throw new Error("Teacher explicitly disabled for duty today was authorized");
  }
});

Deno.test("direct duty and administrator permissions preserve their existing override", () => {
  for (const permissions of [{ duty: true }, { admin: true }]) {
    if (!isDutyReportEligibleOnDay("teacher", permissions, {}, "الأربعاء")) {
      throw new Error("Direct duty/admin permission was denied");
    }
  }
  if (!isDutyReportEligibleOnDay("custom", { duty: true }, {}, "الأربعاء")) {
    throw new Error("Custom account with explicit duty permission was denied");
  }
});

Deno.test("category duty teacher can read the currently open period after grace", () => {
  const allowed = canReadDutyReportPeriod({
    principalType: "teacher",
    permissions: { category: "الرياضيات" },
    subjectDays: SETTINGS.subjectDays,
    date: "2026-11-18",
    weekday: "الأربعاء",
    period: 1,
    periods: SETTINGS.periods,
    graceMinutes: 5,
    now: WEDNESDAY,
  });
  if (!allowed) throw new Error("On-duty teacher was denied the valid current period");
});

Deno.test("category duty teacher is denied before the grace window opens", () => {
  const allowed = canReadDutyReportPeriod({
    principalType: "teacher",
    permissions: { category: "الرياضيات" },
    subjectDays: SETTINGS.subjectDays,
    date: "2026-11-18",
    weekday: "الأربعاء",
    period: 1,
    periods: SETTINGS.periods,
    graceMinutes: 5,
    now: new Date("2026-11-18T07:14:00+04:00"),
  });
  if (allowed) throw new Error("Teacher was authorized before the period grace window");
});

Deno.test("category duty teacher is denied after the requested period ends", () => {
  const allowed = canReadDutyReportPeriod({
    principalType: "teacher",
    permissions: { category: "الرياضيات" },
    subjectDays: SETTINGS.subjectDays,
    date: "2026-11-18",
    weekday: "الأربعاء",
    period: 1,
    periods: SETTINGS.periods,
    graceMinutes: 5,
    now: new Date("2026-11-18T07:46:00+04:00"),
  });
  if (allowed) throw new Error("Teacher was authorized after the requested period ended");
});

Deno.test("category duty teacher cannot use another day or another period time window", () => {
  const wrongDate = canReadDutyReportPeriod({
    principalType: "teacher",
    permissions: { category: "الرياضيات" },
    subjectDays: SETTINGS.subjectDays,
    date: "2026-11-19",
    weekday: "الأربعاء",
    period: 1,
    periods: SETTINGS.periods,
    graceMinutes: 5,
    now: WEDNESDAY,
  });
  const wrongPeriod = canReadDutyReportPeriod({
    principalType: "teacher",
    permissions: { category: "الرياضيات" },
    subjectDays: SETTINGS.subjectDays,
    date: "2026-11-18",
    weekday: "الأربعاء",
    period: 7,
    periods: SETTINGS.periods,
    graceMinutes: 5,
    now: WEDNESDAY,
  });
  if (wrongDate || wrongPeriod) throw new Error("Duty access was granted for a mismatched date or closed period");
});

Deno.test("invalid period, schedule, and non-teacher category assignment are denied", () => {
  const common = {
    principalType: "teacher",
    permissions: { category: "الرياضيات" },
    subjectDays: SETTINGS.subjectDays,
    date: "2026-11-18",
    weekday: "الأربعاء",
    periods: SETTINGS.periods,
    graceMinutes: 5,
    now: WEDNESDAY,
  };
  if (canReadDutyReportPeriod({ ...common, period: 0 })) throw new Error("Invalid period number was accepted");
  if (canReadDutyReportPeriod({ ...common, period: 1, periods: [] })) throw new Error("Missing period schedule was accepted");
  if (canReadDutyReportPeriod({
    ...common,
    principalType: "custom",
    permissions: { category: "الرياضيات" },
    period: 1,
  })) throw new Error("Custom account gained category-based duty access");
});
