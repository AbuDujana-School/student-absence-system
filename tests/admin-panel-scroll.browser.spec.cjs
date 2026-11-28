const { test, expect } = require("@playwright/test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function styleBlock(id) {
  const marker = '<style id="' + id + '">';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("Missing style block: " + id);
  const end = source.indexOf("</style>", start);
  if (end < 0) throw new Error("Unclosed style block: " + id);
  return source.slice(start, end + "</style>".length);
}

function divElementById(id) {
  const start = source.indexOf('<div id="' + id + '"');
  if (start < 0) throw new Error("Missing element: " + id);
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return source.slice(start, tags.lastIndex);
  }
  throw new Error("Unclosed element: " + id);
}

const modalMarkup = divElementById("adminModal");
const fixture = "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head>" +
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<style>" +
  "*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif}" +
  ".hidden{display:none!important}.fixed{position:fixed}.inset-0{inset:0}.flex{display:flex}" +
  ".items-center{align-items:center}.justify-center{justify-content:center}.flex-col{flex-direction:column}" +
  ".w-full{width:100%}.max-w-6xl{max-width:72rem}.overflow-hidden{overflow:hidden}" +
  ".flex-grow{flex-grow:1}.p-4{padding:1rem}.p-5{padding:1.25rem}.rounded-3xl{border-radius:1.5rem}" +
  ".glass-card{background:#fff;border:1px solid #ddd}" +
  "</style>" +
  styleBlock("admin-panel-universal-scroll-fix") +
  styleBlock("admin-report-behavior-scroll-fix") +
  styleBlock("admin-dashboard-universal-scroll-fix") +
  "</head><body>" + modalMarkup + "</body></html>";

const viewports = [
  { label: "phone portrait", width: 390, height: 844 },
  { label: "phone landscape", width: 844, height: 390 },
  { label: "desktop", width: 1366, height: 768 }
];

async function openAdminPanel(page, id) {
  await page.setContent(fixture, { waitUntil: "domcontentloaded" });
  await page.evaluate((panelId) => {
    const modal = document.getElementById("adminModal");
    const card = modal.querySelector(".glass-card");
    const content = document.getElementById("adminContentSection");
    modal.classList.remove("hidden");
    document.getElementById("adminAuthSection").classList.add("hidden");
    content.classList.remove("hidden");
    card.querySelectorAll(":scope > [id^=sec-], :scope > #adminContentSection > [id^=sec-]")
      .forEach(section => section.classList.add("hidden"));
    const panel = document.getElementById(panelId);
    if (!panel || (panel.parentElement !== card && panel.parentElement !== content)) {
      throw new Error("Expected admin panel not found in dashboard layout: " + panelId);
    }
    panel.classList.remove("hidden");
    panel.insertAdjacentHTML("beforeend",
      '<div data-scroll-fixture style="height:2600px;min-height:2600px;width:100%;padding:16px">محتوى تجريبي لاختبار التمرير</div>');
  }, id);
}

for (const viewport of viewports) {
  test("all admin dashboard sections scroll — " + viewport.label, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });
    const panelIds = await page.locator(
      ".glass-card > [id^=sec-], .glass-card > #adminContentSection > [id^=sec-]"
    ).evaluateAll(elements => elements.map(element => element.id));
    expect(panelIds.length, "all direct and wrapped admin panels must be present").toBeGreaterThan(5);

    for (const id of panelIds) {
      await openAdminPanel(page, id);
      const card = page.locator("#adminModal .glass-card");
      const metrics = await card.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        return {
          height: element.clientHeight,
          scrollHeight: element.scrollHeight,
          overflowY: css.overflowY,
          display: css.display,
          flexDirection: css.flexDirection,
          top: rect.top,
          bottom: rect.bottom,
          viewportHeight: window.innerHeight
        };
      });
      expect(metrics.height, id + ": card scroll viewport must be bounded").toBeGreaterThan(100);
      expect(metrics.scrollHeight, id + ": active panel must extend beyond viewport").toBeGreaterThan(metrics.height);
      expect(metrics.overflowY, id + ": card must own vertical scrolling").toBe("auto");
      expect(metrics.display, id + ": card must remain a flex column").toBe("flex");
      expect(metrics.flexDirection, id + ": card flow must remain vertical").toBe("column");
      expect(metrics.top, id + ": dialog must remain inside viewport").toBeGreaterThanOrEqual(0);
      expect(metrics.bottom, id + ": dialog must not extend below viewport").toBeLessThanOrEqual(metrics.viewportHeight + 1);

      const box = await card.boundingBox();
      await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + Math.min(140, box.height / 2));
      await page.mouse.wheel(0, 650);
      await expect.poll(() => card.evaluate(element => element.scrollTop),
        { message: id + ": wheel scroll must move the admin card" }).toBeGreaterThan(0);
    }
  });
}

const printPinStart = source.indexOf("function printPinCredentials()");
const printPinEnd = source.indexOf("async function copyPinAndClose()", printPinStart);
if (printPinStart < 0 || printPinEnd < 0) throw new Error("Could not locate the production PIN print function.");
const printPinFunction = source.slice(printPinStart, printPinEnd);
const printPinFunctionGlobal = printPinFunction.replace(/^function printPinCredentials\(\)/, "window.printPinCredentials = function()");

test("new login credentials remain printable when popups are blocked", async ({ page }) => {
  await page.setContent('<div id="pinDisplayModal" data-pin="731946" data-name="Test Teacher"></div>');
  await page.addScriptTag({ content: printPinFunctionGlobal });
  await page.addScriptTag({ content:
    "window.__pinToasts = []; window.showToast = function (message) { window.__pinToasts.push(message); }; " +
    "window.open = function () { return null; }; window.setTimeout = function (callback) { if (typeof callback === 'function') callback(); return 1; };"
  });
  const before = await page.evaluate(() => ({
    functionType: typeof window.printPinCredentials,
    pin: document.getElementById("pinDisplayModal").dataset.pin,
    openIsStub: window.open.toString().includes("return null")
  }));
  expect(before.functionType).toBe("function");
  expect(before.pin).toBe("731946");
  expect(before.openIsStub).toBe(true);
  await page.evaluate(() => window.printPinCredentials());
  const result = await page.evaluate(() => ({
    iframeCount: document.querySelectorAll("iframe").length,
    iframeTitles: Array.from(document.querySelectorAll("iframe")).map(frame => frame.title),
    toasts: window.__pinToasts
  }));
  console.log("PIN_PRINT_FALLBACK_DIAGNOSTIC", JSON.stringify(result));
  expect(result.iframeCount).toBe(1);
  const frame = page.locator('iframe[title="طباعة بيانات الدخول"]');
  await expect.poll(() => frame.evaluate(el => el.contentDocument && el.contentDocument.body ? el.contentDocument.body.innerText : ""))
    .toContain("731946");
  await expect.poll(() => frame.evaluate(el => el.contentDocument && el.contentDocument.body ? el.contentDocument.body.innerText : ""))
    .toContain("Test Teacher");
});
