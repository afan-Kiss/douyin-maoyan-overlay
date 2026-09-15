const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '../ui');
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file = path.join(root, name === '/' ? 'index.html' : decodeURIComponent(name));
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const executablePath = [
      'C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe',
      require('electron'),
    ].find(p => typeof p === 'string' && fs.existsSync(p));
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.addInitScript(() => {
      window.testSettings = { bubble: { enabled: true, minDelta: 0.001, durationMs: 2000 } };
      window.overlay = {
        getConfig: async () => ({}),
        getOverlaySettings: async () => window.testSettings,
        getSessionStatus: async () => ({}),
        onSettingsChanged: callback => { window.changeSettings = callback; },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1`);
    await page.waitForFunction(() => window.__racePreview);
    await page.clock.install();

    const render = (amount, id = 1001) => page.evaluate(({ amount, id }) => {
      window.__racePreview.renderList([{ movieId: id, rank: 1, name: '气泡测试', todayBox: amount, todayBoxText: String(amount), todayUnit: '万' }]);
      window.__racePreview.updateNation({ todayBox: amount, todayBoxText: String(amount), todayUnit: '万' }, {});
    }, { amount, id });
    const texts = () => page.evaluate(() => [
      document.querySelector('.race-card__delta-bubble')?.textContent || '',
      document.getElementById('nation-delta')?.textContent || '',
    ]);

    await render(852.22);
    assert.deepEqual(await texts(), ['', ''], 'baseline hidden');
    await page.clock.runFor(3000);
    assert.deepEqual(await texts(), ['', ''], 'no rise → no idle bubble');

    await render(853.22);
    assert.deepEqual(await texts(), ['+1万 ↑', '+1万 ↑'], 'rise → red number immediately');
    const colors = await page.evaluate(() => getComputedStyle(document.querySelector('.race-card__delta-bubble')).color);
    assert.equal(colors, 'rgb(255, 77, 77)');

    await page.clock.runFor(2100);
    assert.deepEqual(await texts(), ['', ''], 'rise bubble auto-hides after duration');

    await page.clock.runFor(3000);
    assert.deepEqual(await texts(), ['', ''], 'tick without delta stays empty');

    await render(854.22);
    assert.deepEqual(await texts(), ['+1万 ↑', '+1万 ↑'], 'another rise → red again');

    await page.clock.runFor(2100);
    assert.deepEqual(await texts(), ['', ''], 'hide again');
    await render(850.0);
    assert.deepEqual(await texts(), ['', ''], 'lower reading discarded → no bubble');
    await page.clock.runFor(3000);
    assert.deepEqual(await texts(), ['', ''], 'still no idle bubble after reject');

    await render(855.22);
    assert.deepEqual(await texts(), ['+1万 ↑', '+1万 ↑'], 'rise above high-water → red again');

    console.log('PASS: rise-only cadence, auto-hide, high-water reject');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
