'use strict';

/* Рисунки видов сада — единственный источник: из них make-garden.js собирает
 * листы раскраски, «готовые» рисунки в родных цветах и 3D-параметры.
 *
 * Вид — это части сзади наперёд. Часть — замкнутый контур с заливкой; зоны и
 * линии внутри неё обрезаются по её контуру, так что их можно рисовать с
 * запасом. Внешний контур вида (для съёмки) — объединение всех частей.
 * Координаты — в своей коробке вида, y вниз, как в SVG.
 */

// Целые координаты: единица коробки вида — около 0.1 мм на листе.
const r2 = (n) => Math.round(n);
const poly = (list, closed = true) => 'M' + list.map((p) => r2(p[0]) + ' ' + r2(p[1])).join(' ') + (closed ? 'Z' : '');

function ellipsePts(cx, cy, rx, ry, rot = 0, n = Math.max(12, Math.min(48, Math.round(Math.max(rx, ry) / 2.5)))) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, x = rx * Math.cos(a), y = ry * Math.sin(a);
    return [cx + x * c - y * s, cy + x * s + y * c];
  });
}
const ellipse = (cx, cy, rx, ry, rot) => poly(ellipsePts(cx, cy, rx, ry, rot));
const circle = (cx, cy, r) => ellipse(cx, cy, r, r);

// Catmull-Rom через точки: плавная кривая без ручной расстановки ручек.
function smooth(points, closed = false, steps = 10) {
  const n = points.length, out = [];
  const at = (i) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t +
        (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

// Полоса вокруг осевой линии — стебель, тычиночная колонка.
function ribbon(line, w0, w1 = w0) {
  const pts = smooth(line, false, 12), left = [], right = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const w = (w0 + (w1 - w0) * (i / (pts.length - 1))) / 2;
    left.push([p[0] - (dy / len) * w, p[1] + (dx / len) * w]);
    right.push([p[0] + (dy / len) * w, p[1] - (dx / len) * w]);
  });
  return left.concat(right.reverse());
}

// Лист: яйцевидный, заострённый, с зубчиками и жилками. bend > 0 выгибает
// среднюю жилку влево от направления «основание → кончик».
// sword: широкое основание, сужается к острому кончику (ирис).
function leaf(base, tip, width, { bend = 0.12, teeth = 11, tooth = 0.07, veins = 5, sword = false } = {}) {
  const dx = tip[0] - base[0], dy = tip[1] - base[1], len = Math.hypot(dx, dy);
  const nx = dy / len, ny = -dx / len;
  const mid = (t) => {
    const o = bend * len * Math.sin(Math.PI * t);
    return [base[0] + dx * t + nx * o, base[1] + dy * t + ny * o];
  };
  const half = (t) => {
    let h = sword ? (width / 2) * Math.pow(1 - t, 0.7) * Math.min(1, t * 10 + 0.3)
      : (width / 2) * Math.sin(Math.PI * Math.pow(t, 0.72));
    if (teeth && t > 0.12 && t < 0.97) h *= 1 + tooth * (((t * teeth) % 1) - 0.5);
    return h;
  };
  const side = (sign) => Array.from({ length: 61 }, (_, i) => {
    const t = i / 60, p = mid(t), h = half(t) * sign;
    return [p[0] + nx * h, p[1] + ny * h];
  });
  const outline = side(1).concat(side(-1).reverse());
  const lines = [poly(Array.from({ length: 20 }, (_, i) => mid((i / 19) * 0.94)), false)];
  for (let k = 0; k < veins; k++) {
    const t0 = 0.12 + (k / veins) * 0.7, t1 = Math.min(0.97, t0 + 0.16);
    for (const sign of [1, -1]) {
      const a = mid(t0), b = mid(t1), h = half(t1) * 0.82 * sign;
      lines.push(poly(smooth([a, [mid((t0 + t1) / 2)[0] + nx * h * 0.45, mid((t0 + t1) / 2)[1] + ny * h * 0.45],
        [b[0] + nx * h, b[1] + ny * h]], false, 6), false));
    }
  }
  return { outline: poly(outline), lines, mid };
}

// Лепесток гибискуса: обратнояйцевидный, с гофрированным краем, закручен
// «вертушкой» (skew), основанием в центре цветка.
function petal(c, angle, R, W, { ruffle = 0.03, skew = 0.12, waves = 9 } = {}) {
  const ax = Math.cos(angle), ay = Math.sin(angle), bx = -ay, by = ax;
  const pts = Array.from({ length: 120 }, (_, i) => {
    const phi = (i / 120) * Math.PI * 2;
    let x = 0.55 * R + 0.47 * R * Math.cos(phi);
    const taper = 0.25 + 0.75 * Math.min(1, x / R);
    let y = (W / 2) * Math.sin(phi) * taper;
    const out = Math.max(0, Math.cos(phi));
    x += ruffle * R * Math.sin(waves * phi) * out * out;
    y += skew * R * (x / R) * (x / R);
    return [c[0] + ax * x + bx * y, c[1] + ay * x + by * y];
  });
  const lines = [-0.32, -0.16, 0, 0.16, 0.32].map((k) => {
    const p = (x, y) => [c[0] + ax * x + bx * y, c[1] + ay * x + by * y];
    return poly(smooth([p(0.14 * R, 0), p(0.5 * R, k * W * 0.55 + skew * R * 0.25),
      p(0.86 * R, k * W * 0.95 + skew * R * 0.74)], false, 8), false);
  });
  return { d: poly(pts), lines };
}

function radial(cx, cy, r, stops) { return { radial: { cx, cy, r }, stops }; }
function linear(x1, y1, x2, y2, stops) { return { linear: { x1, y1, x2, y2 }, stops }; }

// ── зеркало для бабочек ─────────────────────────────────────────────────────
function mirrorD(d, ax) {
  return d.replace(/([MLCQ])([^MLCQZ]*)/g, (_, cmd, args) => {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    for (let i = 0; i < n.length; i += 2) n[i] = r2(2 * ax - n[i]);
    return cmd + n.join(' ') + ' ';
  });
}
function mirrorFill(fill, ax) {
  if (!fill || typeof fill === 'string') return fill;
  const f = JSON.parse(JSON.stringify(fill));
  if (f.radial) f.radial.cx = 2 * ax - f.radial.cx;
  if (f.linear) { f.linear.x1 = 2 * ax - f.linear.x1; f.linear.x2 = 2 * ax - f.linear.x2; }
  return f;
}
function mirrorPart(part, ax) {
  return {
    ...part,
    d: mirrorD(part.d, ax),
    fill: mirrorFill(part.fill, ax),
    zones: (part.zones || []).map((z) => ({ ...z, d: mirrorD(z.d, ax), fill: mirrorFill(z.fill, ax) })),
    lines: (part.lines || []).map((l) => (typeof l === 'string' ? mirrorD(l, ax) : { ...l, d: mirrorD(l.d, ax) }))
  };
}
// Правая половина → обе: сначала все задние крылья, потом передние, потом тело.
function butterfly(ax, rightParts, body, antenna) {
  const parts = [];
  for (const p of rightParts) parts.push(mirrorPart(p, ax), p);
  return { parts: parts.concat(body), antennae: [antenna, mirrorD(antenna, ax)] };
}

// ── заготовки ───────────────────────────────────────────────────────────────
const TAU = Math.PI * 2, deg = (a) => (a * Math.PI) / 180;
const blob = (pts, steps = 8) => poly(smooth(pts, true, steps));
const tint = (color) => (d) => ({ d, color });

// Лепесток (прицветник, чашелистик) от основания под углом angle.
// p — где самое широкое место (<1 ближе к основанию), q — полнота кончика
// (0.5 — круглый, 1 — острый), bend — изгиб средней линии.
function petalAt(base, angle, len, width, { p = 0.8, q = 0.8, bend = 0, ruffle = 0, waves = 7 } = {}) {
  const ax = Math.cos(angle), ay = Math.sin(angle), bx = -ay, by = ax;
  const mid = (s) => {
    const o = bend * len * s * s;
    return [base[0] + ax * len * s + bx * o, base[1] + ay * len * s + by * o];
  };
  const half = (s) => (width / 2) * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(s, p))), q);
  const pts = [];
  for (let i = 0; i <= 36; i++) {
    const s = i / 36, m = mid(s), h = half(s) * (1 + ruffle * Math.sin(waves * Math.PI * s) * s);
    pts.push([m[0] + bx * h, m[1] + by * h]);
  }
  for (let i = 36; i >= 0; i--) {
    const s = i / 36, m = mid(s), h = half(s) * (1 + ruffle * Math.sin(waves * Math.PI * s + 1.3) * s);
    pts.push([m[0] - bx * h, m[1] - by * h]);
  }
  const at = (s, f) => { const m = mid(s), h = half(s) * f; return [m[0] + bx * h, m[1] + by * h]; };
  const lines = (fracs, s0 = 0.1, s1 = 0.88) => fracs.map((f) =>
    poly(Array.from({ length: 14 }, (_, i) => at(s0 + ((s1 - s0) * i) / 13, f)), false));
  return { d: poly(pts), at, lines, mid, half, angle };
}

// Тело бабочки: брюшко, грудь, голова. thorax может быть другого цвета.
function bodyParts(ax, head, thorax, tail, w, { abdomen = '#2b2230', chest = abdomen, edge = '#0e0b12', rings = '#463a52' } = {}) {
  const top = thorax + w * 1.6;
  const ring = [];
  for (let y = top + 18; y < tail - 12; y += 28) ring.push({ d: `M ${ax - w * 0.7} ${y} Q ${ax} ${y + 6} ${ax + w * 0.7} ${y}`, color: rings });
  return [
    { d: ellipse(ax, (top + tail) / 2, w * 0.68, (tail - top) / 2), fill: abdomen, edge, lines: ring },
    { d: ellipse(ax, thorax, w, w * 2.45) + ' ' + circle(ax, head, w * 0.86), fill: chest, edge }
  ];
}
// Правый ус: от головы к (dx, dy) выше; feather — перистый, как у бабочек-ночниц.
function antennaPath(ax, head, dx, dy, feather = false) {
  const x0 = ax + 8, y0 = head - 14, x1 = ax + dx, y1 = head - dy;
  const line = `M ${x0} ${y0} C ${x0 + dx * 0.15} ${y0 - dy * 0.45} ${x1 - dx * 0.4} ${y1 + dy * 0.25} ${x1} ${y1} `;
  const a = Math.atan2(y1 - y0, x1 - x0);
  return line + (feather ? ellipse((x0 + x1) / 2 + 6, (y0 + y1) / 2, dy * 0.42, 13, a) : ellipse(x1 + 3, y1 - 3, 7, 11, 0.7));
}
function makeButterfly({ ax = 500, head, thorax, tail, w, hind, fore, body, antenna }) {
  const r = butterfly(ax, [hind, fore], bodyParts(ax, head, thorax, tail, w, body), antennaPath(ax, head, ...antenna));
  r.body = { head: [ax, head], thorax: [ax, thorax], tail: [ax, tail], w };
  return r;
}
const dots = (list, fill) => list.map(([x, y, r]) => ({ d: circle(x, y, r), fill }));
// Полоса вдоль кривой внутри крыла: inner — граница, снаружи — запас под обрезку.
const band = (inner, far) => poly(smooth(inner, false, 8).concat(far));

// ── Морфо ───────────────────────────────────────────────────────────────────
function morpho() {
  const ax = 500;
  const blue = (cx, cy) => radial(cx, cy, 430, [[0, '#c3f4ff'], [0.3, '#56c8ff'], [0.62, '#1d74ff'], [1, '#123fae']]);
  const hind = {
    d: 'M 512 292 C 620 292 745 318 805 372 C 842 432 838 525 774 590 C 742 620 690 642 640 632 ' +
       'C 592 622 548 566 522 474 C 514 420 512 340 512 292 Z',
    fill: blue(560, 330), edge: '#0d2f86',
    zones: [
      { d: 'M 770 330 C 800 420 782 520 708 572 C 668 598 616 594 584 572 L 560 720 L 920 720 L 920 300 Z', fill: '#16121c' },
      ...[[796, 432, 9], [790, 490, 10], [762, 545, 10], [712, 586, 9], [662, 604, 8]]
        .map(([x, y, r]) => ({ d: circle(x, y, r), fill: '#f4f1e6' }))
    ],
    lines: [
      'M 528 318 C 620 360 700 400 788 452', 'M 526 340 C 600 410 660 480 738 556', 'M 524 360 C 560 450 590 530 632 610'
    ].map((d) => ({ d, color: '#1a52c8' }))
  };
  const fore = {
    d: 'M 514 222 C 600 166 760 116 908 116 C 950 116 968 146 958 182 C 934 262 884 322 864 394 ' +
       'C 858 410 846 418 830 415 C 700 382 600 334 518 302 C 510 278 510 246 514 222 Z',
    fill: blue(540, 280), edge: '#0d2f86',
    zones: [
      { d: 'M 556 214 C 640 170 760 168 812 214 C 852 262 852 340 840 430 L 1000 430 L 1000 40 L 556 40 Z', fill: '#16121c' },
      ...[[905, 160, 15], [884, 212, 14], [870, 262, 12], [855, 312, 10], [758, 160, 9], [818, 150, 10]]
        .map(([x, y, r]) => ({ d: circle(x, y, r), fill: '#f4f1e6' }))
    ],
    lines: [
      'M 536 246 C 640 214 740 196 840 194', 'M 538 262 C 650 250 740 256 836 282', 'M 540 278 C 640 296 720 330 830 372'
    ].map((d) => ({ d, color: '#1a52c8' }))
  };
  const body = {
    d: ellipse(ax, 400, 15, 118) + ' ' + ellipse(ax, 252, 22, 54) + ' ' + circle(ax, 190, 19),
    fill: linear(ax, 170, ax, 520, [[0, '#3a3046'], [1, '#1d1724']]), edge: '#0e0b12',
    lines: [300, 330, 360, 390, 420, 450, 480].map((y) => ({ d: `M ${ax - 16} ${y} Q ${ax} ${y + 6} ${ax + 16} ${y}`, color: '#463a52' }))
  };
  return butterfly(ax, [hind, fore], body, 'M 508 176 C 520 128 548 92 578 70 ' + ellipse(581, 67, 7, 11, 0.7));
}

// ── Гибискус ────────────────────────────────────────────────────────────────
function hibiscus() {
  const c = [560, 330], R = 300;
  const petalFill = radial(c[0], c[1], R, [[0, '#9b0e2c'], [0.22, '#d92646'], [0.62, '#ff5d5d'], [1, '#ff9a86']]);
  const leafFill = (a, b) => linear(a[0], a[1], b[0], b[1], [[0, '#2c6e30'], [1, '#62ad4b']]);
  const stem = { d: poly(ribbon([[560, 420], [568, 560], [582, 720], [600, 886]], 28, 22)), fill: '#3f8a39', edge: '#2a5f27',
    lines: [{ d: 'M 566 600 C 574 680 584 780 596 880', color: '#4fa047' }] };
  const leafDefs = [
    { base: [578, 706], tip: [188, 618], w: 180, bend: 0.13, fold: 0.18, arc: 0.12 },
    { base: [592, 790], tip: [1018, 664], w: 190, bend: -0.12, fold: 0.18, arc: 0.12 },
    { base: [598, 872], tip: [286, 852], w: 110, bend: -0.08, fold: 0.15, arc: 0.08 }
  ];
  const leaves = leafDefs.map(({ base, tip, w, bend }) => {
    const l = leaf(base, tip, w, { bend });
    return [
      { d: poly(ribbon([base, l.mid(0.02)], 12, 10)), fill: '#3f8a39', edge: '#2a5f27' },
      { d: l.outline, fill: leafFill(base, tip), edge: '#24572a', lines: l.lines.map((d) => ({ d, color: '#86c96f' })) }
    ];
  }).flat();
  const angles = [-90, -18, 54, 126, 198].map((a, i) => ((a + [0, 4, -3, 5, -2][i]) * Math.PI) / 180);
  const petals = angles.map((a, i) => {
    const p = petal(c, a, R * [1, 0.96, 1.03, 0.98, 1.01][i], R * 0.98, { ruffle: 0.035, skew: 0.14 });
    return { d: p.d, fill: petalFill, edge: '#b0263a', lines: p.lines.map((d) => ({ d, color: '#c8243f' })) };
  });
  const eye = {
    d: poly(Array.from({ length: 120 }, (_, i) => {
      const a = (i / 120) * Math.PI * 2, k = Math.pow((1 + Math.cos(5 * (a - angles[0]))) / 2, 2);
      const r = R * (0.12 + 0.13 * k);
      return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
    })),
    fill: radial(c[0], c[1], R * 0.25, [[0, '#5e0619'], [1, '#a3112e']]), edge: '#5e0619'
  };
  const colLine = [[c[0], c[1]], [c[0] + 70, c[1] + 50], [c[0] + 150, c[1] + 128], [c[0] + 214, c[1] + 214]];
  const column = { d: poly(ribbon(colLine, 20, 14)), fill: linear(c[0], c[1], c[0] + 214, c[1] + 214, [[0, '#f7d3dc'], [1, '#ffeef1']]), edge: '#d48b9b' };
  const along = smooth(colLine, false, 12);
  const anthers = [];
  for (let i = 0; i < 9; i++) {
    const t = 0.5 + i * 0.05, p = along[Math.round(t * (along.length - 1))];
    const q = along[Math.min(along.length - 1, Math.round(t * (along.length - 1)) + 1)];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, side = i % 2 ? 1 : -1;
    anthers.push({ d: circle(p[0] - ((q[1] - p[1]) / len) * 15 * side, p[1] + ((q[0] - p[0]) / len) * 15 * side, 9), fill: '#ffcf33', edge: '#c9971a' });
  }
  const tip = along[along.length - 1];
  const stigma = [0, 1, 2, 3, 4].map((k) => {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    return { d: circle(tip[0] + Math.cos(a) * 15, tip[1] + Math.sin(a) * 15, 9), fill: '#c4122f', edge: '#7d0a1d' };
  });
  return {
    parts: [stem, ...leaves, ...petals, eye, column, ...anthers, ...stigma],
    three: {
      bloom: { c, r: R, cup: 0.32, curl: 0.06, wave: 0.04 },
      column: { line: colLine, lift: 0.55 },
      stem: { line: [[560, 560], [582, 720], [600, 886]], w: 26 },
      leaves: leafDefs,
      base: [600, 886], size: 0.52
    }
  };
}

// ── Мадагаскарская комета: жёлтая ночница с глазками и длинными хвостами ────
function comet() {
  const yellow = (cx, cy) => radial(cx, cy, 430, [[0, '#f3f7b4'], [0.35, '#f6e35a'], [0.75, '#efc834'], [1, '#e0a52a']]);
  const eye = (x, y, s) => [
    { d: ellipse(x, y, 44 * s, 37 * s), fill: '#6e2412' },
    { d: ellipse(x, y, 30 * s, 25 * s), fill: '#e89f3c' },
    { d: ellipse(x + 2 * s, y - s, 15 * s, 12 * s), fill: '#3a1607' },
    { d: ellipse(x - 8 * s, y - 9 * s, 7 * s, 4 * s, -0.4), fill: '#fff6dc' }
  ];
  const vein = tint('#c79a22');
  const hind = {
    d: blob([[516, 300], [620, 318], [740, 345], [808, 398], [800, 470], [742, 522], [690, 565], [656, 640], [648, 720], [668, 800],
      [700, 850], [708, 900], [676, 936], [630, 920], [614, 868], [606, 800], [596, 720], [580, 640], [552, 560], [524, 470], [514, 380]]),
    fill: yellow(560, 360), edge: '#a77d1a',
    zones: [{ d: blob([[700, 826], [748, 880], [706, 960], [598, 944], [590, 862], [640, 818]]), fill: '#c4452a' }, ...eye(704, 436, 0.85)],
    lines: ['M 530 330 C 620 360 700 390 780 430', 'M 528 360 C 590 420 640 500 682 548', 'M 640 600 C 626 700 630 800 656 880'].map(vein)
  };
  const fore = {
    d: blob([[516, 248], [600, 204], [720, 166], [840, 142], [905, 130], [940, 146], [905, 178], [876, 228], [862, 298], [836, 348],
      [790, 372], [690, 360], [590, 330], [518, 300]]),
    fill: yellow(540, 260), edge: '#a77d1a',
    zones: [{ d: blob([[512, 262], [600, 212], [720, 172], [840, 148], [905, 136], [948, 140], [905, 152], [840, 162], [720, 188], [600, 228], [512, 282]]), fill: '#7a2a18' },
      ...eye(722, 270, 1)],
    lines: ['M 540 272 C 640 252 760 240 852 240', 'M 540 292 C 640 302 740 322 822 352'].map(vein)
  };
  return makeButterfly({ head: 212, thorax: 268, tail: 462, w: 28, hind, fore,
    body: { abdomen: '#f4ecdc', chest: '#efe4cf', edge: '#b9a888', rings: '#d6c8aa' }, antenna: [64, 100, true] });
}

// ── Птицекрыл: длинные чёрные передние крылья с изумрудными полосами ────────
function birdwing() {
  const black = '#141414', vein = tint('#383838');
  const green = (x1, y1, x2, y2) => linear(x1, y1, x2, y2, [[0, '#1fbf5a'], [0.5, '#4ff08a'], [1, '#18a84f']]);
  const fore = {
    d: blob([[515, 212], [620, 176], [760, 132], [900, 102], [958, 98], [978, 122], [952, 178], [902, 232], [850, 268], [796, 286],
      [700, 282], [600, 264], [516, 256]]),
    fill: black, edge: '#000',
    zones: [
      { d: blob([[525, 216], [640, 182], [780, 142], [905, 112], [952, 108], [934, 128], [792, 162], [652, 202], [530, 238]]), fill: green(520, 230, 950, 110) },
      { d: blob([[528, 250], [640, 256], [760, 262], [852, 258], [882, 246], [858, 238], [760, 242], [640, 238], [530, 236]]), fill: green(520, 250, 880, 250) }
    ],
    lines: ['M 540 236 C 660 220 800 196 930 150', 'M 560 246 C 680 244 800 236 900 210'].map(vein)
  };
  const hind = {
    d: blob([[515, 256], [600, 268], [700, 290], [762, 330], [778, 400], [752, 470], [692, 520], [620, 542], [560, 522], [526, 462], [515, 360]]),
    fill: radial(560, 330, 300, [[0, '#8af7ae'], [0.45, '#2fd36a'], [1, '#129a4a']]), edge: '#0b5a2c',
    zones: [
      { d: band([[742, 320], [748, 400], [724, 462], [672, 504], [606, 520], [556, 512]], [[556, 640], [880, 640], [880, 300]]), fill: black },
      ...dots([[690, 360, 17], [700, 418, 17], [668, 466, 15], [616, 490, 13]], black)
    ],
    lines: ['M 530 290 C 600 330 650 380 680 430', 'M 528 320 C 570 380 590 440 600 490'].map(tint('#0f7a3a'))
  };
  return makeButterfly({ head: 176, thorax: 232, tail: 540, w: 24, hind, fore,
    body: { abdomen: '#f2c21c', chest: '#151515', edge: '#2a2208', rings: '#c99a0e' }, antenna: [58, 112] });
}

// ── Совиный глаз: бурые крылья и огромный «глаз» на заднем крыле ────────────
function owl() {
  const mottle = tint('#4a3524');
  const fore = {
    d: blob([[515, 232], [620, 192], [760, 162], [880, 150], [934, 166], [930, 212], [906, 270], [880, 330], [840, 370], [720, 360], [600, 322], [516, 292]]),
    fill: linear(520, 200, 900, 360, [[0, '#9c7c58'], [1, '#5e4430']]), edge: '#3b2a1c',
    zones: [
      { d: blob([[512, 240], [600, 214], [640, 280], [600, 322], [512, 302]]), fill: '#5d6a92' },
      { d: blob([[690, 178], [770, 162], [832, 230], [882, 322], [852, 346], [790, 282], [722, 202]]), fill: '#efe0b0' },
      ...dots([[890, 196, 10], [870, 228, 7]], '#f5efdc')
    ],
    lines: ['M 560 300 Q 600 280 640 300 T 720 302', 'M 600 332 Q 650 316 700 336 T 792 348', 'M 742 236 Q 778 226 800 250'].map(mottle)
  };
  const hind = {
    d: blob([[515, 296], [620, 320], [740, 360], [810, 420], [832, 500], [802, 580], [732, 640], [642, 662], [572, 632], [530, 562], [515, 420]]),
    fill: radial(540, 340, 380, [[0, '#5a6aa0'], [0.35, '#6c5a7a'], [0.6, '#8a6a48'], [1, '#5e4430']]), edge: '#3b2a1c',
    zones: [
      { d: ellipse(706, 506, 92, 84), fill: '#1c1410' },
      { d: ellipse(706, 506, 76, 69), fill: '#e8bf45' },
      { d: ellipse(708, 508, 56, 51), fill: '#120c08' },
      { d: ellipse(686, 486, 15, 9, -0.6), fill: '#f6f1e2' },
      { d: circle(592, 604, 19), fill: '#1c1410' }, { d: circle(592, 604, 10), fill: '#e8bf45' }
    ],
    lines: ['M 560 362 Q 620 350 662 380', 'M 540 420 Q 580 442 600 482', 'M 762 602 Q 722 632 682 642', 'M 808 450 Q 790 470 800 520'].map(tint('#3f2e20'))
  };
  return makeButterfly({ head: 196, thorax: 256, tail: 492, w: 25, hind, fore,
    body: { abdomen: '#4a3828', chest: '#3b2c20', edge: '#20160e', rings: '#6a5440' }, antenna: [76, 116] });
}

// ── Геликониус: узкие чёрные крылья, красная перевязь, жёлтая полоса ────────
function heliconius() {
  const black = '#161616';
  const fore = {
    d: blob([[512, 236], [600, 206], [720, 182], [840, 170], [902, 180], [922, 214], [902, 254], [860, 284], [800, 300], [700, 295], [600, 280], [514, 268]]),
    fill: black, edge: '#000',
    zones: [{ d: blob([[630, 214], [720, 192], [800, 186], [846, 202], [836, 242], [786, 268], [700, 278], [640, 264], [612, 238]]),
      fill: radial(730, 230, 130, [[0, '#ff5032'], [1, '#d91c12']]) }],
    lines: ['M 540 252 C 640 238 760 226 880 214'].map(tint('#3a3a3a'))
  };
  const hind = {
    d: blob([[512, 268], [590, 284], [680, 300], [742, 330], [752, 380], [722, 426], [660, 450], [590, 446], [540, 410], [515, 340]]),
    fill: black, edge: '#000',
    zones: [{ d: blob([[548, 298], [650, 306], [724, 330], [744, 350], [700, 360], [620, 346], [548, 328]]), fill: '#f7d531' },
      ...dots([[736, 400, 4.5], [714, 428, 4.5], [680, 444, 4.5], [642, 448, 4.5]], '#f3f0e6')],
    lines: ['M 530 330 C 590 360 640 400 670 440'].map(tint('#3a3a3a'))
  };
  return makeButterfly({ head: 200, thorax: 252, tail: 470, w: 18, hind, fore,
    body: { abdomen: '#1a1a1a', chest: '#1a1a1a', edge: '#000', rings: '#f2d32e' }, antenna: [72, 142] });
}

// ── Урания: чёрная с зелёными полосами, радужное заднее крыло с хвостиками ──
function urania() {
  const black = '#121212';
  const stripe = linear(540, 200, 900, 330, [[0, '#46e6a0'], [0.5, '#2fd0b0'], [1, '#26b4c8']]);
  const fore = {
    d: blob([[512, 242], [640, 206], [780, 170], [900, 140], [928, 150], [912, 214], [884, 282], [858, 330], [820, 352], [700, 336], [600, 302], [514, 286]]),
    fill: black, edge: '#000',
    zones: [0, 1, 2, 3, 4, 5].map((k) => ({ d: poly(ribbon([[566 + 62 * k, 190 - 12 * k], [552 + 56 * k, 340 - 8 * k]], 17, 14)), fill: stripe }))
  };
  const hind = {
    d: blob([[512, 292], [600, 306], [700, 330], [770, 368], [810, 402], [840, 422], [798, 446], [816, 490], [842, 514], [784, 526], [778, 566],
      [798, 608], [740, 592], [708, 624], [712, 666], [674, 626], [622, 620], [572, 594], [532, 534], [515, 420]], 6),
    fill: black, edge: '#000',
    zones: [
      { d: blob([[516, 300], [592, 312], [612, 372], [572, 432], [520, 422]]), fill: '#2ed7a0' },
      { d: blob([[600, 336], [700, 352], [762, 396], [772, 470], [742, 546], [668, 588], [600, 566], [566, 486], [574, 400]]),
        fill: linear(600, 350, 740, 580, [[0, '#f9d34f'], [0.35, '#f8961e'], [0.7, '#f3722c'], [1, '#c9184a']]) },
      ...dots([[722, 420, 14], [736, 480, 13], [702, 540, 12], [642, 560, 11]], black),
      ...dots([[838, 424, 11], [840, 512, 11], [796, 606, 11], [710, 664, 11]], '#f4f2ea')
    ]
  };
  return makeButterfly({ head: 206, thorax: 262, tail: 470, w: 20, hind, fore,
    body: { abdomen: '#1b1b1b', chest: '#1b1b1b', edge: '#000', rings: '#3fe39a' }, antenna: [72, 122] });
}

// ── Подсолнух: большая корзинка со спиралями семечек и два листа-сердца ─────
function sunflower() {
  const c = [550, 330];
  const front = radial(c[0], c[1], 300, [[0.3, '#f59e0b'], [0.6, '#fbbf24'], [1, '#fde047']]);
  const back = radial(c[0], c[1], 300, [[0.3, '#d97706'], [1, '#f2b705']]);
  const ray = (a, len, w, fill) => {
    const p = petalAt([c[0] + Math.cos(a) * 100, c[1] + Math.sin(a) * 100], a, len, w, { p: 0.85, q: 0.7, bend: (((a * 7) % 1) - 0.5) * 0.1 });
    return { d: p.d, fill, edge: '#c98a06', lines: p.lines([0], 0.15, 0.85).map(tint('#e0a50c')) };
  };
  const rays = [];
  for (let i = 0; i < 21; i++) rays.push(ray((i / 21) * TAU + 0.15, 192, 62, back));
  for (let i = 0; i < 21; i++) rays.push(ray(((i + 0.5) / 21) * TAU, 176, 66, front));
  const spirals = [];
  for (let k = 0; k < 13; k++) for (const sign of [1, -1]) {
    const a0 = (k / 13) * TAU;
    spirals.push(poly(Array.from({ length: 12 }, (_, i) => {
      const r = 22 + (i / 11) * 104, a = a0 + sign * (r / 126) * 2.1;
      return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
    }), false));
  }
  const disc = { d: circle(c[0], c[1], 128), fill: radial(c[0], c[1], 128, [[0, '#5b4a1a'], [0.35, '#3a2410'], [0.8, '#5a3a18'], [1, '#7a5220']]), edge: '#2a180a',
    zones: [{ d: circle(c[0], c[1], 50), fill: radial(c[0], c[1], 50, [[0, '#7c7a2c'], [1, '#4f3f16']]) }],
    lines: spirals.map(tint('#2a1808')) };
  const stemLine = [[550, 440], [553, 580], [557, 700], [560, 780]];
  const stem = { d: poly(ribbon(stemLine, 36, 30)), fill: '#4f8a2f', edge: '#2f5f1c' };
  const leafDefs = [
    { base: [551, 600], tip: [150, 520], w: 250, bend: 0.12, fold: 0.16, arc: 0.1 },
    { base: [556, 690], tip: [975, 600], w: 262, bend: -0.12, fold: 0.16, arc: 0.1 }
  ];
  const leaves = leafDefs.map(({ base, tip, w, bend }) => {
    const l = leaf(base, tip, w, { bend, teeth: 15, tooth: 0.05 });
    return { d: l.outline, fill: linear(base[0], base[1], tip[0], tip[1], [[0, '#3c7a2c'], [1, '#6cae45']]), edge: '#2a5a1f', lines: l.lines.map(tint('#8cc96a')) };
  });
  return { parts: [stem, ...leaves, ...rays, disc],
    three: { bloom: { c, r: 290, cup: 0.12, curl: 0.07, wave: 0.02 }, stem: { line: stemLine, w: 34 }, leaves: leafDefs, base: [560, 780], size: 0.66 } };
}

// ── Райская птица: зелёный «клюв», оранжевый хохолок, синий язычок ──────────
function strelitzia() {
  const stemLine = [[335, 404], [365, 560], [395, 700], [410, 772]];
  const stem = { d: poly(ribbon(stemLine, 34, 30)), fill: '#4d7a3f', edge: '#2f5527' };
  const leafDefs = [
    { base: [262, 650], tip: [76, 420], w: 156, bend: 0.08, fold: 0.12, arc: 0.06, stalk: [[402, 772], [330, 720], [262, 650]] },
    { base: [650, 680], tip: [936, 510], w: 166, bend: -0.08, fold: 0.12, arc: 0.06, stalk: [[418, 772], [530, 730], [650, 680]] }
  ];
  const leaves = leafDefs.map(({ base, tip, w, bend, stalk }) => {
    const l = leaf(base, tip, w, { bend, teeth: 0, veins: 9 });
    return [{ d: poly(ribbon(stalk, 18, 14)), fill: '#4d7a3f', edge: '#2f5527' },
      { d: l.outline, fill: linear(base[0], base[1], tip[0], tip[1], [[0, '#2f6a3c'], [1, '#5a9a5e']]), edge: '#24502c', lines: l.lines.map(tint('#7ab07c')) }];
  }).flat();
  const orange = linear(520, 330, 540, 60, [[0, '#ff6a0f'], [1, '#ffc23a']]);
  const sepals = [[500, 336, -112, 270, 0.06], [530, 330, -92, 288, -0.02], [560, 328, -70, 252, -0.06]].map(([x, y, a, len, bend]) => {
    const p = petalAt([x, y], deg(a), len, 64, { p: 0.6, q: 0.9, bend });
    return { d: p.d, fill: orange, edge: '#d4570a', lines: p.lines([0]).map(tint('#ff9a2a')) };
  });
  const spathe = { d: blob([[290, 372], [400, 344], [560, 328], [700, 318], [866, 314], [776, 360], [630, 404], [480, 432], [350, 432], [300, 410]]),
    fill: linear(300, 320, 600, 420, [[0, '#3c7a4a'], [0.6, '#4b6b3a'], [1, '#8a3b5e']]), edge: '#2b4a2a',
    lines: [{ d: 'M 320 382 C 450 362 620 346 840 322', color: '#5a8f5a' }] };
  const blue = [[575, 324, -42, 150, 30], [565, 322, -32, 202, 44]].map(([x, y, a, len, w]) => {
    const p = petalAt([x, y], deg(a), len, w, { p: 0.7, q: 1, bend: 0.05 });
    return { d: p.d, fill: linear(x, y, x + len, y - len * 0.6, [[0, '#2a55d8'], [1, '#5a96ff']]), edge: '#1d3a99' };
  });
  return { parts: [stem, ...leaves, ...sepals, spathe, ...blue],
    three: { bloom: { c: [540, 320], r: 280, cup: 0.04, curl: 0.02, wave: 0 }, stem: { line: stemLine, w: 30 },
      leaves: leafDefs, base: [410, 772], size: 0.95 } };
}

// ── Орхидея: дугой изогнутый стебель, цветок-бабочка, бутоны, листья у земли
function orchid() {
  const c = [600, 300];
  const pink = radial(c[0], c[1], 240, [[0, '#a3126b'], [0.25, '#d4459a'], [0.65, '#ef8cc6'], [1, '#fbd3ea']]);
  const vein = tint('#b82d82');
  const piece = (a, len, w, opts) => {
    const p = petalAt(c, deg(a), len, w, opts);
    return { d: p.d, fill: pink, edge: '#b0337f', lines: p.lines([-0.5, -0.25, 0, 0.25, 0.5], 0.12, 0.8).map(vein) };
  };
  const stemLine = [[420, 850], [425, 650], [455, 480], [530, 370], [620, 290], [760, 224], [880, 226]];
  const leafDefs = [
    { base: [420, 846], tip: [108, 790], w: 170, bend: 0.1, fold: 0.1, arc: 0.05 },
    { base: [430, 848], tip: [770, 806], w: 180, bend: -0.12, fold: 0.1, arc: 0.05 },
    { base: [424, 856], tip: [262, 896], w: 110, bend: -0.05, fold: 0.08, arc: 0.03 }
  ];
  const leaves = leafDefs.map(({ base, tip, w, bend }) => {
    const l = leaf(base, tip, w, { bend, teeth: 0, veins: 0 });
    return { d: l.outline, fill: linear(base[0], base[1], tip[0], tip[1], [[0, '#2c5a2e'], [1, '#55924a']]), edge: '#1f4422', lines: l.lines.map(tint('#6faa62')) };
  });
  const lip = { d: blob([[600, 300], [560, 316], [538, 346], [564, 362], [585, 352], [574, 402], [600, 442], [626, 402], [615, 352], [636, 362], [662, 346], [640, 316]]),
    fill: radial(600, 360, 90, [[0, '#7a0a4f'], [1, '#b0177a']]), edge: '#5e0a3c',
    zones: [{ d: blob([[584, 314], [616, 314], [622, 340], [600, 352], [578, 340]]), fill: '#f2c230' }, ...dots([[592, 330, 3.5], [608, 330, 3.5], [600, 340, 3.5]], '#c2261c')] };
  return {
    parts: [
      { d: poly(ribbon(stemLine, 14, 10)), fill: '#5b7a3a', edge: '#3a5524' },
      ...leaves,
      { d: ellipse(840, 216, 20, 14, 0.15), fill: radial(840, 216, 22, [[0, '#e9b3d2'], [1, '#a8cf7a']]), edge: '#6a8a4a' },
      { d: ellipse(908, 232, 36, 26, 0.2), fill: radial(908, 232, 38, [[0, '#f2b4d6'], [1, '#c4dc94']]), edge: '#7a9a5a' },
      piece(125, 180, 108, { p: 1, q: 0.55, bend: -0.05 }), piece(55, 180, 108, { p: 1, q: 0.55, bend: 0.05 }),
      piece(-90, 190, 125, { p: 1.05, q: 0.5 }),
      piece(187, 205, 205, { p: 0.85, q: 0.42 }), piece(-7, 205, 205, { p: 0.85, q: 0.42 }),
      lip,
      { d: ellipse(600, 292, 16, 20), fill: '#f7eef5', edge: '#c9a3bb' }
    ],
    three: { bloom: { c, r: 230, cup: 0.12, curl: 0.05, wave: 0.03 }, stem: { line: stemLine.slice(0, 4), w: 14 }, leaves: leafDefs, base: [424, 852], size: 0.46 }
  };
}

// ── Ирис: три лепестка вверх, три свисают с жёлтой «бородкой», листья-мечи ──
function iris() {
  const c = [560, 330];
  const upper = radial(c[0], c[1], 240, [[0, '#ece6ff'], [0.4, '#a99af5'], [1, '#7b68e6']]);
  const lower = radial(c[0], c[1], 280, [[0, '#fdf6ff'], [0.25, '#8e6ae0'], [0.6, '#5a35c2'], [1, '#3b1f94']]);
  const standard = (a, len, w, opts) => {
    const p = petalAt(c, deg(a), len, w, opts);
    return { d: p.d, fill: upper, edge: '#4c3aa8', lines: p.lines([-0.4, 0, 0.4], 0.15, 0.85).map(tint('#6a58d0')) };
  };
  const fall = (a, len, w, opts) => {
    const p = petalAt(c, deg(a), len, w, opts);
    const beard = Array.from({ length: 9 }, (_, i) => p.at(0.06 + i * 0.045, 0));
    return { d: p.d, fill: lower, edge: '#2a1670',
      zones: [{ d: ellipse(...p.at(0.26, 0), len * 0.17, p.half(0.26) * 0.62, deg(a)), fill: '#efe6ff' },
        { d: poly(ribbon(beard, 22, 14)), fill: '#ffb703' }],
      lines: p.lines([-0.45, -0.22, 0.22, 0.45], 0.12, 0.5).map(tint('#4a2aa8')) };
  };
  const arm = (a, len, w) => ({ d: petalAt(c, deg(a), len, w, { p: 1, q: 0.6 }).d, fill: '#c9bcff', edge: '#7a68d8' });
  const stemLine = [[560, 450], [560, 600], [561, 704]];
  const leafDefs = [
    { base: [548, 704], tip: [236, 470], w: 70, bend: 0.1, fold: 0.08, arc: 0.04 },
    { base: [574, 704], tip: [884, 480], w: 70, bend: -0.1, fold: 0.08, arc: 0.04 },
    { base: [552, 704], tip: [330, 600], w: 58, bend: 0.06, fold: 0.08, arc: 0.03 },
    { base: [570, 704], tip: [796, 610], w: 58, bend: -0.06, fold: 0.08, arc: 0.03 }
  ];
  const leaves = leafDefs.map(({ base, tip, w, bend }) => {
    const l = leaf(base, tip, w, { bend, teeth: 0, veins: 0, sword: true });
    return { d: l.outline, fill: linear(base[0], base[1], tip[0], tip[1], [[0, '#3f7a52'], [1, '#74b07e']]), edge: '#2a5638', lines: l.lines.map(tint('#86bf8e')) };
  });
  return {
    parts: [
      { d: poly(ribbon(stemLine, 22, 20)), fill: '#4f7f45', edge: '#30562a' }, ...leaves,
      standard(-125, 195, 130, { p: 1.1, q: 0.5, bend: 0.18 }), standard(-55, 195, 130, { p: 1.1, q: 0.5, bend: -0.18 }),
      standard(-90, 226, 150, { p: 1.15, q: 0.48, ruffle: 0.06, waves: 9 }),
      fall(150, 226, 150, { p: 1, q: 0.5, bend: -0.1, ruffle: 0.05 }), fall(30, 226, 150, { p: 1, q: 0.5, bend: 0.1, ruffle: 0.05 }),
      fall(90, 256, 172, { p: 1, q: 0.48, ruffle: 0.05 }),
      arm(150, 86, 40), arm(30, 86, 40), arm(90, 96, 44)
    ],
    three: { bloom: { c, r: 255, cup: 0.14, curl: -0.05, wave: 0.03 }, stem: { line: stemLine, w: 22 }, leaves: leafDefs, base: [561, 704], size: 0.72 }
  };
}

// ── Тигровая лилия: загнутые оранжевые лепестки в крапинку, тычинки вниз ────
function tigerLily() {
  const c = [560, 330];
  const orange = radial(c[0], c[1], 250, [[0, '#ffd27a'], [0.3, '#ffa037'], [0.7, '#ff7414'], [1, '#e2510a']]);
  const tepal = (k) => {
    const outer = k % 2 === 0, a = deg(-90 + 60 * k + 15);
    const p = petalAt(c, a, outer ? 236 : 216, outer ? 74 : 64, { p: 0.65, q: 0.85, bend: outer ? -0.12 : 0.12 });
    const spots = [[0.22, -0.4], [0.3, 0.35], [0.38, -0.2], [0.45, 0.45], [0.52, -0.42], [0.58, 0.15], [0.64, -0.1], [0.34, 0.05]]
      .map(([s, f]) => ({ d: ellipse(...p.at(s, f), 7, 5, a), fill: '#3a1406' }));
    return { d: p.d, fill: orange, edge: '#b8420a', zones: spots, lines: p.lines([0], 0.1, 0.8).map(tint('#e2690f')) };
  };
  const stamens = [];
  for (let j = 0; j < 6; j++) {
    const a = deg(62 + j * 11.2), len = 205 + (j % 2) * 22, end = [c[0] + Math.cos(a) * len, c[1] + Math.sin(a) * len];
    stamens.push({ d: poly(ribbon([c, [c[0] + Math.cos(a) * len * 0.5 - 8, c[1] + Math.sin(a) * len * 0.5], end], 6, 5)), fill: '#d9a063', edge: '#a8743c' });
    stamens.push({ d: ellipse(end[0], end[1] + 4, 21, 8, a + Math.PI / 2), fill: '#5a2a10', edge: '#2f1405' });
  }
  const stemLine = [[560, 420], [563, 560], [566, 690], [568, 760]];
  const leafDefs = [], leaves = [];
  for (let i = 0; i < 6; i++) {
    const y = 520 + i * 44, side = i % 2 ? 1 : -1;
    const base = [565 + side * 8, y], tip = [565 + side * (300 - i * 18), y - 60 + i * 6];
    leafDefs.push({ base, tip, w: 40, bend: side * 0.08, fold: 0.1, arc: 0.05 });
    const l = leaf(base, tip, 40, { bend: side * 0.08, teeth: 0, veins: 0 });
    leaves.push({ d: l.outline, fill: linear(base[0], base[1], tip[0], tip[1], [[0, '#2f5a26'], [1, '#5e9a45']]), edge: '#1f3f19', lines: l.lines.map(tint('#7ab35f')) });
    leaves.push({ d: circle(565 + side * 12, y - 6, 8), fill: '#2b1a10', edge: '#140c06' });
  }
  return {
    parts: [{ d: poly(ribbon(stemLine, 20, 18)), fill: '#3f5f2c', edge: '#26401a' }, ...leaves,
      ...[0, 2, 4, 1, 3, 5].map(tepal), ...stamens,
      { d: poly(ribbon([c, [562, 470], [560, 590]], 8, 7)), fill: '#cf9a5c', edge: '#9a6a34' }, { d: circle(560, 596, 11), fill: '#7a3a14', edge: '#3f1c08' }],
    three: { bloom: { c, r: 250, cup: 0.2, curl: -0.12, wave: 0.03 }, stem: { line: stemLine, w: 20 }, leaves: leafDefs, base: [568, 760], size: 0.5 }
  };
}

// ── Наперстянка: колос из пятнистых колокольчиков и розетка листьев ─────────
function foxglove() {
  const bell = (x, y, s, side) => {
    const P = ([px, py]) => [x + side * px * s, y + py * s];
    const shape = [[0, 0], [0.32, 0.04], [0.5, 0.38], [0.58, 0.82], [0.76, 1.02], [0.42, 1.13], [0.06, 1.08], [-0.1, 0.98], [0, 0.6], [0.02, 0.2]].map(P);
    const mouth = P([0.33, 1.02]);
    const spots = [0, 1, 2, 3].map((k) => P([0.18 + k * 0.08, 0.99 + (k % 2) * 0.03]));
    return { d: blob(shape), fill: linear(x, y, x, y + s, [[0, '#a3307f'], [1, '#e58ac7']]), edge: '#6d1c56',
      zones: [{ d: ellipse(mouth[0], mouth[1], 0.32 * s, 0.11 * s), fill: '#f6d3ea' },
        ...spots.map(([sx, sy]) => ({ d: circle(sx, sy, 0.042 * s), fill: '#ffffff' })),
        ...spots.map(([sx, sy]) => ({ d: circle(sx, sy, 0.025 * s), fill: '#5e1546' }))],
      lines: [{ d: poly(smooth([P([0.12, 0.15]), P([0.22, 0.55]), P([0.3, 0.9])], false, 6), false), color: '#c2549f' }] };
  };
  // главный колос и боковой поменьше: так растение шире и крупнее на листе
  const bells = [];
  const spike = (line, n, s0, s1, flip) => {
    const pts = smooth(line, false, 20);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), p = pts[Math.round((0.3 + t * 0.6) * (pts.length - 1))];
      bells.push(bell(p[0], p[1], s0 - t * (s0 - s1), (i % 2 ? 1 : -1) * flip));
    }
  };
  const side = [[600, 704], [640, 560], [700, 400], [760, 240]];
  const mainLine = [[560, 704], [562, 560], [566, 400], [566, 220], [560, 60]];
  const buds = [];
  [[560, 70, 0], [762, 236, 0.35]].forEach(([x, y, tilt]) => [0, 1, 2].forEach((i) =>
    buds.push({ d: ellipse(x + (i % 2 ? 11 : -11) + tilt * i * 10, y + i * 22, 10, 16, tilt), fill: radial(x, y + 20, 50, [[0, '#d98bc0'], [1, '#9cc070']]), edge: '#5a7a3a' })));
  spike(side, 5, 118, 64, 1);
  const sideBells = bells.splice(0);
  spike([[560, 704], [562, 560], [566, 400], [566, 220], [560, 90]], 8, 168, 74, 1);
  const leafDefs = [
    { base: [552, 700], tip: [150, 590], w: 160, bend: 0.1, fold: 0.12, arc: 0.06 },
    { base: [572, 700], tip: [972, 600], w: 166, bend: -0.1, fold: 0.12, arc: 0.06 },
    { base: [558, 704], tip: [330, 700], w: 100, bend: -0.05, fold: 0.1, arc: 0.04 }
  ];
  const leaves = leafDefs.map(({ base, tip, w, bend }) => {
    const l = leaf(base, tip, w, { bend, teeth: 14, tooth: 0.04 });
    return { d: l.outline, fill: linear(base[0], base[1], tip[0], tip[1], [[0, '#3a6e34'], [1, '#6fa856']]), edge: '#264a22', lines: l.lines.map(tint('#88c06e')) };
  });
  return { parts: [{ d: poly(ribbon(side, 14, 7)), fill: '#5b7f3e', edge: '#3a5526' }, ...sideBells,
    { d: poly(ribbon(mainLine, 22, 8)), fill: '#5b7f3e', edge: '#3a5526' }, ...leaves, ...buds, ...bells],
    three: { bloom: { c: [590, 330], r: 290, cup: 0.06, curl: 0, wave: 0 }, stem: { line: mainLine, w: 20 }, leaves: leafDefs, base: [560, 704], size: 1.0 } };
}

// ── Протея: чаша из розовых прицветников вокруг шелковистого купола ─────────
function protea() {
  const c = [560, 340];
  const ring = (n, r0, len, w, stops, off) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU + off;
    const p = petalAt([c[0] + Math.cos(a) * r0, c[1] + Math.sin(a) * r0], a, len, w, { p: 0.7, q: 0.9, bend: 0.03 });
    return { d: p.d, fill: radial(c[0], c[1], r0 + len, stops), edge: '#c14e6c', lines: p.lines([0], 0.2, 0.8).map(tint('#f7c3cf')) };
  });
  const silk = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * TAU, r1 = 30 + (i % 3) * 8;
    return `M ${r2(c[0] + Math.cos(a) * r1)} ${r2(c[1] + Math.sin(a) * r1)} L ${r2(c[0] + Math.cos(a) * 104)} ${r2(c[1] + Math.sin(a) * 104)}`;
  });
  const stemLine = [[560, 470], [564, 600], [569, 700], [572, 780]];
  const leafDefs = [
    { base: [562, 600], tip: [205, 520], w: 150, bend: 0.08, fold: 0.1, arc: 0.05 },
    { base: [567, 680], tip: [925, 600], w: 160, bend: -0.08, fold: 0.1, arc: 0.05 },
    { base: [571, 756], tip: [300, 780], w: 112, bend: -0.05, fold: 0.08, arc: 0.04 }
  ];
  const leaves = leafDefs.map(({ base, tip, w, bend }) => {
    const l = leaf(base, tip, w, { bend, teeth: 0, veins: 0 });
    return { d: l.outline, fill: linear(base[0], base[1], tip[0], tip[1], [[0, '#3b6a3a'], [1, '#6a9a55']]), edge: '#8a3a2a', lines: l.lines.map(tint('#86b070')) };
  });
  return {
    parts: [{ d: poly(ribbon(stemLine, 40, 34)), fill: '#7a6040', edge: '#4f3c24' }, ...leaves,
      ...ring(16, 55, 245, 78, [[0.2, '#e86a8a'], [0.6, '#f39ab0'], [1, '#fde4d6']], 0.1),
      ...ring(14, 45, 186, 66, [[0.2, '#e05a80'], [1, '#f7b6c6']], 0.33),
      ...ring(12, 35, 140, 52, [[0.2, '#d94f78'], [1, '#f3a0b6']], 0.05),
      { d: circle(c[0], c[1], 112), fill: radial(c[0], c[1], 112, [[0, '#fbf3e6'], [0.6, '#f3dcc6'], [1, '#e7a7b8']]), edge: '#c88a9a', lines: silk.map(tint('#d9b8a8')) }],
    three: { bloom: { c, r: 300, cup: 0.38, curl: 0.04, wave: 0.02 }, stem: { line: stemLine, w: 40 }, leaves: leafDefs, base: [572, 780], size: 0.6 }
  };
}

// Бабочки: span — размах в мире, beatHz — взмахи, glide — доля планирования.
const B = (name, titles, three, art) => ({ name, type: 'butterfly', axis: 500, titles, ...art, three: { ...three, body: art.body } });
const Fl = (name, titles, height, art) => ({ name, type: 'flower', titles, height, ...art });
const morphoArt = morpho();
morphoArt.body = { head: [500, 190], thorax: [500, 252], tail: [500, 518], w: 22 };

module.exports = [
  B('garden-morpho', { ru: 'Морфо', en: 'Morpho', pl: 'Morfo' }, { span: 0.62, beatHz: 4.2, glide: 0.55, speed: 1.0 }, morphoArt),
  B('garden-comet', { ru: 'Мадагаскарская комета', en: 'Comet moth', pl: 'Kometa madagaskarska' }, { span: 0.62, beatHz: 3.2, glide: 0.45, speed: 0.85 }, comet()),
  B('garden-birdwing', { ru: 'Птицекрыл', en: 'Birdwing', pl: 'Ornitoptera' }, { span: 0.72, beatHz: 3.4, glide: 0.75, speed: 1.05 }, birdwing()),
  B('garden-owl', { ru: 'Совиный глаз', en: 'Owl butterfly', pl: 'Sowie oko' }, { span: 0.68, beatHz: 3.8, glide: 0.5, speed: 0.9 }, owl()),
  B('garden-heliconius', { ru: 'Геликониус', en: 'Heliconius', pl: 'Helikonius' }, { span: 0.48, beatHz: 5.5, glide: 0.2, speed: 0.7 }, heliconius()),
  B('garden-urania', { ru: 'Урания', en: 'Sunset moth', pl: 'Urania' }, { span: 0.56, beatHz: 6.5, glide: 0.3, speed: 1.35 }, urania()),
  Fl('garden-hibiscus', { ru: 'Гибискус', en: 'Hibiscus', pl: 'Hibiskus' }, 1.25, hibiscus()),
  Fl('garden-sunflower', { ru: 'Подсолнух', en: 'Sunflower', pl: 'Słonecznik' }, 1.75, sunflower()),
  Fl('garden-strelitzia', { ru: 'Райская птица', en: 'Bird of paradise', pl: 'Strelicja' }, 0, strelitzia()),
  Fl('garden-orchid', { ru: 'Орхидея', en: 'Orchid', pl: 'Storczyk' }, 0, orchid()),
  Fl('garden-iris', { ru: 'Ирис', en: 'Iris', pl: 'Irys' }, 0, iris()),
  Fl('garden-lily', { ru: 'Тигровая лилия', en: 'Tiger lily', pl: 'Lilia tygrysia' }, 1.5, tigerLily()),
  Fl('garden-foxglove', { ru: 'Наперстянка', en: 'Foxglove', pl: 'Naparstnica' }, 0, foxglove()),
  Fl('garden-protea', { ru: 'Протея', en: 'Protea', pl: 'Protea' }, 1.0, protea())
];
