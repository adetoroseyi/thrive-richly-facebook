// Typography design renderer — SVG built in code, rasterized to PNG with sharp.
// Deterministic: the same design object always renders the same pixels, so what
// the human approved in preview is exactly what gets printed.
//
// Two theme variants per design:
//   light — white text + gold accent, transparent background (dark garments)
//   dark  — charcoal text + deep-gold accent, transparent background (white mugs)
// Previews add a solid background so the design is visible on GitHub's white UI.

const sharp = require('sharp');

const PRINT_W = 4500;   // 15" at 300dpi
const PRINT_H = 5400;   // 18" at 300dpi

const THEMES = {
  light: { text: '#FFFFFF', accent: '#FFD700', previewBg: '#1A2430' },
  dark: { text: '#101820', accent: '#C9A100', previewBg: '#FFFFFF' },
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function designSvg(design, themeKey, { background = null, width = PRINT_W, height = PRINT_H } = {}) {
  const theme = THEMES[themeKey];
  const lines = design.quote_lines.map(l => l.toUpperCase());
  const subline = (design.subline || '').trim();

  // Fit the longest line inside ~87% of the canvas width. Heavy sans glyphs
  // average ~0.62em wide; this is an estimate, so lines are capped at 22 chars
  // by the drafting schema to keep the estimate safe.
  const maxLen = Math.max(...lines.map(l => l.length), 1);
  const fontSize = Math.min(Math.round(width * 0.125), Math.floor((width * 0.87) / (maxLen * 0.62)));
  const lineGap = Math.round(fontSize * 1.24);
  const dividerGap = Math.round(fontSize * 0.9);
  const subSize = Math.round(fontSize * 0.34);

  const blockH = lines.length * lineGap + (subline ? dividerGap + subSize : 0);
  let y = Math.round(height / 2 - blockH / 2 + fontSize * 0.8);

  const parts = [];
  if (background) parts.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  for (const line of lines) {
    parts.push(
      `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${fontSize}" letter-spacing="${Math.round(fontSize * 0.02)}" fill="${theme.text}">${esc(line)}</text>`,
    );
    y += lineGap;
  }
  if (subline) {
    y = y - lineGap + dividerGap;
    const dw = Math.round(width * 0.14);
    parts.push(`<rect x="${width / 2 - dw / 2}" y="${y - Math.round(subSize * 1.2)}" width="${dw}" height="${Math.max(6, Math.round(width * 0.0035))}" fill="${theme.accent}"/>`);
    parts.push(
      `<text x="${width / 2}" y="${y + subSize}" text-anchor="middle" font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${subSize}" letter-spacing="${Math.round(subSize * 0.18)}" fill="${theme.accent}">${esc(subline.toUpperCase())}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

// Full-size transparent print file (4500x5400 PNG).
async function renderPrintFile(design, themeKey, outPath) {
  const svg = designSvg(design, themeKey);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

// Quarter-size preview on a solid background, for human review on GitHub.
async function renderPreview(design, themeKey, outPath) {
  const svg = designSvg(design, themeKey, {
    background: THEMES[themeKey].previewBg,
    width: PRINT_W / 4,
    height: PRINT_H / 4,
  });
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = { renderPrintFile, renderPreview, designSvg, PRINT_W, PRINT_H };
