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

async function check(label, path, options = {}) {
  const response = await fetch(\`\${baseUrl}/rest/v1/\${path}\`, {
    ...options,
    headers: {
      apikey: apiKey,
      Authorization: \`Bearer \${apiKey}\`,
      ...(options.headers || {}),
    },
  });
  let code = "";
  try {
    const body = await response.clone().json();
    code = body.code || body.error || body.message || "";
  } catch {}
  console.log(\`\${label}: HTTP \${response.status}\${code ? \` (API code: \${String(code).slice(0, 100)})\` : ""}\`);
  if (!response.ok) process.exitCode = 1;
}
await check("REST table read (classes, limit 1)", "classes?select=*&limit=1");
await check("REST manifest RPC", "rpc/get_app_sync_manifest", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
