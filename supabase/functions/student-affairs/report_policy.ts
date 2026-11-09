export type ReportPermissions = {
  can_read_attendance?: boolean;
  can_read_behavior?: boolean;
  can_view_analytics?: boolean;
  can_print_attendance?: boolean;
  can_print_behavior?: boolean;
  can_print_combined?: boolean;
};
export type AuthorizationError = { status: 400 | 403; message: string };
export function authorizeReportMode(p: ReportPermissions, mode: string): AuthorizationError | null {
  const readAttendance = p.can_read_attendance === true;
  const readBehavior = p.can_read_behavior === true;
  const printAttendance = p.can_print_attendance === true && readAttendance;
  const printBehavior = p.can_print_behavior === true && readBehavior;
  if (!["view", "analytics", "print_attendance", "print_behavior", "print_combined"].includes(mode)) {
    return { status: 400, message: "نوع التقرير غير صالح" };
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
