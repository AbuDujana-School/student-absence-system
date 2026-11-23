export const APP_DATA_TABLES = [
  "classes",
  "students",
  "teachers",
  "attendance",
  "behaviors",
  "school_settings",
  "duty_reports",
] as const;

export type AppDataTable = typeof APP_DATA_TABLES[number];
export type AppDataOperation = "read" | "write" | "delete";
export type AppDataPrincipal = {
  type: "admin" | "teacher" | "custom";
  name: string;
  permissions?: Record<string, unknown>;
  adminScope?: "general" | "additional";
};
export type AppDataScope = {
  /** General class/roster scope: active timetable plus explicit school-affairs grants. */
  allowedClasses: readonly string[];
  /** Separate, explicitly granted attendance scope; never accepted from request JSON. */
  allowedAttendanceClasses?: readonly string[];
  /** Separate, explicitly granted behavior scope; never accepted from request JSON. */
  allowedBehaviorClasses?: readonly string[];
};

const TABLE_FIELDS: Record<AppDataTable, readonly string[]> = {
  classes: ["name"],
  students: ["class_name", "student_name"],
  teachers: ["name", "role", "permissions", "must_change_pin"],
  attendance: ["record_key", "date_str", "class_name", "period", "teacher_name", "records", "updated_at"],
  behaviors: ["record_key", "date_str", "class_name", "period", "teacher_name", "records", "updated_at"],
  school_settings: ["key", "value"],
  duty_reports: ["id", "date_str", "day_num", "period", "class_name", "subject", "teacher_name", "reported_by", "status", "reviewed_by", "reviewed_at", "created_at"],
};

const SECRET_KEY = /(pin|hash|salt|token|secret|password|credential|api.?key|private.?key)/i;
function isSecretField(key: string): boolean {
  return !/^must_?change_?pin$/i.test(key) && !/^mustChangePin$/i.test(key) && SECRET_KEY.test(key);
}
const ALLOWED_TABLES = new Set<string>(APP_DATA_TABLES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSecrets);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isSecretField(key)) output[key] = cleanSecrets(nested);
  }
  return output;
}

function normalizeClasses(values?: readonly string[]): Set<string> {
  return new Set((values || []).map((value) => String(value).trim()).filter(Boolean));
}

export function allowedAppDataFields(table: AppDataTable): readonly string[] {
  return TABLE_FIELDS[table];
}

export function authorizeAppDataOperation(
  principal: AppDataPrincipal | null,
  tableValue: unknown,
  operation: AppDataOperation,
  row: unknown = null,
  scope?: AppDataScope,
): boolean {
  if (!principal || !principal.name?.trim() ||
    (principal.type !== "admin" && principal.type !== "teacher" && principal.type !== "custom") ||
    (operation !== "read" && operation !== "write" && operation !== "delete") ||
    !ALLOWED_TABLES.has(String(tableValue))) return false;
  const table = tableValue as AppDataTable;
  const isGeneralAdmin = principal.type === "admin" && principal.adminScope === "general";
  const isAdditionalAdmin = principal.type === "admin" && principal.adminScope === "additional";

  // Deletes are deliberately held back for the existing tombstone/transfer workflows.
  if (operation === "delete") return false;

  if (table === "school_settings") {
    // Only the general administrator can read or change settings; PIN records
    // remain isolated behind dedicated authentication actions.
    if (!isGeneralAdmin || (isRecord(row) && row.key === "admin_pin")) return false;
    if (operation === "read" && row === null) return true;
    if (operation === "write") return isRecord(row) && (row.key === "duty_module" || row.key === "custom_categories");
    return true;
  }

  if (isGeneralAdmin) return true;

  const permissions = principal.permissions || {};
  const classes = normalizeClasses(scope?.allowedClasses);
  const attendanceClasses = normalizeClasses(scope?.allowedAttendanceClasses ?? scope?.allowedClasses);
  const behaviorClasses = normalizeClasses(scope?.allowedBehaviorClasses ?? scope?.allowedClasses);
  const className = isRecord(row) ? String(row.class_name || "") : "";

  if (table === "classes" || table === "students") {
    if (operation !== "read" || (isAdditionalAdmin && permissions.students !== true)) return false;
    return classes.size > 0 && (table === "classes"
      ? (row === null || (isRecord(row) && classes.has(String(row.name || ""))))
      : (row === null || classes.has(className)));
  }

  if (table === "teachers") {
    return operation === "read" && (isAdditionalAdmin
      ? permissions.teachers === true || permissions.users === true
      : isRecord(row) && String(row.name || "") === principal.name);
  }

  if (table === "attendance" || table === "behaviors") {
    const permissionKey = table === "attendance" ? "attendance" : "behavior";
    // Permissions must be explicitly granted by the current server-loaded teacher profile.
    const enabled = permissions[permissionKey] === true;
    const tableClasses = table === "attendance" ? attendanceClasses : behaviorClasses;
    if (!enabled || !isRecord(row) || !tableClasses.has(className)) return false;
    if (operation === "read") return true;
    return operation === "write" && String(row.teacher_name || "") === principal.name;
  }

  if (table === "duty_reports") {
    return operation === "read" && permissions.duty === true &&
      isRecord(row) && classes.has(className);
  }

  return false;
}

/** Filter both columns and nested secret-like fields before any response reaches a browser. */
export function projectAppDataRow(table: AppDataTable, row: unknown): Record<string, unknown> | null {
  if (!isRecord(row)) return null;
  const allowed = new Set(TABLE_FIELDS[table]);
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (allowed.has(key) && !isSecretField(key)) projected[key] = cleanSecrets(value);
  }
  if (table === "school_settings" && projected.key === "admin_pin") return null;
  return projected;
}

export function validateAppDataWriteRows(
  table: AppDataTable,
  rows: unknown,
): Record<string, unknown>[] | null {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) return null;
  const allowed = new Set(TABLE_FIELDS[table]);
  const output: Record<string, unknown>[] = [];
  for (const value of rows) {
    if (!isRecord(value)) return null;
    const keys = Object.keys(value);
    if (!keys.length || keys.some((key) => !allowed.has(key) || isSecretField(key))) return null;
    const projected = projectAppDataRow(table, value);
    if (!projected) return null;
    output.push(projected);
  }
  return output;
}
