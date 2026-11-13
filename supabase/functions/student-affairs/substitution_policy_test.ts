import {
  getAbsentTeacherLessons,
  getAvailableSubstitutionCandidates,
  type SubstitutionTeacher,
  type TimetableEntry,
  type SubstitutionAssignment,
} from "./substitution_policy.ts";

const teachers: SubstitutionTeacher[] = [
  { id: "absent", name: "أحمد السالمي", departmentId: "arabic" },
  { id: "free", name: "خالد السالمي", departmentId: "arabic" },
  { id: "busy", name: "سعيد", departmentId: "arabic" },
  { id: "assigned", name: "ماجد", departmentId: "arabic" },
  { id: "other", name: "علي", departmentId: "islamic" },
];

const timetable: TimetableEntry[] = [
  { teacherId: "absent", weekday: "الأحد", period: 4, className: "11 أول", subject: "العربية" },
  { teacherId: "absent", weekday: "الأحد", period: 7, className: "10/2" },
  { teacherId: "busy", weekday: "الأحد", period: 4, className: "11 أول" },
  { teacherId: "other", weekday: "الأحد", period: 4, className: "9/1" },
];

const assignments: SubstitutionAssignment[] = [
  { substituteTeacherId: "assigned", weekday: "الأحد", period: 4, status: "confirmed" },
];

Deno.test("empty timetable cell means the teacher is available", () => {
  const result = getAvailableSubstitutionCandidates({
    teachers, timetable, assignments,
    absentTeacherId: "absent", weekday: "الأحد", period: 4,
    departmentId: "arabic",
  });
  if (result.length !== 1 || result[0].id !== "free") {
    throw new Error("Only the teacher with an empty cell should be available");
  }
});

Deno.test("teacher with a class in the selected period is excluded", () => {
  const result = getAvailableSubstitutionCandidates({
    teachers, timetable, assignments,
    absentTeacherId: "absent", weekday: "الأحد", period: 4,
    departmentId: "arabic",
  });
  if (result.some((teacher) => teacher.id === "busy")) {
    throw new Error("A teacher with a scheduled class was incorrectly offered");
  }
});

Deno.test("teacher already assigned to another substitution in the same cell is excluded", () => {
  const result = getAvailableSubstitutionCandidates({
    teachers, timetable, assignments,
    absentTeacherId: "absent", weekday: "الأحد", period: 4,
    departmentId: "arabic",
  });
  if (result.some((teacher) => teacher.id === "assigned")) {
    throw new Error("A teacher already assigned in this period was offered again");
  }
});

Deno.test("other departments are excluded unless cross-department mode is enabled", () => {
  const base = {
    teachers, timetable, assignments,
    absentTeacherId: "absent", weekday: "الأحد", period: 4,
    departmentId: "arabic",
  };
  const crossDepartmentFreeTimetable = timetable.filter((entry) => entry.teacherId !== "other");
  const sameDepartment = getAvailableSubstitutionCandidates({
    ...base,
    timetable: crossDepartmentFreeTimetable,
  });
  if (sameDepartment.some((teacher) => teacher.id === "other")) {
    throw new Error("Cross-department teacher appeared before opt-in");
  }
  const expanded = getAvailableSubstitutionCandidates({
    ...base,
    timetable: crossDepartmentFreeTimetable,
    includeOtherDepartments: true,
  });
  if (!expanded.some((teacher) => teacher.id === "other")) {
    throw new Error("Cross-department teacher did not appear after opt-in");
  }
});

Deno.test("absent teacher lessons are listed only for the chosen day and ordered by period", () => {
  const lessons = getAbsentTeacherLessons(timetable, "absent", "الأحد");
  if (lessons.length !== 2 || lessons[0].period !== 4 || lessons[1].period !== 7) {
    throw new Error("Absent teacher's lessons were not filtered and sorted correctly");
  }
});

Deno.test("cancelled substitution assignment does not block a free teacher", () => {
  const result = getAvailableSubstitutionCandidates({
    teachers,
    timetable: timetable.filter((entry) => entry.teacherId !== "busy" && entry.teacherId !== "other"),
    assignments: [{ substituteTeacherId: "free", weekday: "الأحد", period: 4, status: "cancelled" }],
    absentTeacherId: "absent", weekday: "الأحد", period: 4,
    departmentId: "arabic",
  });
  if (!result.some((teacher) => teacher.id === "free")) {
    throw new Error("Cancelled assignment incorrectly blocked the teacher");
  }
});
