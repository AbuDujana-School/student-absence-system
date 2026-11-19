import fs from "node:fs";

const source = fs.readFileSync("index.html", "utf8");
const urlMatch = source.match(/const\s+SUPABASE_URL\s*=\s*IS_CLOUDFLARE_BRANCH_PREVIEW\s*\?\s*"([^"]+)"/);
const keyMatch = source.match(/const\s+SUPABASE_ANON_KEY\s*=\s*IS_CLOUDFLARE_BRANCH_PREVIEW\s*\?\s*"([^"]+)"/);
if (!urlMatch || !keyMatch) {
  console.error("Could not safely locate the isolated preview Supabase configuration.");
  process.exit(2);
}
const baseUrl = urlMatch[1].endsWith("/") ? urlMatch[1].slice(0, -1) : urlMatch[1];
const apiKey = keyMatch[1];
if (!baseUrl.includes("wawplttrpiinoukpjqqx.supabase.co")) {
  console.error("Safety stop: preview configuration does not point to the isolated development project.");
  process.exit(3);
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: apiKey,
      Authorization: "Bearer " + apiKey,
      ...(options.headers || {}),
    },
  });
  let body = {};
  try { body = await response.clone().json(); } catch {}
  return { status: response.status, code: body.code || body.error || "" };
}

const table = await request("classes?select=*&limit=1");
console.log("REST table read without a user session: HTTP " + table.status +
  (table.code ? " (API code: " + String(table.code).slice(0, 100) + ")" : ""));
if (!(table.status === 401 && table.code === "42501")) {
  console.error("Unexpected table-read result; review API authorization before proceeding.");
  process.exitCode = 1;
} else {
  console.log("Table authorization gate confirmed: anon cannot read protected school data.");
}

const manifest = await request("rpc/get_app_sync_manifest", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
console.log("REST manifest RPC: HTTP " + manifest.status);
if (manifest.status !== 200) {
  console.error("Manifest REST request failed; the preview API key/gateway path is not healthy.");
  process.exitCode = 1;
} else {
  console.log("Preview API key accepted by REST gateway; manifest RPC is reachable.");
}


const productionBaseUrl = "https://ylsocrvwqibptuwfzbke.supabase.co";
const productionPublishableKey = "sb_publishable_xHm5_31UUMAQwpegIxhOTg_iiGdFLW5";
const productionManifestResponse = await fetch(productionBaseUrl + "/rest/v1/rpc/get_app_sync_manifest", {
  method: "POST",
  headers: {
    apikey: productionPublishableKey,
    Authorization: "Bearer " + productionPublishableKey,
    "Content-Type": "application/json",
  },
  body: "{}",
  cache: "no-store",
});
let productionBody = {};
try { productionBody = await productionManifestResponse.clone().json(); } catch {}
console.log("Production manifest via active publishable key: HTTP " + productionManifestResponse.status +
  (productionBody.code ? " (API code: " + String(productionBody.code).slice(0, 100) + ")" : ""));
if (!productionManifestResponse.ok) {
  console.error("Production publishable-key gateway check did not pass; no production data was changed.");
  process.exitCode = 1;
} else if (!productionBody || typeof productionBody !== "object") {
  console.error("Production manifest response shape was unexpected.");
  process.exitCode = 1;
} else {
  console.log("Production publishable key accepted; metadata-only manifest RPC is reachable.");
}


const productionTableProbe = await fetch(productionBaseUrl + "/rest/v1/classes?select=name&limit=0", {
  headers: {
    apikey: productionPublishableKey,
    Authorization: "Bearer " + productionPublishableKey,
  },
  cache: "no-store",
});
console.log("Production table permission probe (zero rows): HTTP " + productionTableProbe.status);
if (productionTableProbe.status !== 200) {
  let probeBody = {};
  try { probeBody = await productionTableProbe.clone().json(); } catch {}
  console.error("Production table permission probe failed" +
    (probeBody.code ? " (API code: " + String(probeBody.code).slice(0, 100) + ")" : ""));
  process.exitCode = 1;
} else {
  console.log("Production table read permission confirmed without retrieving school records.");
}
