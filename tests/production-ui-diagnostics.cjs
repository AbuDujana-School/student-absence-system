const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const failedRequests = [];
  const consoleErrors = [];
  page.on('requestfailed', request => {
    if (/tailwind|fontawesome|googleapis|gstatic/i.test(request.url())) {
      failedRequests.push({ url: request.url(), error: request.failure()?.errorText || 'request failed' });
    }
  });
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  try {
    const response = await page.goto(process.env.PRODUCTION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(9000);
    const visual = await page.evaluate(() => {
      const root = document.querySelector('#loginView');
      const input = document.querySelector('#userPinInput');
      const button = document.querySelector('#loginSubmitBtn');
      const read = el => {
        if (!el) return null;
        const s = getComputedStyle(el);
        return {
          width: s.width, maxWidth: s.maxWidth, padding: s.padding,
          borderRadius: s.borderRadius, fontFamily: s.fontFamily,
          backgroundColor: s.backgroundColor, boxShadow: s.boxShadow,
          display: s.display
        };
      };
      const tailwindStyleSheets = [...document.styleSheets].filter(sheet => {
        try { return [...sheet.cssRules].some(rule => rule.cssText.includes('.max-w-md') || rule.cssText.includes('.p-8')); }
        catch (_) { return false; }
      }).length;
      return {
        title: document.title,
        build: document.querySelector('meta[name="app-build"]')?.content || null,
        loginFound: !!root, pinInputFound: !!input, submitFound: !!button,
        login: read(root), input: read(input), button: read(button),
        tailwindStyleSheets,
        styleTags: document.querySelectorAll('style').length,
        stylesheetLinks: [...document.querySelectorAll('link[rel="stylesheet"]')].map(x => x.href)
      };
    });
    await page.screenshot({ path: 'production-login-ui.png', fullPage: true });
    console.log('PRODUCTION_UI_DIAGNOSTIC=' + JSON.stringify({
      httpStatus: response?.status(), visual, failedRequests, consoleErrors
    }));
    if (!visual.loginFound || !visual.pinInputFound || !visual.submitFound) throw new Error('Login elements missing from production page');
    if (visual.login.maxWidth === 'none' || visual.login.padding === '0px' || visual.input.padding === '0px') {
      throw new Error('Tailwind utility styles are missing or not applied to the production login screen');
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
