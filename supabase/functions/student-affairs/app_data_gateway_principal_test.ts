import { assertEquals } from "jsr:@std/assert@1";
import { normalizeAppDataPrincipalPermissions } from "./app_data_gateway_principal.ts";

Deno.test("ordinary teacher permission defaults match the existing UI unless explicitly false", () => {
  assertEquals(normalizeAppDataPrincipalPermissions("teacher", {}), {
    attendance: true,
    behavior: true,
  });
  assertEquals(normalizeAppDataPrincipalPermissions("teacher", {
    attendance: false,
    behavior: undefined,
    dutyToday: true,
  }), {
    attendance: false,
    behavior: true,
    dutyToday: true,
  });
  assertEquals(normalizeAppDataPrincipalPermissions("teacher", {
    attendance: null,
    behavior: false,
  }), {
    attendance: true,
    behavior: false,
  });
});

Deno.test("custom accounts retain explicit opt-in permissions", () => {
  assertEquals(normalizeAppDataPrincipalPermissions("custom", {}), {});
  assertEquals(normalizeAppDataPrincipalPermissions("custom", {
    attendance: true,
    behavior: undefined,
  }), {
    attendance: true,
    behavior: undefined,
  });
});

Deno.test("normalization does not grant permissions to administrator or unknown roles", () => {
  assertEquals(normalizeAppDataPrincipalPermissions("admin", {}), {});
  assertEquals(normalizeAppDataPrincipalPermissions("unknown", {}), {});
});
