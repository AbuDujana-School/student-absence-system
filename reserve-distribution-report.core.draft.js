/* Isolated core for the future schoolwide substitution-distribution report.
 * Deliberately NOT imported by index.html or reserve-workflow.js.
 * It has no startup hooks, DOM observers, permission bridges, or global function wrappers.
 */
(function (root) {
  "use strict";

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isGeneralAdmin(principal) {
    if (!isRecord(principal)) return false;
    return principal.type === "admin" &&
      (principal.adminScope === "general" || principal.name === "مدير النظام العام");
  }

  // All identity/session data is injected by the caller. This function never
  // reads undeclared application globals and therefore cannot break app boot.
  function canView(context) {
    if (!isRecord(context)) return false;
    const active = isRecord(context.activeUser) ? context.activeUser : null;
    const principal = isRecord(context.principal) ? context.principal : null;
    const permissions = isRecord(active && active.permissions)
      ? active.permissions
      : isRecord(principal && principal.permissions) ? principal.permissions : {};
    return isGeneralAdmin(active) || isGeneralAdmin(principal) ||
      permissions.reportSubstitutionDistribution === true;
  }

  // Only the general system administrator may grant/revoke this capability.
  function canManagePermissions(context) {
    if (!isRecord(context)) return false;
    return isGeneralAdmin(context.activeUser) || isGeneralAdmin(context.principal);
  }

  function isIsoDate(value) {
    if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
    const date = new Date(value + "T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function validateRange(from, to, maxDays) {
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) return false;
    const span = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000;
    return span <= (Number.isInteger(maxDays) && maxDays > 0 ? maxDays : 366);
  }

  function groupRows(rows) {
    const byDate = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!isRecord(row)) return;
      const date = String(row.assignmentDate || "").trim();
      const absentName = String(row.absentTeacherName || "").trim();
      if (!isIsoDate(date) || !absentName) return;

      if (!byDate.has(date)) {
        byDate.set(date, { date, weekday: String(row.weekday || ""), teachers: new Map() });
      }
      const day = byDate.get(date);
      const department = String(row.absentTeacherDepartment || row.subject || "").trim();
      const key = absentName + "\\u0000" + department;
      if (!day.teachers.has(key)) {
        day.teachers.set(key, {
          absentName: absentName + (department ? " – " + department : ""),
          absenceReason: String(row.absenceReason || "-"),
          rows: []
        });
      }
      const group = day.teachers.get(key);
      if ((!group.absenceReason || group.absenceReason === "-") && row.absenceReason) {
        group.absenceReason = String(row.absenceReason);
      }
      const period = Number(row.period);
      if (!Number.isInteger(period) || period < 1 || period > 12) return;
      group.rows.push({
        period,
        className: String(row.className || ""),
        substitute: String(row.substituteTeacherName || ""),
        subject: String(row.subject || "")
      });
    });

    return Array.from(byDate.values())
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((day) => ({
        date: day.date,
        weekday: day.weekday,
        groups: Array.from(day.teachers.values())
          .sort((a, b) => a.absentName.localeCompare(b.absentName, "ar"))
          .map((group) => ({
            absentName: group.absentName,
            absenceReason: group.absenceReason,
            rows: group.rows.sort((a, b) => a.period - b.period)
          }))
      }));
  }

  root.ReserveDistributionReportCore = Object.freeze({
    canView,
    canManagePermissions,
    validateRange,
    groupRows
  });
})(typeof window !== "undefined" ? window : globalThis);
