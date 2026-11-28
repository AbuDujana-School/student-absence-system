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
const adminSectionIds = [...modalMarkup.matchAll(/id="(sec-[^"]+)"/g)].map(match => match[1]);
if (!adminSectionIds.length) throw new Error("No admin sections found for scroll coverage.");
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
  test(`admin panel scroll works — ${viewport.label}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    const page = await context.newPage();
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });
    await page.evaluate(sectionIds => {
      const modal = document.getElementById("adminModal");
      const content = document.getElementById("adminContentSection");
      modal.classList.remove("hidden");
      document.getElementById("adminAuthSection").classList.add("hidden");
      content.classList.remove("hidden");
      content.innerHTML = sectionIds.map(id => `<section id="${id}" style="display:none"><div style="height:2600px;flex:none;padding:16px">synthetic scroll fixture — ${id}</div></section>`).join("");
      document.getElementById(sectionIds[0]).style.display = "block";
    }, adminSectionIds);

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
        touchAction: getComputedStyle(content).touchAction
      };
    });

    expect(metrics.contentHeight, "content must receive a bounded height").toBeGreaterThan(100);
    expect(metrics.contentScrollHeight).toBeGreaterThan(metrics.contentHeight);
    expect(metrics.modalOverflowY).toBe("auto");
    expect(metrics.contentOverflowY).toBe("auto");
    expect(metrics.touchAction).toBe("pan-y");

    const box = await page.locator("#adminContentSection").boundingBox();
    await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(80, box.height / 2));
    await page.mouse.wheel(0, 550);
    await expect.poll(() => page.locator("#adminContentSection").evaluate(el => el.scrollTop)).toBeGreaterThan(0);

    // Exercise every actual admin tab section through the same content scroll host.
    for (const sectionId of adminSectionIds) {
      await page.evaluate(id => {
        document.querySelectorAll("#adminContentSection [id^=sec-]").forEach(section => section.style.display = "none");
        document.getElementById(id).style.display = "block";
        document.getElementById("adminContentSection").scrollTop = 0;
      }, sectionId);
      await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(80, box.height / 2));
      await page.mouse.wheel(0, 180);
      await expect.poll(() => page.locator("#adminContentSection").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    }

    // Real touch gesture on phone viewports (not a mouse-wheel substitute).
    if (viewport.width < 640) {
      await page.locator("#adminContentSection").evaluate(el => { el.scrollTop = 0; });
      const touchBox = await page.locator("#adminContentSection").boundingBox();
      const touchX = Math.round(touchBox.x + Math.min(80, touchBox.width / 2));
      const touchY = Math.round(touchBox.y + Math.min(180, touchBox.height - 20));
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY, id: 1 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX, y: touchY - 220, id: 1 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => page.locator("#adminContentSection").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await cdp.detach();
    }

    // Verify the overlay remains a fallback scroll surface if content cannot scroll.
    await page.evaluate(() => {
      const modal = document.getElementById("adminModal");
      const card = modal.querySelector(".glass-card");
      const content = document.getElementById("adminContentSection");
      content.style.overflowY = "visible";
      content.scrollTop = 0;
      card.style.height = "120vh";
      card.style.maxHeight = "none";
      modal.scrollTop = 0;
    });
    const fallbackMetrics = await page.locator("#adminModal").evaluate(el => {
      const card = el.querySelector(".glass-card");
      return {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowY: getComputedStyle(el).overflowY,
        alignItems: getComputedStyle(el).alignItems,
        cardTop: card.getBoundingClientRect().top,
        cardBottom: card.getBoundingClientRect().bottom,
        cardHeight: card.getBoundingClientRect().height
      };
    });
    expect(fallbackMetrics.scrollHeight, JSON.stringify(fallbackMetrics)).toBeGreaterThan(fallbackMetrics.clientHeight);
    await page.locator("#adminModal").evaluate(el => { el.scrollTop = 200; });
    await expect.poll(() => page.locator("#adminModal").evaluate(el => el.scrollTop), { message: JSON.stringify(fallbackMetrics) }).toBeGreaterThan(0);
    await page.locator("#adminModal").evaluate(el => { el.scrollTop = 0; });
    await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(80, box.height / 2));
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.locator("#adminModal").evaluate(el => el.scrollTop), { message: JSON.stringify(fallbackMetrics) }).toBeGreaterThan(0);

    // On phones, also swipe the overlay padding to validate its fallback touch surface.
    if (viewport.width < 640) {
      await page.locator("#adminModal").evaluate(el => { el.scrollTop = 0; });
      const cdp = await context.newCDPSession(page);
      const overlayBox = await page.locator("#adminContentSection").boundingBox();
      const overlayX = Math.round(overlayBox.x + Math.min(80, overlayBox.width / 2));
      const overlayY = Math.round(overlayBox.y + Math.min(180, overlayBox.height - 20));
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: overlayX, y: overlayY, id: 2 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: overlayX, y: overlayY - 220, id: 2 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(() => page.locator("#adminModal").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      await cdp.detach();
    }
    await page.screenshot({
      path: path.join(__dirname, "..", "test-results", `admin-scroll-${viewport.width}x${viewport.height}.png`),
      fullPage: true
    });
  });
}
