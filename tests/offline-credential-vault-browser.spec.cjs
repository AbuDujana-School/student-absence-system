const { test, expect } = require("@playwright/test");
const esbuild = require("esbuild");
const http = require("node:http");
const path = require("node:path");

const sourcePath = path.resolve(
  "supabase/functions/student-affairs/app_offline_credential_vault.ts",
);

test("real Chromium IndexedDB persists device-bound vault and isolates principal/profile lifecycle", async () => {
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
        const principal = { type: "teacher", name: "Browser QA Teacher" };
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        // Synthetic continuation metadata only: never place PIN verifiers or bearer tokens in this vault.
        const snapshot = {
          displayName: principal.name,
          role: "teacher",
          continuationContext: "synthetic-non-secret-fixture",
        };
        const envelope = await VaultApi.saveOfflineCredentialVault(snapshot, principal, store, {
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
          noPlaintextFixture: !JSON.stringify(envelope).includes(snapshot.continuationContext),
        };
      });

      expect(saved.keyExtractable).toBe(false);
      expect(saved.keyAlgorithm).toBe("AES-GCM");
      expect(saved.keyUsages).toContain("decrypt");
      expect(saved.keyStored).toBe(true);
      expect(saved.envelopeStored).toBe(true);
      expect(saved.noPlaintextFixture).toBe(true);

      // A separate browser context has a separate origin storage partition.
      const isolatedContext = await browser.newContext();
      const isolatedPage = await isolatedContext.newPage();
      await isolatedPage.goto(origin);
      await isolatedPage.addScriptTag({ url: origin + "/vault.js" });
      const isolatedRestore = await isolatedPage.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        return await VaultApi.restoreOfflineCredentialVault(
          { type: "teacher", name: "Browser QA Teacher" },
          store,
        );
      });
      expect(isolatedRestore).toBeNull();
      await isolatedContext.close();

      // Reload proves Chromium structured-clones the non-extractable CryptoKey into IndexedDB.
      await page.reload();
      await page.addScriptTag({ url: origin + "/vault.js" });
      const afterReload = await page.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        const same = await VaultApi.restoreOfflineCredentialVaultVault;
        return {
          same: await VaultApi.restoreOfflineCredentialVault(
            { type: "teacher", name: "Browser QA Teacher" },
            store,
            { now: 1_795_180_000_001 },
          ),
          other: await VaultApi.restoreOfflineCredentialVault(
            { type: "teacher", name: "Different Teacher" },
            store,
            { now: 1_795_180_000_001 },
          ),
          expired: await VaultApi.restoreOfflineCredentialVault(
            { type: "teacher", name: "Browser QA Teacher" },
            store,
            { now: 1_795_183_600_000 },
          ),
        };
      });
      expect(afterReload.same).toEqual(saved.snapshot);
      expect(afterReload.other).toBeNull();
      expect(afterReload.expired).toBeNull();

      const tamperRejected = await page.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        const entries = await store.read();
        const changed = {
          ...entries.envelope,
          ciphertext: entries.envelope.ciphertext.slice(0, -4) + "AAAA",
        };
        const result = await VaultApi.openOfflineCredentialSnapshot(
          changed,
          { type: "teacher", name: "Browser QA Teacher" },
          entries.key,
          { now: 1_795_180_000_002 },
        );
        return result === null;
      });
      expect(tamperRejected).toBe(true);

      // The current store intentionally has one slot: switching principal replaces it.
      const switched = await page.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        const nextPrincipal = { type: "custom", name: "Browser QA Custom" };
        const nextSnapshot = { displayName: nextPrincipal.name, role: "custom" };
        await VaultApi.saveOfflineCredentialVault(nextSnapshot, nextPrincipal, store, {
          now: 1_795_180_000_010,
          ttlMs: 60 * 60 * 1000,
        });
        return {
          previous: await VaultApi.restoreOfflineCredentialVault(
            { type: "teacher", name: "Browser QA Teacher" },
            store,
            { now: 1_795_180_000_011 },
          ),
          current: await VaultApi.restoreOfflineCredentialVault(
            nextPrincipal,
            store,
            { now: 1_795_180_000_011 },
          ),
        };
      });
      expect(switched.previous).toBeNull();
      expect(switched.current).toEqual({ displayName: "Browser QA Custom", role: "custom" });

      const cleared = await page.evaluate(async () => {
        const store = VaultApi.createIndexedDbOfflineCredentialVaultStore(indexedDB, "vault-browser-qa");
        await VaultApi.clearOfflineCredentialVault(store);
        const entries = await store.read();
        const restored = await VaultApi.restoreOfflineCredentialVault(
          { type: "custom", name: "Browser QA Custom" },
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
