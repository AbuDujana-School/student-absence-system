import { isAdditionalAdminTeacher } from "./admin_principal_policy.ts";

Deno.test("additional admin requires the explicit marker and admin permission", () => {
  if (!isAdditionalAdminTeacher({ role: "teacher", permissions: { admin: true, additionalAdmin: true } })) {
    throw new Error("Explicit additional administrator was not recognized");
  }
  if (isAdditionalAdminTeacher({ role: "teacher", permissions: { admin: true } })) {
    throw new Error("A teacher with only an admin permission bit was elevated");
  }
  if (isAdditionalAdminTeacher({ role: "custom", permissions: { admin: true, additionalAdmin: true } })) {
    throw new Error("A custom principal was elevated");
  }
  if (isAdditionalAdminTeacher({ role: "teacher", permissions: { admin: false, additionalAdmin: true } })) {
    throw new Error("Additional admin marker without admin permission was elevated");
  }
});


Deno.test("additional admin permission overrides disable only the explicitly selected capability", async () => {
  const { buildAdditionalAdminPermissions } = await import("./admin_principal_policy.ts");
  const result = buildAdditionalAdminPermissions({ role: "teacher", permissions: { admin: true, additionalAdmin: true, duty: false, additionalAdminOverrides: { morningAssemblyLateness: false } } });
  if (result.morningAssemblyLateness !== false) throw new Error("Explicit morning-lateness override was ignored");
  if (result.studentAffairs !== true || result.users !== true || result.reports !== true) throw new Error("Disabling one capability unexpectedly disabled other capabilities");
  if ("additionalAdminOverrides" in result) throw new Error("Override metadata leaked into effective permissions");
});


Deno.test("additional admin report and reserve capabilities are opt-in and independently overridable", async () => {
  const { buildAdditionalAdminPermissions } = await import("./admin_principal_policy.ts");
  const denied = buildAdditionalAdminPermissions({ role: "teacher", permissions: { admin: true, additionalAdmin: true } });
  if (denied.reportSubstitutionDistribution !== false || denied.reserve !== false) {
    throw new Error("Reserve and report capabilities must not be granted by the admin marker");
  }
  const granted = buildAdditionalAdminPermissions({ role: "teacher", permissions: {
    admin: true, additionalAdmin: true,
    additionalAdminOverrides: { reportSubstitutionDistribution: true, reserve: true },
  } });
  if (granted.reportSubstitutionDistribution !== true || granted.reserve !== true) {
    throw new Error("Explicit additional-admin capability overrides were ignored");
  }
});
