export type ReportPermissions = {
  can_read_attendance?: boolean;
  can_read_behavior?: boolean;
  can_view_analytics?: boolean;
  can_print_attendance?: boolean;
  can_print_behavior?: boolean;
  can_print_combined?: boolean;
};
export type AuthorizationError = { status: 400 | 403; message: string };

export type ReportsEntryPermissions = {
  allowed_classes?: string[];
  allowed_attendance_classes?: string[];
  allowed_behavior_classes?: string[];
  attendance_statuses?: string[];
  can_read_attendance?: boolean;
  can_read_behavior?: boolean;
  can_view_analytics?: boolean;
  can_print_attendance?: boolean;
  can_print_behavior?: boolean;
  can_print_combined?: boolean;
};

/** A granted Reports tab permission includes the full reporting workflow, scoped to configured school classes. */
export function applyReportsEntryPermissions<T extends object>(permissions: T, classes: string[], enabled: boolean): T & ReportsEntryPermissions {
  if (!enabled) return permissions as T & ReportsEntryPermissions;
  const allowed = [...new Set(classes.map(value => String(value || "").trim()).filter(Boolean))];
  return {
    ...permissions,
    allowed_classes: allowed,
    allowed_attendance_classes: allowed,
    allowed_behavior_classes: allowed,
    attendance_statuses: ["absent", "late", "escape", "outside"],
    can_read_attendance: true,
    can_read_behavior: true,
    can_view_analytics: true,
    can_print_attendance: true,
    can_print_behavior: true,
    can_print_combined: true,
  } as T & ReportsEntryPermissions;
}
export function authorizeReportMode(p: ReportPermissions, mode: string): AuthorizationError | null {
  const readAttendance = p.can_read_attendance === true;
  const readBehavior = p.can_read_behavior === true;
  const printAttendance = p.can_print_attendance === true && readAttendance;
  const printBehavior = p.can_print_behavior === true && readBehavior;
  if (!["view", "analytics", "print_attendance", "print_behavior", "print_combined", "notice_history", "notice_issue_commit"].includes(mode)) {
    return { status: 400, message: "نوع التقرير غير صالح" };
  }
  if (mode === "notice_history" && !readAttendance && !readBehavior) {
    return { status: 403, message: "غير مصرح بعرض سجل التنبيهات" };
  }
  if (mode === "notice_issue_commit" && !(printAttendance || printBehavior)) {
    return { status: 403, message: "غير مصرح بإصدار التنبيهات الرسمية" };
  }
  if (mode === "view" && !readAttendance && !readBehavior) {
    return { status: 403, message: "لا تملك صلاحية عرض التقارير" };
  }
  if (mode === "analytics" && p.can_view_analytics !== true) {
    return { status: 403, message: "غير مصرح بعرض التحليلات" };
  }
  if (mode === "print_attendance" && !printAttendance) {
    return { status: 403, message: "غير مصرح بطباعة تقرير الغياب" };
  }
  if (mode === "print_behavior" && !printBehavior) {
    return { status: 403, message: "غير مصرح بطباعة تقرير السلوك" };
  }
  if (mode === "print_combined" && !(p.can_print_combined === true && printAttendance && printBehavior)) {
    return { status: 403, message: "غير مصرح بطباعة التقرير الموحد" };
  }
  return null;
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const ATTENDANCE_STATUS_KEYS = ["absent", "late", "escape", "outside"] as const;
export function filterAttendanceRecordMap(records: unknown, allowedStatuses: string[], selectedStatuses?: string | string[] | null): Record<string, unknown> {
  if (!records || typeof records !== "object" || Array.isArray(records)) return {};
  const allowed = new Set(allowedStatuses.filter(x => (ATTENDANCE_STATUS_KEYS as readonly string[]).includes(x)));
  const requested = selectedStatuses == null ? null : new Set(Array.isArray(selectedStatuses) ? selectedStatuses : [selectedStatuses]);
  if (requested && Array.from(requested).some(status => !allowed.has(status))) return {};
  return Object.fromEntries(Object.entries(records as Record<string, unknown>).filter(([, value]) => {
    const status = typeof value === "string" ? value : value && typeof value === "object" ? String((value as Record<string, unknown>).status || "") : "";
    return allowed.has(status) && (!requested || requested.has(status));
  }));
}
export function behaviorTypesFromRecord(value: unknown): string[] {
  if (!value || typeof value !== "object") return value && value !== "normal" ? [String(value)] : [];
  const record = value as Record<string, unknown>;
  const raw = Array.isArray(record.types) ? record.types : Array.isArray(record.type) ? record.type : [record.type];
  return [...new Set(raw.map(String).filter(type => type && type !== "normal"))];
}
export function filterBehaviorRecordMap(records: unknown): Record<string, unknown> {
  if (!records || typeof records !== "object" || Array.isArray(records)) return {};
  return Object.fromEntries(Object.entries(records as Record<string, unknown>).filter(([, value]) => behaviorTypesFromRecord(value).length > 0));
}

export function areClassesAllowed(requested: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return requested.every(className => allowedSet.has(className));
}
