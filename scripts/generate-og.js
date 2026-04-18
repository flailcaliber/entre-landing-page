/**
 * Generates assets/og-image.png (1200×630) for social link previews.
 * Run once after any design change: node scripts/generate-og.js
 * Requires: npm install --save-dev sharp
 */

const sharp  = require('sharp');
const path   = require('path');
const outPath = path.join(__dirname, '..', 'assets', 'og-image.png');

// ── SVG template ────────────────────────────────────────────
// Fonts: Georgia (serif, Georgia-like stand-in for Cormorant) + system sans.
// sharp uses libvips which renders SVG text with system fonts — both are universally present.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <!-- Ambient blobs -->
    <filter id="blur-a" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="80"/>
    </filter>
    <filter id="blur-b" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="90"/>
    </filter>
    <!-- Grain overlay -->
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feBlend in="SourceGraphic" mode="overlay" result="blend"/>
      <feComposite in="blend" in2="SourceGraphic"/>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="#131220"/>

  <!-- Sage blob (left) -->
  <circle cx="160" cy="310" r="360" fill="#9ED29E" fill-opacity="0.13" filter="url(#blur-a)"/>

  <!-- Purple blob (right) -->
  <circle cx="1050" cy="260" r="400" fill="#7C3AED" fill-opacity="0.14" filter="url(#blur-b)"/>

  <!-- ── Logo mark (Concept 02: geometric e-pin) ──────────────
       Original viewBox: 0 0 46 70  →  scale 2.28 → 105 × 160 px
       Center x: 600 → translate x = 600 - 105/2 = 547.5
       Start y: 78 px from top
  -->
  <g transform="translate(547.5, 78) scale(2.28)" fill="none">
    <path d="M 37.6 12 A 18 18 0 1 0 37.6 30"
          stroke="#9ED29E" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="4"  y1="21" x2="35" y2="21"
          stroke="#9ED29E" stroke-width="2.4" stroke-linecap="round"/>
    <line x1="22" y1="39" x2="22" y2="57"
          stroke="#9ED29E" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="22" cy="62" r="4.5" fill="#9ED29E"/>
  </g>

  <!-- ── "entre" wordmark ─────────────────────────────────── -->
  <!-- Georgia is visually close to Cormorant Garamond and is a universal system font -->
  <text x="600" y="388"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="114"
        font-weight="400"
        fill="#FFF8F0"
        text-anchor="middle"
        letter-spacing="3">entre</text>

  <!-- ── Tagline ───────────────────────────────────────────── -->
  <text x="600" y="448"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="27"
        font-weight="300"
        fill="rgba(255,248,240,0.48)"
        text-anchor="middle"
        letter-spacing="0.5">The restaurant between you two.</text>

  <!-- ── Thin rule ─────────────────────────────────────────── -->
  <line x1="540" y1="510" x2="660" y2="510"
        stroke="rgba(255,248,240,0.1)" stroke-width="1"/>

  <!-- ── URL ───────────────────────────────────────────────── -->
  <text x="600" y="566"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="19"
        font-weight="300"
        fill="rgba(255,248,240,0.22)"
        text-anchor="middle"
        letter-spacing="4">ENTRE.NYC</text>
</svg>`;

// ── Generate ─────────────────────────────────────────────────
sharp(Buffer.from(svg))
  .png({ quality: 95, compressionLevel: 8 })
  .toFile(outPath, (err, info) => {
    if (err) { console.error('✗  Error:', err.message); process.exit(1); }
    console.log(`✓  og-image.png  ${info.width}×${info.height}  (${Math.round(info.size / 1024)} KB)`);
    console.log(`   → ${outPath}`);
  });
