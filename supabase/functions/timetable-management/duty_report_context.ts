import { classSectionsForCell, type ClassTimetableSourceCell } from "./timetable_class_grid.ts";

export interface DutyReportCell extends ClassTimetableSourceCell {
  id?: string;
  matched_teacher_name?: string | null;
}
export interface DutyReportAssignment {
  assignment_type?: string;
  teacher_name?: string | null;
  absent_teacher_name?: string | null;
  source_cell_id?: string | null;
  class_sections?: unknown;
  status?: string;
}
export interface DutyReportLesson {
  teacherName: string;
  subject: string;
  substituteNames: string[];
}
export interface DutyReportClassContext {
  className: string;
  lessons: DutyReportLesson[];
}

function classIdentity(value: unknown): string {
  const normalized = String(value ?? "").normalize("NFKC")
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[／⁄]/g, "/").replace(/\s+/g, "").trim();
  const pair = normalized.match(/^(\d+)\/(\d+)$/);
  if (!pair) return normalized;
  const first = Number(pair[1]), second = Number(pair[2]);
  if (second >= 9 && second <= 12) return second + "/" + first;
  if (first >= 9 && first <= 12) return first + "/" + second;
  return normalized;
}
function teacherIdentity(value: unknown): string {
  return String(value ?? "").normalize("NFKC")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ة/g, "ه")
    .replace(/\\s+/g, "").trim();
}
function sections(value: unknown, subject = ""): string[] {
  return classSectionsForCell({
    weekday: "الأحد", period: 1, cell_status: "teaching",
    class_sections: value, subject,
  });
}
function unique(values: string[]): string[] {
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
}

/** Build class-specific lesson and substitute details from the active timetable. */
export function buildDutyReportContext(
  classNames: string[],
  cells: DutyReportCell[],
  assignments: DutyReportAssignment[],
): DutyReportClassContext[] {
  const activeAssignments = (assignments || []).filter(item =>
    item.assignment_type === "substitution" &&
    ["assigned", "confirmed", "completed"].includes(String(item.status || ""))
  );
  return (classNames || []).map(className => {
    const classKey = classIdentity(className);
    const lessonMap = new Map<string, DutyReportLesson>();
    for (const cell of cells || []) {
      if (cell.cell_status !== "teaching") continue;
      if (!sections(cell.class_sections, String(cell.subject || "")).some(value => classIdentity(value) === classKey)) continue;
      const teacherName = String(cell.matched_teacher_name || "").trim();
      const subject = String(cell.subject || "").trim();
      const lessonKey = classIdentity(teacherName) + "\u001f" + classIdentity(subject);
      let lesson = lessonMap.get(lessonKey);
      if (!lesson) {
        lesson = { teacherName, subject, substituteNames: [] };
        lessonMap.set(lessonKey, lesson);
      }
      if (!teacherName) continue;
      const substituteNames = [...lesson.substituteNames];
      for (const assignment of activeAssignments) {
        if (teacherIdentity(assignment.absent_teacher_name) !== teacherIdentity(teacherName)) continue;
        const sourceCellId = String(assignment.source_cell_id || "");
        if (sourceCellId && sourceCellId !== String(cell.id || "")) continue;
        const assignmentSections = sections(assignment.class_sections);
        if (assignmentSections.length && !assignmentSections.some(value => classIdentity(value) === classKey)) continue;
        if (!assignmentSections.length && !sourceCellId) continue;
        const substituteName = String(assignment.teacher_name || "").trim();
        if (substituteName) substituteNames.push(substituteName);
      }
      lesson.substituteNames = unique(substituteNames);
    }
    return {
      className,
      lessons: [...lessonMap.values()].map(lesson => ({
        ...lesson,
        substituteNames: unique(lesson.substituteNames),
      })),
    };
  });
}
