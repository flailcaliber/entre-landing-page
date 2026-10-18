/**
 * Generates the link preview image for guest invites (entre.nyc/join/<token>),
 * the card iMessage/WhatsApp/Slack show when an Entre user texts someone their
 * link. Renders the HTML below in headless Edge/Chrome, then saves it with sharp.
 *
 *   node scripts/generate-og-join.js
 *
 * /assets/* is served with a one-year immutable cache, so a changed image needs a
 * new filename: bump OG_NAME below and the og:image / twitter:image tags in join.html.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { execFileSync } = require('child_process');

const OG_NAME = 'og-join.png';
const ROOT = path.join(__dirname, '..');
const outPath = path.join(ROOT, 'assets', OG_NAME);

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) { console.error('✗  No Edge or Chrome found'); process.exit(1); }

const mark = fs.readFileSync(path.join(ROOT, 'assets', 'entre-mark.svg'), 'utf8');

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Cormorant+Garamond:ital,wght@1,500&family=DM+Sans:opsz,wght@9..40,500;9..40,600&display=block" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative; background: #FDFAF4; color: #131220; font-family: 'DM Sans', sans-serif;
    display: grid; grid-template-columns: 1fr 430px; align-items: center; padding: 0 84px; gap: 40px;
  }
  body::before {
    content: ''; position: absolute; inset: 0; opacity: .06;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  .brand { position: absolute; top: 56px; left: 84px; display: flex; align-items: center; gap: 12px; }
  .brand svg { width: 40px; height: 40px; }
  .brand span { font-family: 'Cormorant Garamond', serif; font-style: italic; font-weight: 500; font-size: 42px; line-height: 1; }
  h1 { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 96px; line-height: .98; letter-spacing: -0.04em; }
  p { margin-top: 26px; font-size: 34px; color: #4A4358; font-weight: 500; }
  .card {
    transform: rotate(-3deg); background: #fff; border: 2px solid #E2D9CC; border-radius: 34px; padding: 26px 30px 32px;
    box-shadow: 0 2px 0 #EDE6DB, 0 40px 60px -46px rgba(19, 18, 32, .55);
  }
  .top { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 20px; border-bottom: 3px dashed #E2D9CC; }
  .top .what { font-size: 19px; font-weight: 600; letter-spacing: .12em; color: #8A8098; }
  .top .when { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 800; font-size: 28px; }
  .seats { display: flex; gap: 22px; padding-top: 26px; }
  .av { width: 74px; height: 74px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 600; font-size: 26px; }
  .you { border: 3px dashed #8A8098; color: #8A8098; font-size: 21px; }
</style></head><body>
  <div class="brand">${mark}<span>Entre</span></div>
  <div>
    <h1>You're invited<br>to lunch.</h1>
    <p>Add your spot. No app needed.</p>
  </div>
  <div class="card">
    <div class="top"><span class="what">THE TABLE</span><span class="when">Lunch</span></div>
    <div class="seats">
      <div class="av" style="background:#4E9A4E">S</div>
      <div class="av" style="background:#BCA4E3">J</div>
      <div class="av" style="background:#98C8D2">M</div>
      <div class="av you">You</div>
    </div>
  </div>
</body></html>`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entre-og-join-'));
const page = path.join(tmpDir, 'og.html');
const shot = path.join(tmpDir, 'og-raw.png');
fs.writeFileSync(page, HTML);

execFileSync(browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--user-data-dir=${path.join(tmpDir, 'profile')}`,
  '--virtual-time-budget=8000', // let the web fonts load
  '--force-device-scale-factor=2',
  '--window-size=1200,630',
  `--screenshot=${shot}`,
  'file:///' + page.replace(/\\/g, '/'),
], { stdio: 'ignore' });

sharp(shot)
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(outPath)
  .then((info) => {
    console.log(`✓  ${OG_NAME}  ${info.width}×${info.height}  (${Math.round(info.size / 1024)} KB)`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  })
  .catch((err) => { console.error('✗  Error:', err.message); process.exit(1); });
