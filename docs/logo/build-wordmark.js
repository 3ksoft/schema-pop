// One-off build script: generates schema-pop-wordmark.svg by converting
// the "schema-pop" wordmark text to SVG path data via opentype.js, with
// the spiral inlined where the "o" would be.
//
// Run: bun docs/logo/build-wordmark.js
// Inputs:
//   - /tmp/Inter-Black.woff (downloaded once from @fontsource/inter)
//   - docs/logo/schema-pop-spiral.svg (committed asset)
// Output:
//   - docs/logo/schema-pop-wordmark.svg
//
// We render glyph-by-glyph (no GSUB shaping) because opentype.js does not
// implement every substitution table format Inter uses. For plain ASCII
// text the visual result is identical.

import opentype from 'opentype.js';
import fs from 'node:fs';

const FONT_PATH = '/tmp/Inter-Black.woff';
const FONT_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-900-normal.woff';
const SPIRAL_PATH = new URL('./schema-pop-spiral.svg', import.meta.url).pathname;
const OUT_PATH = new URL('./schema-pop-wordmark.svg', import.meta.url).pathname;

const fontSize = 1000;

if (!fs.existsSync(FONT_PATH)) {
    console.log(`Downloading Inter Black WOFF -> ${FONT_PATH}`);
    const res = await fetch(FONT_URL);
    if (!res.ok) throw new Error(`Font download failed: ${res.status}`);
    fs.writeFileSync(FONT_PATH, Buffer.from(await res.arrayBuffer()));
}

const fontBuf = fs.readFileSync(FONT_PATH);
const ab = fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength);
const font = opentype.parse(ab);

function advanceFor(char) {
    return (font.charToGlyph(char).advanceWidth / font.unitsPerEm) * fontSize;
}

function runWidth(text) {
    let w = 0;
    for (const ch of text) w += advanceFor(ch);
    return w;
}

function runPath(text, x0, y) {
    const path = new opentype.Path();
    let x = x0;
    for (const ch of text) {
        const glyph = font.charToGlyph(ch);
        const glyphPath = glyph.getPath(x, y, fontSize);
        path.extend(glyphPath);
        x += advanceFor(ch);
    }
    return path.toPathData(2);
}

const left = 'schema-p';
const right = 'p';

const leftAdvance = runWidth(left);
const oAdvance = advanceFor('o');
const rightAdvance = runWidth(right);

const xLeft = 0;
const xSpiral = leftAdvance;
const xRight = xSpiral + oAdvance;
const totalWidth = xRight + rightAdvance;

const ascender = (font.ascender / font.unitsPerEm) * fontSize;
const descender = (-font.descender / font.unitsPerEm) * fontSize;
const totalHeight = ascender + descender;
const baselineY = ascender;

const leftPath = runPath(left, xLeft, baselineY);
const rightPath = runPath(right, xRight, baselineY);

// Spiral position: centered on where the "o" glyph would visually sit.
const oGlyph = font.charToGlyph('o');
const oBbox = oGlyph.getBoundingBox();
const oTop = (oBbox.y2 / font.unitsPerEm) * fontSize;
const oBottom = (oBbox.y1 / font.unitsPerEm) * fontSize;
const oCenterY = baselineY - (oTop + oBottom) / 2;
const spiralCenterX = xSpiral + oAdvance / 2;
const spiralCenterY = oCenterY;

// Spiral viewBox is 0..512 with dome radius 230.4, so dome diameter = 460.8.
// Scale so that dome diameter ≈ "o" advance width.
const spiralScale = oAdvance / 460.8;

const spiralFull = fs.readFileSync(SPIRAL_PATH, 'utf8');
const spiralInner = spiralFull
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>/, '')
    .trim();

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth.toFixed(2)} ${totalHeight.toFixed(2)}" width="1em" height="1em">
<defs><style>
svg { color: #fdf5e6; }
.sp-text { fill: currentColor; }
@media (prefers-color-scheme: light) {
  svg { color: #1a1a1a; }
}
</style></defs>
<g class="sp-text">
<path d="${leftPath}"/>
<path d="${rightPath}"/>
</g>
<g transform="translate(${spiralCenterX.toFixed(2)} ${spiralCenterY.toFixed(2)}) scale(${spiralScale.toFixed(4)}) translate(-256 -256)">
${spiralInner}
</g>
</svg>
`;

fs.writeFileSync(OUT_PATH, svg);
console.log(`wrote ${OUT_PATH} (${svg.length} bytes, viewBox ${totalWidth.toFixed(0)}×${totalHeight.toFixed(0)})`);
