import { behaviorTypesFromRecord } from "./report_policy.ts";

export const NOTICE_ATTENDANCE_TYPES = ["absent", "late", "escape", "outside"] as const;
export const NOTICE_BEHAVIOR_TYPES = ["eating", "talking", "tools", "chaos", "sleeping", "homework", "other"] as const;
export const NOTICE_TYPES = [...NOTICE_ATTENDANCE_TYPES, ...NOTICE_BEHAVIOR_TYPES] as const;

export type NoticeEvent = { type: string; date: string; period: string; note: string };
export type NoticeHistoryRow = {
  class_name: string;
  student_name: string;
  issue_number: number;
  issued_on: string;
  events: NoticeEvent[] | unknown;
};
export type NoticeSession = {
  class_name?: string;
  date_str?: string;
  period?: number | string;
  record_key?: string;
  records?: Record<string, unknown>;
};
export type NoticeCandidate = {
  class_name: string;
  student_name: string;
  issue_number: number;
  previous_issue_on: string | null;
  period_start: string;
  period_end: string;
  events: NoticeEvent[];
};
export type BuildNoticeCandidatesInput = {
  attendance: NoticeSession[];
  behaviors: NoticeSession[];
  history: NoticeHistoryRow[];
  roster: Array<{ class_name: string; student_name: string }>;
  selected_types: string[];
  threshold: number;
  period_end: string;
};

const normalize = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");
const keyOf = (className: string, studentName: string) => className + String.fromCharCode(31) + studentName;
const eventKey = (className: string, studentName: string, event: NoticeEvent) =>
  [className, studentName, event.type, event.date, event.period, event.note].join(String.fromCharCode(31));

function periodOf(session: NoticeSession): string {
  const direct = session.period;
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct);
  const match = String(session.record_key || "").match(/_p(\d+)$/);
  return match ? match[1] : "غير محددة";
}
function validDate(value: unknown, end: string): string {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= end ? date : "";
}

export function buildNoticeCandidates(input: BuildNoticeCandidatesInput): NoticeCandidate[] {
  const selected = new Set(input.selected_types.filter(type => (NOTICE_TYPES as readonly string[]).includes(type)));
  if (!selected.size || !Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > 10) return [];
  const roster = new Map<string, string>();
  for (const row of input.roster || []) {
    const cl = normalize(row.class_name), name = normalize(row.student_name);
    if (cl && name) roster.set(keyOf(cl, name), name);
  }

  const latest = new Map<string, { issue: number; date: string }>();
  const alreadyIssued = new Set<string>();
  for (const row of input.history || []) {
    const cl = normalize(row.class_name), name = normalize(row.student_name);
    if (!cl || !name) continue;
    const key = keyOf(cl, name);
    const prior = latest.get(key);
    const issue = Number(row.issue_number) || 0;
    if (!prior || issue > prior.issue || (issue === prior.issue && String(row.issued_on) > prior.date)) {
      latest.set(key, { issue, date: String(row.issued_on || "").slice(0, 10) });
    }
    if (Array.isArray(row.events)) {
      for (const raw of row.events) {
        if (!raw || typeof raw !== "object") continue;
        const event = raw as NoticeEvent;
        if (event.type && event.date && event.period !== undefined) {
          if (String(event.type) === "absent") absenceDays.add([cl, name, String(event.date).slice(0, 10)].join(String.fromCharCode(31)));
          alreadyIssued.add(eventKey(cl, name, {
            type: String(event.type), date: String(event.date), period: String(event.period), note: normalize(event.note)
          }));
        }
      }
    }
  }

  const grouped = new Map<string, { class_name: string; student_name: string; events: NoticeEvent[] }>();
  const absenceDays = new Set<string>();
  const seenEvents = new Set<string>();
  const add = (classNameRaw: unknown, rawName: unknown, type: string, dateRaw: unknown, period: string, noteRaw = "") => {
    if (!selected.has(type)) return;
    const className = normalize(classNameRaw);
    const originalName = normalize(rawName);
    const date = validDate(dateRaw, input.period_end);
    if (!className || !originalName || !date) return;
    const studentName = roster.get(keyOf(className, originalName)) || originalName;
    const studentKey = keyOf(className, studentName);
    const previousIssueDate = latest.get(studentKey)?.date || "";
    // A student's next monitoring window begins the day after their last official issue,
    // regardless of which categories were selected on that earlier issue.
    if (previousIssueDate && date <= previousIssueDate) return;
    const event: NoticeEvent = { type, date, period: normalize(period) || "غير محددة", note: normalize(noteRaw) };
    const fingerprint = eventKey(className, studentName, event);
    if (type === "absent") {
      const daily = [className, studentName, date].join(String.fromCharCode(31));
      if (absenceDays.has(daily)) return;
      absenceDays.add(daily);
    }
    if (alreadyIssued.has(fingerprint) || seenEvents.has(fingerprint)) return;
    seenEvents.add(fingerprint);
    if (!grouped.has(studentKey)) grouped.set(studentKey, { class_name: className, student_name: studentName, events: [] });
    grouped.get(studentKey)!.events.push(event);
  };

  for (const session of input.attendance || []) {
    const date = validDate(session.date_str, input.period_end);
    if (!date || !session.records || typeof session.records !== "object" || Array.isArray(session.records)) continue;
    for (const [name, raw] of Object.entries(session.records)) {
      const status = typeof raw === "string" ? raw : raw && typeof raw === "object"
        ? String((raw as Record<string, unknown>).status || (raw as Record<string, unknown>).type || "") : "";
      if ((NOTICE_ATTENDANCE_TYPES as readonly string[]).includes(status)) add(session.class_name, name, status, date, periodOf(session));
    }
  }
  for (const session of input.behaviors || []) {
    const date = validDate(session.date_str, input.period_end);
    if (!date || !session.records || typeof session.records !== "object" || Array.isArray(session.records)) continue;
    for (const [name, raw] of Object.entries(session.records)) {
      const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : { type: String(raw || ""), note: "" };
      const note = String(data.note || data.description || "");
      for (const type of behaviorTypesFromRecord(data)) add(session.class_name, name, type, date, periodOf(session), type === "other" ? note : "");
    }
  }

  const result: NoticeCandidate[] = [];
  for (const [key, student] of grouped) {
    const previous = latest.get(key);
    if (student.events.length < input.threshold) continue;
    student.events.sort((a, b) => a.date.localeCompare(b.date) || a.period.localeCompare(b.period, "ar", { numeric: true }) || a.type.localeCompare(b.type));
    result.push({
      ...student,
      issue_number: (previous?.issue || 0) + 1,
      previous_issue_on: previous?.date || null,
      period_start: previous?.date
        ? new Date(new Date(previous.date + "T00:00:00.000Z").getTime() + 86400000).toISOString().slice(0, 10)
        : "2000-01-01",
      period_end: input.period_end,
    });
  }
  return result.sort((a, b) => a.class_name.localeCompare(b.class_name, "ar", { numeric: true }) || a.student_name.localeCompare(b.student_name, "ar"));
}
