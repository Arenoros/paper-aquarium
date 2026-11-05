(function () {
  'use strict';
  if (!Tank.id) { location.replace('/'); return; }
  var $ = function (id) { return document.getElementById(id); };
  var query = new URLSearchParams(location.search), tv = query.has('tv');
  if (tv) document.body.classList.add('tv');
  I18N.mount($('lang'));
  var scene, manifest, records = [], feedAt, live, polling, messageTimer, previousFocus;

  function status(key) {
    $('status').textContent = I18N.t(key); $('status').hidden = false;
    clearTimeout(messageTimer); messageTimer = setTimeout(function () { $('status').hidden = true; }, 6000);
  }
  function json(response) {
    if (!response.ok) throw new Error(response.status === 409 ? 'garden.full' : 'garden.offline');
    return response.json();
  }
  function post(path, value) {
    return Tank.send(Tank.api + path, { method: 'POST', body: value ? JSON.stringify(value) : undefined }).then(json);
  }
  function run(button, action) {
    button.disabled = true;
    return Promise.resolve().then(action).catch(function (e) { status(e.message === 'garden.full' ? e.message : 'garden.offline'); })
      .finally(function () { button.disabled = false; });
  }
  function applyFish(list) {
    if (!Array.isArray(list)) return;
    records = list.filter(function (r) { return !!scene.specs[r.kind]; });
    scene.sync(records, Tank.api);
    $('welcome').hidden = records.length > 0;
    $('count').textContent = records.length ? I18N.t('garden.drawings', { n: records.length }) : I18N.t('garden.lead');
  }
  function applySettings(s) {
    if (s.world !== 'garden') { location.replace(Tank.url + location.search); return; }
    scene.weather = s.gardenWeather === 'rain' ? 'rain' : 'sun';
    $('sun').setAttribute('aria-pressed', scene.weather === 'sun' ? 'true' : 'false');
    $('rain').setAttribute('aria-pressed', scene.weather === 'rain' ? 'true' : 'false');
    if (s.feedAt !== undefined) {
      if (feedAt !== undefined && s.feedAt && feedAt !== s.feedAt) scene.nectar();
      feedAt = s.feedAt || 0;
    }
  }
  function refresh() {
    return Promise.all([
      fetch(Tank.api + '/fish').then(json).then(applyFish),
      fetch(Tank.api + '/settings').then(json).then(applySettings)
    ]).catch(function () { status('garden.offline'); });
  }
  function stopUpdates() {
    if (live) { live.close(); live = null; }
    clearInterval(polling); polling = null;
  }
  function startUpdates() {
    stopUpdates(); refresh();
    function fallback() {
      if (live) { live.close(); live = null; }
      if (!polling) polling = setInterval(refresh, 3000);
    }
    if (!window.EventSource || query.has('native')) return fallback();
    live = new EventSource(Tank.api + '/events');
    live.addEventListener('fish', function (e) { try { applyFish(JSON.parse(e.data)); } catch (err) { fallback(); } });
    live.addEventListener('settings', function (e) { try { applySettings(JSON.parse(e.data)); } catch (err) { fallback(); } });
    live.onerror = fallback;
  }

  function main() {
    $('menu-main').hidden = false; $('detail').hidden = true;
    $('frame').src = 'about:blank'; $('frame').hidden = true; $('sharing').hidden = true;
  }
  function openMenu() {
    previousFocus = document.activeElement;
    main(); $('menu').hidden = false; $('open-menu').setAttribute('aria-expanded', 'true'); $('close-menu').focus();
  }
  function closeMenu() {
    $('menu').hidden = true; main(); $('open-menu').setAttribute('aria-expanded', 'false');
    if (previousFocus && previousFocus.focus) previousFocus.focus();
  }
  function detail(url, title) {
    if ($('menu').hidden) openMenu();
    $('menu-main').hidden = true; $('detail').hidden = false;
    $('sharing').hidden = true; $('frame').hidden = false; $('frame').title = I18N.t(title); $('frame').src = url;
  }
  $('open-menu').onclick = openMenu; $('close-menu').onclick = closeMenu; $('back').onclick = main;
  $('menu').onclick = function (e) { if (e.target === $('menu')) closeMenu(); };
  $('garden').onclick = function () { if (!query.has('native')) openMenu(); };
  addEventListener('keydown', function (e) {
    if ($('menu').hidden) return;
    if (e.key === 'Escape') { closeMenu(); e.preventDefault(); }
    if (e.key === 'Tab') {
      var nodes = Array.from($('menu').querySelectorAll('button:not(:disabled),a,input,iframe')).filter(function (el) { return el.getClientRects().length; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  });
  $('capture').onclick = function () { detail(Tank.url + '/capture?world=garden&embed=1', 'garden.capture'); };
  function sheets() { detail('/print.html?world=garden&embed=1', 'garden.print'); }
  $('sheets').onclick = sheets; $('first-print').onclick = sheets;
  $('manage').onclick = function () { detail(Tank.url + '/admin?world=garden&only=fish&embed=1', 'garden.manage'); };
  $('aquarium').onclick = function () {
    var button = this;
    run(button, function () { return post('/settings', { world: 'aquarium' }).then(function () { location.replace(Tank.url + location.search); }); });
  };
  $('nectar').onclick = function () { run(this, function () { return post('/feed').then(function (s) { feedAt = s.feedAt; scene.nectar(); }); }); };
  ['sun', 'rain'].forEach(function (weather) {
    $(weather).onclick = function () { run(this, function () { return post('/settings', { gardenWeather: weather }).then(applySettings); }); };
  });
  $('sample').onclick = function () {
    run(this, function () {
      return manifest.fish.slice().reverse().reduce(function (promise, spec) {
        return promise.then(function () { return post('/fish', { kind: spec.name, texture: GardenSprites.sample(spec) }); });
      }, Promise.resolve()).finally(refresh);
    });
  };
  $('share').onclick = function () {
    $('menu-main').hidden = true; $('detail').hidden = false; $('frame').hidden = true; $('sharing').hidden = false;
    var link = location.origin + Tank.url;
    $('link').value = link;
    $('share-hint').textContent = I18N.t('garden.share.hint', { code: Tank.id });
    if (!$('qr').firstChild && window.qrcode) {
      var qr = qrcode(0, 'M'); qr.addData(link); qr.make(); $('qr').innerHTML = qr.createSvgTag(4, 0);
    }
  };
  $('link').onclick = function () { this.select(); };
  $('pin-button').onclick = function () {
    run(this, function () { return post('/pin').then(function (p) { $('pin').textContent = p.pin; }); });
  };
  addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== $('frame').contentWindow || !e.data) return;
    if (e.data.aqua === 'fish-added') refresh();
    if (e.data.aqua === 'height') $('frame').style.height = Math.max(240, Math.min(8000, Number(e.data.height) || 560)) + 'px';
  });
  addEventListener('aqua:lang', function () { if (scene) applyFish(records); });
  document.addEventListener('visibilitychange', function () {
    if (!scene) return;
    if (document.hidden) { stopUpdates(); scene.stop(); } else { startUpdates(); scene.start(); }
  });
  fetch('/assets/garden/manifest.json').then(json).then(function (m) {
    manifest = m; scene = new GardenScene($('garden'), manifest);
    window.gardenScene = scene;
    scene.start(); startUpdates();
    return fetch(Tank.api + '/meta').then(json);
  }).then(function (meta) {
    if (meta.local) { $('home').hidden = true; $('pin-button').hidden = true; }
  }).catch(function () { status('garden.offline'); });
})();
