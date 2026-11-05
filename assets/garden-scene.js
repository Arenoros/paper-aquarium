(function () {
  'use strict';
  var M = GardenMotion;

  // Capture textures fill their bounding box. Clip once, rather than every animation frame.
  function sprite(image, spec) {
    var canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    var ctx = canvas.getContext('2d'), bb = spec.bboxModel;
    ctx.beginPath();
    spec.contourModel.forEach(function (p, i) {
      var x = (p[0] - bb.z[0]) / (bb.z[1] - bb.z[0]) * canvas.width;
      var y = (bb.y[1] - p[1]) / (bb.y[1] - bb.y[0]) * canvas.height;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath(); ctx.clip();
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function sample(spec) {
    var canvas = document.createElement('canvas');
    canvas.width = 512;
    var bb = spec.bboxModel;
    canvas.height = Math.round(512 * (bb.y[1] - bb.y[0]) / (bb.z[1] - bb.z[0]));
    var ctx = canvas.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    if (spec.name === 'garden-flower') {
      g.addColorStop(0, '#ffd886'); g.addColorStop(1, '#ed9294');
    } else {
      g.addColorStop(0, '#8edecf'); g.addColorStop(0.5, '#75afda'); g.addColorStop(1, '#b093d8');
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff4b4';
    for (var i = 0; i < 8; i++) {
      ctx.beginPath(); ctx.arc(95 + i % 2 * 320, 70 + Math.floor(i / 2) * 115, 20, 0, Math.PI * 2); ctx.fill();
    }
    if (spec.name === 'garden-flower') {
      ctx.fillStyle = '#ffcb50'; ctx.beginPath(); ctx.arc(canvas.width / 2, canvas.height / 2, 72, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#5c4f60'; ctx.beginPath(); ctx.ellipse(canvas.width / 2, canvas.height * 0.53, 10, canvas.height * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    }
    return canvas.toDataURL('image/png');
  }

  function Scene(canvas, manifest) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.manifest = manifest;
    this.specs = Object.create(null); manifest.fish.forEach(function (f) { this.specs[f.name] = f; }, this);
    this.items = new Map(); this.weather = 'sun'; this.nectarUntil = 0; this.time = 0;
    this.frame = this.frame.bind(this); this.raf = 0; this.last = null;
  }
  Scene.prototype.sync = function (records, api) {
    var self = this, alive = new Set();
    records.forEach(function (r) {
      if (!self.specs[r.kind]) return;
      alive.add(r.id);
      if (self.items.has(r.id)) return;
      var item = { id: r.id, kind: r.kind, image: null, motion: M.create(r.id) };
      self.items.set(r.id, item);
      var image = new Image();
      image.onload = function () {
        if (self.items.get(r.id) === item) item.image = sprite(image, self.specs[r.kind]);
      };
      image.onerror = function () { if (self.items.get(r.id) === item) self.items.delete(r.id); };
      image.src = api + '/fish/' + encodeURIComponent(r.id) + '/texture.png';
    });
    this.items.forEach(function (_, id) { if (!alive.has(id)) self.items.delete(id); });
  };
  Scene.prototype.nectar = function () { this.nectarUntil = this.time + 10; };
  Scene.prototype.start = function () { if (!this.raf) { this.last = null; this.raf = requestAnimationFrame(this.frame); } };
  Scene.prototype.stop = function () { cancelAnimationFrame(this.raf); this.raf = 0; this.last = null; };
  Scene.prototype.frame = function (now) {
    this.raf = requestAnimationFrame(this.frame);
    var dt = this.last === null ? 0 : Math.min((now - this.last) / 1000, 0.05);
    this.last = now; this.time += dt;
    this.draw(dt);
  };
  Scene.prototype.draw = function (dt) {
    var c = this.canvas, ctx = this.ctx, w = c.clientWidth, h = c.clientHeight;
    var dpr = Math.min(devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var t = this.time, rain = this.weather === 'rain', unit = Math.min(w, h);
    var sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, rain ? '#86a6b4' : '#addde6'); sky.addColorStop(0.7, rain ? '#d1ded1' : '#fff4ce');
    sky.addColorStop(1, '#e4edc1'); ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    if (!rain) {
      var glow = ctx.createRadialGradient(w * 0.78, h * 0.18, 5, w * 0.78, h * 0.18, unit * 0.28);
      glow.addColorStop(0, '#fff5bf'); glow.addColorStop(1, 'rgba(255,244,188,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff6d2'; ctx.beginPath(); ctx.arc(w * 0.78, h * 0.18, unit * 0.048, 0, Math.PI * 2); ctx.fill();
    }
    for (var cloud = 0; cloud < 4; cloud++) {
      var cx = ((cloud * 0.29 + t * 0.002) % 1.4 - 0.2) * w, cy = h * (0.12 + cloud % 2 * 0.12);
      ctx.fillStyle = rain ? 'rgba(242,245,239,.55)' : 'rgba(255,255,245,.65)';
      ctx.beginPath(); ctx.ellipse(cx, cy, unit * 0.1, unit * 0.025, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx - unit * 0.025, cy - unit * 0.018, unit * 0.048, unit * 0.036, 0, 0, Math.PI * 2); ctx.fill();
    }
    ['#b6d39a', '#8dbb83', '#6c9e69'].forEach(function (color, i) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, h);
      ctx.lineTo(0, h * (0.67 + i * 0.09));
      ctx.bezierCurveTo(w * 0.28, h * (0.49 + i * 0.11), w * 0.62, h * (0.89 - i * 0.02), w, h * (0.62 + i * 0.1));
      ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    });
    var records = Array.from(this.items.values()), plants = M.flowers(records);
    var flowerSize = unit * Math.max(0.065, Math.min(0.145, 0.9 / Math.max(plants.length, 1)));
    plants.forEach(function (p) {
      var item = this.items.get(p.id), x = p.x * w, y = p.y * h;
      var sway = Math.sin(t * 1.1 + M.seed(p.id) * 6) * unit * 0.006;
      ctx.strokeStyle = '#487b4c'; ctx.lineWidth = Math.max(3, unit * 0.006); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, y + flowerSize * 1.15); ctx.quadraticCurveTo(x - sway, y + flowerSize * 0.5, x + sway, y); ctx.stroke();
      ctx.fillStyle = '#609b58';
      ctx.beginPath(); ctx.ellipse(x - flowerSize * 0.21, y + flowerSize * 0.65, flowerSize * 0.25, flowerSize * 0.09, 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + flowerSize * 0.2, y + flowerSize * 0.85, flowerSize * 0.25, flowerSize * 0.09, -0.55, 0, Math.PI * 2); ctx.fill();
      if (item.image) ctx.drawImage(item.image, x + sway - flowerSize / 2, y - flowerSize / 2, flowerSize, flowerSize);
    }, this);
    records.forEach(function (item) {
      if (item.kind !== 'garden-butterfly') return;
      var b = M.step(item.motion, dt, t, plants, this.nectarUntil);
      if (!item.image) return;
      var size = unit * 0.095, image = item.image, height = size * image.height / image.width;
      var flap = b.perched ? 0.8 + Math.sin(t * 2 + b.phase) * 0.12 : 0.35 + Math.abs(Math.sin(t * 10 + b.phase)) * 0.65;
      ctx.save(); ctx.translate(b.x * w, b.y * h); ctx.rotate(Math.sin(t * 0.7 + b.phase) * (b.perched ? 0.06 : 0.24));
      ctx.scale(flap, 1); ctx.drawImage(image, -size / 2, -height / 2, size, height); ctx.restore();
    }, this);
    if (this.nectarUntil > t) {
      ctx.fillStyle = 'rgba(255,225,125,.8)';
      for (var spark = 0; spark < 18; spark++) {
        ctx.beginPath(); ctx.arc((0.1 + M.seed('n' + spark) * 0.8) * w, (0.7 - (t * 0.07 + spark * 0.13) % 0.45) * h, 2 + spark % 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (rain) {
      ctx.strokeStyle = 'rgba(240,252,255,.65)'; ctx.lineWidth = 1.4; ctx.beginPath();
      for (var drop = 0; drop < 75; drop++) {
        var dx = M.seed('x' + drop) * w, dy = ((M.seed('y' + drop) + t * 0.6) % 1) * h;
        ctx.moveTo(dx, dy); ctx.lineTo(dx - 5, dy + 14);
      }
      ctx.stroke();
    }
  };
  window.GardenScene = Scene;
  window.GardenSprites = { sample: sample, sprite: sprite };
})();
