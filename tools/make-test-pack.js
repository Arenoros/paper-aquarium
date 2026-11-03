// Тестовый пак без покупки: рыбы из силуэтов tools/contours.json.
//
//   node tools/make-test-pack.js            → assets/models/pack/ (в git не лежит)
//   node tools/make-test-pack.js --grid 64  → гуще сетка, больше вершин
//
// Силуэты сняты с настоящего пака, поэтому листы раскрасок, съёмка и
// планарная UV ложатся на эти рыбы так же, как на покупные. Тело — боковой
// силуэт, «надутый» по расстоянию до края: толще в середине, тонко у плавников.
// Скелет — цепочка Bone01…Bone08 от носа к хвосту, клип — бегущая волна
// рыскания: по ней fish-frame.js сам находит нос (там мотает меньше) и бок.
//
// Это не замена паку, а нагрузка для замеров: ~2–3 тыс. вершин, скиннинг,
// клип и текстура 1024×1024 на вид — порядок цифр как у покупных рыб.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'models', 'pack');
const GRID = Number((process.argv.indexOf('--grid') > 0 && process.argv[process.argv.indexOf('--grid') + 1]) || 48);
const BONES = 8;
const T_MAX = 0.07;    // половина толщины тела при длине 1
const T_REF = 0.15;    // на каком удалении от края тело набирает полную толщину
const TEX = 1024;
const KEYS = 24;       // кадров в клипе длиной 1 с

// ── геометрия силуэта ──────────────────────────────────────────────────────
function inside(poly, z, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [zi, yi] = poly[i], [zj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && z < (zj - zi) * (y - yi) / (yj - yi) + zi) hit = !hit;
  }
  return hit;
}

// Ближайшая точка контура и расстояние до неё.
function nearest(poly, z, y) {
  let best = Infinity, bz = z, by = y;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [az, ay] = poly[j], [cz, cy] = poly[i];
    const dz = cz - az, dy = cy - ay;
    const t = Math.max(0, Math.min(1, ((z - az) * dz + (y - ay) * dy) / (dz * dz + dy * dy || 1)));
    const pz = az + t * dz, py = ay + t * dy;
    const d = Math.hypot(z - pz, y - py);
    if (d < best) { best = d; bz = pz; by = py; }
  }
  return { d: best, z: bz, y: by };
}

// Сетка по габариту силуэта: клетки, задевшие контур, берём, а их внешние
// углы притягиваем на контур — край выходит гладким, без лесенки.
function buildMesh(poly) {
  const ys = poly.map((p) => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const h = 1 / GRID;
  const nz = GRID, ny = Math.ceil((y1 - y0) / h);
  const grid = [];   // [i][j] → {z, y, t, in}
  for (let i = 0; i <= nz; i++) {
    grid.push([]);
    for (let j = 0; j <= ny; j++) {
      const z = -0.5 + i * h, y = y0 + j * h;
      const n = nearest(poly, z, y);
      const isIn = inside(poly, z, y);
      const u = isIn ? Math.min(n.d / T_REF, 1) : 0;
      grid[i].push(isIn
        ? { z, y, t: T_MAX * Math.sqrt(1 - (1 - u) * (1 - u)), in: true }
        : { z: n.z, y: n.y, t: 0, in: false });
    }
  }

  const pos = [], uv = [], index = [];
  const ids = [new Map(), new Map()];   // сторона → (i,j) → номер вершины
  function vert(side, i, j) {
    const key = i * (ny + 1) + j;
    if (ids[side].has(key)) return ids[side].get(key);
    const g = grid[i][j];
    const id = pos.length / 3;
    pos.push(side ? -g.t : g.t, g.y, g.z);
    uv.push(g.z + 0.5, (y1 - g.y) / (y1 - y0));
    ids[side].set(key, id);
    return id;
  }
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < ny; j++) {
      const c = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]];
      if (!c.some((g) => g.in)) continue;
      for (const side of [0, 1]) {
        const a = vert(side, i, j), b = vert(side, i + 1, j), d = vert(side, i + 1, j + 1), e = vert(side, i, j + 1);
        // Лицо +X смотрит наружу при обходе (z, y) против часовой; обратная сторона — наоборот.
        if (side === 0) index.push(a, e, b, b, e, d); else index.push(a, b, e, b, d, e);
      }
    }
  }
  return { pos, uv, index, y0, y1 };
}

function normals(pos, index) {
  const n = new Float32Array(pos.length);
  for (let k = 0; k < index.length; k += 3) {
    const [a, b, c] = [index[k] * 3, index[k + 1] * 3, index[k + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const p of [a, b, c]) { n[p] += nx; n[p + 1] += ny; n[p + 2] += nz; }
  }
  for (let p = 0; p < n.length; p += 3) {
    const l = Math.hypot(n[p], n[p + 1], n[p + 2]) || 1;
    n[p] /= l; n[p + 1] /= l; n[p + 2] /= l;
  }
  return n;
}

// ── скелет и клип ──────────────────────────────────────────────────────────
// Кости от носа (z = 0.45) к хвосту (z = −0.5), вес — между двумя соседними.
const BONE_Z = Array.from({ length: BONES }, (_, k) => 0.45 - k * 0.95 / (BONES - 1));

function skinWeights(pos) {
  const n = pos.length / 3;
  const joints = new Uint8Array(n * 4), weights = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const z = pos[v * 3 + 2];
    let k = 0;
    while (k < BONES - 2 && z < BONE_Z[k + 1]) k++;
    const w = Math.max(0, Math.min(1, (z - BONE_Z[k + 1]) / (BONE_Z[k] - BONE_Z[k + 1])));
    joints[v * 4] = k; joints[v * 4 + 1] = k + 1;
    weights[v * 4] = w; weights[v * 4 + 1] = 1 - w;
  }
  return { joints, weights };
}

// Рыскание бегущей волной: нос почти неподвижен, к хвосту размах растёт.
function swimTracks() {
  const times = new Float32Array(KEYS + 1);
  const rots = [];
  for (let k = 0; k < BONES; k++) rots.push(new Float32Array((KEYS + 1) * 4));
  for (let f = 0; f <= KEYS; f++) {
    const t = f / KEYS;
    times[f] = t;
    for (let k = 0; k < BONES; k++) {
      const amp = 0.02 + 0.16 * Math.pow(k / (BONES - 1), 1.3);
      const a = amp * Math.sin(2 * Math.PI * (t - k * 0.1));
      rots[k].set([0, Math.sin(a / 2), 0, Math.cos(a / 2)], f * 4);
    }
  }
  return { times, rots };
}

// ── текстура ───────────────────────────────────────────────────────────────
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(pixel(x / w, y / h), y * (w * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8 бит, RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

function hsl(hh, s, l) {
  const f = (n) => {
    const k = (n + hh * 12) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

// Полосы поперёк тела и тёмная спина: видно и вид, и что текстура легла.
function fishPixel(hue) {
  return (u, v) => {
    const band = Math.sin(u * Math.PI * 9) > 0.55;
    const l = band ? 0.92 : 0.35 + 0.3 * v;
    return hsl(band ? hue : (hue + 0.08) % 1, band ? 0.15 : 0.85, l);
  };
}

// Рисунок «как с листа» для раскрашенных рыбок в замерах: тот же размер,
// что отдаёт съёмка (1024 по ширине), каждый раз свой оттенок.
function paintedPng(hue, h) { return png(TEX, h, fishPixel(hue)); }

// ── glTF ───────────────────────────────────────────────────────────────────
function gltfFor(name, contour) {
  const m = buildMesh(contour);
  const nrm = normals(m.pos, m.index);
  const skin = skinWeights(m.pos);
  const anim = swimTracks();

  const parts = [];
  let offset = 0;
  const views = [], accessors = [];
  function add(arr, type, componentType, target, extra) {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    views.push(Object.assign({ buffer: 0, byteOffset: offset, byteLength: buf.length }, target ? { target } : {}));
    parts.push(buf, Buffer.alloc(pad));
    offset += buf.length + pad;
    const per = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    accessors.push(Object.assign({ bufferView: views.length - 1, componentType, count: arr.length / per, type }, extra || {}));
    return accessors.length - 1;
  }

  const posArr = new Float32Array(m.pos);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < posArr.length; i++) { min[i % 3] = Math.min(min[i % 3], posArr[i]); max[i % 3] = Math.max(max[i % 3], posArr[i]); }

  const aPos = add(posArr, 'VEC3', 5126, 34962, { min, max });
  const aNrm = add(nrm, 'VEC3', 5126, 34962);
  const aUv = add(new Float32Array(m.uv), 'VEC2', 5126, 34962);
  const aJ = add(skin.joints, 'VEC4', 5121, 34962);
  const aW = add(skin.weights, 'VEC4', 5126, 34962);
  const aIdx = add(new Uint16Array(m.index), 'SCALAR', 5123, 34963);

  // Обратные матрицы привязки: кость k стоит в (0, 0, BONE_Z[k]) без поворота.
  const ibm = new Float32Array(BONES * 16);
  for (let k = 0; k < BONES; k++) ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -BONE_Z[k], 1], k * 16);
  const aIbm = add(ibm, 'MAT4', 5126);
  const aTime = add(anim.times, 'SCALAR', 5126, null, { min: [0], max: [1] });
  const aRot = anim.rots.map((r) => add(r, 'VEC4', 5126));

  // Узлы: 0 — меш, 1…BONES — кости цепочкой, BONES+1 — корень.
  const nodes = [{ name: name + '_mesh', mesh: 0, skin: 0 }];
  for (let k = 0; k < BONES; k++) {
    nodes.push(Object.assign(
      { name: 'Bone' + String(k + 1).padStart(2, '0'), translation: [0, 0, k ? BONE_Z[k] - BONE_Z[k - 1] : BONE_Z[0]] },
      k < BONES - 1 ? { children: [k + 2] } : {}
    ));
  }
  nodes.push({ name, children: [0, 1] });

  const texFile = name + '_basecolor.png';
  const gltf = {
    asset: { version: '2.0', generator: 'paper-aquarium tools/make-test-pack.js' },
    scene: 0,
    scenes: [{ nodes: [BONES + 1] }],
    nodes,
    meshes: [{ name, primitives: [{
      attributes: { POSITION: aPos, NORMAL: aNrm, TEXCOORD_0: aUv, JOINTS_0: aJ, WEIGHTS_0: aW },
      indices: aIdx, material: 0
    }] }],
    skins: [{ joints: Array.from({ length: BONES }, (_, k) => k + 1), inverseBindMatrices: aIbm, skeleton: 1 }],
    animations: [{
      name: 'Swim',
      samplers: aRot.map((out) => ({ input: aTime, output: out, interpolation: 'LINEAR' })),
      channels: aRot.map((_, k) => ({ sampler: k, target: { node: k + 1, path: 'rotation' } }))
    }],
    materials: [{
      name: name + '_mat', doubleSided: true,
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.6 }
    }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ uri: texFile }],
    buffers: [{ uri: 'buffer.bin', byteLength: offset }],
    bufferViews: views,
    accessors
  };
  return { gltf, bin: Buffer.concat(parts), texFile, verts: posArr.length / 3, tris: m.index.length / 3 };
}

function hueOf(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 360) / 360;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'coloring', 'manifest.json'), 'utf8'));
  const list = [];
  for (const f of manifest.fish) {
    const r = gltfFor(f.name, f.contourModel);
    const dir = path.join(OUT, f.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, f.name + '.gltf'), JSON.stringify(r.gltf));
    fs.writeFileSync(path.join(dir, 'buffer.bin'), r.bin);
    fs.writeFileSync(path.join(dir, r.texFile), png(TEX, TEX, fishPixel(hueOf(f.name))));
    list.push({ name: f.name, title: f.titles && f.titles.en || f.name, url: '/assets/models/pack/' + f.name + '/' + f.name + '.gltf' });
    console.log(`${f.name.padEnd(24)} ${String(r.verts).padStart(5)} вершин ${String(r.tris).padStart(5)} треугольников`);
  }
  fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify(list, null, 1));
  console.log(`${list.length} видов → ${path.relative(ROOT, OUT)}`);
}

// Заселить аквариум раскрашенными рыбками для замеров: у каждой свой рисунок
// 1024×592 (как после съёмки) — худший случай по памяти, общих текстур нет.
//   node tools/make-test-pack.js --fill <код аквариума> <сколько> [http://localhost:8000]
async function fill(id, count, base) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'coloring', 'manifest.json'), 'utf8'));
  for (let i = 0; i < count; i++) {
    const kind = manifest.fish[i % manifest.fish.length].name;
    const texture = 'data:image/png;base64,' + paintedPng((i * 0.137) % 1, 592).toString('base64');
    const r = await fetch(base + '/api/t/' + id + '/fish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, texture })
    });
    if (!r.ok) throw new Error(kind + ': ' + r.status + ' ' + await r.text());
  }
  console.log(`+${count} раскрашенных рыбок в ${id}`);
}

const fillAt = process.argv.indexOf('--fill');
if (fillAt > 0) {
  fill(process.argv[fillAt + 1], Number(process.argv[fillAt + 2]), process.argv[fillAt + 3] || 'http://localhost:8000')
    .catch((e) => { console.error(e.message); process.exit(1); });
} else if (require.main === module) main();
