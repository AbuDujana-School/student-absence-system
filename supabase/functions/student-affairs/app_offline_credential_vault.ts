/**
 * Device-profile-scoped offline credential vault primitives.
 *
 * This module deliberately does not persist anything itself. The browser integration
 * must store the non-extractable CryptoKey and encrypted envelope in the same
 * IndexedDB profile, never in localStorage, and must bind restore to the same
 * principal. It is a building block only; it must not replace the current login
 * flow until the end-to-end migration and preview acceptance tests are complete.
 */

export type OfflineCredentialPrincipal = {
  type: "admin" | "teacher" | "custom";
  name: string;
};

export type OfflineCredentialEnvelope = {
  schemaVersion: 1;
  principal: OfflineCredentialPrincipal;
  createdAt: number;
  expiresAt: number;
  iv: string;
  ciphertext: string;
};

const MAX_VAULT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isPrincipal(value: unknown): value is OfflineCredentialPrincipal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["admin", "teacher", "custom"].includes(String(candidate.type)) &&
    typeof candidate.name === "string" && candidate.name.trim().length > 0 &&
    candidate.name.length <= 160;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function additionalData(principal: OfflineCredentialPrincipal, expiresAt: number): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(JSON.stringify([1, principal.type, principal.name, expiresAt]));
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
}

/** Generate a key suitable for structured-clone persistence in IndexedDB. */
export async function createOfflineCredentialVaultKey(
  cryptoProvider: Crypto = crypto,
): Promise<CryptoKey> {
  return await cryptoProvider.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt one principal's credential snapshot. The envelope contains no plaintext
 * verifier fields; the key must be kept in the same browser profile's IndexedDB.
 */
export async function sealOfflineCredentialSnapshot(
  snapshot: unknown,
  principal: OfflineCredentialPrincipal,
  key: CryptoKey,
  options: { now?: number; ttlMs?: number; cryptoProvider?: Crypto } = {},
): Promise<OfflineCredentialEnvelope> {
  const cryptoProvider = options.cryptoProvider ?? crypto;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MAX_VAULT_TTL_MS;
  if (!isPrincipal(principal)) throw new TypeError("Invalid offline credential principal.");
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_VAULT_TTL_MS) {
    throw new TypeError("Invalid offline credential vault lifetime.");
  }
  if (key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM" ||
      !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) {
    throw new TypeError("Offline credential vault key must be non-extractable AES-GCM.");
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Credential snapshot must be an object.");
  }

  const plaintext = encoder.encode(JSON.stringify(snapshot));
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new TypeError("Credential snapshot exceeds the allowed size.");
  }

  const iv = cryptoProvider.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const expiresAt = now + ttlMs;
  const encrypted = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(principal, expiresAt), tagLength: 128 },
    key,
    plaintext,
  );
  return {
    schemaVersion: 1,
    principal: { type: principal.type, name: principal.name },
    createdAt: now,
    expiresAt,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
}

/**
 * Decrypt only for the same principal and within the bounded lifetime.
 * Returns null for expired, malformed, cross-account, or tampered envelopes.
 */
export async function openOfflineCredentialSnapshot(
  envelope: unknown,
  principal: OfflineCredentialPrincipal,
  key: CryptoKey,
  options: { now?: number; cryptoProvider?: Crypto } = {},
): Promise<Record<string, unknown> | null> {
  const cryptoProvider = options.cryptoProvider ?? crypto;
  const now = options.now ?? Date.now();
  if (!isPrincipal(principal) || !envelope || typeof envelope !== "object") return null;
  const record = envelope as Partial<OfflineCredentialEnvelope>;
  if (record.schemaVersion !== 1 || !isPrincipal(record.principal) ||
      record.principal.type !== principal.type || record.principal.name !== principal.name ||
      !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt) ||
      !Number.isFinite(now) || (record.createdAt as number) > now + CLOCK_SKEW_TOLERANCE_MS ||
      (record.expiresAt as number) <= now ||
      (record.expiresAt as number) <= (record.createdAt as number) ||
      (record.expiresAt as number) - (record.createdAt as number) > MAX_VAULT_TTL_MS ||
      typeof record.iv !== "string" || typeof record.ciphertext !== "string") return null;

  if (key.type !== "secret" || key.algorithm.name !== "AES-GCM" ||
      !key.usages.includes("decrypt")) return null;

  try {
    const iv = base64ToBytes(record.iv);
    const ciphertext = base64ToBytes(record.ciphertext);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 17 ||
        ciphertext.byteLength > MAX_SNAPSHOT_BYTES + 16) return null;
    const plaintext = await cryptoProvider.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: additionalData(principal, record.expiresAt as number),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    const parsed: unknown = JSON.parse(decoder.decode(plaintext));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
