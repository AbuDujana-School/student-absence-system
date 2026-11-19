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
