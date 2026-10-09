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

// 复用站点自己的解析器做校验，保证"校验的"就是"页面渲染的"
import {
  parseNotation, renderNotation, buildTimeline, paintProgress, resetProgress,
} from '../docs/assets/js/notation.js';
import { ScorePlayer } from '../docs/assets/js/player.js';

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
  if (typeof data.notation !== 'string' || !data.notation.trim()) problems.push('missing notation');
  if (!data.title) problems.push('missing title');
  if (!data.abc || !data.abc.body) problems.push('missing abc.body');

  if (problems.length) {
    fail(`${file}: ${problems.join(', ')}`);
    continue;
  }

  let parsed;
  try {
    parsed = parseNotation(data.notation);
  } catch (err) {
    fail(`${file}: notation 解析失败 -> ${err.message}`);
    continue;
  }
  if (!parsed.notes.length) {
    fail(`${file}: notation 里没有解析出音符`);
    continue;
  }
  if (!parsed.bpm) console.log(`warn  ${file}: notation 未标速度（回退到 abc.tempo）`);

  // 速度必须两边一致，否则播放进度高亮会和实际发声脱节
  if (parsed.bpm && data.abc.tempo && parsed.bpm !== data.abc.tempo) {
    fail(`${file}: notation bpm ${parsed.bpm} 与 abc.tempo ${data.abc.tempo} 不一致`);
  } else if (parsed.bpm && data.abc.tempo) {
    ok(`${file}: 速度一致 (bpm=${parsed.bpm})`);
  }

  // 每一行歌词的槽位数必须等于该行可唱音符数（休止符 0 不占歌词位）
  let mismatched = 0;
  for (const line of parsed.lines) {
    if (!line.lyric.length) continue;
    const singable = line.items.filter((it) => it.kind === 'note' && it.pitch !== '0').length;
    if (line.lyric.length !== singable) mismatched += 1;
  }
  if (mismatched) fail(`${file}: ${mismatched} 行歌词与音符数不匹配`);
  else ok(`${file}: 歌词与音符逐行对齐`);

  ok(`${file}: ${parsed.notes.length} 个音符 / ${parsed.lines.length} 行 / key=${parsed.key || '-'}`);
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

// ---------- 3c. 音色切换：GM program 编号解析 ----------
// 钢琴编号是 0（falsy），历史 bug 就出在用 || 回退，导致"选钢琴没反应"。

const player = new ScorePlayer({ buildAbc: () => '' });
for (const [input, expected, why] of [
  ['0', 0, '钢琴编号 0 不能被当成 falsy 吞掉'],
  ['12', 12, '马林巴'],
  ['13', 13, '木琴'],
  ['abc', 13, '非法输入回退到默认木琴'],
  ['999', 13, '越界回退到默认木琴'],
]) {
  player.setProgram(input);
  if (player.program === expected) ok(`音色 program ${input} -> ${player.program}（${why}）`);
  else fail(`音色 program ${input} -> ${player.program}，期望 ${expected}（${why}）`);
}

// 下拉选项的 value 必须是合法的 GM 编号，且默认项与 player.js 的默认音色一致
const scoreHtml = readFileSync(path.join(docsDir, 'score.html'), 'utf8');
const options = [...scoreHtml.matchAll(/<option value="(\d+)"(\s+selected)?>/g)]
  .map((m) => ({ value: Number(m[1]), selected: !!m[2] }));
if (!options.length) fail('score.html: 音色下拉没有选项');
else {
  const bad = options.filter((o) => !Number.isInteger(o.value) || o.value < 0 || o.value > 127);
  if (bad.length) fail(`score.html: 音色选项编号非法（${bad.map((o) => o.value).join(',')}）`);
  else ok(`score.html: ${options.length} 个音色选项编号都是合法 GM 值`);

  const def = options.find((o) => o.selected) || options[0];
  const fresh = new ScorePlayer({ buildAbc: () => '' });
  if (def.value === fresh.program) ok(`score.html: 默认音色 ${def.value} 与 player.js 默认一致`);
  else fail(`score.html: 默认音色 ${def.value} 与 player.js 默认 ${fresh.program} 不一致`);
}

// ---------- 3c-2. 播放状态机：暂停后应从暂停处继续 ----------
// 用假时钟直接驱动 player.js，不碰真实音频。

{
  const p = new ScorePlayer({ buildAbc: () => '' });
  let clock = 0;
  p.audioContext = { state: 'running', resume: async () => {}, get currentTime() { return clock; } };
  p.synth = { start() {}, stop() {}, pause() {}, resume() {} };
  p.primed = true;

  await p.play();
  clock = 3;
  if (Math.abs(p.currentTime() - 3) < 1e-9) ok('播放：位置跟随时钟');
  else fail(`播放：位置 ${p.currentTime()}，期望 3`);

  p.pause();
  clock = 10; // 暂停期间时钟照常走
  if (Math.abs(p.currentTime() - 3) < 1e-9) ok('暂停：位置冻结在 3s');
  else fail(`暂停：位置 ${p.currentTime()}，期望冻结在 3`);

  await p.play(); // 继续
  clock = 11;
  if (Math.abs(p.currentTime() - 4) < 1e-9) ok('暂停后继续：从 3s 处接着放（不是从头）');
  else fail(`暂停后继续：位置 ${p.currentTime()}，期望 4（从 3s 接着放）`);

  p.stop();
  if (p.currentTime() === 0 && p.state === 'idle') ok('停止：位置归零且回到 idle');
  else fail(`停止：位置 ${p.currentTime()}，state=${p.state}`);
}

// 播放到底：状态要收尾，不能一直停在“正在播放…”
{
  let status = '';
  const q = new ScorePlayer({ buildAbc: () => '', onStatus: (m) => { status = m; } });
  let clock = 0;
  q.audioContext = { state: 'running', resume: async () => {}, get currentTime() { return clock; } };
  q.synth = { start() {}, stop() {}, pause() {}, resume() {} };
  q.primed = true;
  q.duration = 5;

  await q.play();
  clock = 2;
  if (q.progressTime() === 2) ok('进度：播放中返回当前秒数');
  else fail(`进度：返回 ${q.progressTime()}，期望 2`);

  clock = 5.5; // 越过总时长
  const ended = q.progressTime();
  if (ended === null && q.state === 'idle' && status === '播放完毕') {
    ok('播放到底：状态回到 idle 且提示「播放完毕」');
  } else {
    fail(`播放到底：progressTime=${ended}，state=${q.state}，status=${status}`);
  }
}

// ---------- 3d. 渲染结构 + 播放进度三态（纯 Node 驱动真实代码） ----------
// notation.js 只用到极少的 DOM API，给它一个最小桩就能在 Node 里跑完整渲染，
// 这样这些不变量不必依赖浏览器就能回归。

class StubNode {
  constructor(name) {
    this.nodeName = name;
    this.childNodes = [];
    this.attrs = {};
    this._text = '';
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      contains: (n) => this._classes.has(n),
    };
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'class') {
      this._classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((c) => this._classes.add(c));
    }
  }
  getAttribute(key) { return this.attrs[key]; }
  appendChild(child) { this.childNodes.push(child); return child; }
  set textContent(value) { this._text = value; this.childNodes = []; }
  get textContent() {
    return this._text || this.childNodes.map((c) => c.textContent).join('');
  }
}

const realDocument = globalThis.document;
globalThis.document = { createElementNS: (_ns, name) => new StubNode(name) };

try {
  const collect = (node, out = []) => {
    if (node.classList && node.classList.contains('nt-note')) out.push(node);
    for (const child of node.childNodes) collect(child, out);
    return out;
  };

  let firstScore = null;
  for (const file of scoreFiles) {
    const data = JSON.parse(readFileSync(path.join(scoresDir, file), 'utf8'));
    const parsed = parseNotation(data.notation);
    const container = new StubNode('div');
    const { noteEls } = renderNotation(container, parsed);
    const gs = collect(container);

    if (gs.length !== parsed.notes.length) fail(`${file}: 渲染出的音符节点 ${gs.length} ≠ 解析出的 ${parsed.notes.length}`);
    else ok(`${file}: 渲染出 ${gs.length} 个音符节点且与解析一致`);

    const idsOk = gs.every((g, i) => g.getAttribute('data-i') === String(i));
    if (idsOk) ok(`${file}: data-i 与时间轴序号一一对应`);
    else fail(`${file}: data-i 序号不连续或错位`);

    if (!firstScore) firstScore = { file, parsed, noteEls };
  }

  if (firstScore) {
    const { file, parsed, noteEls } = firstScore;
    const timeline = buildTimeline(parsed.notes, parsed.bpm);
    const state = { prevTime: -1, prevIndex: -1 };
    resetProgress(noteEls, state);

    const snap = () => ({
      past: noteEls.filter((n) => n.classList.contains('past')).length,
      cur: noteEls.findIndex((n) => n.classList.contains('current')),
    });

    const cases = [
      [0, 0, 0, '起点：只有第 0 个在播'],
      [timeline[0].end + 0.02, 1, 1, '跨过首音：第 0 个已播放、第 1 个在播'],
      [Number.MAX_SAFE_INTEGER, noteEls.length, -1, '播完：全部已播放且无在播'],
      [0, 0, 0, '时间回退：重新从第 0 个开始'],
      [null, 0, -1, '未播放（null）：三态全灭'],
    ];
    for (const [time, past, cur, why] of cases) {
      paintProgress(noteEls, timeline, time, state);
      const got = snap();
      if (got.past === past && got.cur === cur) ok(`播放进度三态 ${file}｜${why}`);
      else fail(`播放进度三态 ${file}｜${why}：期望 past=${past} cur=${cur}，得到 ${JSON.stringify(got)}`);
    }
  }
} finally {
  globalThis.document = realDocument;
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
