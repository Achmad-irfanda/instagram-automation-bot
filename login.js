const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const sessionPath = path.join(__dirname, 'ig-session');
  const context = await chromium.launchPersistentContext(sessionPath, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });

  const page = await context.newPage();
  await page.goto('https://www.instagram.com/');

  console.log('login dulu bro.');
  console.log('Jika sudah masuk beranda, tekan Ctrl+C di terminal untuk menyimpan session.');

  await page.waitForTimeout(300000);
})();