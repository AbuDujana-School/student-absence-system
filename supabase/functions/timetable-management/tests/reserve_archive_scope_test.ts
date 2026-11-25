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
  const policyUses = backend.match(/canViewSchoolwideReserveArchive\(principal\.type\)/g) || [];
  assert(
    policyUses.length >= 2,
    "Both archive query paths must use the shared server-side principal policy",
  );
  assert(
    backend.includes("Boolean(actor?.departmentId&&teacher.departmentId===actor.departmentId)"),
    "Non-admin archive results must be restricted to the actor's department",
  );
  assert(
    backend.includes("Boolean(actorDepartmentId&&teacher.departmentId===actorDepartmentId)"),
    "The alternate archive query path must fail closed when the actor has no department",
  );
  assert(
    !backend.includes('principal.type==="admin"||hasReservePermission||teacher.departmentId===actorDepartmentId'),
    "Reserve feature permission must never grant schoolwide archive visibility",
  );
});


Deno.test("archive access exposes department capability to scoped accounts and schoolwide capability only to admins", async () => {
  const backend = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
  assert(backend.includes("canViewDepartmentArchive") && backend.includes("canViewSchoolwide"), "Access response must distinguish department and schoolwide archive");
  assert(backend.includes("departments:canViewSchoolwide?departments:[]"), "Only admins may receive all department selector options");
  assert(backend.includes("canViewDepartmentArchive=canViewSchoolwide||Boolean(actor?.departmentId)"), "Non-admin access requires a linked department");
});
