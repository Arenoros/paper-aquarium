import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const garden = require('../assets/garden/manifest.json');
const fish = require('../assets/coloring/manifest.json');
const flight = require('../assets/garden-flight.js');
const rotate = bits => Array.from({ length: 16 }, (_, i) => bits[(3 - i % 4) * 4 + Math.floor(i / 4)]);
const rotations = bits => { const list = []; for (let i = 0; i < 4; i++, bits = rotate(bits)) list.push(bits); return list; };
const distance = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

test('garden sheets cannot be confused with fish or another rotated corner', () => {
  const all = [...fish.fish, ...garden.fish].flatMap(f => Object.entries(f.markers).flatMap(([corner, bits]) =>
    rotations(bits).map((code, rotation) => ({ key: f.name + corner + rotation, code, garden: f.world === 'garden' }))));
  for (const a of all.filter(x => x.garden)) {
    for (const b of all) if (a.key !== b.key) assert.ok(distance(a.code, b.code) >= 4, a.key + ' / ' + b.key);
  }
  for (const f of garden.fish) {
    assert.ok(f.name.startsWith('garden-'));
    for (const [x, y] of f.contourModel) {
      const sx = f.sheetTransform.ox + f.sheetTransform.scale * x;
      const sy = f.sheetTransform.oy - f.sheetTransform.scale * y;
      assert.ok(sx >= garden.sheet.work.x0 && sx <= garden.sheet.work.x1);
      assert.ok(sy >= garden.sheet.work.y0 && sy <= garden.sheet.work.y1);
    }
  }
});

// Присест цветка: серединка p, нормаль бутона n, «вверх по цветку» u.
const perch = (id, x = 0, z = 0) => ({ id, p: { x, y: 1, z }, n: { x: 0, y: 0.3, z: 0.95 }, u: { x: 0, y: 1, z: 0 }, r: 0.25 });
const fly = (b, from, to, ctx, each) => { for (let t = from; t < to; t += 0.025) { flight.step(b, 0.025, t, ctx); if (each) each(t); } };

test('butterflies land on a drawn flower, rest, then fly away', () => {
  const b = flight.create('childs-butterfly', { span: 0.6 });
  const flower = perch('childs-flower');
  let landedAt = null, flewAway = false;
  fly(b, 0, 40, { perches: [flower], rain: 0, others: [b] }, (t) => {
    if (b.mode === 'perch' && landedAt === null) {
      landedAt = t;
      assert.ok(Math.hypot(b.x - flower.p.x, b.y - flower.p.y, b.z - flower.p.z) < 0.12, 'sits on the middle of the bloom');
    }
    if (landedAt !== null && b.mode === 'fly') flewAway = true;
    assert.ok(Number.isFinite(b.x + b.y + b.z));
  });
  assert.notEqual(landedAt, null);
  assert.equal(flewAway, true);
});

test('nectar invites butterflies early and removing a flower releases them', () => {
  const b = flight.create('butterfly', {});
  const flower = perch('flower');
  fly(b, 0, 1, { perches: [flower], rain: 0, others: [b] });
  b.nextVisit = 100;
  flight.step(b, 0.025, 1, { perches: [flower], rain: 0, nectarUntil: 11, others: [b] });
  assert.equal(b.target, 'flower');
  fly(b, 1, 14, { perches: [flower], rain: 0, nectarUntil: 11, others: [b] });
  flight.step(b, 0.025, 14, { perches: [], rain: 0, nectarUntil: 11, others: [b] });
  assert.equal(b.target, null);
  assert.notEqual(b.mode, 'perch');
  assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z));
});

test('in the rain every butterfly hides on a swaying flower, each on its own', () => {
  const flowers = Array.from({ length: 20 }, (_, i) => ({ ...perch('f' + i, -3 + (i % 7), [-2, -0.6, 0.8][i % 3]), x0: -3 + (i % 7) }));
  const all = Array.from({ length: 20 }, (_, i) => flight.create('b' + i, { span: 0.65 }));
  for (let t = 0; t < 40; t += 0.02) {
    flowers.forEach((f, i) => { f.p = { ...f.p, x: f.x0 + Math.sin(t * 0.9 + i) * 0.1 }; });
    all.forEach((b) => flight.step(b, 0.02, t, { perches: flowers, rain: 1, others: all }));
  }
  assert.deepEqual(all.map((b) => b.mode), all.map(() => 'perch'));
  assert.ok(all.every((b) => b.wing > 1.2), 'wings folded');
  assert.equal(new Set(all.map((b) => b.target)).size, 20, 'one butterfly per flower');
});

test('without flowers the rain sends butterflies away; a new flower or the sun brings them back', () => {
  const a = flight.create('away-1', {}), b = flight.create('away-2', {});
  fly(a, 0, 15, { perches: [], rain: 1, others: [a] });
  fly(b, 0, 15, { perches: [], rain: 1, others: [b] });
  assert.equal(a.mode, 'away'); assert.equal(a.visible, false);
  fly(a, 15, 40, { perches: [perch('late-flower')], rain: 1, others: [a] });
  assert.equal(a.mode, 'perch'); assert.equal(a.visible, true);
  fly(b, 15, 16, { perches: [], rain: 0, others: [b] });
  assert.equal(b.visible, true); assert.notEqual(b.mode, 'away');
});

test('a tap scares a sitting butterfly off its flower', () => {
  const b = flight.create('tapped', {});
  const flower = perch('flower');
  b.nextVisit = 0;
  fly(b, 0, 20, { perches: [flower], rain: 0, others: [b] }, () => { if (b.mode === 'perch') b.perchedUntil = 1e9; });
  assert.equal(b.mode, 'perch');
  flight.scare(b, 20, { x: 0, y: 2, z: 7 });
  assert.equal(b.mode, 'flee');
  fly(b, 20, 21, { perches: [flower], rain: 0, others: [b] });
  assert.ok(b.z < flower.p.z + 0.5 || b.y > flower.p.y, 'flies away from the viewer');
});

// Сетка цветка: earcut сшивал ровные ряды опорных точек щепками, на изгибе их
// нормали смотрели вбок — по цветку шли тёмные полосы. Вбок могут смотреть
// только края трубки-стебля и загнутые кромки, это единицы вершин.
test('flower meshes are lit smoothly: almost no vertex normal points sideways', () => {
  globalThis.THREE = require('../vendor/three.min.js');
  globalThis.GardenFlight = flight;
  globalThis.window = globalThis;
  require('../assets/garden-world.js');
  const canvas = { width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: [90, 140, 70, 255] }) }) };
  for (const spec of garden.fish.filter(f => f.type === 'flower' || f.name === 'garden-flower')) {
    const n = window.GardenWorld.buildFlower(spec, { dispose() {} }, canvas).mesh.geometry.getAttribute('normal');
    let sideways = 0;
    for (let i = 0; i < n.count; i++) if (n.getZ(i) < 0.3) sideways++;
    assert.ok(sideways / n.count < 0.02, `${spec.name}: ${sideways} of ${n.count}`);
  }
});
