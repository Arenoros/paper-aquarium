import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const garden = require('../assets/garden/manifest.json');
const fish = require('../assets/coloring/manifest.json');
const motion = require('../assets/garden-motion.js');
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

test('butterflies land on a drawn flower, rest, then fly away', () => {
  const butterfly = motion.create('childs-butterfly');
  const plants = motion.flowers([{ id: 'childs-flower', kind: 'garden-flower' }]);
  let landedAt = null, flewAway = false;
  for (let i = 0; i < 1600; i++) {
    const t = i * 0.025;
    motion.step(butterfly, 0.025, t, plants, 0);
    if (butterfly.perched && landedAt === null) {
      landedAt = t;
      assert.ok(Math.abs(butterfly.x - plants[0].x) < 0.01);
      assert.ok(Math.abs(butterfly.y - (plants[0].y - 0.025)) < 0.01);
    }
    if (landedAt !== null && !butterfly.perched) { flewAway = true; break; }
  }
  assert.notEqual(landedAt, null);
  assert.equal(flewAway, true);
});

test('nectar invites butterflies early and removing a flower releases them', () => {
  const b = motion.create('butterfly');
  const plants = motion.flowers([{ id: 'flower', kind: 'garden-flower' }]);
  b.nextVisit = 100;
  motion.step(b, 0.025, 1, plants, 11);
  assert.equal(b.target, 'flower');
  for (let i = 0; i < 500; i++) motion.step(b, 0.025, 1 + i * 0.025, plants, 11);
  motion.step(b, 0.025, 14, [], 11);
  assert.equal(b.target, null);
  assert.equal(b.perched, false);
  assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
});
