import { assert, assertEquals } from "jsr:@std/assert";
import {
  createOfflineCredentialVaultKey,
  openOfflineCredentialSnapshot,
  sealOfflineCredentialSnapshot,
} from "./app_offline_credential_vault.ts";

const teacher = { type: "teacher" as const, name: "Teacher A" };
const otherTeacher = { type: "teacher" as const, name: "Teacher B" };
const fixedNow = Date.UTC(2026, 10, 20, 12, 0, 0);

Deno.test("vault key is AES-GCM and non-extractable", async () => {
  const key = await createOfflineCredentialVaultKey();
  assertEquals(key.type, "secret");
  assertEquals(key.algorithm.name, "AES-GCM");
  assertEquals(key.extractable, false);
  assert(key.usages.includes("encrypt"));
  assert(key.usages.includes("decrypt"));
});

Deno.test("credential snapshot is encrypted and restores for the same principal", async () => {
  const key = await createOfflineCredentialVaultKey();
  const snapshot = {
    accounts: [{ name: teacher.name, pin_hash: "a".repeat(64), pin_salt: "b".repeat(32) }],
    admin_pin: null,
  };
  const envelope = await sealOfflineCredentialSnapshot(snapshot, teacher, key, {
    now: fixedNow,
    ttlMs: 60 * 60 * 1000,
  });

  assertEquals(JSON.stringify(envelope).includes("pin_hash"), false);
  assertEquals(JSON.stringify(envelope).includes("a".repeat(64)), false);
  assertEquals(envelope.principal, teacher);
  assertEquals(envelope.expiresAt, fixedNow + 60 * 60 * 1000);
  assertEquals(
    await openOfflineCredentialSnapshot(envelope, teacher, key, { now: fixedNow + 1000 }),
    snapshot,
  );
});

Deno.test("credential snapshot cannot be opened for a different account", async () => {
  const key = await createOfflineCredentialVaultKey();
  const envelope = await sealOfflineCredentialSnapshot(
    { accounts: [{ name: teacher.name, pin_hash: "a".repeat(64) }] },
    teacher,
    key,
    { now: fixedNow },
  );
  assertEquals(await openOfflineCredentialSnapshot(envelope, otherTeacher, key, { now: fixedNow + 1 }), null);
});

Deno.test("credential snapshot cannot be opened after expiry", async () => {
  const key = await createOfflineCredentialVaultKey();
  const envelope = await sealOfflineCredentialSnapshot(
    { accounts: [{ name: teacher.name }] },
    teacher,
    key,
    { now: fixedNow, ttlMs: 5 * 60 * 1000 },
  );
  assertEquals(await openOfflineCredentialSnapshot(envelope, teacher, key, {
    now: fixedNow + 5 * 60 * 1000,
  }), null);
});

Deno.test("credential snapshot rejects tampering and a key from another device profile", async () => {
  const key = await createOfflineCredentialVaultKey();
  const anotherKey = await createOfflineCredentialVaultKey();
  const envelope = await sealOfflineCredentialSnapshot(
    { accounts: [{ name: teacher.name, pin_hash: "a".repeat(64) }] },
    teacher,
    key,
    { now: fixedNow },
  );
  const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
  assertEquals(await openOfflineCredentialSnapshot(tampered, teacher, key, { now: fixedNow + 1 }), null);
  assertEquals(await openOfflineCredentialSnapshot(envelope, teacher, anotherKey, { now: fixedNow + 1 }), null);
});

Deno.test("vault rejects invalid principals, excessive lifetime, and extractable keys", async () => {
  const key = await createOfflineCredentialVaultKey();
  let invalidPrincipalRejected = false;
  try {
    await sealOfflineCredentialSnapshot({ accounts: [] }, { type: "teacher", name: " " }, key, { now: fixedNow });
  } catch { invalidPrincipalRejected = true; }
  assert(invalidPrincipalRejected);

  let excessiveTtlRejected = false;
  try {
    await sealOfflineCredentialSnapshot({ accounts: [] }, teacher, key, {
      now: fixedNow,
      ttlMs: 8 * 60 * 60 * 1000 + 1,
    });
  } catch { excessiveTtlRejected = true; }
  assert(excessiveTtlRejected);

  const extractableKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  let extractableKeyRejected = false;
  try {
    await sealOfflineCredentialSnapshot({ accounts: [] }, teacher, extractableKey, { now: fixedNow });
  } catch { extractableKeyRejected = true; }
  assert(extractableKeyRejected);
});
