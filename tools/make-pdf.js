/* Генератор PDF с раскрасками.
 *
 *   node tools/make-pdf.js        (или npm run pdf)
 *
 * На выходе: assets/coloring/raskraski.<ru|en|pl>.pdf — все листы одним
 * файлом, по одному PDF на язык; raskraski-4.* и raskraski-6.* — то же
 * по 4 и 6 рыбок на странице (print.html?per=). Файлы статические и едут в git: генерить
 * их на проде не из чего — там нет Chrome.
 *
 * Печатает print.html?lang=xx&pdf=1 через headless Chrome (или Edge — он
 * есть на любой Windows и понимает те же флаги). Свой мини-сервер поднимаем
 * потому, что странице нужны абсолютные пути /assets/... — с file:// они
 * не работают, а тащить сюда весь server.js с его data/ незачем.
 *
 * Запускать после каждого make-coloring.js: листы поменялись — PDF отстал.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'coloring');
const LANGS = ['ru', 'en', 'pl'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function findChrome() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.CHROME,
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error('Не нашёл ни Chrome, ни Edge. Укажи путь в переменной CHROME.');
    process.exit(1);
  }
  return found;
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.normalize(path.join(ROOT, url === '/' ? '/print.html' : url));
      if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    // Порт 0 — свободный: генератор не должен спорить с запущенным server.js.
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async function main() {
  const chrome = findChrome();
  const server = await serve();
  const port = server.address().port;
  // Свой профиль во временной папке: без него headless не стартует,
  // пока открыт обычный Chrome с тем же профилем.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aqua-pdf-'));

  console.log('Браузер: ' + chrome);
  try {
    // Аквариум и сад: node tools/make-pdf.js [aquarium|garden] — только один мир.
    const worlds = [['aquarium', OUT, 'raskraski', ''], ['garden', path.join(ROOT, 'assets', 'garden'), 'sad', '&world=garden']]
      .filter(([w]) => !process.argv[2] || process.argv[2] === w);
    for (const [, dir, base, world, lang, per] of worlds.flatMap((w) => LANGS.flatMap((l) => ['1', '4', '6'].map((p) => [...w, l, p])))) {
      const suffix = per === '1' ? '' : '-' + per;
      const out = path.join(dir, base + suffix + '.' + lang + '.pdf');
      const url = 'http://127.0.0.1:' + port + '/print.html?lang=' + lang + '&pdf=1' + world + (suffix && '&per=' + per);
      // Chrome запускается асинхронно: страницу ему отдаёт наш же сервер,
      // и синхронный запуск запер бы event loop — Chrome ждёт страницу,
      // сервер ждёт Chrome.
      await new Promise((resolve, reject) => {
        execFile(chrome, [
          '--headless',
          '--disable-gpu',
          '--no-first-run',
          '--user-data-dir=' + profile,
          '--no-pdf-header-footer',
          // Виртуальное время: Chrome досиживает fetch манифеста и загрузку
          // всех картинок, а не печатает страницу в момент load.
          '--virtual-time-budget=30000',
          '--print-to-pdf=' + out,
          url
        ], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
      });
      console.log(path.relative(ROOT, out) + '  ' + Math.round(fs.statSync(out).size / 1024) + ' KB');
    }
  } finally {
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* занят — приберёт ОС */ }
  }
})();
