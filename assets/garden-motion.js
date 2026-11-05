(function (root) {
  'use strict';
  function seed(id) {
    var h = 2166136261;
    for (var i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  }
  function create(id) {
    var s = seed(id);
    return { id: id, phase: s * Math.PI * 2, x: 0.15 + s * 0.7, y: 0.2 + s * 0.3,
      nextVisit: 2 + s * 3, visit: 0, target: null, perchedUntil: 0, nectar: 0, perched: false };
  }
  function flowers(records) {
    var list = records.filter(function (r) { return r.kind === 'garden-flower'; });
    return list.map(function (r, i) {
      return { id: r.id, x: 0.1 + (i + 0.5) / list.length * 0.8, y: 0.68 + seed(r.id) * 0.13 };
    });
  }
  function step(b, dt, t, plants, nectarUntil) {
    dt = Math.max(0, Math.min(dt, 0.05));
    if (nectarUntil > t && b.nectar !== nectarUntil) { b.nextVisit = t; b.nectar = nectarUntil; }
    var target = plants.find(function (p) { return p.id === b.target; });
    if (!target) { b.target = null; b.perched = false; }
    if (b.perched && t < b.perchedUntil && target) {
      b.x = target.x; b.y = target.y - 0.025; return b;
    }
    if (b.perched) { b.perched = false; b.target = null; b.nextVisit = t + 5; target = null; }
    if (!target && plants.length && t >= b.nextVisit) {
      target = plants[(Math.floor(seed(b.id) * plants.length) + b.visit++) % plants.length];
      b.target = target.id;
    }
    var x = target ? target.x : 0.5 + Math.sin(t * 0.19 + b.phase) * 0.36;
    var y = target ? target.y - 0.025 : 0.31 + Math.sin(t * 0.31 + b.phase * 2) * 0.17;
    b.x += (x - b.x) * Math.min(1, dt * 1.1);
    b.y += (y - b.y) * Math.min(1, dt * 1.1);
    if (target && Math.hypot(x - b.x, y - b.y) < 0.008) {
      b.perched = true; b.perchedUntil = t + 3 + seed(b.id) * 3;
    }
    return b;
  }
  var api = { seed: seed, create: create, flowers: flowers, step: step };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GardenMotion = api;
})(typeof window === 'object' ? window : globalThis);
