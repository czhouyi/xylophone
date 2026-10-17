/**
 * check.mjs — 站点自检（本地运行，不参与线上页面）
 *
 * 校验四件事：
 *   1. index.json 里的 meta 齐全（含词曲作者），与 <id>.jianpu 谱面文件一一对应
 *   2. 每份谱面可解析、歌词逐行对齐、生成的 ABC 与简谱一致
 *   3. HTML 里引用的本地资源都存在，播放状态机与进度三态正确
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
  parseNotation, renderNotation, buildTimeline, paintProgress, resetProgress, DEFAULT_BPM, describeSkipped,
} from '../docs/assets/js/notation.js';
import { buildBody, inferMeter, toAbc } from '../docs/assets/js/abc.js';
import { ScorePlayer } from '../docs/assets/js/player.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const scoresDir = path.join(docsDir, 'data', 'scores');

let failures = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => { failures += 1; console.log(`FAIL  ${msg}`); };

// ---------- 1. 曲谱数据 ----------
// meta 只有一份：docs/data/scores/index.json
// 谱面是独立文件：docs/data/scores/<id>.jianpu（里面的换行就是真换行）

const NOTATION_EXT = 'jianpu';
const ID_OK = /^[a-z0-9][a-z0-9._-]*$/i;

const indexBuf = readFileSync(path.join(scoresDir, 'index.json'));
const indexText = indexBuf.toString('utf8');
if (indexBuf[0] === 0xef && indexBuf[1] === 0xbb && indexBuf[2] === 0xbf) fail('index.json: has UTF-8 BOM');
if (indexText.includes('\uFFFD')) fail('index.json: contains U+FFFD (encoding damaged)');

let metaList = [];
try {
  const parsedIndex = JSON.parse(indexText);
  metaList = Array.isArray(parsedIndex) ? parsedIndex : parsedIndex && parsedIndex.scores;
  if (!Array.isArray(metaList)) {
    fail('index.json: 格式不正确，应为 { "scores": [...] }');
    metaList = [];
  }
} catch (err) {
  fail(`index.json: JSON parse error -> ${err.message}`);
}

const scoreFiles = readdirSync(scoresDir)
  .filter((f) => f.endsWith(`.${NOTATION_EXT}`))
  .sort();

if (!scoreFiles.length) console.log('note  no notation files found');
ok(`index.json: ${metaList.length} 条 meta / ${scoreFiles.length} 份谱面`);

const metaIds = new Set();
const parsedScores = [];   // 供后面的渲染 / 进度检查复用

for (const meta of metaList) {
  const id = meta && meta.id;
  if (!id) {
    fail('index.json: 有一条 meta 缺少 id');
    continue;
  }

  const problems = [];
  if (!ID_OK.test(id)) problems.push('id 含非法字符');
  if (metaIds.has(id)) problems.push('id 重复');
  metaIds.add(id);
  if (!meta.title) problems.push('缺少 title');
  if (typeof meta.artist !== 'string') problems.push('artist 应为字符串（没有就写空串）');
  if (typeof meta.composer !== 'string') problems.push('composer 应为字符串（没有就写空串）');
  if (typeof meta.lyricist !== 'string') problems.push('lyricist 应为字符串（没有就写空串）');
  if ('notation' in meta) problems.push('meta 里不该再存 notation（谱面请放 <id>.jianpu）');

  const label = `${id}.${NOTATION_EXT}`;
  const notationPath = path.join(scoresDir, label);
  if (!existsSync(notationPath)) problems.push(`找不到谱面文件 ${label}`);
  if (problems.length) {
    fail(`${id}: ${problems.join(', ')}`);
    continue;
  }

  const buf = readFileSync(notationPath);
  const text = buf.toString('utf8');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { fail(`${label}: has UTF-8 BOM`); continue; }
  if (text.includes('\uFFFD')) { fail(`${label}: contains U+FFFD (encoding damaged)`); continue; }

  let parsed;
  try {
    parsed = parseNotation(text);
  } catch (err) {
    fail(`${label}: 谱面解析失败 -> ${err.message}`);
    continue;
  }
  if (!parsed.notes.length) {
    fail(`${label}: 谱面里没有解析出音符`);
    continue;
  }
  // 速度已经移到界面控件上，谱面里不该再写 bpm（写了会被忽略，这里直接拦下）
  if (parsed.bpm) fail(`${label}: 谱面里不该再写 bpm（速度在详情页的速度控件上）`);

  // 每一行歌词的槽位数必须等于该行可唱音符数（休止符 0 不占歌词位）
  let mismatched = 0;
  for (const line of parsed.lines) {
    if (!line.lyric.length) continue;
    const singable = line.items.filter((it) => it.kind === 'note' && it.pitch !== '0' && it.pitch !== '-').length;
    if (line.lyric.length !== singable) mismatched += 1;
  }
  if (mismatched) fail(`${label}: ${mismatched} 行歌词与音符数不匹配`);
  else ok(`${label}: 歌词与音符逐行对齐`);

  ok(`${label}: ${parsed.notes.length} 个音符 / ${parsed.lines.length} 行 / key=${parsed.key || '-'}`);

  // 播放靠运行时生成的 ABC：这里验证它真能生成，且音符与简谱一一对应
  const abcBody = buildBody(parsed, parsed.key || 'C');
  const abcNotes = abcBody.split(/[\s|]+/).filter(Boolean).length;
  if (abcNotes === parsed.notes.length) ok(`${label}: 生成的 ABC 音符与简谱一致（${abcNotes}）`);
  else fail(`${label}: 生成的 ABC 音符 ${abcNotes} 个 ≠ 简谱 ${parsed.notes.length} 个`);

  const abc = toAbc(parsed, { title: meta.title, program: 13 });
  const heads = ['X:1', 'M:', 'L:1/4', `Q:1/4=${DEFAULT_BPM}`, `K:${parsed.key || 'C'}`, '%%MIDI program 13'];
  const absent = heads.filter((h) => !abc.includes(h));
  if (absent.length) fail(`${label}: 生成的 ABC 缺少头部字段 ${JSON.stringify(absent)}`);
  else ok(`${label}: ABC 头部完整（拍号推断为 ${inferMeter(parsed)}）`);

  parsedScores.push({ label, meta, parsed });
}

// ---------- 1b. notation 指令（key / bpm / meter）----------

// meter 是唯一能显式覆盖拍号推断的写法，容易踩「括号里的数字被当成音符」的坑，
// 所以固定几个用例把解析结果和生成的 M: 都钉住。
const directiveCases = [
  {
    name: 'meter(3/4) 显式拍号',
    text: "/key(C) meter(3/4) bpm90\n1_2_3_ 4_5_6_ | 1'_7_6_ 5- |",
    parsedMeter: '3/4', meter: '3/4', notes: 10, bpm: 90, key: 'C',
  },
  {
    name: '不写 meter 时按小节拍数反推（2/4）',
    text: '/key(C)\n1 2 | 3 4 |',
    parsedMeter: null, meter: '2/4', notes: 4, bpm: null, key: 'C',
  },
  {
    name: 'meter(6/8) 原样保留',
    text: '/key(G) meter(6/8)\n1_2_3_ 4_5_6_ | 1_2_3_ 4_5_6_ |',
    parsedMeter: '6/8', meter: '6/8', notes: 12, bpm: null, key: 'G',
  },
];

for (const c of directiveCases) {
  const parsed = parseNotation(c.text);
  const abc = toAbc(parsed, { title: 't', program: 13 });
  const mLine = /^M:(.+)$/m.exec(abc);
  const problems = [];
  if (parsed.meter !== c.parsedMeter) problems.push(`parsed.meter=${parsed.meter}`);
  if (inferMeter(parsed) !== c.meter) problems.push(`inferMeter=${inferMeter(parsed)}`);
  if (!mLine || mLine[1] !== c.meter) problems.push(`M:${mLine && mLine[1]}`);
  if (parsed.notes.length !== c.notes) problems.push(`音符 ${parsed.notes.length} ≠ ${c.notes}（指令里的数字被当成音符了？）`);
  if ((parsed.bpm || null) !== c.bpm) problems.push(`bpm=${parsed.bpm}`);
  if (parsed.key !== c.key) problems.push(`key=${parsed.key}`);
  if (problems.length) fail(`notation 指令｜${c.name}: ${problems.join(', ')}`);
  else ok(`notation 指令｜${c.name}`);
}

// 速度由界面给：toAbc 的 Q: 必须跟着传进来的 bpm 走，缺省用 DEFAULT_BPM
{
  const parsed = parseNotation('/key(C)\n1 2 3 4 |');
  const q = (bpm) => {
    const line = /^Q:1\/4=(\d+)$/m.exec(toAbc(parsed, { bpm }));
    return line ? Number(line[1]) : NaN;
  };
  if (q(60) === 60 && q(150) === 150 && q(undefined) === DEFAULT_BPM) {
    ok(`速度：toAbc 的 Q: 跟随界面速度（60 / 150 / 缺省 ${DEFAULT_BPM}）`);
  } else {
    fail(`速度：Q: 得到 ${q(60)} / ${q(150)} / ${q(undefined)}，期望 60 / 150 / ${DEFAULT_BPM}`);
  }
}

// ---------- 1c. 认不出来的字符要被记下来 ----------
// 解析器对认不出的字符是「跳过」而不是报错：粘进来的谱面不会因为一两个怪字符就整行作废。
// 但跳过是静默的，时值会悄悄少掉，所以 parseNotation 把跳过的字符（带行号）一并返回，
// 详情页的「临时改谱」面板用它提醒。注意落单的 `-` 不在此列：它是合法语法（延音）。

{
  const cases = [
    { name: '正常写法', text: '/key(C)\n1_ 2_ 3- | 5 |', expect: [] },
    { name: '落单的 - 是合法延音，不再被跳过', text: '/key(C)\n1 2 -_3 |', expect: [] },
    { name: '两侧有空格的 - 同样是合法延音', text: '/key(C)\n1_2_|3 - 4|', expect: [] },
    { name: '真认不出的字符照旧被记下', text: '/key(C)\n1_ 2_ %3 |', expect: [{ line: 2, text: '%' }] },
    { name: '指令行的括号不算被跳过', text: '/key(C) meter(3/4)\n1_2_3_ |', expect: [] },
  ];
  for (const c of cases) {
    const parsed = parseNotation(c.text);
    const got = parsed.skipped || [];
    const same = got.length === c.expect.length
      && got.every((s, i) => s.line === c.expect[i].line && s.text === c.expect[i].text);
    if (same) ok(`认不出的字符｜${c.name}：记下 ${got.length} 处`);
    else fail(`认不出的字符｜${c.name}：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(c.expect)}`);
  }

  // 提示文案要说清楚「几处、在哪几行」
  const tip = describeSkipped([{ line: 5, text: '%' }, { line: 7, text: '~.' }]);
  if (tip.includes('2 处') && tip.includes('第 5 行') && tip.includes('第 7 行')) {
    ok(`认不出的字符｜提示文案：${tip}`);
  } else {
    fail(`认不出的字符｜提示文案不对：${tip}`);
  }
  if (describeSkipped([]) === '' && describeSkipped(undefined) === '') {
    ok('认不出的字符｜没有问题时提示为空串');
  } else {
    fail('认不出的字符｜没有问题时该返回空串');
  }

  // 现有谱面里有没有这类字符：有就列出来（不是失败，只是提醒该修）
  const skippedScores = parsedScores
    .filter(({ parsed }) => (parsed.skipped || []).length)
    .map(({ label, parsed }) => `${label}(${parsed.skipped.length})`);
  if (skippedScores.length) console.log(`note  谱面里有认不出的字符：${skippedScores.join(', ')}`);
  else ok('所有谱面都没有认不出的字符');
}

// ---------- 1d. 延音横杠 '-' 的两种用法 ----------
// 参照 jianpu.space 的写法：
//   紧跟在音高后面的 '-' 是增时线，每多一个多一拍（5- 两拍、5-- 三拍）；
//   独立的 '-' 自己就是一个音高，表示延续前一个音，并且能带自己的时值后缀
//   （裸 '-' 一拍、'-_' 半拍、'-=' 四分之一拍——一串音里可以随意换时值）。
// 两者都合法，都不该落进 skipped。

{
  const cases = [
    { name: '紧贴数字：增时线', text: '/key(C)\n5--|', beats: [3] },
    { name: '落单：整拍延音', text: '/key(C)\n5 - -|', beats: [1, 1, 1] },
    { name: '连着写的 - 被前一个延音吃掉', text: '/key(C)\n5 --|', beats: [1, 2] },
    { name: '落单且带减时线：半拍延音', text: '/key(C)\n2_ -= -|', beats: [0.5, 0.25, 1] },
    { name: '跟在八度后面', text: "/key(C)\n72' -_1'_|", beats: [1, 1, 0.5, 0.5] },
  ];
  for (const c of cases) {
    const parsed = parseNotation(c.text);
    const beats = parsed.notes.map((n) => n.beat);
    const beatsOk = beats.length === c.beats.length
      && beats.every((b, i) => Math.abs(b - c.beats[i]) < 1e-9);
    if (beatsOk && !(parsed.skipped || []).length) ok(`延音横杠｜${c.name}：${beats.join(' / ')} 拍`);
    else fail(`延音横杠｜${c.name}：得到 [${beats.join(', ')}] 拍、skipped=${JSON.stringify(parsed.skipped)}，期望 [${c.beats.join(', ')}]`);
  }
}

// 延音音符和休止符一样不占歌词位
{
  const parsed = parseNotation("/key(C)\n5 - 3 0|\nL: 啊 咿");
  const singable = parsed.notes.filter((n) => n.pitch !== '0' && n.pitch !== '-').length;
  const got = parsed.notes.filter((n) => n.lyric).map((n) => n.lyric).join('');
  if (singable === 2 && got === '啊咿') ok(`延音横杠｜不占歌词位：可唱 ${singable} 个、歌词「${got}」`);
  else fail(`延音横杠｜歌词槽位：可唱 ${singable} 个、歌词「${got}」，期望 2 个 / 「啊咿」`);
}

// ABC：延音写成 tie（`C- C`），音符数不受影响
// abcjs 的合成器会把 tie 合并成一个长音，听感与单个长音一致
{
  const cases = [
    { name: '音名延音（C 调的 5 是 G）', text: '/key(C)\n5 - 3|', has: /G- G/, absent: null },
    { name: '休止符不写 tie', text: '/key(C)\n0 - 3|', has: null, absent: /z-/ },
    { name: '开口就是 - ：无可延续，退化成休止', text: '/key(C)\n- 3|', has: /^z/, absent: null },
  ];
  for (const c of cases) {
    const parsed = parseNotation(c.text);
    const body = buildBody(parsed, 'C');
    const tokens = body.split(/[\s|]+/).filter(Boolean).length;
    const hit = (!c.has || c.has.test(body)) && (!c.absent || !c.absent.test(body));
    if (hit && tokens === parsed.notes.length) ok(`延音横杠｜${c.name}：${body}`);
    else fail(`延音横杠｜${c.name}：得到 '${body}'（${tokens} 个 token，期望 ${parsed.notes.length}）`);
  }
}

// ---------- 2. meta 与谱面文件双向一致 ----------

const orphanNotation = scoreFiles
  .map((f) => path.basename(f, `.${NOTATION_EXT}`))
  .filter((id) => !metaIds.has(id));
if (orphanNotation.length) fail(`有谱面但 index.json 里没有 meta：${orphanNotation.join(', ')}`);
else ok(`谱面文件与 meta 一一对应（各 ${scoreFiles.length} 份）`);

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

// ---------- 3c-3. iOS 音频会话：播放前必须声明 playback ----------
// iOS 上 Web Audio 默认走 ambient 类别，会被手机侧边的静音开关掉：
// 页面照常显示“正在播放”、Safari 亮着扬声器图标、进度也在走，但一点声音都没有。
// 用假 navigator 驱动真实代码，把「播放时声明 playback」这条钉住。

{
  const withSession = async (session) => {
    const pl = new ScorePlayer({ buildAbc: () => '' });
    pl.audioContext = { state: 'running', resume: async () => {}, get currentTime() { return 0; } };
    pl.synth = { start() {}, stop() {}, pause() {}, resume() {} };
    pl.primed = true;
    globalThis.navigator = session === null ? {} : { audioSession: session };
    await pl.play();
  };

  const session = { type: 'auto' };
  await withSession(session);
  if (session.type === 'playback') ok('iOS 音频会话：播放时声明为 playback（不受静音开关影响）');
  else fail(`iOS 音频会话：播放后 type=${session.type}，期望 playback`);

  // 没有 audioSession 的浏览器（桌面 Chrome / Node）不能让播放垮掉
  let survived = true;
  try { await withSession(null); } catch (err) { survived = false; }
  delete globalThis.navigator;
  if (survived) ok('没有 audioSession 的浏览器：播放照常，不抛错');
  else fail('没有 audioSession 的浏览器：play() 抛错了');
}

// iOS 专有的 interrupted 状态（切后台 / 来电 / 锁屏后）：不是 running 就得恢复上下文
{
  const pl = new ScorePlayer({ buildAbc: () => '' });
  let resumed = 0;
  pl.audioContext = {
    state: 'interrupted',
    resume: async () => { resumed += 1; pl.audioContext.state = 'running'; },
    get currentTime() { return 0; },
  };
  pl.abcjs = { renderAbc: () => [{}] };
  pl.hiddenDiv = {};
  pl.synth = { init: async () => {}, prime: async () => {}, start() {}, stop() {}, pause() {}, resume() {} };
  pl.primed = false;
  await pl.play();
  if (resumed === 1) ok('iOS interrupted 状态：播放前恢复上下文（不只认 suspended）');
  else fail(`iOS interrupted 状态：resume 调用了 ${resumed} 次，期望 1`);
}

// 速度 / 音色变了要丢掉旧 buffer：reload 后必须回到未预渲染状态
{
  const p = new ScorePlayer({ buildAbc: () => '' });
  let stopped = 0;
  p.synth = { stop() { stopped += 1; } };
  p.primed = true;
  p.state = 'playing';
  p.startedAt = 5;
  p.pausedAt = 2;
  p.visualObj = { fake: true };
  p.reload();
  if (p.primed === false && p.visualObj === null && p.state === 'idle'
    && p.startedAt === 0 && p.pausedAt === 0 && stopped === 1) {
    ok('reload：丢掉已预渲染的 buffer，回到从头待播状态');
  } else {
    fail(`reload：primed=${p.primed} visualObj=${p.visualObj} state=${p.state} startedAt=${p.startedAt} stop=${stopped}`);
  }
}

// 播放到底：状态要收尾，不能一直停在“正在播放…”
{
  let status = '';
  const q = new ScorePlayer({ buildAbc: () => '', onStatus: (m) => { status = m; } });
  let clock = 0;
  q.audioContext = { state: 'running', resume: async () => {}, get currentTime() { return clock; } };
  q.synth = { start() {}, stop() {}, pause() {}, resume() {} };
  q.primed = true;
  q.setDuration(5);

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

// 总时长由页面传入（简谱时间轴）；非法值不能让它误触发结束判定
{
  const a = new ScorePlayer({ buildAbc: () => '' });
  a.setDuration(12.5);
  const notZeroed = [0, -1, NaN, undefined, 'abc', null].filter((v) => {
    const s = new ScorePlayer({ buildAbc: () => '' });
    s.setDuration(v);
    return s.duration !== 0;
  });
  if (a.duration === 12.5 && notZeroed.length === 0) ok('时长：setDuration 接受正数，非法值一律退化为 0');
  else fail(`时长：正数=${a.duration}，非法值未归零的：${JSON.stringify(notZeroed)}`);
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
  const collectLines = (node, out = []) => {
    if (node.nodeName === 'line' && node.classList.contains('nt-underline')) out.push(node);
    for (const child of node.childNodes || []) collectLines(child, out);
    return out;
  };
  const collectBars = (node, out = []) => {
    if (node.classList && node.classList.contains('nt-bar')) out.push(node);
    for (const child of node.childNodes || []) collectBars(child, out);
    return out;
  };
  const collectLyrics = (node, out = []) => {
    if (node.nodeName === 'text' && node.classList.contains('nt-lyric')) out.push(node);
    for (const child of node.childNodes || []) collectLyrics(child, out);
    return out;
  };

  let firstScore = null;
  // parsedScores 的 label 就是谱面文件名（如 little-star.jianpu），下面沿用它做前缀
  for (const { label: file, parsed } of parsedScores) {
    const container = new StubNode('div');
    const { noteEls } = renderNotation(container, parsed);
    const gs = collect(container);

    if (gs.length !== parsed.notes.length) fail(`${file}: 渲染出的音符节点 ${gs.length} ≠ 解析出的 ${parsed.notes.length}`);
    else ok(`${file}: 渲染出 ${gs.length} 个音符节点且与解析一致`);

    const idsOk = gs.every((g, i) => g.getAttribute('data-i') === String(i));
    if (idsOk) ok(`${file}: data-i 与时间轴序号一一对应`);
    else fail(`${file}: data-i 序号不连续或错位`);

    // 占位槽（`_` / `*`）不应把符号本身漏到谱面上
    const lyricTexts = collectLyrics(container).map((t) => t.textContent);
    const leaks = lyricTexts.filter((s) => /[_*]/.test(s));
    if (leaks.length) fail(`${file}: 占位符漏进了歌词：${JSON.stringify(leaks.slice(0, 4))}`);
    else ok(`${file}: ${lyricTexts.length} 个字渲染出来，占位符未泄漏`);

    // 小节线（含 || / |]）每一条都应渲染成一个 bar 节点
    const parsedBars = parsed.lines
      .reduce((n, l) => n + l.items.filter((it) => it.kind === 'bar').length, 0);
    const renderedBars = collectBars(container).length;
    if (renderedBars === parsedBars) ok(`${file}: ${renderedBars} 条小节线渲染完整`);
    else fail(`${file}: 小节线渲染 ${renderedBars} 条 ≠ 解析出 ${parsedBars} 条`);

    // 减时线按“拍”分组：5_6_5_4_ 应该是 “56”“54” 两段，不能连成一长条。
    // 统计时按 svg（= 排版后的一行）分开：行数现在随屏幕宽度变，
    // 不分开的话会把不同行的横线拿来比 x。
    if (file === 'two-tigers.jianpu') {
      const svgs = container.childNodes.filter((n) => n.nodeName === 'svg');
      let underlines = 0;
      let joins = 0;
      for (const svg of svgs) {
        const segs = collectLines(svg)
          .sort((a, b) => Number(a.getAttribute('x1')) - Number(b.getAttribute('x1')));
        underlines += segs.length;
        for (let i = 1; i < segs.length; i += 1) {
          const prevX2 = Number(segs[i - 1].getAttribute('x2'));
          const curX1 = Number(segs[i].getAttribute('x1'));
          if (Math.abs(prevX2 - curX1) < 0.001) joins += 1;
        }
      }
      if (underlines === 8 && joins === 4) ok('two-tigers: 减时线按拍分组（56 / 54 各一段，没连成长条）');
      else fail(`two-tigers: 减时线 ${underlines} 条、相接 ${joins} 对，期望 8 条 / 4 对`);
    }

    if (!firstScore) firstScore = { file, parsed, noteEls };
  }

  if (firstScore) {
    const { file, parsed, noteEls } = firstScore;
    const timeline = buildTimeline(parsed.notes, parsed.bpm);
    const state = { prevTime: -1, prevFrom: -1, prevTo: -1 };
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

  // 减时线分组的「同一拍」必须按小节内的拍位算，不能整行累加。
  // 第一小节故意写成 1.75 拍：整行累加会把下一小节的 3_ 0_ 1_ 0_ 算成
  // 1.75 / 2.25 / 2.75 / 3.25 拍，floor 之后变成「3 | 01 | 0」。
  {
    const probe = parseNotation('/key(C)\n3_. 1= 5=5=5= | 3_ 0_ 1_ 0_ |');
    const box = new StubNode('div');
    renderNotation(box, probe);
    const segs = collectLines(box)
      .map((l) => ({
        x1: Number(l.getAttribute('x1')),
        x2: Number(l.getAttribute('x2')),
        y: Number(l.getAttribute('y1')),
      }))
      .sort((a, b) => a.x1 - b.x1 || a.y - b.y);
    const tail = segs.slice(-4);
    const joins = tail.slice(1).map((s, i) => Math.abs(s.x1 - tail[i].x2) < 0.001);
    if (tail.length === 4 && joins[0] === true && joins[1] === false && joins[2] === true) {
      ok('减时线：拍位按小节重新起算（30 相连 / 01 断开 / 10 相连）');
    } else {
      fail(`减时线分组的拍位：相接 ${JSON.stringify(joins)}，期望 [true,false,true]`);
    }
  }

  // 延音横杠渲染成独立的音符节点：有自己的高亮块，画出来是一根横杠而不是数字。
  // 播放进度就是靠这些节点逐个点亮的，所以它是独立节点而不是「前一个数字的一部分」。
  {
    const probe = parseNotation('/key(C)\n5 - - 3|');
    const box = new StubNode('div');
    const rendered = renderNotation(box, probe);
    const textsOf = (node, out = []) => {
      if (node.nodeName === 'text') out.push(node.textContent);
      for (const c of node.childNodes || []) textsOf(c, out);
      return out;
    };
    const dashes = textsOf(box).filter((t) => t === '-').length;
    const marked = rendered.noteEls
      .filter((g) => g.childNodes.some((c) => c.classList && c.classList.contains('nt-mark'))).length;
    // 块只画在单元的头上（5 和 3 各一块，两个 - 不画）
    if (rendered.noteEls.length === 4 && dashes === 2 && marked === 2) {
      ok('延音横杠｜渲染：2 个独立横杠节点，高亮块只画在单元头上（5 / 3 各一块）');
    } else {
      fail(`延音横杠｜渲染：节点 ${rendered.noteEls.length} 个、横杠 ${dashes} 个、带高亮块 ${marked} 个，期望 4 / 2 / 2`);
    }
  }

  // 一个音拖几条延音杠时（`6---`）：歌词要跟数字竖着对齐，
  // 高亮块要罩住整段（数字 + 延音杠），而不是只包住数字那一小格。
  {
    const measure = (notation) => {
      const box = new StubNode('div');
      const { noteEls } = renderNotation(box, parseNotation(notation));
      const g = noteEls[0];
      const pick = (cls) => g.childNodes.find((c) => c.classList && c.classList.contains(cls));
      const ties = g.childNodes.filter((c) => c.classList && c.classList.contains('nt-tie'));
      const mark = pick('nt-mark');
      return {
        count: noteEls.length,
        ties: ties.length,
        digitX: Number(pick('nt-digit').getAttribute('x')),
        lyricX: Number(pick('nt-lyric').getAttribute('x')),
        markW: Number(mark.getAttribute('width')),
        markRight: Number(mark.getAttribute('x')) + Number(mark.getAttribute('width')),
        lastTieX: ties.length ? Math.max(...ties.map((t) => Number(t.getAttribute('x')))) : -1,
      };
    };
    const long = measure('/key(C)\n6---|\nL: 你');
    const short = measure('/key(C)\n6|\nL: 你');
    const aligned = Math.abs(long.lyricX - long.digitX) < 1e-9;
    const covers = long.markRight >= long.lastTieX && long.markW > short.markW;
    if (long.count === 1 && long.ties === 3 && aligned && covers) {
      ok(`延音横杠｜长音：歌词对齐数字，高亮块罩住整段（${long.markW} > 单音符的 ${short.markW}）`);
    } else {
      fail(`延音横杠｜长音：${JSON.stringify(long)} / 单音符 ${JSON.stringify(short)}`);
    }
  }

  // 一个音连同紧跟它的延音，在时间轴上共享一个时间段，播放时整段一起亮。
  // 也就是 `6 - - -` 会同时变色（简谱里那本来就是一个音），而不是挨个走一遍。
  {
    const parsed = parseNotation('/key(C)\n6 - - - 3|');
    const timeline = buildTimeline(parsed.notes, 120);
    const head = timeline[0];
    const shared = timeline.slice(0, 4).every((s) => s.start === head.start && s.end === head.end);
    const nextStarts = timeline[4].start === timeline[3].end;

    const box = new StubNode('div');
    const { noteEls } = renderNotation(box, parsed);
    const st = { prevTime: -1, prevFrom: -1, prevTo: -1 };
    const lit = () => noteEls.filter((n) => n.classList.contains('current')).length;
    const done = () => noteEls.filter((n) => n.classList.contains('past')).length;

    paintProgress(noteEls, timeline, head.start + 0.01, st);
    const litAtStart = lit();
    paintProgress(noteEls, timeline, head.end - 0.01, st);   // 快放完了，还是同一段
    const litNearEnd = lit();
    paintProgress(noteEls, timeline, timeline[4].start + 0.01, st);
    const doneAfter = done();
    const litAfter = lit();

    if (parsed.notes.length === 5 && shared && nextStarts
      && litAtStart === 4 && litNearEnd === 4 && doneAfter === 4 && litAfter === 1) {
      ok('延音横杠｜整段一起亮：`6 - - -` 四个字符同时点亮，过完一起变已播放');
    } else {
      fail('延音横杠｜整段一起亮：共享时间段=' + shared + ' 下一段紧接=' + nextStarts
        + ' 起点亮=' + litAtStart + ' 尾端亮=' + litNearEnd
        + ' 过后已播放=' + doneAfter + ' 过后在播=' + litAfter + '（期望 true/true/4/4/4/1）');
    }
  }

  // 高亮块只画在单元的头上，宽度罩住整段；组内其它字符不重复画
  {
    const parsed = parseNotation('/key(C)\n6 - - 3|');
    const box = new StubNode('div');
    const { noteEls } = renderNotation(box, parsed);
    const isMark = (c) => c.classList && c.classList.contains('nt-mark');
    const rectOf = (g) => {
      const r = g.childNodes.find(isMark);
      return r ? { x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')) } : null;
    };
    const head = rectOf(noteEls[0]);
    const solo = rectOf(noteEls[3]);
    const others = [rectOf(noteEls[1]), rectOf(noteEls[2])];
    const onlyHead = others.every((r) => r === null) && head && solo;
    if (parsed.notes.length === 4 && onlyHead && head.w > solo.w) {
      ok(`延音横杠｜高亮块：6 那块宽 ${head.w} 罩住 6 - -，两个 - 不重复画；3 另起一块（宽 ${solo.w}）`);
    } else {
      fail(`延音横杠｜高亮块：head=${JSON.stringify(head)} others=${JSON.stringify(others)} solo=${JSON.stringify(solo)}`);
    }
  }

  // 回归：`51_6_--` 里 `6` 不能被自己的高亮块盖掉。
  // 块是矩形，和数字在同一个 <g> 里：块先画、数字后画，所以数字一定在块之上；
  // 而组内靠后的 `-` 不重复画块，否则它画在后面，会压到 `6` 头上。（曾经就败在这里）
  {
    const parsed = parseNotation('/key(C)\n51_6_--|');
    const box = new StubNode('div');
    const { noteEls } = renderNotation(box, parsed);
    const isMark = (c) => c.classList && c.classList.contains('nt-mark');
    const isDigit = (c) => c.classList && c.classList.contains('nt-digit');
    const six = noteEls[2].childNodes;    // `6_`：本段延音的头
    const dash = noteEls[3].childNodes;   // 后面的 `-`：跟着亮，但不重复画块
    const markAt = six.findIndex(isMark);
    const digitAt = six.findIndex(isDigit);
    const okLayers = markAt === 0 && digitAt === 1 && !dash.some(isMark);
    if (parsed.notes.length === 4 && okLayers) {
      ok('延音横杠｜回归：6_-- 的块画在 6 下面，后面的 - 不重复画块');
    } else {
      fail(`延音横杠｜回归：6 的 markAt=${markAt} digitAt=${digitAt}，- 有块=${dash.some(isMark)}`);
    }
  }

  // 自动折行：断行跟着容器宽度走，每行装整数个小节，源文件的换行不参与排版。
  // 同一份「源文件里只有一行」的谱面，窄容器应该排出更多行，且每行都不超宽。
  {
    const notation = '/key(C)\n' + Array.from({ length: 16 }, () => '1_1_|').join('');
    const layout = (width) => {
      const box = new StubNode('div');
      box.clientWidth = width;
      renderNotation(box, parseNotation(notation));
      return box.childNodes.filter((n) => n.nodeName === 'svg');
    };
    const narrow = layout(260);
    const wide = layout(1200);
    const over = (rows, width) => rows.filter((s) => Number(s.getAttribute('width')) > width + 1).length;
    // 每一行都得含小节线：整节装行，不会把一小节劈成两半
    const wholeBars = (rows) => rows.every((svg) => svg.childNodes
      .some((n) => n.classList && n.classList.contains('nt-bar')));
    if (narrow.length > wide.length && over(narrow, 260) === 0 && over(wide, 1200) === 0 && wholeBars(narrow)) {
      ok(`自动折行：窄屏 ${narrow.length} 行 / 宽屏 ${wide.length} 行，都按整小节装且不超宽`);
    } else {
      fail(`自动折行：窄屏 ${narrow.length} 行 / 宽屏 ${wide.length} 行，`
        + `超宽 ${over(narrow, 260)} / ${over(wide, 1200)}，整节 ${wholeBars(narrow)}`);
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
  '.jianpu': 'text/plain; charset=utf-8',
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
  '/assets/js/abc.js',
  '/assets/js/data.js',
  '/assets/js/list.js',
  '/assets/js/notation.js',
  '/assets/js/player.js',
  '/assets/js/score.js',
  '/data/scores/index.json',
  '/data/scores/little-star.jianpu',
  '/data/scores/does-not-exist.jianpu',
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
