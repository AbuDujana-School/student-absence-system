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
