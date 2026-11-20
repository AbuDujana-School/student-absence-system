import { assertEquals } from "jsr:@std/assert";
import { isAppDataGatewayDate } from "./app_data_gateway_validation.ts";

Deno.test("gateway date accepts valid ISO calendar dates", () => {
  assertEquals(isAppDataGatewayDate("2026-11-19"), true);
  assertEquals(isAppDataGatewayDate("2024-02-29"), true);
});
Deno.test("gateway date rejects malformed and impossible dates", () => {
  for (const value of ["2026-2-09", "19-11-2026", "2025-02-29", "2026-13-01", "2026-04-31", "", null, 20261119]) {
    assertEquals(isAppDataGatewayDate(value), false);
  }
});
