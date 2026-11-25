import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseTimetableDay, validateSchoolTeacherCount } from "./timetable_grid.ts";
import { matchSystemTeacherName, parseTimetableWorkbook, validateWorkbookSchema, type SystemTeacher } from "./timetable_import.ts";
import { aggregateClassTimetables } from "./timetable_class_grid.ts";
import { buildDutyReportContext } from "./duty_report_context.ts";
import { canReadDutyReportPeriod, isDutyReportEligibleOnDay } from "./duty_report_access.ts";
import { fetchAllTimetablePages } from "./timetable_pagination.ts";
import { selectTeacherTimetableCells, TEACHER_TIMETABLE_FALLBACK_FILTER } from "./teacher_timetable_cells.ts";
import { buildBatchSubstitutionPlan, countTeacherTeachingPeriods, getAbsentTeacherLessons, getAvailableSubstitutionCandidates, getVisibleAbsentTeachers, isValidSubstitutionDate, type TimetableEntry, type SubstitutionAssignment, type SubstitutionTeacher } from "./substitution_policy.ts";
import { canAccessTeacherTimetablePortal, canIncludeOtherDepartments, canUseTimetableAction, resolveTimetablePrincipal, type TimetableAuthStore, type TimetablePrincipal } from "./session_auth.ts";
import { canCustomCoordinatorManageDepartment, canViewSchoolwideReserveArchive } from "./reserve_authorization.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL, SERVICE_KEY, { auth:¶»§q«^