'use strict';

/* Листы и манифест сада из tools/garden-art.js.
 *
 *   node tools/make-garden.js        (или npm run garden)
 *
 * На каждый вид: лист раскраски на трёх языках (assets/garden/<вид>[.en|.pl].svg),
 * «готовый» рисунок в родных цветах (<вид>.ready.svg — того же кадра, что
 * текстура со съёмки) и запись в manifest.json: контур для съёмки, метки,
 * 3D-параметры в модельных координатах.
 *
 * Старые виды garden-butterfly и garden-flower остаются в манифесте как есть
 * (legacy): их рисунки уже живут на телевизорах, а распечатанные листы должны
 * узнаваться. Новые метки не совпадают ни с ними, ни с рыбьими.
 */
const fs = require('node:fs');
const path = require('node:path');
const fish = require('../assets/coloring/manifest.json');
const ART = require('./garden-art.js');

const OUT = path.join(__dirname, '../assets/garden');
const MANIFEST = path.join(OUT, 'manifest.json');
const LANGS = ['ru', 'en', 'pl'];
const corners = ['tl', 'tr', 'bl', 'br'];
const sheet = fish.sheet;
const r2 = (n) => Math.round(n * 100) / 100;
const r5 = (n) => Math.round(n * 1e5) / 1e5;

// ── метки ───────────────────────────────────────────────────────────────────
const rotate = (bits) => Array.from({ length: 16 }, (_, i) => bits[(3 - i % 4) * 4 + Math.floor(i / 4)]);
const distance = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
const rotations = (bits) => { const all = []; for (let i = 0; i < 4; i++, bits = rotate(bits)) all.push(bits); return all; };

function codes(count, used) {
  const taken = used.flatMap(rotations), result = [];
  for (let n = 1; n < 65535 && result.length < count; n++) {
    const bits = Array.from({ length: 16 }, (_, i) => (n >> i) & 1);
    const whites = bits.reduce((a, b) => a + b, 0);
    if (whites < 5 || whites > 11) continue;
    const rots = rotations(bits);
    if (rots.some((a, i) => rots.slice(i + 1).some((b) => distance(a, b) < 4))) continue;
    if (rots.some((a) => taken.some((b) => distance(a, b) < 4))) continue;
    result.push(bits); taken.push(...rots);
  }
  if (result.length !== count) throw new Error('Not enough distinct garden marker codes');
  return result;
}

function marker(bits, x, y) {
  const cell = sheet.marker.size / sheet.marker.cells;
  let svg = `<rect x="${x}" y="${y}" width="${sheet.marker.size}" height="${sheet.marker.size}" fill="#000"/>`;
  bits.forEach((white, i) => {
    if (white) svg += `<rect x="${x + (i % 4 + 1) * cell}" y="${y + (Math.floor(i / 4) + 1) * cell}" width="${cell}" height="${cell}" fill="#fff"/>`;
  });
  return svg;
}

// ── путь → полилинии (рисунки пишут только абсолютные M L C Q Z) ──────────
function flatten(d) {
  const subs = [];
  let cur = null, x = 0, y = 0;
  const re = /([MLCQZ])([^MLCQZ]*)/g;
  let m;
  while ((m = re.exec(d))) {
    const n = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (m[1] === 'M') { cur = [[n[0], n[1]]]; subs.push(cur); [x, y] = n; for (let i = 2; i < n.length; i += 2) { cur.push([n[i], n[i + 1]]); [x, y] = [n[i], n[i + 1]]; } }
    if (m[1] === 'L') for (let i = 0; i < n.length; i += 2) { cur.push([n[i], n[i + 1]]); [x, y] = [n[i], n[i + 1]]; }
    if (m[1] === 'C') for (let i = 0; i < n.length; i += 6) {
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        cur.push([u * u * u * x + 3 * u * u * t * n[i] + 3 * u * t * t * n[i + 2] + t * t * t * n[i + 4],
          u * u * u * y + 3 * u * u * t * n[i + 1] + 3 * u * t * t * n[i + 3] + t * t * t * n[i + 5]]);
      }
      [x, y] = [n[i + 4], n[i + 5]];
    }
    if (m[1] === 'Q') for (let i = 0; i < n.length; i += 4) {
      for (let k = 1; k <= 12; k++) {
        const t = k / 12, u = 1 - t;
        cur.push([u * u * x + 2 * u * t * n[i] + t * t * n[i + 2], u * u * y + 2 * u * t * n[i + 1] + t * t * n[i + 3]]);
      }
      [x, y] = [n[i + 2], n[i + 3]];
    }
  }
  return subs.filter((s) => s.length > 2);
}

// ── внешний контур: объединение частей через растр ──────────────────────────
// Части перекрываются (лепестки, листья на стебле), а съёмке нужен один
// замкнутый контур. Растр 1400 px по большей стороне — это ±0.1 мм на листе.
function outlineOf(parts) {
  const polys = parts.flatMap((p) => flatten(p.d));
  const xs = polys.flat().map((p) => p[0]), ys = polys.flat().map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  const k = 1400 / Math.max(x1 - x0, y1 - y0);
  const W = Math.ceil((x1 - x0) * k) + 4, H = Math.ceil((y1 - y0) * k) + 4;
  const grid = new Uint8Array(W * H);
  for (const poly of polys) {
    const pts = poly.map(([x, y]) => [(x - x0) * k + 2, (y - y0) * k + 2]);
    for (let row = 0; row < H; row++) {
      const yc = row + 0.5, xsRow = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= yc) !== (b[1] <= yc)) xsRow.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xsRow.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xsRow.length; i += 2) {
        for (let col = Math.max(0, Math.ceil(xsRow[i] - 0.5)); col <= Math.min(W - 1, Math.floor(xsRow[i + 1] - 0.5)); col++) grid[row * W + col] = 1;
      }
    }
  }
  // Обход границы по рёбрам пикселей: внутри всегда справа.
  const inside = (c, r) => c >= 0 && r >= 0 && c < W && r < H && grid[r * W + c] === 1;
  const edges = new Map();
  const add = (ax, ay, bx, by) => { const key = ax + ',' + ay; if (!edges.has(key)) edges.set(key, []); edges.get(key).push([bx, by]); };
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!inside(c, r)) continue;
    if (!inside(c, r - 1)) add(c, r, c + 1, r);
    if (!inside(c + 1, r)) add(c + 1, r, c + 1, r + 1);
    if (!inside(c, r + 1)) add(c + 1, r + 1, c, r + 1);
    if (!inside(c - 1, r)) add(c, r + 1, c, r);
  }
  let best = [];
  while (edges.size) {
    const [startKey] = edges.keys();
    const loop = [];
    let key = startKey;
    while (edges.has(key)) {
      const list = edges.get(key), next = list.pop();
      if (!list.length) edges.delete(key);
      loop.push(key.split(',').map(Number));
      key = next[0] + ',' + next[1];
    }
    if (loop.length > best.length) best = loop;
  }
  const back = best.map(([c, r]) => [(c - 2) / k + x0, (r - 2) / k + y0]);
  return simplify(back, 1.4 / k);
}

function simplify(pts, tol) {
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1, dmax = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > dmax) { dmax = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ── SVG ─────────────────────────────────────────────────────────────────────
function paint(fill, defs, id) {
  if (!fill) return 'none';
  if (typeof fill === 'string') return fill;
  const stops = fill.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  if (fill.radial) defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fill.radial.cx}" cy="${fill.radial.cy}" r="${fill.radial.r}">${stops}</radialGradient>`);
  else defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fill.linear.x1}" y1="${fill.linear.y1}" x2="${fill.linear.x2}" y2="${fill.linear.y2}">${stops}</linearGradient>`);
  return `url(#${id})`;
}

// ready: родные цвета; иначе — лист: белые зоны, серые линии толщиной в мм.
function artBody(spec, ready, mm) {
  const defs = [], body = [];
  spec.parts.forEach((part, i) => {
    const id = spec.name + '-' + i;
    // Контур части — один раз в defs; заливка, обрезка зон и обводка ссылаются на него.
    defs.push(`<path id="${id}" d="${part.d}"/>`);
    body.push(`<use href="#${id}" fill="${ready ? paint(part.fill, defs, id + 'f') : '#fff'}"/>`);
    if ((part.zones && part.zones.length) || (part.lines && part.lines.length)) {
      defs.push(`<clipPath id="${id}c"><use href="#${id}"/></clipPath>`);
      body.push(`<g clip-path="url(#${id}c)">`);
      (part.zones || []).forEach((z, j) => body.push(ready
        ? `<path d="${z.d}" fill="${paint(z.fill, defs, id + 'z' + j)}"/>`
        : `<path d="${z.d}" fill="#fff" stroke="#7a7a7a" stroke-width="${mm(0.75)}" stroke-linejoin="round"/>`));
      (part.lines || []).forEach((l) => {
        const d = typeof l === 'string' ? l : l.d;
        body.push(`<path d="${d}" fill="none" stroke="${ready ? l.color || '#0004' : '#8a8a8a'}" stroke-width="${ready ? mm(0.4) : mm(0.5)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      });
      body.push('</g>');
    }
    body.push(`<use href="#${id}" fill="none" stroke="${ready ? part.edge || '#0006' : '#7a7a7a'}" stroke-width="${ready ? mm(0.35) : mm(0.75)}" stroke-linejoin="round"/>`);
  });
  return { defs, body };
}

const pathOf = (pts) => 'M' + pts.map((p) => Math.round(p[0]) + ' ' + Math.round(p[1])).join(' ') + 'Z';

function sheetInner(spec, entry, lang) {
  const st = entry.sheetTransform, k = st.scale / spec.S;
  const mm = (v) => r5(v / k);
  const { defs, body } = artBody(spec, false, mm);
  const antennae = (spec.antennae || []).map((d) => `<path d="${d}" fill="none" stroke="#555" stroke-width="${mm(0.9)}" stroke-linecap="round"/>`).join('');
  return `<rect width="${sheet.w}" height="${sheet.h}" fill="#fff"/>
${corners.map((c) => marker(entry.markers[c], ...sheet.markerPositions[c])).join('\n')}
<defs>${defs.join('')}</defs>
<g transform="matrix(${r5(k)} 0 0 ${r5(k)} ${r5(st.ox - k * spec.ox)} ${r5(st.oy - k * spec.oy)})">
${body.join('\n')}
${antennae}
<path d="${pathOf(spec.outline)}" fill="none" stroke="#555" stroke-width="${mm(1.6)}" stroke-linejoin="round"/>
</g>
<text x="${sheet.w / 2}" y="197" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="7.0" font-weight="600" fill="#444">${spec.titles[lang]}</text>`;
}
const svgHead = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">`;
const sheetSvg = (spec, entry, lang) => svgHead + '\n' + sheetInner(spec, entry, lang) + '\n</svg>\n';

// Несколько видов на одной А4 — как у рыб (make-coloring.js): каждый лист
// целиком, уменьшенный, со своими метками; между листами линии отреза.
const LAYOUTS = { 4: [2, 2], 6: [3, 2] }, PAGE = { margin: 4, gap: 4 };
function pageSvg(group, lang, cols, rows) {
  const W = sheet.w, H = sheet.h, g = PAGE.gap;
  const k = Math.min((W - 2 * PAGE.margin - (cols - 1) * g) / cols / W, (H - 2 * PAGE.margin - (rows - 1) * g) / rows / H);
  const sw = W * k, sh = H * k, x0 = (W - cols * sw - (cols - 1) * g) / 2, y0 = (H - rows * sh - (rows - 1) * g) / 2;
  const cut = 'stroke="#bbb" stroke-width="0.25" stroke-dasharray="1 1.5"', out = [svgHead, `<rect width="${W}" height="${H}" fill="#fff"/>`];
  for (let c = 1; c < cols; c++) { const x = r2(x0 + c * sw + (c - 0.5) * g); out.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" ${cut}/>`); }
  for (let r = 1; r < rows; r++) { const y = r2(y0 + r * sh + (r - 0.5) * g); out.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" ${cut}/>`); }
  group.forEach(([spec, entry], i) => {
    out.push(`<svg x="${r2(x0 + (i % cols) * (sw + g))}" y="${r2(y0 + Math.floor(i / cols) * (sh + g))}" width="${r2(sw)}" height="${r2(sh)}" viewBox="0 0 ${W} ${H}">`,
      sheetInner(spec, entry, lang), '</svg>');
  });
  return out.join('\n') + '\n</svg>\n';
}

// Кадр «готового» рисунка = рамка контура, как у текстуры со съёмки.
function readyParts(spec) {
  const xs = spec.outline.map((p) => p[0]), ys = spec.outline.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
  const { defs, body } = artBody(spec, true, (v) => r5(v * spec.S / 120));
  const id = spec.name + '-outline';
  return { aspect: h / w, viewBox: `${r2(x0)} ${r2(y0)} ${r2(w)} ${r2(h)}`,
    inner: `<defs>${defs.join('')}<clipPath id="${id}"><path d="${pathOf(spec.outline)}"/></clipPath></defs>\n<g clip-path="url(#${id})">\n${body.join('\n')}\n</g>` };
}
function readySvg(spec) {
  const r = readyParts(spec);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="${Math.round(1024 * r.aspect)}" viewBox="${r.viewBox}">\n${r.inner}\n</svg>\n`;
}
// Карточка сада на главной, пока сад никто не открыл и снимка нет.
function previewSvg() {
  const by = (name) => ART.find((s) => s.name === name);
  const put = (name, x, y, w) => { const r = readyParts(by(name)); return `<svg x="${x}" y="${y}" width="${w}" height="${r2(w * r.aspect)}" viewBox="${r.viewBox}">${r.inner}</svg>`; };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270">
<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#8ccdee"/><stop offset="1" stop-color="#fcf1d6"/></linearGradient></defs>
<path fill="url(#sky)" d="M0 0H480V270H0Z"/><circle cx="392" cy="52" r="22" fill="#fff6d2"/>
<path fill="#acd08f" d="M0 150Q120 110 250 150T480 140V270H0Z"/><path fill="#8fbf72" d="M0 190Q240 150 480 185V270H0Z"/>
${put('garden-iris', 60, 110, 120)}${put('garden-hibiscus', 290, 120, 130)}
${put('garden-morpho', 200, 40, 90)}${put('garden-heliconius', 340, 56, 70)}
</svg>\n`;
}

// ── 3D-параметры: в модельные координаты (x вправо, y вверх) ───────────────
function threeOf(spec) {
  const P = ([x, y]) => [r5((x - spec.ox) / spec.S), r5((spec.oy - y) / spec.S)];
  const L = (v) => r5(v / spec.S);
  const t = spec.three || {};
  if (spec.type === 'butterfly') {
    const b = t.body;
    return { ...t, body: { head: P(b.head), thorax: P(b.thorax), tail: P(b.tail), w: L(b.w) } };
  }
  return {
    height: spec.height, size: t.size,
    bloom: { ...t.bloom, c: P(t.bloom.c), r: L(t.bloom.r) },
    stem: { line: t.stem.line.map(P), w: L(t.stem.w) },
    leaves: t.leaves.map((l) => ({ base: P(l.base), tip: P(l.tip), w: L(l.w), bend: l.bend, fold: l.fold, arc: l.arc })),
    base: P(t.base)
  };
}

// ── сборка ──────────────────────────────────────────────────────────────────
const old = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const legacy = old.fish.filter((f) => f.name === 'garden-butterfly' || f.name === 'garden-flower')
  .map((f) => ({ ...f, legacy: true }));
const used = fish.fish.concat(legacy).flatMap((f) => corners.map((c) => f.markers[c]));
const markerCodes = codes(ART.length * 4, used);

const entries = ART.map((spec, i) => {
  spec.outline = outlineOf(spec.parts);
  const xs = spec.outline.map((p) => p[0]), ys = spec.outline.map((p) => p[1]);
  const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
  spec.S = Math.max(bx1 - bx0, by1 - by0);
  spec.ox = spec.type === 'butterfly' ? spec.axis : (bx0 + bx1) / 2;
  spec.oy = (by0 + by1) / 2;   // лист кладёт начало координат в центр рабочей зоны
  const contour = spec.outline.map(([x, y]) => [r5((x - spec.ox) / spec.S), r5((spec.oy - y) / spec.S)]);
  const bbox = { z: [Math.min(...contour.map((p) => p[0])), Math.max(...contour.map((p) => p[0]))],
    y: [Math.min(...contour.map((p) => p[1])), Math.max(...contour.map((p) => p[1]))] };
  const scale = 0.87 * Math.min((sheet.work.x1 - sheet.work.x0) / (bbox.z[1] - bbox.z[0]),
    (sheet.work.y1 - sheet.work.y0) / (bbox.y[1] - bbox.y[0]));
  const file = (lang) => 'assets/garden/' + spec.name + (lang === 'ru' ? '' : '.' + lang) + '.svg';
  return {
    name: spec.name, world: 'garden', type: spec.type, title: spec.titles.ru, titles: spec.titles,
    svg: file('ru'), sheets: Object.fromEntries(LANGS.map((l) => [l, file(l)])),
    ready: 'assets/garden/' + spec.name + '.ready.svg',
    contourModel: contour, bboxModel: bbox,
    sheetTransform: { scale: r5(scale), ox: sheet.w / 2, oy: (sheet.work.y0 + sheet.work.y1) / 2 },
    markers: Object.fromEntries(corners.map((c, j) => [c, markerCodes[i * 4 + j]])),
    three: threeOf(spec)
  };
});

fs.mkdirSync(OUT, { recursive: true });
ART.forEach((spec, i) => {
  for (const lang of LANGS) fs.writeFileSync(path.join(__dirname, '..', entries[i].sheets[lang]), sheetSvg(spec, entries[i], lang));
  fs.writeFileSync(path.join(__dirname, '..', entries[i].ready), readySvg(spec));
});
const layouts = {};
for (const per of Object.keys(LAYOUTS)) {
  const [cols, rows] = LAYOUTS[per];
  layouts[per] = [];
  for (let i = 0; i < ART.length; i += +per) {
    const group = ART.slice(i, i + +per).map((spec, j) => [spec, entries[i + j]]);
    const name = 'page' + per + '-' + (i / per + 1), sheets = {};
    for (const lang of LANGS) {
      sheets[lang] = 'assets/garden/' + name + (lang === 'ru' ? '' : '.' + lang) + '.svg';
      fs.writeFileSync(path.join(__dirname, '..', sheets[lang]), pageSvg(group, lang, cols, rows));
    }
    layouts[per].push({ fish: group.map(([spec]) => spec.name), sheets });
  }
}
fs.writeFileSync(MANIFEST, JSON.stringify({ version: 3, sheet, fish: entries.concat(legacy), layouts }, null, 1) + '\n');
fs.writeFileSync(path.join(OUT, 'preview.svg'), previewSvg());
console.log('Garden: ' + entries.length + ' kinds (+' + legacy.length + ' legacy), 3 languages; marker distance >= 4.');
