import { assertEquals } from "jsr:@std/assert";
import { isAdminStudentAffairsAccessEnabled } from "./admin_student_affairs_access_policy.ts";

Deno.test("admin Student Affairs access stays enabled when no temporary flag exists", () => {
  assertEquals(isAdminStudentAffairsAccessEnabled(null, 1000), true);
  assertEquals(isAdminStudentAffairsAccessEnabled({ enabled: true }, 1000), true);
});

Deno.test("admin Student Affairs access is disabled until the configured expiry", () => {
  assertEquals(isAdminStudentAffairsAccessEnabled({ enabled: false, expires_at: "2026-11-22T10:00:00Z" }, Date.parse("2026-11-22T09:00:00Z")), false);
});

Deno.test("admin Student Affairs access automatically returns after expiry", () => {
  assertEquals(isAdminStudentAffairsAccessEnabled({ enabled: false, expires_at: "2026-11-22T10:00:00Z" }, Date.parse("2026-11-22T10:00:01Z")), true);
});

Deno.test("admin Student Affairs access remains disabled without a valid expiry until manually restored", () => {
  assertEquals(isAdminStudentAffairsAccessEnabled({ enabled: false }, 1000), false);
  assertEquals(isAdminStudentAffairsAccessEnabled({ enabled: false, expires_at: "invalid" }, 1000), false);
});
