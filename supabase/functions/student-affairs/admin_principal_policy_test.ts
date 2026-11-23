import { isAdditionalAdminTeacher } from "./admin_principal_policy.ts";

Deno.test("additional admin identity depends only on its dedicated marker and teacher role", () => {
  if (!isAdditionalAdminTeacher({ role: "teacher", permissions: { additionalAdmin: true } })) {
    throw new Error("Dedicated additional-admin marker was not recognized without the generic admin bit");
  }
  if (!isAdditionalAdminTeacher({ role: "teacher", permissions: { admin: false, additionalAdmin: true } })) {
    throw new Error("Generic admin=false must not disable the dedicated additional-admin identity");
  }
  if (isAdditionalAdminTeacher({ role: "teacher", permissions: { admin: true } })) {
    throw new Error("A teacher with only the generic admin bit was elevated");
  }
  if (isAdditionalAdminTeacher({ role: "custom", permissions: { additionalAdmin: true } })) {
    throw new Error("A custom principal was elevated");
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
  if (denied.admin !== false) {
    throw new Error("Additional-admin permissions must not project the legacy generic admin flag");
  }
  const granted = buildAdditionalAdminPermissions({ role: "teacher", permissions: {
    admin: true, additionalAdmin: true,
    additionalAdminOverrides: { reportSubstitutionDistribution: true, reserve: true },
  } });
  if (granted.reportSubstitutionDistribution !== true || granted.reserve !== true) {
    throw new Error("Explicit additional-admin capability overrides were ignored");
  }
});
