const { test, expect } = require("@playwright/test");
const esbuild = require("esbuild");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const sourcePath = path.resolve(
  "supabase/functions/student-affairs/app_offline_credential_vault.ts",
);

test("real Chromium IndexedDB persists a non-extractable key and enforces vault boundaries", async () => {
  test.setTimeout(90_000);
  const bundled = esbuild.buildSync({
    entryPoints: [sourcePath],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "VaultApi",
    write: false,
    target: ["chrome120"],
  }).outputFiles[0].text;

  const server = http.createServer((request, response) => {
    if (request.url === "/vault.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bundled);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head></head><body>IndexedDB vault browser test</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = "http://127.0.0.1:" + address.port;

  try {
    const browser = await require("@playwright/test").chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(origin);
      await page.addScriptTag({ url: origin + "/vault.js" });

      const saved = await page.evaluate(async () => {
        const teacher = { type: "teacher", name: "Browser QA Teacher" };
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        const snapshot = {
          accounts: [{ name: teacher.name, pin_hash: "a".repeat(64), pin_salt: "b".repeat(32) }],
          admin_pin: null,
        };
        const envelope = await VaultApi.saveOfflineCredentialVault(snapshot, teacher, store, {
          now: 1_795_180_000_000,
          ttlMs: 60 * 60 * 1000,
        });
        const entries = await store.read();
        return {
          envelope,
          snapshot,
          keyExtractable: entries.key?.extractable,
          keyAlgorithm: entries.key?.algorithm?.name,
          keyUsages: entries.key?.usages,
          keyStored: Boolean(entries.key),
          envelopeStored: Boolean(entries.envelope),
          noPlaintextVerifier: !JSON.stringify(envelope).includes("pin_hash") &&
            !JSON.stringify(envelope).includes("a".repeat(64)),
        };
      });

      expect(saved.keyExtractable).toBe(false);
      expect(saved.keyAlgorithm).toBe("AES-GCM");
      expect(saved.keyUsages).toContain("decrypt");
      expect(saved.keyStored).toBe(true);
      expect(saved.envelopeStored).toBe(true);
      expect(saved.noPlaintextVerifier).toBe(true);

      // Reload proves the browser can structured-clone and recover CryptoKey from IndexedDB.
      await page.reload();
      await page.addScriptTag({ url: origin + "/vault.js" });
      const afterReload = await page.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        const same = await VaultApi.restoreOfflineCredentialVault(
          { type: "teacher", name: "Browser QA Teacher" },
          store,
          { now: 1_795_180_000_001 },
        );
        const other = await VaultApi.restoreOfflineCredentialVault(
          { type: "teacher", name: "Different Teacher" },
          store,
          { now: 1_795_180_000_001 },
        );
        const expired = await VaultApi.restoreOfflineCredentialVault(
          { type: "teacher", name: "Browser QA Teacher" },
          store,
          { now: 1_795_183_600_000 },
        );
        return { same, other, expired };
      });
      expect(afterReload.same).toEqual(saved.snapshot);
      expect(afterReload.other).toBeNull();
      expect(afterReload.expired).toBeNull();

      const tamperRejected = await page.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        const entries = await store.read();
        const changed = { ...entries.envelope, ciphertext: entries.envelope.ciphertext.slice(0, -4) + "AAAA" };
        const result = await VaultApi.openOfflineCredentialSnapshot(
          changed,
          { type: "teacher", name: "Browser QA Teacher" },
          entries.key,
          { now: 1_795_180_000_002 },
        );
        return result === null;
      });
      expect(tamperRejected).toBe(true);

      const cleared = await page.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        await VaultApi.clearOfflineCredentialVault(store);
        const entries = await store.read();
        const restored = await VaultApi.restoreOfflineCredentialVault(
          { type: "teacher", name: "Browser QA Teacher" },
          store,
        );
        return { key: entries.key, envelope: entries.envelope, restored };
      });
      expect(cleared).toEqual({ key: null, envelope: null, restored: null });
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
