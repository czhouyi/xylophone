/**
 * check.mjs — 站点自检（本地运行，不参与线上页面）
 *
 * 校验四件事：
 *   1. 每首曲谱 JSON 可解析、无 BOM/乱码、必需字段齐全、id 与文件名一致
 *   2. index.json 与实际曲谱文件双向一致
 *   3. HTML 里引用的本地资源都存在
 *   4. 起一个临时静态服务器，逐个 URL 探活（页面 / 样式 / 脚本 / 数据）
 *
 * 用法：node tools/check.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const scoresDir = path.join(docsDir, 'data', 'scores');

let failures = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => { failures += 1; console.log(`FAIL  ${msg}`); };

// ---------- 1. 曲谱数据 ----------

const scoreFiles = readdirSync(scoresDir)
  .filter((f) => f.endsWith('.json') && f !== 'index.json');

if (!scoreFiles.length) console.log('note  no score files found');

for (const file of scoreFiles) {
  const full = path.join(scoresDir, file);
  const buf = readFileSync(full);
  const text = buf.toString('utf8');

  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fail(`${file}: has UTF-8 BOM`);
  if (text.includes('\uFFFD')) fail(`${file}: contains U+FFFD (encoding damaged)`);

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`${file}: JSON parse error -> ${err.message}`);
    continue;
  }

  const problems = [];
  if (!data.id) problems.push('missing id');
  if (data.id !== path.basename(file, '.json')) problems.push('id != filename');
  if (!data.jianpu || typeof data.jianpu.score !== 'string') problems.push('missing jianpu.score');
  if (!data.jianpu || !data.jianpu.info || !data.jianpu.info.title) problems.push('missing jianpu.info.title');
  if (!data.abc || !data.abc.body) problems.push('missing abc.body');

  if (problems.length) fail(`${file}: ${problems.join(', ')}`);
  else {
    const cps = [...data.jianpu.info.title].map((c) => c.codePointAt(0).toString(16)).join(' ');
    ok(`${file}: fields ok (title=${cps}, ${data.jianpu.score.split('\n').length} score lines)`);

    // 歌词要与音符逐字对应（'-' 是占位），不齐会导致歌词错位
    const notes = String(data.jianpu.score).replace(/\s/g, '').split(/[|,]/).filter(Boolean);
    const lyric = [...String(data.jianpu.lyric || '').replace(/\s/g, '')];
    if (lyric.length !== notes.length) {
      console.log(`warn  ${file}: 歌词 ${lyric.length} 字 vs 音符 ${notes.length} 个，可能错位`);
    } else {
      ok(`${file}: 歌词与音符逐字对齐 (${notes.length})`);
    }
  }
}

// ---------- 2. index.json 一致性 ----------

const index = JSON.parse(readFileSync(path.join(scoresDir, 'index.json'), 'utf8'));
if (!Array.isArray(index.scores)) fail('index.json: missing scores array');

const indexed = new Set((index.scores || []).map((s) => s.id));
for (const s of index.scores || []) {
  if (!s.id) fail('index.json: entry without id');
  else if (!existsSync(path.join(scoresDir, `${s.id}.json`))) fail(`index.json: ${s.id} has no ${s.id}.json`);
  else ok(`index.json -> ${s.id}.json resolves`);
}
for (const file of scoreFiles) {
  const id = path.basename(file, '.json');
  if (!indexed.has(id)) fail(`${file}: not listed in index.json (run node tools/build-index.mjs)`);
}

// ---------- 3. HTML 本地引用 ----------

const htmlFiles = readdirSync(docsDir).filter((f) => f.endsWith('.html'));
for (const html of htmlFiles) {
  const source = readFileSync(path.join(docsDir, html), 'utf8');
  const refs = [...source.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(?:https?:)?\/\//.test(ref) || ref.startsWith('#')) continue;
    const target = path.join(docsDir, ref.split('?')[0]);
    if (existsSync(target)) ok(`${html} -> ${ref}`);
    else fail(`${html} -> ${ref} missing`);
  }
}

// ---------- 3b. JS 引用的 DOM id 必须存在于某个页面 ----------

const pageIds = new Map();
for (const html of htmlFiles) {
  const source = readFileSync(path.join(docsDir, html), 'utf8');
  pageIds.set(html, new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
}

const jsDir = path.join(docsDir, 'assets', 'js');
for (const file of readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
  const source = readFileSync(path.join(jsDir, file), 'utf8');
  for (const match of source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
    const id = match[1];
    const hosts = [...pageIds].filter(([, ids]) => ids.has(id)).map(([h]) => h);
    if (hosts.length) ok(`${file} -> #${id} present in ${hosts.join(', ')}`);
    else fail(`${file} -> #${id} not found in any page`);
  }
}

// ---------- 4. HTTP 连通性 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(docsDir, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(docsDir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const urls = [
  '/',
  '/index.html',
  '/score.html?id=little-star',
  '/assets/css/base.css',
  '/assets/css/list.css',
  '/assets/css/score.css',
  '/assets/js/data.js',
  '/assets/js/list.js',
  '/assets/js/player.js',
  '/assets/js/score.js',
  '/data/scores/index.json',
  '/data/scores/little-star.json',
  '/data/scores/does-not-exist.json',
];

for (const url of urls) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`);
  const body = await res.text();
  const expected404 = url.includes('does-not-exist');
  if (expected404 ? res.status === 404 : res.ok && body.length > 0) {
    ok(`GET ${url} -> ${res.status} ${res.headers.get('content-type') || ''}`.trim());
  } else {
    fail(`GET ${url} -> ${res.status} (unexpected)`);
  }
}

server.close();

console.log(failures ? `\n${failures} problem(s) found` : '\nall checks passed');
process.exit(failures ? 1 : 0);
