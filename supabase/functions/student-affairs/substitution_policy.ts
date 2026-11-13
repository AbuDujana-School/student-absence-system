/**
 * Pure substitution eligibility rules.
 *
 * Availability is read from the ACTIVE timetable grid:
 * - a teacher with a scheduled timetable entry in the requested weekday/period is busy;
 * - a teacher with no entry in that cell is free, provided they have no active
 *   substitution assignment in the same cell.
 *
 * This module deliberately has no database or UI dependencies so it can be
 * tested independently before wiring it into the Edge Function.
 */

export interface SubstitutionTeacher {
  id: string;
  name: string;
  departmentId: string;
}

export interface TimetableEntry {
  teacherId: string;
  weekday: string;
  period: number;
  className: string;
  subject?: string;
}

export interface SubstitutionAssignment {
  substituteTeacherId: string;
  weekday: string;
  period: number;
  status?: "assigned" | "confirmed" | "cancelled";
}

export interface SubstitutionLesson {
  weekday: string;
  period: number;
  className: string;
  subject?: string;
}

export interface CandidateQuery {
  teachers: SubstitutionTeacher[];
  timetable: TimetableEntry[];
  assignments: SubstitutionAssignment[];
  absentTeacherId: string;
  weekday: string;
  period: number;
  departmentId: string;
  includeOtherDepartments?: boolean;
}

function sameCell(
  a: { weekday: string; period: number },
  b: { weekday: string; period: number },
): boolean {
  return a.weekday === b.weekday && a.period === b.period;
}

/** Return the absent teacher's scheduled lessons for the selected weekday. */
export function getAbsentTeacherLessons(
  timetable: TimetableEntry[],
  teacherId: string,
  weekday: string,
): SubstitutionLesson[] {
  return timetable
    .filter((entry) => entry.teacherId === teacherId && entry.weekday === weekday)
    .map((entry) => ({
      weekday: entry.weekday,
      period: entry.period,
      className: entry.className,
      ...(entry.subject ? { subject: entry.subject } : {}),
    }))
    .sort((a, b) => a.period - b.period);
}

/**
 * List only genuinely free teachers for one absent lesson.
 * Department scope is strict by default; cross-department candidates are
 * included only when the coordinator explicitly enables that option.
 */
export function getAvailableSubstitutionCandidates(
  query: CandidateQuery,
): SubstitutionTeacher[] {
  const {
    teachers,
    timetable,
    assignments,
    absentTeacherId,
    weekday,
    period,
    departmentId,
    includeOtherDepartments = false,
  } = query;

  const occupiedTeacherIds = new Set(
    timetable
      .filter((entry) => sameCell(entry, { weekday, period }))
      .map((entry) => entry.teacherId),
  );

  const alreadyAssignedTeacherIds = new Set(
    assignments
      .filter((assignment) =>
        sameCell(assignment, { weekday, period }) &&
        assignment.status !== "cancelled"
      )
      .map((assignment) => assignment.substituteTeacherId),
  );

  return teachers
    .filter((teacher) => teacher.id !== absentTeacherId)
    .filter((teacher) =>
      includeOtherDepartments || teacher.departmentId === departmentId
    )
    .filter((teacher) => !occupiedTeacherIds.has(teacher.id))
    .filter((teacher) => !alreadyAssignedTeacherIds.has(teacher.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));
}
