const migrationUrl = new URL("../../../migrations/20261114150000_timetable_import_idempotency.sql", import.meta.url);

Deno.test("timetable import migration enforces server-side idempotency", async () => {
  const sql = await Deno.readTextFile(migrationUrl);
  const checks: Array<[string, RegExp]> = [
    ["unique idempotency key index", /create unique index if not exists timetable_imports_idempotency_key_uidx[\s\S]*?on public\.timetable_imports \(idempotency_key\)/i],
    ["conflict-safe insert", /on conflict \(idempotency_key\) where idempotency_key is not null do nothing/i],
    ["payload mismatch protection", /request_hash is distinct from v_request_hash/i],
    ["replay response marker", /'replayed',\s*true/i],
    ["service-role-only RPC", /revoke all on function public\.save_timetable_import\(jsonb\) from public, anon, authenticated/i],
  ];
  for (const [label, pattern] of checks) {
    if (!pattern.test(sql)) throw new Error("Missing migration safeguard: " + label);
  }
});
