'use strict';

// Garden sheets use the same capture format, with codes distinct from every fish sheet.
const fs = require('node:fs');
const path = require('node:path');
const fish = require('../assets/coloring/manifest.json');
const out = path.join(__dirname, '../assets/garden');
const corners = ['tl', 'tr', 'bl', 'br'];
const rotate = bits => Array.from({ length: 16 }, (_, i) => bits[(3 - i % 4) * 4 + Math.floor(i / 4)]);
const distance = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
const rotations = bits => { const all = []; for (let i = 0; i < 4; i++, bits = rotate(bits)) all.push(bits); return all; };

function codes(count) {
  const taken = fish.fish.flatMap(f => corners.flatMap(c => rotations(f.markers[c])));
  const result = [];
  for (let n = 1; n < 65535 && result.length < count; n++) {
    const bits = Array.from({ length: 16 }, (_, i) => (n >> i) & 1);
    const whites = bits.reduce((a, b) => a + b, 0);
    if (whites < 5 || whites > 11) continue;
    const rots = rotations(bits);
    if (rots.some((a, i) => rots.slice(i + 1).some(b => distance(a, b) < 4))) continue;
    if (rots.some(a => taken.some(b => distance(a, b) < 4))) continue;
    result.push(bits); taken.push(...rots);
  }
  if (result.length !== count) throw new Error('Not enough distinct garden marker codes');
  return result;
}

function butterfly() {
  const points = [[0, 0.42]];
  const segments = [
    [[0.13, 0.65], [0.5, 0.58], [0.5, 0.31]],
    [[0.5, 0.17], [0.36, 0.09], [0.25, 0.04]],
    [[0.53, 0.03], [0.49, -0.38], [0.27, -0.4]],
    [[0.12, -0.42], [0.08, -0.2], [0, -0.42]]
  ];
  for (const [a, b, c] of segments) {
    const start = points[points.length - 1];
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, u = 1 - t;
      points.push([0, 1].map(k => +(u ** 3 * start[k] + 3 * u * u * t * a[k] + 3 * u * t * t * b[k] + t ** 3 * c[k]).toFixed(5)));
    }
  }
  return points.concat(points.slice(1, -1).reverse().map(([x, y]) => [-x, y]));
}

const specs = [
  { name: 'garden-butterfly', titles: { ru: 'Бабочка', en: 'Butterfly', pl: 'Motyl' }, contour: butterfly() },
  { name: 'garden-flower', titles: { ru: 'Цветок', en: 'Flower', pl: 'Kwiat' },
    contour: Array.from({ length: 180 }, (_, i) => {
      const a = i / 180 * Math.PI * 2, r = 0.38 + 0.12 * Math.cos(6 * a);
      return [+(r * Math.cos(a)).toFixed(5), +(r * Math.sin(a)).toFixed(5)];
    }) }
];
const markerCodes = codes(specs.length * 4);
const sheet = fish.sheet;
const entries = specs.map((s, i) => {
  const bbox = { z: [Math.min(...s.contour.map(p => p[0])), Math.max(...s.contour.map(p => p[0]))],
    y: [Math.min(...s.contour.map(p => p[1])), Math.max(...s.contour.map(p => p[1]))] };
  const scale = 0.87 * Math.min((sheet.work.x1 - sheet.work.x0) / (bbox.z[1] - bbox.z[0]),
    (sheet.work.y1 - sheet.work.y0) / (bbox.y[1] - bbox.y[0]));
  return { name: s.name, world: 'garden', title: s.titles.ru, titles: s.titles,
    svg: 'assets/garden/' + s.name + '.svg',
    sheets: Object.fromEntries(['ru', 'en', 'pl'].map(lang => [lang, 'assets/garden/' + s.name + (lang === 'ru' ? '' : '.' + lang) + '.svg'])),
    contourModel: s.contour, bboxModel: bbox,
    sheetTransform: { scale, ox: sheet.w / 2, oy: (sheet.work.y0 + sheet.work.y1) / 2 },
    markers: Object.fromEntries(corners.map((c, j) => [c, markerCodes[i * 4 + j]])) };
});

function marker(bits, x, y) {
  const cell = sheet.marker.size / sheet.marker.cells;
  let svg = `<rect x="${x}" y="${y}" width="${sheet.marker.size}" height="${sheet.marker.size}" fill="#000"/>`;
  bits.forEach((white, i) => { if (white) svg += `<rect x="${x + (i % 4 + 1) * cell}" y="${y + (Math.floor(i / 4) + 1) * cell}" width="${cell}" height="${cell}" fill="#fff"/>`; });
  return svg;
}

fs.mkdirSync(out, { recursive: true });
for (const f of entries) {
  const st = f.sheetTransform;
  const X = x => (st.ox + x * st.scale).toFixed(3);
  const Y = y => (st.oy - y * st.scale).toFixed(3);
  const outline = f.contourModel.map((p, i) => `${i ? 'L' : 'M'}${X(p[0])} ${Y(p[1])}`).join(' ') + 'Z';
  const detail = f.name === 'garden-flower'
    ? `<circle cx="${X(0)}" cy="${Y(0)}" r="${st.scale * 0.14}"/>`
    : `<path d="M${X(0)} ${Y(0.35)} L${X(0)} ${Y(-0.3)} M${X(0)} ${Y(0.3)} Q${X(-0.03)} ${Y(0.43)} ${X(-0.08)} ${Y(0.42)} M${X(0)} ${Y(0.3)} Q${X(0.03)} ${Y(0.43)} ${X(0.08)} ${Y(0.42)}"/>`;
  for (const lang of ['ru', 'en', 'pl']) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">
<rect width="${sheet.w}" height="${sheet.h}" fill="#fff"/>
${corners.map(c => marker(f.markers[c], ...sheet.markerPositions[c])).join('\n')}
<path d="${outline}" fill="#fff" stroke="#aaa" stroke-width="0.35" stroke-linejoin="round"/>
<g fill="none" stroke="#bbb" stroke-width="0.35">${detail}</g>
<text x="${sheet.w / 2}" y="197" text-anchor="middle" font-family="sans-serif" font-size="7" fill="#444">${f.titles[lang]}</text>
</svg>\n`;
    fs.writeFileSync(path.join(__dirname, '..', f.sheets[lang]), svg);
  }
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ version: 2, sheet, fish: entries }, null, 1) + '\n');
const shape = (f, x, y, size, color) => `<path d="${f.contourModel.map((p, i) => `${i ? 'L' : 'M'}${(x + p[0] * size).toFixed(2)} ${(y - p[1] * size).toFixed(2)}`).join(' ')}Z" fill="${color}"/>`;
fs.writeFileSync(path.join(out, 'preview.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270">
<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#addde6"/><stop offset="1" stop-color="#fff4ce"/></linearGradient></defs>
<path fill="url(#sky)" d="M0 0H480V270H0Z"/><circle cx="380" cy="58" r="25" fill="#fff6d2"/>
<path fill="#a8ca8e" d="M0 202Q110 140 240 205T480 180V270H0Z"/><path fill="#6c9e69" d="M0 240Q240 180 480 230V270H0Z"/>
<path stroke="#487b4c" stroke-width="4" d="M140 250V190M320 270V215"/>
${shape(entries[1], 140, 190, 64, '#f2a3a0')}${shape(entries[1], 320, 215, 55, '#ffd38b')}
<circle cx="140" cy="190" r="9" fill="#ffdc6d"/><circle cx="320" cy="215" r="8" fill="#ffdc6d"/>
${shape(entries[0], 210, 110, 53, '#8e98cf')}${shape(entries[0], 90, 75, 35, '#7bc6bb')}
</svg>\n`);
console.log('Garden: 2 sheets in 3 languages; marker distance >= 4, including all fish codes.');
