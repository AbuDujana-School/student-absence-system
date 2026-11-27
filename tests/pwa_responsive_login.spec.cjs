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

// Use the real login markup and its real CSS, without executing the school app's
// authentication, Supabase, service-worker, or data-management scripts.
const loginMarkup = divElementById("loginView");
const fixture = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  ${styleBlock("login-first-paint")}
  ${styleBlock("premium-pin-login-style")}
  ${styleBlock("premium-pin-responsive-layout")}
</head>
<body class="login-mode">
  <main>${loginMarkup}</main>
</body>
</html>`;

const viewports = [
  { label: "compact phone 320x568", width: 320, height: 568 },
  { label: "phone 360x780", width: 360, height: 780 },
  { label: "phone 393x852", width: 393, height: 852 },
  { label: "large phone 412x915", width: 412, height: 915 },
  { label: "large phone 432x960", width: 432, height: 960 },
  { label: "phone landscape 844x390", width: 844, height: 390 },
  { label: "tablet portrait 800x1280", width: 800, height: 1280 },
  { label: "desktop 1366x768", width: 1366, height: 768 }
];

mkdirSync(path.join(__dirname, "..", "test-results"), { recursive: true });

for (const viewport of viewports) {
  test(`PIN login responsive layout — ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.setContent(fixture, { waitUntil: "domcontentloaded" });

    const metrics = await page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        const box = element.getBoundingClientRect();
        return { width: box.width, height: box.height, left: box.left, right: box.right };
      };
      const css = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        bodyScrollWidth: document.body.scrollWidth,
        root: rect("#loginView"),
        main: rect("main"),
        hero: rect(".sl-hero"),
        key: rect(".sl-key"),
        titleFont: parseFloat(css(".sl-title").fontSize),
        bodyOverflowY: css("body").overflowY,
        mainOverflowY: css("main").overflowY,
        cardDisplay: css(".sl-card").display
      };
    });

    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(viewport.width + 1);
    expect(metrics.root.width).toBeGreaterThan(viewport.width * 0.85);
    expect(metrics.root.height).toBeGreaterThan(viewport.height * 0.82);
    expect(metrics.root.left).toBeGreaterThanOrEqual(-1);
    expect(metrics.root.right).toBeLessThanOrEqual(viewport.width + 1);
    expect(metrics.titleFont).toBeGreaterThanOrEqual(18);
    expect(metrics.bodyOverflowY).not.toBe("hidden");
    expect(metrics.mainOverflowY).not.toBe("hidden");

    if (viewport.width < 760) {
      expect(metrics.hero.width).toBeGreaterThanOrEqual(94);
      expect(metrics.key.height).toBeGreaterThanOrEqual(54);
      expect(metrics.cardDisplay).toBe("flex");
    } else {
      expect(metrics.hero.width).toBeGreaterThanOrEqual(132);
      expect(metrics.key.height).toBeGreaterThanOrEqual(60);
      expect(metrics.cardDisplay).toBe("grid");
    }

    await page.screenshot({
      path: path.join(__dirname, "..", "test-results", `pin-login-${viewport.width}x${viewport.height}.png`),
      fullPage: true
    });
  });
}
