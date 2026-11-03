/* Генератор листов раскраски.
 *
 *   1) открыть /tools/silhouettes.html, дождаться конца, «Скачать contours.json»
 *   2) положить contours.json рядом с этим файлом
 *   3) node tools/make-coloring.js
 *
 * На выходе: assets/coloring/<вид>.svg и assets/coloring/manifest.json.
 *
 * Лист А4 альбомный. По углам — четыре метки 6×6 клеток с чёрной рамкой;
 * 16 внутренних клеток кодируют «какой это вид» и «какой это угол», по ним
 * capture.js находит лист на фотографии и выправляет перспективу.
 *
 * Коды подбираются здесь, а не берутся из головы: capture.js сравнивает биты
 * ТОЧНО, без допуска, поэтому два вида, отличающиеся на одну клетку, — это
 * тихая подмена рыбы при одном неверно прочитанном пикселе. Ниже коды
 * разводятся так, чтобы между любыми двумя (с учётом всех поворотов)
 * расстояние Хэмминга было не меньше MIN_DIST.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'coloring');

// ── лист ────────────────────────────────────────────────────────────────────
const SHEET = {
  w: 297, h: 210,
  marker: { size: 18, margin: 8, cells: 6 },
  markerPositions: { tl: [8, 8], tr: [271, 8], bl: [8, 184], br: [271, 184] },
  // поле для рыбы: не залезаем на метки и оставляем поля под пальцы и принтер
  work: { x0: 36, x1: 261, y0: 36, y1: 166 }
};
const FIT = 0.94;          // доля рабочего поля, которую занимает габарит рыбы
// Контур тонкий и тёмно-серый: жирная чёрная обводка спорила с раскраской
// ребёнка, а после съёмки от неё оставалась тёмная кайма по краю рыбы;
// светло-серый (#8a8a8a) бытовой принтер печатал бледно. Ширину знает
// и capture.js — он срезает полосу вдоль контура (TRIM_MM).
const STROKE = 1.6;        // мм
const STROKE_COLOR = '#555';

// ── виды ────────────────────────────────────────────────────────────────────
// name — папка в assets/models/pack, titles — что видит ребёнок, на трёх
// языках сайта (лист печатается на том, который выбран),
// len — длина рыбки в аквариуме (метры сцены),
// eye — [z, y] в долях длины тела; null = посчитать автоматически.
const LANGS = ['ru', 'en', 'pl'];

const SPECIES = [
  { name: 'clownfish',              len: 1.5, eye: null,
    titles: { ru: 'Рыба-клоун',        en: 'Clownfish',                pl: 'Błazenek' } },
  { name: 'bluetang',               len: 1.9, eye: null,
    titles: { ru: 'Голубой хирург',    en: 'Blue tang',                pl: 'Chirurg niebieski' } },
  { name: 'chelmonrostratus',       len: 1.7, eye: null,
    titles: { ru: 'Рыба-пинцет',       en: 'Copperband butterflyfish', pl: 'Chelmon' } },
  { name: 'clowntriggerfish',       len: 2.1, eye: null,
    titles: { ru: 'Спинорог',          en: 'Clown triggerfish',        pl: 'Rogatnica klaun' } },
  { name: 'frenchangelfish',        len: 2.4, eye: null,
    titles: { ru: 'Французский ангел', en: 'French angelfish',         pl: 'Pomakant francuski' } },
  { name: 'fusilierfish',           len: 1.6, eye: null,
    titles: { ru: 'Цезио',             en: 'Fusilier',                 pl: 'Cezjo' } },
  { name: 'blackspottedsweetlips',  len: 2.3, eye: null,
    titles: { ru: 'Ворчун',            en: 'Sweetlips',                pl: 'Chrząkiew' } },
  { name: 'coralgrouper',           len: 2.6, eye: null,
    titles: { ru: 'Групер',            en: 'Coral grouper',            pl: 'Strzępiel koralowy' } },
  { name: 'browntang',              len: 1.8, eye: null,
    titles: { ru: 'Бурый хирург',      en: 'Brown tang',               pl: 'Chirurg brązowy' } },
  { name: 'bicolorangelfish',       len: 1.7, eye: null,
    titles: { ru: 'Двухцветный ангел', en: 'Bicolor angelfish',        pl: 'Pomakant dwubarwny' } },
  { name: 'bluecheekbutterflyfish', len: 1.5, eye: null,
    titles: { ru: 'Рыба-бабочка',      en: 'Butterflyfish',            pl: 'Motylek' } },
  { name: 'discus1',                len: 1.8, eye: null,
    titles: { ru: 'Дискус',            en: 'Discus',                   pl: 'Paletka' } }
];

// Имя файла листа: русский лежит по старому адресу, остальные рядом с ним.
// Так уже напечатанные и разосланные ссылки на .svg остаются рабочими.
function sheetFile(name, lang) {
  return name + (lang === 'ru' ? '' : '.' + lang) + '.svg';
}

// ── коды меток ──────────────────────────────────────────────────────────────
const MIN_DIST = 4;   // минимум различий между любыми двумя кодами и их поворотами

function rotate(bits) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + (3 - r)] = bits[r * 4 + c];
  return o;
}
function popcount(n) { let c = 0; while (n) { n &= n - 1; c++; } return c; }
function bitsOf(n) {
  const b = new Array(16);
  for (let i = 0; i < 16; i++) b[i] = (n >> (15 - i)) & 1;
  return b;
}
function numOf(bits) { return bits.reduce((a, b) => (a << 1) | b, 0); }

// Кандидаты: коды с умеренным числом белых клеток. Слишком светлая или
// слишком тёмная середина плохо бинаризуется — capture.js берёт порог как
// середину между min и max по клеткам самой метки.
function candidates() {
  const out = [];
  for (let n = 0; n < 65536; n++) {
    const ones = popcount(n);
    if (ones >= 6 && ones <= 10) out.push(n);
  }
  return out;
}

// Детерминированное перемешивание: без него жадный отбор идёт по возрастанию,
// выгребает соседей одного угла пространства и упирается заметно раньше.
function shuffled(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function greedy(pool, count, dist) {
  const chosen = [], taken = [];
  for (const n of pool) {
    const rots = [];
    let b = bitsOf(n);
    for (let r = 0; r < 4; r++) { rots.push(numOf(b)); b = rotate(b); }

    let ok = true;
    for (const t of taken) {
      for (const r of rots) {
        if (popcount(t ^ r) < dist) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;

    chosen.push(n);
    for (const r of rots) taken.push(r);
    if (chosen.length === count) return chosen;
  }
  return null;
}

// Берём самый строгий разброс, при котором кодов ещё хватает. Порядок попыток
// фиксирован, так что повторный запуск даёт те же метки и уже напечатанные
// листы остаются рабочими.
function pickCodes(count) {
  const pool = candidates();
  for (let dist = 7; dist >= MIN_DIST; dist--) {
    for (let seed = 1; seed <= 24; seed++) {
      const got = greedy(seed === 1 ? pool : shuffled(pool, seed), count, dist);
      if (got) return { codes: got, dist: dist };
    }
  }
  throw new Error('не хватило кодов: нужно ' + count + ' при разбросе от ' + MIN_DIST);
}

// ── геометрия листа ─────────────────────────────────────────────────────────
function sheetTransform(bbox) {
  const spanY = bbox.y[1] - bbox.y[0];
  const workW = SHEET.work.x1 - SHEET.work.x0;
  const workH = SHEET.work.y1 - SHEET.work.y0;
  return {
    scale: +(FIT * Math.min(workW / 1, workH / spanY)).toFixed(4),
    ox: SHEET.w / 2,
    oy: (SHEET.work.y0 + SHEET.work.y1) / 2
  };
}

// Глаз: смещаемся от кончика носа вглубь, пока тело не станет достаточно
// высоким — так глаз не попадает на длинное рыло у пинцета и не уезжает
// на середину туловища у круглых рыб.
function eyeAt(contour, bbox) {
  const spanY = bbox.y[1] - bbox.y[0];
  const at = (z) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i], b = contour[(i + 1) % contour.length];
      if ((a[0] - z) * (b[0] - z) > 0) continue;          // отрезок не пересекает z
      const t = Math.abs(b[0] - a[0]) < 1e-9 ? 0 : (z - a[0]) / (b[0] - a[0]);
      const y = a[1] + (b[1] - a[1]) * t;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    return hi > lo ? { lo, hi, h: hi - lo } : null;
  };

  let z = 0.5;
  for (let step = 0; step < 60; step++) {
    z = 0.5 - step * 0.01;
    const s = at(z);
    if (s && s.h > spanY * 0.55) break;
  }
  z -= 0.035;                       // ещё чуть вглубь головы
  const s = at(z) || { lo: 0, hi: spanY * 0.5 };
  return [+z.toFixed(4), +(s.lo + (s.hi - s.lo) * 0.68).toFixed(4)];
}

// ── зона плавников ──────────────────────────────────────────────────────────
// Силуэт рыбы — один замкнутый контур: где кончается тело и начинается плавник,
// на листе не видно, и ребёнок красит рыбу одним пятном. Границу считаем сами.
//
// Приём простой: «открытие» силуэта. Стираем от края полосу шириной R —
// тонкие выросты (плавники, хвост) исчезают, остаётся тело; потом возвращаем
// полосу обратно. Граница получившегося тела совпадает с контуром почти везде,
// кроме мест, где были срезаны плавники, — там она проходит поперёк их
// основания. Эти-то куски и рисуем.
//
// R берём от самой толстой части рыбы, а не фиксированным: у дискуса тело
// круглое и высокое, у цезио — узкое, одна константа не подошла бы обоим.
const FIN = {
  grid: 0.4,          // мм на клетку растра
  bodyPart: 0.38,     // R = столько от полутолщины самого толстого места
  keepMM: 1.2,        // мм; всё, что идёт вплотную к контуру, — не срез, а он сам
  minLen: 5,          // мм; короче — это шум, а не основание плавника
  minDepth: 1.8,      // мм; насколько срез должен отойти от контура вглубь
  reach: 5,           // мм; на столько продлеваем концы, чтобы упереть в контур
  // Пунктир, а не сплошная: сплошную линию ребёнок обводит как часть рисунка,
  // пунктир читается как подсказка «здесь плавник».
  // Светлее контура нарочно: всё, что напечатано внутри рыбы, попадает
  // на фотографию и остаётся на текстуре. Но не бледнее #888 и не тоньше
  // 0.7 мм: прежний #c2c2c2 в 0.55 мм принтер растрировал в редкие точки,
  // и пунктира на бумаге почти не было.
  color: '#7a7a7a',
  width: 0.75,
  dash: '2.4 1.8'
};

// Глаз — кружок-подсказка тем же цветом, что пунктир, но сплошной: место
// глаза ребёнок видит сразу, а закрасить его может как хочет. Радиус — в долях
// длины рыбы (модельные единицы), чтобы глаз рос и мельчал вместе с ней.
const EYE = { r: 0.032 };

// Расстояние до ближайшей клетки маски, в клетках. Двухпроходный чамфер:
// точности 2% нам хватает, а честный евклид тут ни к чему.
function distanceTo(mask, w, h) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) d[k] = mask[k] ? 0 : INF;
  const D1 = 1, D2 = Math.SQRT2;
  const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h) ? INF : d[j * w + i];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      d[k] = Math.min(d[k], at(i - 1, j) + D1, at(i, j - 1) + D1,
                            at(i - 1, j - 1) + D2, at(i + 1, j - 1) + D2);
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      d[k] = Math.min(d[k], at(i + 1, j) + D1, at(i, j + 1) + D1,
                            at(i + 1, j + 1) + D2, at(i - 1, j + 1) + D2);
    }
  }
  return d;
}

function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > y) !== (b[1] > y) &&
        x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distToPoly(pts, x, y) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[j][0], ay = pts[j][1], bx = pts[i][0], by = pts[i][1];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? ((x - ax) * vx + (y - ay) * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + vx * t), dy = y - (ay + vy * t);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < best) best = dist;
  }
  return best;
}

// Маршевые квадраты по клеткам-центрам: на выходе отрезки границы маски.
function marchingSquares(mask, w, h, toMM) {
  const segs = [];
  const m = (i, j) => (i < 0 || j < 0 || i >= w || j >= h) ? 0 : mask[j * w + i];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const tl = m(i, j), tr = m(i + 1, j), br = m(i + 1, j + 1), bl = m(i, j + 1);
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;
      const top = [i + 0.5, j], right = [i + 1, j + 0.5];
      const bottom = [i + 0.5, j + 1], left = [i, j + 0.5];
      const push = (a, b) => segs.push([toMM(a), toMM(b)]);
      switch (code) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(top, right); break;
        case 5: push(left, top); push(bottom, right); break;
        case 6: case 9: push(top, bottom); break;
        case 7: case 8: push(left, top); break;
        case 10: push(left, bottom); push(top, right); break;
      }
    }
  }
  return segs;
}

// Отрезки в ломаные: концы совпадают до долей клетки, поэтому склеиваем
// по округлённым координатам.
function chain(segs, eps) {
  const key = (p) => Math.round(p[0] / eps) + ':' + Math.round(p[1] / eps);
  const ends = new Map();
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const used = new Set();
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const line = [segs[i][0], segs[i][1]];
    for (const dir of [0, 1]) {
      for (;;) {
        const tip = dir ? line[0] : line[line.length - 1];
        const next = (ends.get(key(tip)) || []).find((j) => !used.has(j));
        if (next === undefined) break;
        used.add(next);
        const s = segs[next];
        const near = key(s[0]) === key(tip) ? s[1] : s[0];
        if (dir) line.unshift(near); else line.push(near);
      }
    }
    lines.push(line);
  }
  return lines;
}

function polyLen(line) {
  let sum = 0;
  for (let i = 1; i < line.length; i++) {
    sum += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  }
  return sum;
}

// Прореживание Дугласа–Пекера: в SVG незачем сотня точек там, где хватает пяти.
function simplify(line, tol) {
  if (line.length < 3) return line;
  let maxD = -1, idx = 0;
  const a = line[0], b = line[line.length - 1];
  for (let i = 1; i < line.length - 1; i++) {
    const d = distToPoly([a, b], line[i][0], line[i][1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [a, b];
  return simplify(line.slice(0, idx + 1), tol).slice(0, -1).concat(simplify(line.slice(idx), tol));
}

// Луч из точки в заданном направлении: где он пересечёт контур. Нужен,
// чтобы концы среза упирались в силуэт, а не висели в воздухе.
function rayHit(pts, px, py, dx, dy, maxT) {
  let best = null;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[j][0], ay = pts[j][1], bx = pts[i][0], by = pts[i][1];
    const ex = bx - ax, ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - px) * ey - (ay - py) * ex) / den;
    const u = ((ax - px) * dy - (ay - py) * dx) / den;
    if (t <= 0.01 || t > maxT || u < 0 || u > 1) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? null : [px + dx * best, py + dy * best];
}

function extendEnds(line, pts) {
  const out = line.slice();
  const ends = [[out[0], out[1], 'head'], [out[out.length - 1], out[out.length - 2], 'tail']];
  for (const [tip, prev, where] of ends) {
    const dx = tip[0] - prev[0], dy = tip[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const hit = rayHit(pts, tip[0], tip[1], dx / len, dy / len, FIN.reach);
    if (!hit) continue;
    if (where === 'head') out.unshift(hit); else out.push(hit);
  }
  return out;
}

// Возвращает d-атрибуты линий, отделяющих плавники от тела.
function finLines(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const pad = 4, g = FIN.grid;
  const x0 = Math.min.apply(null, xs) - pad, y0 = Math.min.apply(null, ys) - pad;
  const w = Math.ceil((Math.max.apply(null, xs) + pad - x0) / g);
  const h = Math.ceil((Math.max.apply(null, ys) + pad - y0) / g);
  const toMM = (c) => [x0 + (c[0] + 0.5) * g, y0 + (c[1] + 0.5) * g];

  const inside = new Uint8Array(w * h);
  const outside = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      inside[k] = pointInPoly(pts, x0 + (i + 0.5) * g, y0 + (j + 0.5) * g) ? 1 : 0;
      outside[k] = inside[k] ? 0 : 1;
    }
  }

  const depth = distanceTo(outside, w, h);      // клетки: как глубоко внутри рыбы
  let maxDepth = 0;
  for (let k = 0; k < depth.length; k++) if (inside[k] && depth[k] > maxDepth) maxDepth = depth[k];
  const R = maxDepth * FIN.bodyPart;

  const core = new Uint8Array(w * h);           // тело без плавников
  for (let k = 0; k < core.length; k++) core[k] = (inside[k] && depth[k] >= R) ? 1 : 0;

  const back = distanceTo(core, w, h);          // возвращаем срезанную полосу
  const opened = new Uint8Array(w * h);
  for (let k = 0; k < opened.length; k++) opened[k] = (inside[k] && back[k] <= R) ? 1 : 0;

  const keep = FIN.keepMM;                      // мм от контура, ближе — не рисуем
  const lines = [];
  for (const line of chain(marchingSquares(opened, w, h, toMM), g / 2)) {
    // Граница «тела» совпадает с контуром рыбы почти везде — оставляем только
    // куски, ушедшие внутрь: это и есть срезы поперёк плавников.
    let piece = [];
    for (const p of line.concat([null])) {
      if (p && distToPoly(pts, p[0], p[1]) > keep) { piece.push(p); continue; }
      if (piece.length > 1 && polyLen(piece) >= FIN.minLen) {
        // Срез должен именно резать: полоска, идущая вдоль контура в
        // миллиметре от него, — это не основание плавника, а вогнутость тела.
        const deep = Math.max.apply(null, piece.map((q) => distToPoly(pts, q[0], q[1])));
        if (deep >= FIN.minDepth) lines.push(extendEnds(simplify(piece, 0.3), pts));
      }
      piece = [];
    }
  }
  return lines.map((line) =>
    line.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' '));
}

// ── SVG ─────────────────────────────────────────────────────────────────────
function markerSvg(bits, x, y) {
  const cell = SHEET.marker.size / SHEET.marker.cells;
  let out = `<rect x="${x}" y="${y}" width="${SHEET.marker.size}" height="${SHEET.marker.size}" fill="#000"/>`;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (!bits[r * 4 + c]) continue;
      const cx = (x + (c + 1) * cell).toFixed(2);
      const cy = (y + (r + 1) * cell).toFixed(2);
      out += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" fill="#fff"/>`;
    }
  }
  return out;
}

// Плавники, лежащие поверх тела: в силуэт они не попадают, их отдельно
// находит /tools/silhouettes.html (ступенька карты глубины) и складывает
// в tools/inner-fins.json. Файла нет — просто рисуем без них.
const INNER_FINS = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'inner-fins.json'), 'utf8'));
    delete raw._;
    return raw;
  } catch (e) { return {}; }
})();

// Содержимое листа без обёртки <svg>. k — во сколько раз лист уменьшен на
// бумаге (1 — свой лист А4). Пунктир, глаз и подпись при уменьшении
// утолщаем на 1/√k: пунктир 0.24 мм на листе по 6 рыбок принтер опять
// не пропечатал бы. Контур не трогаем: его ширину в мм листа знает
// capture.js (TRIM_MM), а в каком масштабе лист напечатан — нет.
const FINS = new Map();

function sheetBody(fish, lang, k) {
  const st = fish.sheetTransform;
  const X = (z) => (st.ox + st.scale * z).toFixed(2);
  const Y = (y) => (st.oy - st.scale * y).toFixed(2);
  const f = 1 / Math.sqrt(k);
  const finW = (FIN.width * f).toFixed(2);
  const dash = FIN.dash.split(' ').map((v) => (v * f).toFixed(2)).join(' ');

  const pts = fish.contourModel.map((p) => [+X(p[0]), +Y(p[1])]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ') + ' Z';

  const parts = [`<rect width="${SHEET.w}" height="${SHEET.h}" fill="#fff"/>`];
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const pos = SHEET.markerPositions[corner];
    parts.push(markerSvg(fish.markers[corner], pos[0], pos[1]));
  }
  parts.push(
    `<path d="${d}" fill="#fff" stroke="${STROKE_COLOR}" stroke-width="${STROKE}" stroke-linejoin="round"/>`
  );
  const inner = (INNER_FINS[fish.name] || []).map((line) =>
    line.map((p, i) => `${i ? 'L' : 'M'}${X(p[0])} ${Y(p[1])}`).join(' '));

  // срезы плавников считаются растром — один раз на вид, а не на каждый лист
  if (!FINS.has(fish.name)) FINS.set(fish.name, finLines(pts));
  for (const line of FINS.get(fish.name).concat(inner)) {
    parts.push(`<path d="${line}" fill="none" stroke="${FIN.color}" stroke-width="${finW}" ` +
               `stroke-dasharray="${dash}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  parts.push(
    `<circle cx="${X(fish.eye[0])}" cy="${Y(fish.eye[1])}" r="${(EYE.r * st.scale).toFixed(2)}" ` +
      `fill="none" stroke="${FIN.color}" stroke-width="${finW}"/>`,
    `<text x="${SHEET.w / 2}" y="197" text-anchor="middle" font-family="Segoe UI, sans-serif" ` +
      `font-size="${(7 * f).toFixed(1)}" font-weight="600" fill="#444">${fish.titles[lang]}</text>`
  );
  return parts;
}

function buildSvg(fish, lang) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET.w}mm" height="${SHEET.h}mm" viewBox="0 0 ${SHEET.w} ${SHEET.h}">`,
    ...sheetBody(fish, lang, 1).map((p) => '  ' + p),
    '</svg>'
  ].join('\n') + '\n';
}

// ── несколько рыбок на одной А4 ─────────────────────────────────────────────
// Каждая — целый лист в уменьшенном виде, со своими метками: capture.js ищет
// метки по форме, а не по размеру, и выправляет перспективу по ним же, так
// что распознаётся любой из маленьких листов. Между листами — линии отреза.
const PAGE = { margin: 4, gap: 4 };            // мм; поле страницы и зазор
const LAYOUTS = { 4: [2, 2], 6: [3, 2] };       // рыбок на А4: [колонок, рядов]

function buildPage(fishes, lang, cols, rows) {
  const W = SHEET.w, H = SHEET.h, g = PAGE.gap;
  const k = Math.min((W - 2 * PAGE.margin - (cols - 1) * g) / cols / W,
                     (H - 2 * PAGE.margin - (rows - 1) * g) / rows / H);
  const sw = W * k, sh = H * k;
  const x0 = (W - cols * sw - (cols - 1) * g) / 2;
  const y0 = (H - rows * sh - (rows - 1) * g) / 2;
  const cut = 'stroke="#bbb" stroke-width="0.25" stroke-dasharray="1 1.5"';

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
    `  <rect width="${W}" height="${H}" fill="#fff"/>`
  ];
  for (let c = 1; c < cols; c++) {
    const x = (x0 + c * sw + (c - 0.5) * g).toFixed(2);
    parts.push(`  <line x1="${x}" y1="0" x2="${x}" y2="${H}" ${cut}/>`);
  }
  for (let r = 1; r < rows; r++) {
    const y = (y0 + r * sh + (r - 0.5) * g).toFixed(2);
    parts.push(`  <line x1="0" y1="${y}" x2="${W}" y2="${y}" ${cut}/>`);
  }
  fishes.forEach((f, i) => {
    const x = (x0 + (i % cols) * (sw + g)).toFixed(2);
    const y = (y0 + Math.floor(i / cols) * (sh + g)).toFixed(2);
    parts.push(`  <svg x="${x}" y="${y}" width="${sw.toFixed(2)}" height="${sh.toFixed(2)}" viewBox="0 0 ${W} ${H}">`,
               ...sheetBody(f, lang, k).map((p) => '    ' + p),
               '  </svg>');
  });
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

// ── сборка ──────────────────────────────────────────────────────────────────
function main() {
  const src = path.join(__dirname, 'contours.json');
  if (!fs.existsSync(src)) {
    console.error('нет tools/contours.json — сперва выгрузи контуры из /tools/silhouettes.html');
    process.exit(1);
  }
  const contours = JSON.parse(fs.readFileSync(src, 'utf8'));

  const missing = SPECIES.filter((s) => !contours[s.name]).map((s) => s.name);
  if (missing.length) {
    console.error('в contours.json нет видов: ' + missing.join(', '));
    process.exit(1);
  }

  const picked = pickCodes(SPECIES.length * 4);
  const codes = picked.codes;
  const fish = SPECIES.map((s, i) => {
    const c = contours[s.name];
    const f = {
      id: i + 1,
      name: s.name,
      // title и svg — русские: так манифест читали до появления языков,
      // и старые ссылки на листы от этого не ломаются.
      title: s.titles.ru,
      titles: s.titles,
      model: '/assets/models/pack/' + s.name + '/' + s.name + '.gltf',
      svg: 'assets/coloring/' + sheetFile(s.name, 'ru'),
      sheets: LANGS.reduce((acc, lang) => {
        acc[lang] = 'assets/coloring/' + sheetFile(s.name, lang);
        return acc;
      }, {}),
      length: s.len,
      markers: {
        tl: bitsOf(codes[i * 4]),
        tr: bitsOf(codes[i * 4 + 1]),
        bl: bitsOf(codes[i * 4 + 2]),
        br: bitsOf(codes[i * 4 + 3])
      },
      contourModel: c.contour,
      bboxModel: c.bbox
    };
    f.sheetTransform = sheetTransform(c.bbox);
    f.eye = s.eye || eyeAt(c.contour, c.bbox);
    return f;
  });

  fs.mkdirSync(OUT, { recursive: true });
  // старые листы убираем: они были сняты с моделей, которых больше нет в игре
  for (const old of fs.readdirSync(OUT)) {
    if (old.endsWith('.svg')) fs.unlinkSync(path.join(OUT, old));
  }

  for (const f of fish) {
    for (const lang of LANGS) {
      fs.writeFileSync(path.join(OUT, sheetFile(f.name, lang)), buildSvg(f, lang), 'utf8');
    }
  }
  // Страницы по 4 и 6 рыбок: page4-1.svg, page4-1.en.svg, …
  const layouts = {};
  for (const per of Object.keys(LAYOUTS)) {
    const [cols, rows] = LAYOUTS[per];
    layouts[per] = [];
    for (let i = 0; i < fish.length; i += +per) {
      const group = fish.slice(i, i + +per);
      const name = 'page' + per + '-' + (i / per + 1);
      const sheets = {};
      for (const lang of LANGS) {
        fs.writeFileSync(path.join(OUT, sheetFile(name, lang)), buildPage(group, lang, cols, rows), 'utf8');
        sheets[lang] = 'assets/coloring/' + sheetFile(name, lang);
      }
      layouts[per].push({ fish: group.map((f) => f.name), sheets: sheets });
    }
  }
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    JSON.stringify({ version: 2, sheet: SHEET, fish: fish, layouts: layouts }, null, 1),
    'utf8'
  );

  // Контроль: если два кода вдруг сойдутся, вид подменится молча — лучше
  // увидеть цифру сейчас, чем ловить это на детском рисунке.
  let worst = 99;
  const all = [];
  fish.forEach((f) => ['tl', 'tr', 'bl', 'br'].forEach((c) => {
    let b = f.markers[c];
    for (let r = 0; r < 4; r++) { all.push({ n: numOf(b), key: f.name + '/' + c }); b = rotate(b); }
  }));
  for (let a = 0; a < all.length; a++) {
    for (let b = a + 1; b < all.length; b++) {
      if (all[a].key === all[b].key) continue;
      worst = Math.min(worst, popcount(all[a].n ^ all[b].n));
    }
  }

  console.log('листов: ' + fish.length);
  console.log('минимальное различие кодов: ' + worst + ' клеток из 16');
  fish.forEach((f) => console.log(
    '  ' + f.name.padEnd(24) + f.title.padEnd(20) +
    'масштаб ' + String(f.sheetTransform.scale).padEnd(9) +
    'глаз ' + f.eye.join(', ')
  ));
}

main();
