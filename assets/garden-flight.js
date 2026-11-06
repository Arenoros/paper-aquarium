/* Полёт бабочки в саду — без three.js, чтобы проверять в node.
 *
 * Бабочка машет сериями взмахов и планирует, на каждом взмахе подскакивает,
 * курс рваный. Летает к цветам: подлетает, держа крылья поднятыми, садится
 * на серединку и то складывает, то раскрывает крылья. Нектар зовёт всех к
 * цветам сразу; в дождь каждая прячется на своём цветке (без цветов —
 * улетает за край до солнца); тап вспугивает.
 *
 * Мир: y вверх, земля y=0. Цветок отдаёт «присест»: точку серединки p,
 * нормаль бутона n и направление «вверх по цветку» u.
 */
(function (root) {
  'use strict';

  var BOUNDS = { x: [-3.6, 3.6], y: [0.35, 2.2], z: [-3.2, 1.6] };
  var UP = { x: 0, y: 1, z: 0 };

  function seed(id) {
    var h = 2166136261;
    for (var i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
  }
  // Свой генератор у каждой бабочки: полёт воспроизводим (и проверяем).
  function rng(s) {
    var a = Math.floor(s * 4294967296) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var v3 = function (x, y, z) { return { x: x, y: y, z: z }; };
  var add = function (a, b, k) { return v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k); };
  var sub = function (a, b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); };
  var len = function (a) { return Math.hypot(a.x, a.y, a.z); };
  var norm = function (a) { var l = len(a) || 1; return v3(a.x / l, a.y / l, a.z / l); };
  var dot = function (a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; };
  var cross = function (a, b) { return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); };
  var lerp = function (a, b, k) { return a + (b - a) * k; };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  var DEFAULTS = { beatHz: 5, glide: 0.4, speed: 1, span: 0.5 };

  function create(id, kind) {
    var s = seed(id), r = rng(s), k = kind || {};
    var b = {
      id: id, s: s, rand: r,
      beatHz: k.beatHz || DEFAULTS.beatHz, glide: k.glide === undefined ? DEFAULTS.glide : k.glide,
      speed: k.speed || DEFAULTS.speed, span: k.span || DEFAULTS.span,
      p: v3(lerp(-3, 3, r()), lerp(0.8, 2, r()), lerp(-2, 1, r())),
      v: v3(r() - 0.5, 0, r() - 0.5),
      f: v3(0, 0, 1), up: v3(0, 1, 0), roll: 0,
      phase: r() * Math.PI * 2, beats: 4, glideUntil: 0, burst: 0,
      wing: 0.4, mode: 'fly', target: null, slot: v3(0, 0, 0),
      aim: null, aimUntil: 0, nextVisit: 1.5 + r() * 4,
      perchedUntil: 0, baskUntil: 0, fleeUntil: 0, nectar: 0,
      visible: true, x: 0, y: 0, z: 0
    };
    b.x = b.p.x; b.y = b.p.y; b.z = b.p.z;
    return b;
  }

  function wanderPoint(b, bounds) {
    var r = b.rand;
    return v3(lerp(bounds.x[0], bounds.x[1], r()), lerp(bounds.y[0] + 0.2, bounds.y[1] - 0.2, r()), lerp(bounds.z[0], bounds.z[1], r()));
  }

  // Свой цветок по id, но если там уже сидят — ближайший по кругу свободнее.
  function choosePerch(b, perches, shift, others) {
    if (!perches.length) return null;
    var start = Math.floor(b.s * perches.length) + (shift || 0), best = null, bestBusy = Infinity;
    for (var i = 0; i < perches.length; i++) {
      var p = perches[(start + i) % perches.length], busy = 0;
      (others || []).forEach(function (o) { if (o !== b && o.target === p.id) busy++; });
      if (busy < bestBusy) { best = p; bestBusy = busy; }
    }
    return best;
  }

  function takeOff(b, perch, t) {
    b.mode = 'fly'; b.target = null; b.burst = 6; b.beats = 6;
    var n = perch ? perch.n : UP;
    b.v = add(add(v3(0, 0, 0), n, 0.8), UP, 0.7);
    b.nextVisit = t + 6 + b.rand() * 9;
    b.aim = null;
  }

  // Тап по бабочке: вспархивает и улетает прочь от того, кто тапнул.
  function scare(b, t, from) {
    if (!b.visible) return;
    if (b.mode === 'perch') takeOff(b, null, t);
    b.shelter = false;
    var away = norm(add(sub(b.p, from || v3(0, 2, 7)), UP, 1.2));
    b.mode = 'flee'; b.fleeUntil = t + 1.6; b.burst = 8; b.beats = 8;
    b.aim = add(b.p, away, 2.5);
    b.nextVisit = Math.max(b.nextVisit, t + 5);
  }

  // ctx: { perches, rain (0..1), nectarUntil, others, bounds, camera }
  function step(b, dt, t, ctx) {
    dt = clamp(dt, 0, 0.05);
    var perches = ctx.perches || [], bounds = ctx.bounds || BOUNDS, rainy = (ctx.rain || 0) > 0.5;
    var r = b.rand;
    var perch = null;
    if (b.target) for (var i = 0; i < perches.length; i++) if (perches[i].id === b.target) perch = perches[i];
    if (b.target && !perch && (b.mode === 'visit' || b.mode === 'perch')) {
      b.mode = 'fly'; b.target = null; b.aim = null; b.shelter = false;
    }

    // ── погода и нектар ──
    // улетевшая за край вернётся прятаться, как только появится цветок
    if (rainy && !b.shelter && b.mode !== 'away' && !(b.mode === 'leave' && !perches.length)) {
      if (b.mode === 'perch') b.shelter = true;
      else {
        perch = choosePerch(b, perches, 0, ctx.others);
        if (perch) { b.mode = 'visit'; b.target = perch.id; b.slot = slotOf(b, perch); b.shelter = true; }
        else { b.mode = 'leave'; b.aim = v3(b.p.x < 0 ? -7 : 7, 1.6, b.p.z); }
      }
    }
    if (!rainy && b.mode === 'leave') { b.mode = 'fly'; b.aim = null; }
    if (!rainy && b.shelter) {
      b.shelter = false;
      if (b.mode === 'perch') b.perchedUntil = t + 1 + r() * 4;
    }
    if (b.mode === 'away') {
      if (rainy && !perches.length) return hide(b);
      b.mode = 'fly'; b.visible = true;
      b.p = v3(r() < 0.5 ? -6.5 : 6.5, 1.4 + r(), lerp(-2, 1, r()));
      b.v = v3(-Math.sign(b.p.x) * b.speed, 0, 0);
      b.aim = null;
    }
    if (ctx.nectarUntil > t && b.nectar !== ctx.nectarUntil && perches.length) {
      b.nectar = ctx.nectarUntil;
      if (b.mode === 'fly' || b.mode === 'flee') {
        perch = choosePerch(b, perches, Math.floor(r() * perches.length), ctx.others);
        b.mode = 'visit'; b.target = perch.id; b.slot = slotOf(b, perch);
      }
    }
    if (b.mode === 'fly' && perches.length && t >= b.nextVisit) {
      perch = choosePerch(b, perches, Math.floor(r() * perches.length), ctx.others);
      b.mode = 'visit'; b.target = perch.id; b.slot = slotOf(b, perch);
    }
    if (b.mode === 'flee' && t > b.fleeUntil) { b.mode = 'fly'; b.aim = null; }

    // ── сидит на цветке ──
    if (b.mode === 'perch') {
      var seat = add(add(perch.p, perch.n, 0.035), b.slot, 1);
      b.p = seat; b.v = v3(0, 0, 0);
      b.f = norm(sub(perch.u, add(v3(0, 0, 0), perch.n, dot(perch.u, perch.n))));
      b.pf = b.f; b.pu = perch.n; b.roll = 0;
      var closed = b.shelter ? 1.42 : null;
      if (closed === null) {
        if (t > b.baskUntil && r() < dt * 0.12) b.baskUntil = t + 1.5 + r() * 2.5;
        closed = t < b.baskUntil ? 0.06 : 0.75 + 0.55 * Math.sin(t * 0.9 + b.s * 20);
      }
      b.wing = lerp(b.wing, closed, Math.min(1, dt * 3));
      if (!b.shelter && t > b.perchedUntil) takeOff(b, perch, t);
      b.visible = true; b.x = b.p.x; b.y = b.p.y; b.z = b.p.z;
      return b;
    }

    // ── куда лететь ──
    var aim, arrive = 1, erratic = 1, landing = false;
    if (b.mode === 'visit' && perch) {
      var seatP = add(add(perch.p, perch.n, 0.04), b.slot, 1);
      var approach = add(add(seatP, perch.n, 0.5), UP, 0.08);
      var dSeat = len(sub(seatP, b.p));
      if (dSeat < 0.6 || len(sub(approach, b.p)) < 0.25) {
        aim = seatP; landing = true; erratic = clamp(dSeat * 1.5, 0, 0.6);
        arrive = clamp(dSeat * 1.6, 0.25, 1);
        // цветок качается: садимся, когда серединка рядом, а не точно в точке
        if (dSeat < 0.06) {
          b.mode = 'perch'; b.perchedUntil = t + 4 + r() * 5; b.baskUntil = 0;
          return step(b, 0, t, ctx);
        }
      } else aim = approach;
    } else if (b.mode === 'leave') {
      aim = b.aim;
      if (Math.abs(b.p.x) > 6.4) { b.mode = 'away'; return hide(b); }
    } else if (b.mode === 'flee') {
      aim = b.aim;
    } else if (b.mode === 'spiral') {
      var k = t - b.spiral.t0;
      if (k > b.spiral.dur) { b.mode = 'fly'; b.aim = null; aim = wanderPoint(b, bounds); }
      else {
        var c = add(b.spiral.c, UP, k * 0.35), a = k * 3.6 + b.spiral.a;
        aim = v3(c.x + Math.cos(a) * 0.28, c.y, c.z + Math.sin(a) * 0.28);
        erratic = 0.2;
      }
    } else {
      if (!b.aim || t > b.aimUntil || len(sub(b.aim, b.p)) < 0.4) { b.aim = wanderPoint(b, bounds); b.aimUntil = t + 2 + r() * 3; }
      aim = b.aim;
    }

    var dir = norm(sub(aim, b.p));
    // Рваный курс: направление качает сумма синусов со своей фазой.
    var yaw = erratic * (0.55 * Math.sin(t * 1.7 + b.s * 31) + 0.35 * Math.sin(t * 3.1 + b.s * 17));
    var pitch = erratic * 0.35 * Math.sin(t * 2.3 + b.s * 13);
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    dir = v3(dir.x * cy - dir.z * sy, dir.y + pitch, dir.x * sy + dir.z * cy);
    var want = add(v3(0, 0, 0), norm(dir), b.speed * arrive * (b.mode === 'flee' ? 1.9 : 1));

    // мягкие стенки, земля и соседи
    if (!landing && b.mode !== 'leave') {
      if (b.p.x < bounds.x[0]) want.x += (bounds.x[0] - b.p.x) * 2;
      if (b.p.x > bounds.x[1]) want.x -= (b.p.x - bounds.x[1]) * 2;
      if (b.p.z < bounds.z[0]) want.z += (bounds.z[0] - b.p.z) * 2;
      if (b.p.z > bounds.z[1]) want.z -= (b.p.z - bounds.z[1]) * 2;
      if (b.p.y > bounds.y[1]) want.y -= (b.p.y - bounds.y[1]) * 2;
    }
    if (b.p.y < 0.25 && !landing) want.y += (0.25 - b.p.y) * 4;
    (ctx.others || []).forEach(function (o) {
      if (o === b || landing || !o.visible || o.mode === 'perch') return;
      var d = sub(b.p, o.p), l = len(d), room = (b.span + o.span) * 0.6;
      if (l < room && l > 1e-4 && b.mode !== 'spiral') want = add(want, d, (room - l) * 4 / l);
    });

    // ── крылья: серии взмахов и планирование ──
    var gliding = t < b.glideUntil;
    if (landing) {
      b.phase += Math.PI * 2 * b.beatHz * 1.3 * dt;
      b.wing = lerp(b.wing, 1.0 + 0.32 * Math.cos(b.phase), Math.min(1, dt * 12));
    } else if (gliding) {
      b.wing = lerp(b.wing, 0.12, Math.min(1, dt * 6));
      want.y -= 0.35;
    } else {
      var before = b.phase;
      b.phase += Math.PI * 2 * b.beatHz * (b.burst > 0 ? 1.5 : 1) * dt;
      if (Math.floor(b.phase / (Math.PI * 2)) > Math.floor(before / (Math.PI * 2))) {
        b.beats--; if (b.burst > 0) b.burst--;
        var climbing = aim.y > b.p.y + 0.3;
        if (b.beats <= 0 && !climbing && b.mode === 'fly' && b.glide > 0) {
          b.glideUntil = t + (0.3 + r() * 0.9) * b.glide * 2;
          b.beats = 3 + Math.floor(r() * 6);
        } else if (b.beats <= 0) b.beats = 3 + Math.floor(r() * 6);
      }
      b.wing = 0.45 + 0.85 * Math.cos(b.phase);
    }

    var agility = landing ? 4 : 2.4;
    b.v = add(b.v, sub(want, b.v), Math.min(1, dt * agility));
    b.p = add(b.p, b.v, dt);
    return pose(b, dt, gliding || landing ? 0 : 1);
  }

  function slotOf(b, perch) {
    // Несколько бабочек на одном цветке рассаживаются по кругу серединки.
    var a = b.s * Math.PI * 2 * 7, rad = (perch.r || 0.2) * 0.35 * ((b.s * 13) % 1);
    var t1 = norm(cross(perch.n, perch.u)), t2 = perch.u;
    return add(add(v3(0, 0, 0), t1, Math.cos(a) * rad), t2, Math.sin(a) * rad * 0.6);
  }

  function hide(b) { b.visible = false; b.v = v3(0, 0, 0); return b; }

  // Поза: вперёд по скорости, крен в повороте, корпус качается против крыльев,
  // на взмахе подскакивает.
  function pose(b, dt, beating) {
    b.visible = true;
    if (dt > 0 && len(b.v) > 0.05) {
      var nf = norm(b.v);
      var turn = cross(b.f, nf).y / dt;
      b.f = norm(add(b.f, sub(nf, b.f), Math.min(1, dt * 6)));
      b.roll = lerp(b.roll, clamp(-turn * 0.35, -0.7, 0.7), Math.min(1, dt * 4));
    }
    var side = cross(b.f, UP);
    var right = len(side) > 1e-3 ? norm(side) : v3(1, 0, 0);
    var up0 = cross(right, b.f);
    var up = add(add(v3(0, 0, 0), up0, Math.cos(b.roll)), right, Math.sin(b.roll));
    var osc = beating ? 0.2 * Math.sin(b.phase) : 0;
    b.pf = norm(add(add(v3(0, 0, 0), b.f, Math.cos(osc)), up, Math.sin(osc)));
    b.pu = norm(add(add(v3(0, 0, 0), up, Math.cos(osc)), b.f, -Math.sin(osc)));
    var bob = beating ? 0.035 * b.span * 3 * Math.sin(b.phase) : 0;
    b.x = b.p.x; b.y = b.p.y + bob; b.z = b.p.z;
    return b;
  }

  // Изредка две летающие рядом бабочки кружат парой спиралью вверх.
  function coordinate(list, t, random) {
    random = random || Math.random;
    if (random() > 0.004) return;
    var free = list.filter(function (b) { return b.visible && b.mode === 'fly'; });
    for (var i = 0; i < free.length; i++) for (var j = i + 1; j < free.length; j++) {
      var a = free[i], c = free[j];
      if (len(sub(a.p, c.p)) < 1.8) {
        var mid = add(a.p, sub(c.p, a.p), 0.5);
        mid.y = Math.min(mid.y, 1.4);
        var dur = 3.5 + random() * 2;
        a.mode = c.mode = 'spiral';
        a.spiral = { c: mid, t0: t, dur: dur, a: 0 };
        c.spiral = { c: mid, t0: t, dur: dur, a: Math.PI };
        return;
      }
    }
  }

  var api = { seed: seed, create: create, step: step, scare: scare, coordinate: coordinate, BOUNDS: BOUNDS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GardenFlight = api;
})(typeof window === 'object' ? window : globalThis);
