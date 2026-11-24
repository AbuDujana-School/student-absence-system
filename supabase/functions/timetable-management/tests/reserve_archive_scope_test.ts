import { canViewSchoolwideReserveArchive } from "../reserve_authorization.ts";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("only system admins can read the consolidated cross-department reserve archive", () => {
  assert(canViewSchoolwideReserveArchive("admin"), "System admins must retain the consolidated archive");
  for (const principalType of ["teacher", "custom", "student", "unknown", ""]) {
    assert(
      !canViewSchoolwideReserveArchive(principalType),
      "Non-admin principals must stay inside their department archive scope: " + principalType,
    );
  }
});

Deno.test("the archive endpoint uses the shared server-side scope policy", async () => {
  const backend = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
  assert(
    backend.includes("canViewSchoolwideReserveArchive(principal.type)"),
    "Archive visibility must be enforced by the server-side principal policy",
  );
});
