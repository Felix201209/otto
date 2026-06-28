const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8791/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'setup-shot-1.png' });
  // 选 custom 预设，露出协议下拉 + 填一些字段，再截一张
  await page.getByText('自定义 / 兼容端点').click();
  await page.waitForTimeout(150);
  const modelInput = page.locator('.otto-setup__input').nth(2);
  await page.locator('.otto-setup__input').first().fill('https://api.deepseek.com/v1');
  await page.locator('.otto-setup__keyinput').fill('sk-test-1234567890abcdef');
  await modelInput.fill('deepseek-chat');
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'setup-shot-2.png' });
  await browser.close();
})();
