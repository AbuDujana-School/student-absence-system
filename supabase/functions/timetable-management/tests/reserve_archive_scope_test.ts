import { canViewSchoolwideReserveArchive } from "../reserve_authorization.ts";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("system admins and explicitly archive-authorized coordinators can read the schoolwide reserve archive", () => {
  assert(canViewSchoolwideReserveArchive("admin"), "System admins must retain the consolidated archive");
  for (const principalType of ["teacher", "custom", "student", "unknown", ""]) {
    assert(
      !canViewSchoolwideReserveArchive(principalType, false),
      "Principals without an archive grant must not receive schoolwide archive access: " + principalType,
    );
  }
  assert(canViewSchoolwideReserveArchive("teacher", true), "A teacher with reserve-distribution/archive permission must see both archive scopes");
  assert(canViewSchoolwideReserveArchive("custom", true), "An authorized absence coordinator must see both archive scopes");
});

Deno.test("the archive endpoint uses the shared server-side scope policy", async () => {
  const backend = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
  const policyUses = backend.match(/canViewSchoolwideReserveArchive\(principal\.type,hasSchoolwideArchiveGrant\)/g) || [];
  assert(
    policyUses.length >= 2,
    "Both archive query paths must use the validated archive grant for schoolwide visibility",
  );
  assert(
    backend.includes('const targetDepartmentId=requestedArchiveScope==="department"?(principal.type==="admin"?requestedDepartmentId:actorDepartmentId):""'),
    "A non-admin department request must always resolve to the authenticated actor's own department, ignoring a caller-supplied department id",
  );
  assert(
    backend.includes('requestedArchiveScope==="school"&&!canViewSchoolwide'),
    "A principal without a validated archive grant must be rejected when requesting the schoolwide archive",
  );
  assert(
    backend.includes('requestedArchiveScope===""&&principal.type!=="admin"&&Boolean(actorDepartmentId&&String(teacher.departmentId||"")===actorDepartmentId)'),
    "Legacy archive requests without an explicit scope must remain pinned to the authenticated actor's department",
  );
  assert(
    backend.includes('Boolean(targetDepartmentId&&String(teacher.departmentId||"")===targetDepartmentId)'),
    "Department results must be filtered against the server-resolved department id",
  );
  assert(
    backend.includes('const hasExplicitSchoolwideArchivePermission = principal.type === "teacher" &&'),
    "A teacher must receive schoolwide archive access only through the explicit teacher permission",
  );
  assert(
    backend.includes("hasTimetableGrant || hasExplicitSchoolwideArchivePermission"),
    "The explicit teacher permission must authorize archive reads without granting reserve management",
  );
});


Deno.test("archive access exposes both scopes to all principals with a validated archive grant", async () => {
  const backend = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
  assert(backend.includes("canViewDepartmentArchive") && backend.includes("canViewSchoolwide"), "Access response must distinguish department and schoolwide archive");
  assert(backend.includes("const canSelectAnyDepartment=principal.type===\"admin\";"), "Only administrators may select another department for the department archive");
  assert(backend.includes("departments:canSelectAnyDepartment?departments:(actor?.departmentId?departments.filter(item=>item.id===String(actor.departmentId)):[])"), "Non-admins receive only their own department option");
  assert(backend.includes("canViewDepartmentArchive=canViewSchoolwide||Boolean(actor?.departmentId)"), "Authorized accounts may view the school archive even when no department is linked");
});


Deno.test("a generic teacher timetable grant does not imply schoolwide archive access", async () => {
  const backend = await Deno.readTextFile(new URL("../index.ts", import.meta.url));
  assert(
    backend.includes('(principal.type === "custom" && hasTimetableGrant) || hasExplicitSchoolwideArchivePermission'),
    "Only custom coordinators retain their legacy schoolwide archive access from timetable grants",
  );
  assert(
    backend.includes('principal.permissions?.schoolwideReserveArchive === true'),
    "Teacher schoolwide archive permission must be read from the authenticated permission snapshot",
  );
});
