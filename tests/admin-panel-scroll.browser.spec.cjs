const { test, expect } = require("@playwright/test");
const { readFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function styleBlock(id) {
  const start = source.indexOf(`<style id="${id}">`);
  if (start < 0) throw new Error(`Missing style block: ${id}`);
  const end = source.indexOf("</style>", start);
  if (end < 0) throw new Error(`Unclosed style block: ${id}`);
  return source.slice(start, end + "</style>".length);
}

function divElementById(id) {
  const start = source.indexOf(`<div id="${id}"`);
  if (start < 0) throw new Error(`Missing element: ${id}`);
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return source.slice(start, tags.lastIndex);
  }
  throw new Error(`Unclosed element: ${id}`);
}

const modalMarkup = divElementById("adminModal");
const fixture = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif}
.hidden{display:none!important}.fixed{position:fixed}.inset-0{inset:0}.flex{display:flex}
.items-center{align-items:center}.justify-center{justify-content:center}.flex-col{flex-direction:column}
.w-full{width:100%}.max-w-6xl{max-width:72rem}.overflow-hidden{overflow:hidden}
.flex-grow{flex-grow:1}.p-4{padding:1rem}.p-5{padding:1.25rem}.rounded-3xl{border-radius:1.5rem}
.max-h-\\[92vh\\]{max-height:92vh}.shadow-2xl{box-shadow:0 20px 30px #0003}
.glass-card{background:#fff;border:1px solid #ddd}.bg-slate-900\\/60{background:#0f172a99}
</style>
${styleBlock("admin-panel-universal-scroll-fix")}
${styleBlock("admin-dashboard-section-scroll-fix")}
</head>
<body>${modalMarkup}</body>
</html>`;

const viewports = [
  { label: "phone portrait", width: 390, height: 844 },
  { label: "phone landscape", width: 844, height: 390 },
  { label: "desktop", width: 1366, height: 768 }
];

mkdirSync(path.join(__dirname, "..", "test-results"), { recursive: true });

for (const viewport of viewports) {
  test(`admin panel scroll works — ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const modal = document.getElementById("adminModal");
      const content = document.getElementById("adminContentSection");
      modal.classList.remove("hidden");
      document.getElementById("adminAuthSection").classList.add("hidden");
      content.classList.remove("hidden");
      content.innerHTML = '<div style="height:2600px;flex:none;padding:16px">synthetic scroll fixture</div>';
    });

    const metrics = await page.evaluate(() => {
      const modal = document.getElementById("adminModal");
      const card = modal.querySelector(".glass-card");
      const content = document.getElementById("adminContentSection");
      const rect = content.getBoundingClientRect();
      return {
        contentHeight: content.clientHeight,
        contentScrollHeight: content.scrollHeight,
        contentTop: rect.top,
        contentBottom: rect.bottom,
        modalOverflowY: getComputedStyle(modal).overflowY,
        contentOverflowY: getComputedStyle(content).overflowY,
        cardHeight: card.getBoundingClientRect().height,
        cardTop: card.getBoundingClientRect().top,
        cardBottom: card.getBoundingClientRect().bottom,
        viewportHeight: window.innerHeight,
        touchAction: getComputedStyle(content).touchAction
      };
    });

    expect(metrics.contentHeight, "content must receive a bounded height").toBeGreaterThan(100);
    expect(metrics.contentScrollHeight).toBeGreaterThan(metrics.contentHeight);
    expect(metrics.modalOverflowY).toBe("auto");
    expect(metrics.contentOverflowY).toBe("auto");
    expect(metrics.touchAction).toBe("pan-y");
    if (viewport.width <= 640) {
      expect(metrics.cardTop, "mobile dialog must start inside the viewport").toBeGreaterThanOrEqual(0);
      expect(metrics.cardBottom, "mobile dialog must not extend below the viewport").toBeLessThanOrEqual(metrics.viewportHeight);
    }

    const box = await page.locator("#adminContentSection").boundingBox();
    await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(80, box.height / 2));
    await page.mouse.wheel(0, 550);
    await expect.poll(() => page.locator("#adminContentSection").evaluate(el => el.scrollTop)).toBeGreaterThan(0);

    // Verify the overlay remains a fallback scroll surface if content cannot scroll.
    await page.evaluate(() => {
      const modal = document.getElementById("adminModal");
      const card = modal.querySelector(".glass-card");
      const content = document.getElementById("adminContentSection");
      content.style.overflowY = "hidden";
      card.style.height = "120vh";
      card.style.maxHeight = "none";
      modal.scrollTop = 0;
    });
    await page.mouse.move(10, viewport.height - 10);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.locator("#adminModal").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({
      path: path.join(__dirname, "..", "test-results", `admin-scroll-${viewport.width}x${viewport.height}.png`),
      fullPage: true
    });
  });
}

for (const sectionId of ["sec-reports", "sec-behaviorstats"]) {
  test(`admin dashboard section scroll works — ${sectionId}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });
    await page.evaluate((targetId) => {
      const modal = document.getElementById("adminModal");
      const content = document.getElementById("adminContentSection");
      modal.classList.remove("hidden");
      document.getElementById("adminAuthSection").classList.add("hidden");
      content.classList.remove("hidden");
      content.querySelectorAll('[id^="sec-"]').forEach(section => section.classList.add("hidden"));
      const target = document.getElementById(targetId);
      target.classList.remove("hidden");
      target.insertAdjacentHTML("beforeend",
        '<div data-scroll-fixture style="height:2600px;min-height:2600px;width:100%">real section scroll fixture</div>');
    }, sectionId);

    const metrics = await page.evaluate(() => {
      const content = document.getElementById("adminContentSection");
      const section = content.querySelector('[id^="sec-"]:not(.hidden)');
      return {
        clientHeight: content.clientHeight,
        scrollHeight: content.scrollHeight,
        sectionHeight: section.getBoundingClientRect().height,
        overflowY: getComputedStyle(content).overflowY,
        display: getComputedStyle(content).display
      };
    });
    expect(metrics.clientHeight).toBeGreaterThan(100);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.display).toBe("block");

    await page.locator("#adminContentSection").evaluate(el => { el.scrollTop = 0; });
    await page.mouse.move(180, 650);
    await page.mouse.wheel(0, 600);
    await expect.poll(() =>
      page.locator("#adminContentSection").evaluate(el => el.scrollTop)
    ).toBeGreaterThan(0);
  });
}
