import {
  authorizeAppDataOperation,
  projectAppDataRow,
  validateAppDataWriteRows,
} from "./app_data_gateway_policy.ts";
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("admin can read and write allowlisted non-credential tables", () => {
  const admin = { type: "admin" as const, adminScope: "general" as const, name: "مدير النظام العام" };
  assertEquals(authorizeAppDataOperation(admin, "attendance", "read"), true);
  assertEquals(authorizeAppDataOperation(admin, "students", "write"), true);
  assertEquals(authorizeAppDataOperation(admin, "unknown_table", "read"), false);
});

Deno.test("unknown tables and all delete operations fail closed", () => {
  const admin = { type: "admin" as const, adminScope: "general" as const, name: "مدير النظام العام" };
  assertEquals(authorizeAppDataOperation(admin, "teachers", "delete"), false);
  assertEquals(authorizeAppDataOperation(admin, "app_sessions", "read"), false);
  assertEquals(authorizeAppDataOperation(null, "classes", "read"), false);
});

Deno.test("teacher reads are constrained to server-resolved class scope", () => {
  const teacher = { type: "teacher" as const, name: "Teacher A", permissions: { attendance: true, behavior: false } };
  const scope = { allowedClasses: ["5/1", "5/2"] };
  assertEquals(authorizeAppDataOperation(teacher, "students", "read", { class_name: "5/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(teacher, "students", "read", { class_name: "6/1" }, scope), false);
  assertEquals(authorizeAppDataOperation(teacher, "attendance", "read", { class_name: "5/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(teacher, "behaviors", "read", { class_name: "5/1" }, scope), false);
});

Deno.test("teacher writes are limited to own attendance or behavior rows and allowed classes", () => {
  const teacher = { type: "teacher" as const, name: "Teacher A", permissions: { attendance: true, behavior: true } };
  const scope = { allowedClasses: ["5/1"] };
  assertEquals(authorizeAppDataOperation(teacher, "attendance", "write", { class_name: "5/1", teacher_name: "Teacher A" }, scope), true);
  assertEquals(authorizeAppDataOperation(teacher, "attendance", "write", { class_name: "5/1", teacher_name: "Teacher B" }, scope), false);
  assertEquals(authorizeAppDataOperation(teacher, "attendance", "write", { class_name: "6/1", teacher_name: "Teacher A" }, scope), false);
});

Deno.test("custom users require explicit attendance and behavior permissions", () => {
  const custom = { type: "custom" as const, name: "Custom A", permissions: { attendance: true } };
  const scope = { allowedClasses: ["5/1"] };
  assertEquals(authorizeAppDataOperation(custom, "attendance", "read", { class_name: "5/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(custom, "behaviors", "read", { class_name: "5/1" }, scope), false);
});

Deno.test("teacher profile projection never returns PIN or secret fields", () => {
  assertEquals(projectAppDataRow("teachers", {
    name: "Teacher A", role: "teacher", pin_hash: "never", pin_salt: "never",
    permissions: { attendance: true, api_token: "never" }, must_change_pin: true,
  }), {
    name: "Teacher A", role: "teacher", permissions: { attendance: true }, must_change_pin: true,
  });
});

Deno.test("admin PIN setting is not readable or writable through generic data gateway", () => {
  const admin = { type: "admin" as const, adminScope: "general" as const, name: "مدير النظام العام" };
  assertEquals(projectAppDataRow("school_settings", { key: "admin_pin", value: { hash: "secret", salt: "secret" } }), null);
  assertEquals(authorizeAppDataOperation(admin, "school_settings", "write", { key: "admin_pin", value: {} }), false);
  assertEquals(authorizeAppDataOperation(admin, "school_settings", "write", { key: "duty_module", value: {} }), true);
});

Deno.test("write validation rejects secret columns and unknown columns", () => {
  assertEquals(validateAppDataWriteRows("teachers", [{ name: "Teacher A", pin_hash: "secret" }]), null);
  assertEquals(validateAppDataWriteRows("students", [{ class_name: "5/1", student_name: "Student A", is_admin: true }]), null);
  assertEquals(validateAppDataWriteRows("students", [{ class_name: "5/1", student_name: "Student A" }]), [{ class_name: "5/1", student_name: "Student A" }]);
});


Deno.test("teacher attendance and behavior access require explicit server-loaded grants", () => {
  const scope = { allowedClasses: ["5/1"] };
  const missing = { type: "teacher" as const, name: "Teacher A", permissions: {} };
  const denied = { type: "teacher" as const, name: "Teacher A", permissions: { attendance: false, behavior: false } };
  const granted = { type: "teacher" as const, name: "Teacher A", permissions: { attendance: true, behavior: true } };
  const row = { class_name: "5/1", teacher_name: "Teacher A" };
  assertEquals(authorizeAppDataOperation(missing, "attendance", "read", row, scope), false);
  assertEquals(authorizeAppDataOperation(denied, "attendance", "read", row, scope), false);
  assertEquals(authorizeAppDataOperation(granted, "attendance", "read", row, scope), true);
  assertEquals(authorizeAppDataOperation(missing, "behaviors", "read", row, scope), false);
  assertEquals(authorizeAppDataOperation(granted, "behaviors", "read", row, scope), true);
});

Deno.test("invalid principal and operation values fail closed at runtime", () => {
  const invalidPrincipal = { type: "root", name: "Unexpected" } as unknown as import("./app_data_gateway_policy.ts").AppDataPrincipal;
  const admin = { type: "admin" as const, adminScope: "general" as const, name: "مدير النظام العام" };
  assertEquals(authorizeAppDataOperation(invalidPrincipal, "classes", "read"), false);
  assertEquals(authorizeAppDataOperation(admin, "classes", "update" as never), false);
});


Deno.test("student affairs grants use separate attendance and behavior scopes", () => {
  const principal = { type: "teacher" as const, name: "Affairs Teacher", permissions: { attendance: true, behavior: true } };
  const scope = {
    allowedClasses: ["5/1"],
    allowedAttendanceClasses: ["5/1", "6/1"],
    allowedBehaviorClasses: ["5/1", "7/1"],
  };
  assertEquals(authorizeAppDataOperation(principal, "students", "read", { class_name: "6/1" }, scope), false);
  assertEquals(authorizeAppDataOperation(principal, "attendance", "read", { class_name: "6/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(principal, "attendance", "read", { class_name: "7/1" }, scope), false);
  assertEquals(authorizeAppDataOperation(principal, "behaviors", "read", { class_name: "7/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(principal, "behaviors", "read", { class_name: "6/1" }, scope), false);
});


Deno.test("additional administrators use explicit data permissions and never inherit general settings access", () => {
  const additional = {
    type: "admin" as const,
    adminScope: "additional" as const,
    name: "Tester1",
    permissions: { students: true, teachers: true, attendance: true, behavior: false, duty: true },
  };
  const scope = { allowedClasses: ["5/1"] };
  assertEquals(authorizeAppDataOperation(additional, "students", "read", { class_name: "5/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(additional, "teachers", "read", { name: "Teacher B" }, scope), true);
  assertEquals(authorizeAppDataOperation(additional, "attendance", "read", { class_name: "5/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(additional, "behaviors", "read", { class_name: "5/1" }, scope), false);
  assertEquals(authorizeAppDataOperation(additional, "duty_reports", "read", { class_name: "5/1" }, scope), true);
  assertEquals(authorizeAppDataOperation(additional, "school_settings", "read", null), false);
  assertEquals(authorizeAppDataOperation(additional, "school_settings", "write", { key: "duty_module", value: {} }), false);
});

Deno.test("admin marker alone never grants additional-admin data access", () => {
  const additional = { type: "admin" as const, adminScope: "additional" as const, name: "Tester1", permissions: { admin: true, additionalAdmin: true } };
  assertEquals(authorizeAppDataOperation(additional, "students", "read", { class_name: "5/1" }, { allowedClasses: ["5/1"] }), false);
  assertEquals(authorizeAppDataOperation(additional, "teachers", "read", { name: "Teacher B" }), false);
});
