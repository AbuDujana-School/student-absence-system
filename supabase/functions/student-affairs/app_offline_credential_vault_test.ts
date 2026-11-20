import { assert, assertEquals } from "jsr:@std/assert";
import {
  clearOfflineCredentialVault,
  createOfflineCredentialVaultKey,
  openOfflineCredentialSnapshot,
  restoreOfflineCredentialVault,
  saveOfflineCredentialVault,
  sealOfflineCredentialSnapshot,
  type OfflineCredentialEnvelope,
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
    displayName: teacher.name,
    role: "teacher",
    continuationContext: "synthetic-non-secret-fixture",
  };
  const envelope = await sealOfflineCredentialSnapshot(snapshot, teacher, key, {
    now: fixedNow,
    ttlMs: 60 * 60 * 1000,
  });

  assertEquals(JSON.stringify(envelope).includes("synthetic-non-secret-fixture"), false);
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
    { displayName: teacher.name, role: "teacher" },
    teacher,
    key,
    { now: fixedNow },
  );
  assertEquals(await openOfflineCredentialSnapshot(envelope, otherTeacher, key, { now: fixedNow + 1 }), null);
});

Deno.test("credential snapshot cannot be opened after expiry", async () => {
  const key = await createOfflineCredentialVaultKey();
  const envelope = await sealOfflineCredentialSnapshot(
    { displayName: teacher.name },
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
    { displayName: teacher.name, role: "teacher" },
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
    await sealOfflineCredentialSnapshot({ displayName: "synthetic-empty-fixture" }, { type: "teacher", name: " " }, key, { now: fixedNow });
  } catch { invalidPrincipalRejected = true; }
  assert(invalidPrincipalRejected);

  let excessiveTtlRejected = false;
  try {
    await sealOfflineCredentialSnapshot({ displayName: "synthetic-empty-fixture" }, teacher, key, {
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
    await sealOfflineCredentialSnapshot({ displayName: "synthetic-empty-fixture" }, teacher, extractableKey, { now: fixedNow });
  } catch { extractableKeyRejected = true; }
  assert(extractableKeyRejected);

  const validEnvelope = await sealOfflineCredentialSnapshot({ displayName: "synthetic-empty-fixture" }, teacher, key, { now: fixedNow });
  assertEquals(await openOfflineCredentialSnapshot(validEnvelope, teacher, extractableKey, { now: fixedNow + 1 }), null);
});


Deno.test("IndexedDB store contract saves and restores only the same account's encrypted vault", async () => {
  let key: CryptoKey | null = null;
  let envelope: import("./app_offline_credential_vault.ts").OfflineCredentialEnvelope | null = null;
  const store = {
    async read() { return { key, envelope }; },
    async write(nextKey: CryptoKey, nextEnvelope: OfflineCredentialEnvelope) {
      key = nextKey;
      envelope = nextEnvelope;
    },
    async clear() { key = null; envelope = null; },
  };
  const snapshot = { displayName: teacher.name, role: "teacher" };
  await saveOfflineCredentialVault(snapshot, teacher, store, {
    now: fixedNow,
    ttlMs: 30 * 60 * 1000,
  });
  assert(key);
  assert(envelope);
  assertEquals(JSON.stringify(envelope).includes("synthetic-non-secret-fixture"), false);
  assertEquals(
    await restoreOfflineCredentialVault(teacher, store, { now: fixedNow + 1 }),
    snapshot,
  );
  assertEquals(
    await restoreOfflineCredentialVault(otherTeacher, store, { now: fixedNow + 1 }),
    null,
  );
  await clearOfflineCredentialVault(store);
  assertEquals(await store.read(), { key: null, envelope: null });
  assertEquals(await restoreOfflineCredentialVault(teacher, store, { now: fixedNow + 2 }), null);
});
