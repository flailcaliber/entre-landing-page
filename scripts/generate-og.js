/**
 * Generates the social link preview image (1200×630) from the live homepage
 * design: renders index.html's hero in headless Edge/Chrome, then saves it
 * with sharp.
 *
 * Run after any hero design change: node scripts/generate-og.js
 *
 * /assets/* is served with a one-year immutable cache, so a changed image
 * needs a new filename: bump OG_NAME below and update the og:image /
 * twitter:image tags in index.html to match.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const sharp  = require('sharp');
const { execFileSync } = require('child_process');

const OG_NAME = 'og-beta.png';
const ROOT    = path.join(__dirname, '..');
const outPath = path.join(ROOT, 'assets', OG_NAME);

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const browser = BROWSERS.find(p => fs.existsSync(p));
if (!browser) { console.error('✗  No Edge or Chrome found'); process.exit(1); }

// Render at 1600×840 and scale to 1200×630 so the desktop hero layout fits.
// The install steps, waitlist link and scroll cue are hidden: a preview only
// needs the headline, button and map.
const OG_CSS = `
  .install-help, .hero-alt, .scroll-cue { display: none !important; }
  .hero { min-height: 840px !important; padding-top: 104px !important; padding-bottom: 40px !important; }
  .hero h1 { font-size: 5.4rem !important; }
`;

const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'entre-og-'));
const page    = path.join(tmpDir, 'og.html');
const shot    = path.join(tmpDir, 'og-raw.png');
const fileUrl = p => 'file:///' + p.replace(/\\/g, '/');

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace('<head>', `<head><base href="${fileUrl(ROOT)}/">`)
           .replace('</style>', OG_CSS + '</style>');
fs.writeFileSync(page, html);

execFileSync(browser, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--user-data-dir=${path.join(tmpDir, 'profile')}`,
  '--allow-file-access-from-files',
  '--virtual-time-budget=8000',          // let the hero animations finish
  '--force-device-scale-factor=1',
  '--window-size=1600,840',
  `--screenshot=${shot}`,
  fileUrl(page),
], { stdio: 'ignore' });

sharp(shot)
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(outPath)
  .then(info => {
    console.log(`✓  ${OG_NAME}  ${info.width}×${info.height}  (${Math.round(info.size / 1024)} KB)`);
    console.log(`   → ${outPath}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  })
  .catch(err => { console.error('✗  Error:', err.message); process.exit(1); });
