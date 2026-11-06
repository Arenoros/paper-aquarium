/* Сад в 3D (three.js r128).
 *
 * Детский рисунок здесь — бумажная поделка: бабочка — два плоских крыла на
 * шарнире вдоль тела (настоящие крылья тоже плоские), цветок — рисунок,
 * выгнутый по параметрам вида: бутон чашей, листья по жилке, стебель
 * трубкой; ниже нарисованного стебель достроен до земли. Поведение бабочек —
 * garden-flight.js, здесь только картинка, погода и тапы.
 *
 *   var world = new GardenWorld(canvas, manifest);
 *   world.sync(records, api); world.weather = 'rain'; world.nectar(); world.start();
 */
(function () {
  'use strict';
  var T = THREE, F = GardenFlight;
  var CAM = new T.Vector3(0, 1.75, 5.4), LOOK = new T.Vector3(0, 0.9, -0.6), FOV = 40;
  var TAU = Math.PI * 2;

  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var lerp = function (a, b, k) { return a + (b - a) * k; };
  var smoothstep = function (a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  var col = function (hex) { return new T.Color(hex).convertSRGBToLinear(); };
  var mix = function (a, b, k) { return a.clone().lerp(b, k); };

  function canvasTexture(w, h, draw) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new T.CanvasTexture(c); t.encoding = T.sRGBEncoding;
    return t;
  }
  function radialTexture(stops) {
    return canvasTexture(128, 128, function (ctx) {
      var g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
      ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    });
  }
  function cloudTexture() {
    return canvasTexture(256, 128, function (ctx) {
      [[70, 80, 46], [118, 62, 54], [170, 76, 44], [140, 92, 40], [96, 96, 38], [200, 92, 30]].forEach(function (p) {
        var g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], p[2]);
        g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(0.6, 'rgba(255,255,255,.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 128);
      });
    });
  }

  function kindType(spec) { return spec.type || (spec.name === 'garden-butterfly' ? 'butterfly' : 'flower'); }
  // Старые виды без 3D-параметров: только контур.
  function threeOf(spec) {
    if (spec.three) return spec.three;
    var bb = spec.bboxModel;
    if (kindType(spec) === 'butterfly') {
      return { span: 0.45, beatHz: 5.5, glide: 0.35, speed: 1, body: { head: [0, bb.y[1] * 0.75], thorax: [0, bb.y[1] * 0.45], tail: [0, bb.y[0] * 0.75], w: 0.03 } };
    }
    var r = (bb.z[1] - bb.z[0]) / 2, cy = (bb.y[0] + bb.y[1]) / 2;
    return { height: 0.9, size: 0.42, bloom: { c: [0, cy], r: r, cup: 0.22, curl: 0, wave: 0.03 }, stem: null, leaves: [], base: [0, bb.y[0] + r * 0.4] };
  }

  // ── геометрия по контуру ──────────────────────────────────────────────────
  function inside(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function segDist(x, y, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1;
    var t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l, 0, 1);
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
  }
  function edgeDist(poly, x, y) {
    var d = Infinity;
    for (var i = 0; i < poly.length; i++) d = Math.min(d, segDist(x, y, poly[i], poly[(i + 1) % poly.length]));
    return d;
  }
  function lineDist(line, x, y) {
    var d = Infinity;
    for (var i = 0; i + 1 < line.length; i++) d = Math.min(d, segDist(x, y, line[i], line[i + 1]));
    return d;
  }
  function clipHalf(pts, sign) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length], ia = a[0] * sign >= 0, ib = b[0] * sign >= 0;
      if (ia) out.push(a);
      if (ia !== ib) out.push([0, a[1] + (b[1] - a[1]) * (a[0] / (a[0] - b[0]))]);
    }
    return out;
  }
  // Треугольники по контуру; точки внутри — «дырки» из одной вершины, earcut
  // берёт их как опорные: поверхность можно гнуть.
  function sheetGeometry(contour, steiner, toPos, toUv) {
    var shape = contour.map(function (p) { return new T.Vector2(p[0], p[1]); });
    var holes = steiner.map(function (p) { return [new T.Vector2(p[0], p[1])]; });
    var faces = T.ShapeUtils.triangulateShape(shape, holes);
    var all = shape.concat.apply(shape, holes), pos = [], uv = [], idx = [];
    all.forEach(function (v) { var p = toPos(v.x, v.y), u = toUv(v.x, v.y); pos.push(p[0], p[1], p[2]); uv.push(u[0], u[1]); });
    faces.forEach(function (f) { idx.push(f[0], f[1], f[2]); });
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  function facingFix(g, axis) {
    // лицевая сторона — там, где рисунок; если earcut обошёл наоборот, разворачиваем
    var n = g.getAttribute('normal'), s = 0;
    for (var i = 0; i < n.count; i++) s += axis === 'y' ? n.getY(i) : n.getZ(i);
    if (s < 0) { var idx = g.index.array; for (var j = 0; j < idx.length; j += 3) { var t = idx[j]; idx[j] = idx[j + 1]; idx[j + 1] = t; } g.computeVertexNormals(); }
    return g;
  }

  function paperMaterial(map) {
    var m = new T.MeshLambertMaterial({ map: map, side: T.DoubleSide });
    // Изнанку ребёнок не раскрашивал: тот же рисунок, темнее и глуше.
    m.onBeforeCompile = function (sh) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(.3,.5,.2))), .35) * .62;');
    };
    return m;
  }

  function sampleColor(canvas, u0, v0, u1, v1) {
    var ctx = canvas.getContext('2d');
    var x = Math.floor(u0 * canvas.width), y = Math.floor((1 - v1) * canvas.height);
    var w = Math.max(1, Math.floor((u1 - u0) * canvas.width)), h = Math.max(1, Math.floor((v1 - v0) * canvas.height));
    var d = ctx.getImageData(x, y, w, h).data, r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return col('#3b3242');
    return new T.Color(r / n / 255, g / n / 255, b / n / 255).convertSRGBToLinear();
  }

  // ── бабочка ───────────────────────────────────────────────────────────────
  function buildButterfly(spec, tex, canvas) {
    var t3 = threeOf(spec), span = t3.span, bb = spec.bboxModel;
    var cw = bb.z[1] - bb.z[0], ch = bb.y[1] - bb.y[0];
    var uvOf = function (x, y) { return [(x - bb.z[0]) / cw, (y - bb.y[0]) / ch]; };
    var mat = paperMaterial(tex);
    var group = new T.Group();
    var wings = [1, -1].map(function (sign) {
      // правая половина рисунка видна справа, если смотреть сверху: локальный X = -x
      var g = facingFix(sheetGeometry(clipHalf(spec.contourModel, sign), [],
        function (x, y) { return [-x * span, 0, y * span]; }, uvOf), 'y');
      var pivot = new T.Group(), mesh = new T.Mesh(g, mat);
      pivot.add(mesh); group.add(pivot);
      return { pivot: pivot, mesh: mesh, sign: sign };
    });
    var b = t3.body, w = b.w * span;
    var bodyMat = new T.MeshLambertMaterial({ color: sampleColor(canvas, 0.485, (b.tail[1] - bb.y[0]) / ch, 0.515, (b.head[1] - bb.y[0]) / ch) });
    var sphere = new T.SphereGeometry(1, 12, 8);
    var part = function (z0, z1, rx, ry) {
      var m = new T.Mesh(sphere, bodyMat);
      m.position.set(0, ry * 0.4, ((z0 + z1) / 2) * span); m.scale.set(rx, ry, (Math.abs(z1 - z0) / 2) * span);
      group.add(m);
    };
    part(b.tail[1], b.thorax[1] - b.w, w * 0.62, w * 0.6);
    part(b.thorax[1] - b.w * 2.2, b.thorax[1] + b.w * 2.2, w * 0.95, w * 0.85);
    var head = new T.Mesh(sphere, bodyMat);
    head.position.set(0, w * 0.4, b.head[1] * span); head.scale.setScalar(w * 0.75); group.add(head);
    var antMat = new T.MeshLambertMaterial({ color: col('#241d29') });
    [1, -1].forEach(function (s) {
      var h = b.head[1] * span;
      var curve = new T.CatmullRomCurve3([new T.Vector3(s * w * 0.3, w * 0.6, h), new T.Vector3(s * 0.03 * span, 0.04 * span, h + 0.07 * span),
        new T.Vector3(s * 0.075 * span, 0.06 * span, h + 0.15 * span)]);
      group.add(new T.Mesh(new T.TubeGeometry(curve, 8, Math.max(0.0035, 0.004 * span), 4), antMat));
      var club = new T.Mesh(sphere, antMat); club.position.copy(curve.getPoint(1)); club.scale.setScalar(Math.max(0.007, 0.011 * span));
      group.add(club);
    });
    return { group: group, wings: wings, pick: wings.map(function (x) { return x.mesh; }), dispose: function () {
      wings.forEach(function (x) { x.mesh.geometry.dispose(); }); mat.dispose(); bodyMat.dispose(); antMat.dispose(); tex.dispose();
    } };
  }

  // ── цветок ────────────────────────────────────────────────────────────────
  function bend(t3) {
    var bl = t3.bloom;
    return function (x, y) {
      var z = 0, dx = x - bl.c[0], dy = y - bl.c[1], d = Math.hypot(dx, dy) / bl.r;
      var wb = 1 - smoothstep(1.0, 1.3, d);
      if (wb > 0) z += wb * bl.r * (bl.cup * d * d + (bl.curl || 0) * smoothstep(0.65, 1.05, d) + (bl.wave || 0) * Math.sin(5 * Math.atan2(dy, dx) + 0.7) * d);
      if (t3.stem) {
        var hw = t3.stem.w / 2, ds = lineDist(t3.stem.line, x, y);
        if (ds < hw) z += Math.sqrt(hw * hw - ds * ds) * (1 - wb);
      }
      (t3.leaves || []).forEach(function (L) {
        var lx = L.tip[0] - L.base[0], ly = L.tip[1] - L.base[1], len = Math.hypot(lx, ly);
        var t = ((x - L.base[0]) * lx + (y - L.base[1]) * ly) / (len * len);
        if (t < -0.02 || t > 1.05) return;
        var nx = -ly / len, ny = lx / len, q = (x - L.base[0]) * nx + (y - L.base[1]) * ny;
        q -= (L.bend || 0) * len * Math.sin(Math.PI * clamp(t, 0, 1));
        var h = (L.w / 2) * Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.72)) + 1e-4;
        var k = Math.abs(q) / h;
        if (k > 1.3) return;
        var wl = smoothstep(0, 0.15, t) * (1 - smoothstep(1.0, 1.3, k)) * (1 - wb);
        z += wl * ((L.fold || 0) * (q * q) / (L.w / 2) + (L.arc || 0) * len * t * t);
      });
      return z;
    };
  }

  function buildFlower(spec, tex, canvas) {
    var t3 = threeOf(spec), bb = spec.bboxModel, bl = t3.bloom;
    var cw = bb.z[1] - bb.z[0], ch = bb.y[1] - bb.y[0];
    var scale = (t3.size || 0.5) / (2 * bl.r), z = bend(t3), base = t3.base;
    var drawn = (bl.c[1] - base[1]) * scale;
    var extra = Math.max(0, t3.height - drawn);
    var step = cw / 34, steiner = [], contour = spec.contourModel;
    for (var x = bb.z[0] + step / 2; x < bb.z[1]; x += step) for (var y = bb.y[0] + step / 2; y < bb.y[1]; y += step) {
      if (inside(contour, x, y) && edgeDist(contour, x, y) > step * 0.4) steiner.push([x, y]);
    }
    var g = facingFix(sheetGeometry(contour, steiner,
      function (x, y) { return [(x - base[0]) * scale, (y - base[1]) * scale + extra, z(x, y) * scale]; },
      function (x, y) { return [(x - bb.z[0]) / cw, (y - bb.y[0]) / ch]; }), 'z');
    var mat = paperMaterial(tex);
    var plant = new T.Group(), mesh = new T.Mesh(g, mat);
    plant.add(mesh);
    var stemMat = null, pick = [mesh];
    if (extra > 0.01) {
      var w = ((t3.stem ? t3.stem.w : 0.03) / 2) * scale;
      var su = (base[0] - bb.z[0]) / cw, sv = (base[1] - bb.y[0]) / ch;
      stemMat = new T.MeshLambertMaterial({ color: sampleColor(canvas, su - 0.008, sv + 0.01, su + 0.008, sv + 0.06) });
      var stem = new T.Mesh(new T.CylinderGeometry(w * 0.9, w * 1.15, extra + 0.02, 8, 1, true), stemMat);
      stem.position.set(0, extra / 2, 0);
      plant.add(stem); pick.push(stem);
    }
    var perch = new T.Vector3((bl.c[0] - base[0]) * scale, drawn + extra, z(bl.c[0], bl.c[1]) * scale);
    var rim = function (a) {
      return new T.Vector3((bl.c[0] - base[0] + Math.cos(a) * bl.r * 0.9) * scale, drawn + extra + Math.sin(a) * bl.r * 0.9 * scale,
        z(bl.c[0] + Math.cos(a) * bl.r * 0.9, bl.c[1] + Math.sin(a) * bl.r * 0.9) * scale);
    };
    return { group: plant, mesh: mesh, pick: pick, perch: perch, rim: rim, r: bl.r * scale, width: cw * scale, height: drawn + extra, dispose: function () {
      g.dispose(); mat.dispose(); tex.dispose(); if (stemMat) stemMat.dispose();
    } };
  }

  // ── окружение ─────────────────────────────────────────────────────────────
  var SUN = { top: col('#6fbbe8'), horizon: col('#fcf1d6'), fog: col('#eef3dc'), light: 1.0, hemi: 0.8, ground: col('#ffffff') };
  var RAIN = { top: col('#6f808e'), horizon: col('#c3cccc'), fog: col('#b9c3c3'), light: 0.28, hemi: 0.62, ground: col('#c4cdd0') };

  function skyDome() {
    var mat = new T.ShaderMaterial({
      uniforms: { top: { value: new T.Color() }, horizon: { value: new T.Color() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: 'uniform vec3 top, horizon; varying vec3 vDir;\n' +
        'vec3 enc(vec3 c){ return pow(c, vec3(1./2.2)); }\n' +
        'void main(){ float h = clamp(vDir.y * 1.7, 0., 1.); gl_FragColor = vec4(enc(mix(horizon, top, pow(h, .75))), 1.); }',
      side: T.BackSide, depthWrite: false, fog: false
    });
    var m = new T.Mesh(new T.SphereGeometry(150, 32, 16), mat);
    m.renderOrder = -2;
    return m;
  }

  function hills(scene) {
    var mats = [];
    [['#97c37a', -15, 1.6, 0], ['#acd08f', -26, 3.2, 1.7], ['#c3dcae', -40, 5.5, 3.1]].forEach(function (h, i) {
      var pts = [], idx = [], N = 90;
      for (var k = 0; k <= N; k++) {
        var x = -95 + (190 * k) / N;
        var y = h[2] * (0.55 + 0.25 * Math.sin(x * 0.07 + h[3]) + 0.2 * Math.sin(x * 0.19 + h[3] * 2));
        pts.push(x, y, h[1], x, -0.5, h[1] + 2);
        if (k) { var a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pts, 3)); g.setIndex(idx); g.computeVertexNormals();
      var m = new T.MeshLambertMaterial({ color: col(h[0]) });
      mats.push(m); scene.add(new T.Mesh(g, m));
      void i;
    });
    return mats;
  }

  function ground() {
    var g = new T.PlaneGeometry(140, 90, 70, 45);
    g.rotateX(-Math.PI / 2);
    var p = g.getAttribute('position'), colors = [], a = col('#7fb365'), b = col('#a3cb80'), c = new T.Color();
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), z = p.getZ(i);
      var n = 0.5 + 0.3 * Math.sin(x * 0.9 + z * 0.4) + 0.2 * Math.sin(x * 0.23 - z * 0.71);
      c.copy(a).lerp(b, clamp(n, 0, 1)); colors.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
    var m = new T.MeshLambertMaterial({ vertexColors: true });
    return new T.Mesh(g, m);
  }

  function grass(count) {
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute([-0.011, 0, 0, 0.011, 0, 0, 0, 1, 0], 3));
    g.setAttribute('normal', new T.Float32BufferAttribute([0, 0.4, 1, 0, 0.4, 1, 0, 0.6, 0.8], 3));
    var m = new T.MeshLambertMaterial({ side: T.DoubleSide });
    var uniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
    m.onBeforeCompile = function (sh) {
      sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uWind = uniforms.uWind;
      sh.vertexShader = 'uniform float uTime; uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed.x += sin(uTime * 1.7 + instanceMatrix[3].x * 1.3 + instanceMatrix[3].z * 0.8) * 0.09 * position.y * uWind;');
    };
    var mesh = new T.InstancedMesh(g, m, count), o = new T.Object3D(), c = new T.Color();
    for (var i = 0; i < count; i++) {
      var z = lerp(-5, 2.6, Math.pow(Math.random(), 0.8));
      o.position.set((Math.random() - 0.5) * (10 + (2.6 - z) * 1.6), 0, z);
      o.rotation.set(0, Math.random() * TAU, (Math.random() - 0.5) * 0.4);
      o.scale.set(1, 0.07 + Math.random() * 0.13, 1);
      o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, c.copy(col('#7fb862')).lerp(col('#c2e29a'), Math.random()));
    }
    mesh.userData.uniforms = uniforms;
    return mesh;
  }

  function meadow(count) {
    var mesh = new T.InstancedMesh(new T.CircleGeometry(0.06, 6), new T.MeshLambertMaterial(), count);
    var o = new T.Object3D(), palette = ['#ffffff', '#ffd8e6', '#ffe58a', '#d8c8ff', '#ffb7a0'].map(col);
    for (var i = 0; i < count; i++) {
      var z = lerp(-14, -5, Math.random());
      o.position.set((Math.random() - 0.5) * (18 + (-z) * 1.8), 0.08 + Math.random() * 0.14, z);
      o.rotation.set(-0.3, 0, 0); o.scale.setScalar(0.7 + Math.random() * 0.8);
      o.updateMatrix(); mesh.setMatrixAt(i, o.matrix); mesh.setColorAt(i, palette[i % palette.length]);
    }
    return mesh;
  }

  // ── дождь: косые капли в трёх слоях, брызги, капли с лепестков, радуга ────
  function Rain(scene, camera) {
    this.layers = [
      { n: 240, z: [2.6, 5.6], len: 0.5, speed: 11.5, op: 0.6 },
      { n: 360, z: [-2.6, 2.6], len: 0.32, speed: 9.5, op: 0.45 },
      { n: 480, z: [-16, -2.6], len: 0.6, speed: 9, op: 0.28 }
    ].map(function (L) {
      var g = new T.BufferGeometry(), pos = new Float32Array(L.n * 6);
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      var m = new T.LineBasicMaterial({ color: col('#eef7ff'), transparent: true, opacity: 0, depthWrite: false });
      var lines = new T.LineSegments(g, m); lines.frustumCulled = false; scene.add(lines);
      L.drops = []; for (var i = 0; i < L.n; i++) L.drops.push({ x: 0, y: Math.random() * 8, z: 0, s: L.speed * (0.85 + Math.random() * 0.3) });
      L.g = g; L.pos = pos; L.m = m; L.lines = lines;
      return L;
    });
    this.camera = camera; this.wind = -1.6;
    var ring = new T.RingGeometry(0.55, 1, 18); ring.rotateX(-Math.PI / 2);
    this.splashes = [];
    for (var s = 0; s < 70; s++) {
      var sm = new T.Mesh(ring, new T.MeshBasicMaterial({ color: col('#f2f8ff'), transparent: true, opacity: 0, depthWrite: false }));
      sm.visible = false; scene.add(sm); this.splashes.push({ m: sm, age: 9 });
    }
    var dg = new T.BufferGeometry(); this.dripPos = new Float32Array(60 * 6);
    dg.setAttribute('position', new T.BufferAttribute(this.dripPos, 3));
    this.dripMat = new T.LineBasicMaterial({ color: col('#f4faff'), transparent: true, opacity: 0, depthWrite: false });
    this.drip = new T.LineSegments(dg, this.dripMat); this.drip.frustumCulled = false; scene.add(this.drip);
    this.drips = []; for (var d = 0; d < 60; d++) this.drips.push({ x: 0, y: -1, z: 0, v: 0 });
    this.nextSplash = 0;
  }
  Rain.prototype.spawnX = function (z) {
    var dist = CAM.z - z, half = dist * Math.tan((FOV / 2) * Math.PI / 180) * (this.camera.aspect || 1.7) + 1.5;
    return (Math.random() * 2 - 1) * half;
  };
  Rain.prototype.update = function (dt, w, flowers) {
    var self = this, on = w > 0.01, splashBudget = Math.round(70 * dt * 6);
    this.layers.forEach(function (L, li) {
      L.lines.visible = on; L.m.opacity = L.op * w;
      if (!on) return;
      for (var i = 0; i < L.n; i++) {
        var d = L.drops[i];
        if (!d.z) { d.z = lerp(L.z[0], L.z[1], Math.random()); d.x = self.spawnX(d.z); }
        d.y -= d.s * dt; d.x += self.wind * dt;
        if (d.y < 0) {
          if (li < 2 && splashBudget > 0 && Math.random() < w) { self.splash(d.x, d.z); splashBudget--; }
          d.y = 6 + Math.random() * 2; d.z = lerp(L.z[0], L.z[1], Math.random()); d.x = self.spawnX(d.z);
        }
        var k = L.len / Math.hypot(self.wind, d.s), o = i * 6;
        L.pos[o] = d.x; L.pos[o + 1] = d.y; L.pos[o + 2] = d.z;
        L.pos[o + 3] = d.x - self.wind * k; L.pos[o + 4] = d.y + d.s * k; L.pos[o + 5] = d.z;
      }
      L.g.attributes.position.needsUpdate = true;
    });
    this.splashes.forEach(function (s) {
      if (s.age > 0.4) { s.m.visible = false; return; }
      s.age += dt; var k = s.age / 0.4;
      s.m.visible = true; s.m.scale.setScalar(0.02 + k * s.size); s.m.material.opacity = (1 - k) * 0.55 * w;
    });
    // капли стекают с лепестков
    this.drip.visible = on; this.dripMat.opacity = 0.8 * w;
    if (on && flowers.length && Math.random() < dt * 6 * w) {
      var free = this.drips.find(function (d) { return d.y < 0; }), f = flowers[Math.floor(Math.random() * flowers.length)];
      if (free && f.ready) {
        var p = f.view.rim(Math.PI * (1.15 + Math.random() * 0.7)); f.view.group.localToWorld(p);
        free.x = p.x; free.y = p.y; free.z = p.z; free.v = 0;
      }
    }
    this.drips.forEach(function (d, i) {
      var o = i * 6;
      if (d.y >= 0) { d.v += 9.8 * dt; d.y -= d.v * dt; if (d.y < 0 && on) self.splash(d.x, d.z, 0.06); }
      var y = d.y < 0 ? -10 : d.y;
      self.dripPos[o] = d.x; self.dripPos[o + 1] = y; self.dripPos[o + 2] = d.z;
      self.dripPos[o + 3] = d.x; self.dripPos[o + 4] = y + 0.025 + d.v * 0.012; self.dripPos[o + 5] = d.z;
    });
    this.drip.geometry.attributes.position.needsUpdate = true;
  };
  Rain.prototype.splash = function (x, z, size) {
    var s = this.splashes.find(function (q) { return q.age > 0.4; });
    if (!s) return;
    s.age = 0; s.size = size || 0.08 + Math.random() * 0.06; s.m.position.set(x, 0.015, z);
  };

  function rainbow() {
    var mat = new T.ShaderMaterial({
      uniforms: { opacity: { value: 0 } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: 'uniform float opacity; varying vec2 vP;\n' +
        'vec3 hue(float h){ return clamp(abs(mod(h * 6. + vec3(0., 4., 2.), 6.) - 3.) - 1., 0., 1.); }\n' +
        'void main(){ float t = (length(vP) - 24.) / 3.6; if (t < 0. || t > 1.) discard;\n' +
        '  vec3 c = mix(vec3(1.), hue((1. - t) * .78), .75);\n' +
        '  float a = opacity * sin(3.14159 * t) * .55 * smoothstep(-6., 6., vP.y);\n' +
        '  gl_FragColor = vec4(c, a); }',
      transparent: true, depthWrite: false, fog: false
    });
    var m = new T.Mesh(new T.RingGeometry(24, 27.6, 120, 1, 0, Math.PI), mat);
    m.position.set(-9, -13, -75); m.renderOrder = -1;
    return m;
  }

  // ── мир ───────────────────────────────────────────────────────────────────
  // opts.pixelRatio — плотность кадра; по умолчанию экранная, но не выше 1.5.
  function World(canvas, manifest, opts) {
    var self = this;
    this.canvas = canvas; this.manifest = manifest;
    this.specs = Object.create(null);
    manifest.fish.forEach(function (f) { self.specs[f.name] = f; });
    this.renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
    this.renderer.setPixelRatio((opts && opts.pixelRatio) || Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputEncoding = T.sRGBEncoding;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 400);
    this.scene.fog = new T.Fog(SUN.fog.clone(), 14, 70);
    this.hemi = new T.HemisphereLight(col('#e6f6ff'), col('#6d8f4c'), SUN.hemi);
    this.sun = new T.DirectionalLight(col('#fff0d2'), SUN.light);
    this.sun.position.set(5, 8, 5);
    this.scene.add(this.hemi, this.sun);
    this.sky = skyDome(); this.scene.add(this.sky);
    this.hillMats = hills(this.scene);
    this.ground = ground(); this.scene.add(this.ground);
    this.grass = grass(2600); this.scene.add(this.grass);
    this.scene.add(meadow(260));
    var glow = radialTexture([[0, 'rgba(255,250,225,1)'], [0.18, 'rgba(255,246,205,.95)'], [0.4, 'rgba(255,240,190,.35)'], [1, 'rgba(255,240,190,0)']]);
    this.sunSprite = new T.Sprite(new T.SpriteMaterial({ map: glow, transparent: true, depthWrite: false, fog: false }));
    this.sunSprite.position.set(30, 13, -95); this.sunSprite.scale.set(30, 30, 1); this.scene.add(this.sunSprite);
    var cloud = cloudTexture();
    this.clouds = [];
    for (var i = 0; i < 12; i++) {
      var storm = i >= 6;
      var s = new T.Sprite(new T.SpriteMaterial({ map: cloud, transparent: true, depthWrite: false, fog: false, opacity: storm ? 0 : 0.85 }));
      s.position.set(-80 + Math.random() * 160, storm ? 7 + Math.random() * 5 : 9 + Math.random() * 8, -70 - Math.random() * 20);
      var k = storm ? 1.0 + Math.random() * 0.5 : 0.45 + Math.random() * 0.45;
      s.scale.set(30 * k, 14 * k, 1); s.userData.storm = storm; s.userData.speed = 0.4 + Math.random() * 0.6;
      this.scene.add(s); this.clouds.push(s);
    }
    this.shadowTex = radialTexture([[0, 'rgba(20,40,20,.55)'], [1, 'rgba(20,40,20,0)']]);
    this.shadowGeo = new T.PlaneGeometry(1, 1); this.shadowGeo.rotateX(-Math.PI / 2);
    this.rain = new Rain(this.scene, this.camera);
    this.rainbow = rainbow(); this.scene.add(this.rainbow);
    this.items = new Map(); this.picks = [];
    this.time = 0; this.w = 0; this.target = 0; this.rainbowAt = -99; this.nectarUntil = 0;
    this.raf = 0; this.last = null; this.frame = this.frame.bind(this);
    this.raycaster = new T.Raycaster();
    canvas.addEventListener('pointerdown', function (e) { self.tap(e); });
    this.onTap = null;
    this.applyWeather(0);
  }

  Object.defineProperty(World.prototype, 'weather', {
    get: function () { return this.target > 0.5 ? 'rain' : 'sun'; },
    set: function (v) {
      var next = v === 'rain' ? 1 : 0;
      if (this.target === 1 && next === 0) this.rainbowAt = this.time;
      this.target = next;
    }
  });
  World.prototype.nectar = function () { this.nectarUntil = this.time + 10; };
  // Кадр для карточки на главной: центр нужных пропорций. Рисуем прямо перед
  // снятием — содержимое WebGL-канваса живёт только до конца кадра.
  World.prototype.snapshot = function (W, H) {
    this.update(0);
    this.renderer.render(this.scene, this.camera);
    var src = this.canvas, c = document.createElement('canvas');
    c.width = W; c.height = H;
    var k = Math.max(W / src.width, H / src.height), cw = Math.min(src.width, W / k), ch = Math.min(src.height, H / k);
    c.getContext('2d').drawImage(src, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.72);
  };
  World.prototype.start = function () { if (!this.raf) { this.last = null; this.raf = requestAnimationFrame(this.frame); } };
  World.prototype.stop = function () { cancelAnimationFrame(this.raf); this.raf = 0; this.last = null; };

  // records: [{id, kind, textureUrl?}]; текстура — со съёмки (api) или готовая.
  World.prototype.sync = function (records, api) {
    var self = this, alive = new Set();
    records.forEach(function (r) {
      var spec = self.specs[r.kind];
      if (!spec) return;
      alive.add(r.id);
      if (self.items.has(r.id)) return;
      var item = { id: r.id, kind: r.kind, spec: spec, type: kindType(spec), ready: false, born: self.time };
      self.items.set(r.id, item);
      var img = new Image();
      img.onload = function () {
        if (self.items.get(r.id) !== item) return;
        var c = document.createElement('canvas');
        c.width = img.naturalWidth || 1024; c.height = img.naturalHeight || 512;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var tex = new T.CanvasTexture(c); tex.encoding = T.sRGBEncoding;
        tex.anisotropy = Math.min(4, self.renderer.capabilities.getMaxAnisotropy());
        self.build(item, tex, c);
      };
      img.onerror = function () { if (self.items.get(r.id) === item) self.items.delete(r.id); };
      img.src = r.textureUrl || api + '/fish/' + encodeURIComponent(r.id) + '/texture.png';
    });
    this.items.forEach(function (item, id) { if (!alive.has(id)) self.remove(item); });
  };

  World.prototype.build = function (item, tex, canvas) {
    var self = this;
    if (item.type === 'butterfly') {
      item.view = buildButterfly(item.spec, tex, canvas);
      item.brain = F.create(item.id, threeOf(item.spec));
      item.view.group.position.set(item.brain.x, item.brain.y, item.brain.z);
    } else {
      item.view = buildFlower(item.spec, tex, canvas);
      var spot = this.place(item.id, item.view.width / 2);
      item.view.group.position.set(spot.x, 0, spot.z);
      item.yaw = Math.atan2(CAM.x - spot.x, CAM.z - spot.z) + (F.seed(item.id + 'y') - 0.5) * 0.5;
      item.sway = { a: 0, v: 0, b: 0, vb: 0 };
      item.perch = { id: item.id, p: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 0, z: 1 }, u: { x: 0, y: 1, z: 0 }, r: item.view.r };
      item.view.group.scale.setScalar(0.001);
    }
    item.view.pick.forEach(function (m) { m.userData.item = item; self.picks.push(m); });
    var shadow = new T.Mesh(this.shadowGeo, new T.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false }));
    shadow.renderOrder = 1; item.shadow = shadow;
    this.scene.add(item.view.group, shadow);
    item.ready = true; item.born = this.time;
  };

  World.prototype.remove = function (item) {
    this.items.delete(item.id);
    if (!item.ready) return;
    this.scene.remove(item.view.group, item.shadow);
    this.picks = this.picks.filter(function (m) { return m.userData.item !== item; });
    item.view.dispose(); item.shadow.material.dispose();
  };

  // Место цветка выводится из его id и не меняется. Три ряда в глубину;
  // перебираем кандидатов и берём первый, где растение не налезает на
  // соседей (по ширине рисунка), иначе — самый просторный.
  World.prototype.place = function (id, radius) {
    var taken = [];
    this.items.forEach(function (it) { if (it.spot) taken.push(it.spot); });
    var best = null, room = -Infinity;
    for (var k = 0; k < 24; k++) {
      var a = F.seed(id + ':' + k), b = F.seed(id + '#' + k);
      var row = Math.floor(b * 3), z = [-1.8, -0.4, 1.0][row] + (a - 0.5) * 0.5;
      var halfW = 2.1 + (1.0 - z) * 0.4;
      var spot = { x: (F.seed(id + 'x' + k) * 2 - 1) * halfW, z: z, r: radius };
      var clear = taken.reduce(function (m, s) {
        return Math.min(m, Math.hypot(s.x - spot.x, (s.z - spot.z) * 1.6) - (s.r + spot.r) * 0.7);
      }, Infinity);
      if (clear > 0) { best = spot; break; }
      if (clear > room) { room = clear; best = spot; }
    }
    this.items.get(id).spot = best;
    return best;
  };

  World.prototype.tap = function (e) {
    var r = this.canvas.getBoundingClientRect();
    var ndc = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    var hit = this.raycaster.intersectObjects(this.picks, false)[0];
    if (!hit) { if (this.onTap) this.onTap(null); return; }
    var item = hit.object.userData.item, t = this.time, cam = this.camera.position;
    if (item.type === 'butterfly') F.scare(item.brain, t, { x: cam.x, y: cam.y, z: cam.z });
    else {
      item.sway.v += 1.6 * (Math.random() < 0.5 ? -1 : 1); item.sway.vb -= 0.9;
      this.items.forEach(function (b) { if (b.brain && b.brain.target === item.id && b.brain.mode === 'perch') F.scare(b.brain, t, { x: cam.x, y: cam.y, z: cam.z }); });
    }
    if (this.onTap) this.onTap(item);
  };

  World.prototype.applyWeather = function (w) {
    var A = SUN, B = RAIN;
    this.sky.material.uniforms.top.value.copy(mix(A.top, B.top, w));
    this.sky.material.uniforms.horizon.value.copy(mix(A.horizon, B.horizon, w));
    this.scene.fog.color.copy(mix(A.fog, B.fog, w));
    this.scene.fog.near = lerp(14, 8, w); this.scene.fog.far = lerp(70, 42, w);
    this.sun.intensity = lerp(A.light, B.light, w);
    this.hemi.intensity = lerp(A.hemi, B.hemi, w);
    var g = mix(A.ground, B.ground, w);
    this.ground.material.color.copy(g);
    this.sunSprite.material.opacity = 1 - w;
    var grey = col('#9aa3a8'), white = col('#ffffff');
    this.clouds.forEach(function (c) {
      c.material.color.copy(mix(white, grey, w));
      c.material.opacity = c.userData.storm ? 0.95 * smoothstep(0.1, 0.9, w) : lerp(0.85, 0.95, w);
      c.visible = c.material.opacity > 0.01;   // прозрачное всё равно закрашивается — на ТВ это дорого
    });
    this.grass.userData.uniforms.uWind.value = 1 + w * 1.6;
  };

  World.prototype.frame = function (now) {
    this.raf = requestAnimationFrame(this.frame);
    var dt = this.last === null ? 0 : Math.min((now - this.last) / 1000, 0.05);
    this.last = now; this.time += dt;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  World.prototype.update = function (dt) {
    var c = this.canvas, w = c.clientWidth, h = c.clientHeight, t = this.time, self = this;
    if (w && h && (this.size !== w + 'x' + h)) {
      this.size = w + 'x' + h; this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }
    // плавная смена погоды за ~3 с
    this.w += clamp(this.target - this.w, -dt / 3, dt / 3);
    var rain = smoothstep(0, 1, this.w);
    this.applyWeather(rain);
    var bow = this.time - this.rainbowAt;
    this.rainbow.material.uniforms.opacity.value = smoothstep(0, 3, bow) * (1 - smoothstep(26, 30, bow)) * (1 - rain);
    this.rainbow.visible = this.rainbow.material.uniforms.opacity.value > 0.001;
    this.clouds.forEach(function (cl) { cl.position.x += cl.userData.speed * dt; if (cl.position.x > 95) cl.position.x = -95; });
    this.grass.userData.uniforms.uTime.value = t;
    this.camera.position.set(CAM.x + Math.sin(t * 0.045) * 0.4, CAM.y + Math.sin(t * 0.063) * 0.07, CAM.z);
    this.camera.lookAt(LOOK);

    var flowers = [], butterflies = [];
    this.items.forEach(function (it) { if (it.ready) (it.type === 'flower' ? flowers : butterflies).push(it); });

    // цветы: вырастают из земли, качаются, клонятся под дождём
    var perches = [], tmp = new T.Vector3();
    flowers.forEach(function (f) {
      var g = f.view.group, age = t - f.born, k = clamp(age / 2.2, 0, 1);
      var grow = k < 1 ? 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2) : 1;
      g.scale.setScalar(Math.max(0.001, grow));
      var s = f.sway;
      s.v += (-12 * s.a - 2.2 * s.v) * dt; s.a += s.v * dt;
      s.vb += (-14 * s.b - 2.6 * s.vb) * dt; s.b += s.vb * dt;
      var seed = F.seed(f.id) * 10;
      g.rotation.order = 'YXZ';
      g.rotation.y = f.yaw;
      g.rotation.z = Math.sin(t * 0.9 + seed) * (0.02 + rain * 0.05) + s.a * 0.12;
      g.rotation.x = -0.12 + rain * 0.14 + Math.sin(t * 0.7 + seed) * (0.012 + rain * 0.03) + s.b * 0.1;
      g.updateMatrixWorld();
      f.shadow.position.set(g.position.x, 0.012, g.position.z + 0.05);
      f.shadow.scale.setScalar(f.view.r * 2.2 * grow); f.shadow.material.opacity = 0.5 * (1 - rain * 0.6);
      if (k >= 1) {
        tmp.copy(f.view.perch); g.localToWorld(tmp);
        f.perch.p.x = tmp.x; f.perch.p.y = tmp.y; f.perch.p.z = tmp.z;
        tmp.set(0, 0, 1).transformDirection(g.matrixWorld); f.perch.n.x = tmp.x; f.perch.n.y = tmp.y; f.perch.n.z = tmp.z;
        tmp.set(0, 1, 0).transformDirection(g.matrixWorld); f.perch.u.x = tmp.x; f.perch.u.y = tmp.y; f.perch.u.z = tmp.z;
        perches.push(f.perch);
      }
    });

    // бабочки
    var brains = butterflies.map(function (b) { return b.brain; });
    F.coordinate(brains, t);
    var ctx = { perches: perches, rain: this.w, nectarUntil: this.nectarUntil, others: brains };
    var basis = new T.Matrix4(), X = new T.Vector3(), Y = new T.Vector3(), Z = new T.Vector3();
    butterflies.forEach(function (b) {
      var wasPerched = b.brain.mode === 'perch';
      F.step(b.brain, dt, t, ctx);
      var br = b.brain, g = b.view.group;
      if (!wasPerched && br.mode === 'perch') {
        var fl = self.items.get(br.target); if (fl && fl.sway) fl.sway.vb -= 0.5;
      }
      g.visible = br.visible; b.shadow.visible = br.visible;
      if (!br.visible) return;
      g.position.set(br.x, br.y, br.z);
      Z.set(br.pf.x, br.pf.y, br.pf.z); Y.set(br.pu.x, br.pu.y, br.pu.z); X.crossVectors(Y, Z).normalize(); Y.crossVectors(Z, X);
      basis.makeBasis(X, Y, Z); g.quaternion.setFromRotationMatrix(basis);
      var grow = clamp((t - b.born) / 0.6, 0, 1);
      g.scale.setScalar(Math.max(0.001, grow));
      b.view.wings.forEach(function (wg) { wg.pivot.rotation.z = wg.sign > 0 ? -br.wing : br.wing; });
      var hgt = Math.max(0, br.y);
      b.shadow.position.set(br.x, 0.014, br.z);
      b.shadow.scale.setScalar(br.span * (0.9 + hgt * 0.25));
      b.shadow.material.opacity = 0.42 * (1 - clamp(hgt / 3, 0, 0.85)) * (1 - rain * 0.7);
    });

    this.rain.update(dt, rain, flowers);
  };

  window.GardenWorld = World;
})();
