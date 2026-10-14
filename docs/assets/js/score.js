/**
 * score.js — 曲谱详情页入口
 *
 * 流程：读地址里的 ID → 取数据 → 渲染抬头 → 渲染简谱（notation.js）
 *       → 由简谱合成 ABC（abc.js）交给 abcjs 播放 → rAF 驱动播放进度三态
 *
 * 页面上还有两件「调了立刻能听、刷新即还原」的事：
 *   - 工具栏上的速度滑块（速度不写在谱面里）
 *   - 「临时改谱」面板：改谱面会立刻重新渲染并能直接试听，改动不落盘
 */

import { loadScore, getScoreIdFromUrl, scoreTitle, scoreByline } from './data.js';
import { ScorePlayer } from './player.js';
import { parseNotation, renderNotation, buildTimeline, startProgress, DEFAULT_BPM, describeSkipped } from './notation.js';
import { toAbc } from './abc.js';

const els = {
  status: document.getElementById('page-status'),
  article: document.getElementById('score-article'),
  title: document.getElementById('score-title'),
  subtitle: document.getElementById('score-subtitle'),
  byline: document.getElementById('score-byline'),
  tags: document.getElementById('score-tags'),
  container: document.getElementById('notation-container'),
  instrument: document.getElementById('instrument'),
  tempo: document.getElementById('tempo'),
  tempoValue: document.getElementById('tempo-value'),
  play: document.getElementById('btn-play'),
  pause: document.getElementById('btn-pause'),
  stop: document.getElementById('btn-stop'),
  playStatus: document.getElementById('play-status'),
  edit: document.getElementById('btn-edit'),
  editorPanel: document.getElementById('editor-panel'),
  revert: document.getElementById('btn-revert'),
  notationInput: document.getElementById('notation-input'),
  editorStatus: document.getElementById('editor-status'),
};

let noteEls = [];              // 每个音符的 <g>，序号与 timeline 对齐
let timeline = [];             // 每个音符的 [start, end)，单位秒
let currentParsed = null;      // 当前渲染的谱面（可能已被临时编辑过）
let currentBpm = DEFAULT_BPM;  // 播放速度，由工具栏上的速度控件决定（谱面里不写）
let originalNotation = '';     // 仓库里的原谱，供「恢复原谱」用
let playerRef = null;

function setStatus(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle('error', isError);
}

function fail(message) {
  els.article.hidden = true;
  setStatus(els.status, message, true);
}

/** 抬头：标题、副标题、署名、难度与标签 */
function renderHeader(score) {
  const title = scoreTitle(score);
  const byline = scoreByline(score);

  document.title = `${title} · 木琴曲谱库`;
  els.title.textContent = title;

  if (score.subtitle) els.subtitle.textContent = score.subtitle;
  else els.subtitle.hidden = true;

  if (byline) els.byline.textContent = byline;
  else els.byline.hidden = true;

  const tags = [];
  if (score.difficulty) tags.push(String(score.difficulty));
  if (Array.isArray(score.tags)) tags.push(...score.tags);
  tags.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = String(tag);
    els.tags.append(chip);
  });
}

/** 歌词对没对上：逐行体检（编辑器靠它给即时反馈） */
function lyricProblems(parsed) {
  const problems = [];
  for (const [i, line] of parsed.lines.entries()) {
    if (!line.lyric.length) continue;
    const singable = line.items.filter((it) => it.kind === 'note' && it.pitch !== '0').length;
    if (line.lyric.length !== singable) {
      problems.push(`第 ${i + 1} 行 ${singable} 个音 / ${line.lyric.length} 个字`);
    }
  }
  return problems;
}

function describeParsed(parsed) {
  const head = `${parsed.notes.length} 个音符 · ${parsed.lines.length} 行 · ${parsed.key || 'C'} 调`;
  const parts = [];

  const problems = lyricProblems(parsed);
  parts.push(problems.length ? `歌词对不上：${problems.join('，')}` : '歌词逐行对齐');

  // 认不出来的字符不报错但会静默丢时值，这里明确说出来（附行号）
  const skipped = describeSkipped(parsed.skipped);
  if (skipped) parts.push(skipped);

  return `${head}；${parts.join('；')}`;
}

/**
 * 渲染一份谱面，并把音符节点与时间轴「就地」更新。
 *
 * 必须就地更新而不是换新数组：进度高亮的 rAF 闭包持有的是 noteEls / timeline
 * 这两个数组的引用，换掉引用它就画不到新谱上了。
 */
function renderNotationToPage(notation) {
  const parsed = parseNotation(notation || '');
  if (!parsed.notes.length) throw new Error('这份谱面里没有解析出音符');

  const rendered = renderNotation(els.container, parsed);
  noteEls.splice(0, noteEls.length, ...rendered.noteEls);
  timeline.splice(0, timeline.length, ...buildTimeline(parsed.notes, currentBpm));
  currentParsed = parsed;
  return parsed;
}

/** 谱面总时长（秒），用来判定「播放到底」 */
function totalSeconds() {
  return timeline.length ? timeline[timeline.length - 1].end : 0;
}

function setControlsEnabled(enabled) {
  [els.play, els.pause, els.stop].forEach((btn) => { btn.disabled = !enabled; });
}

/** 临时改谱：重新解析渲染，并让播放器按新谱重新预加载 */
function applyNotation(notation, sourceLabel = '临时谱面') {
  let parsed;
  try {
    parsed = renderNotationToPage(notation);
  } catch (err) {
    setStatus(els.editorStatus, `没改成：${err.message}`, true);
    return false;
  }

  if (playerRef) {
    playerRef.setDuration(totalSeconds());
    playerRef.reload();
  }
  setStatus(els.editorStatus, `${sourceLabel}已生效（${describeParsed(parsed)}），点「播放」试听`);
  return true;
}

/** 临时改谱面板：改动只在当前页面里，刷新就回到仓库里的原谱 */
function initEditor() {
  els.notationInput.value = originalNotation;

  els.edit.addEventListener('click', () => {
    const open = els.editorPanel.hidden;
    els.editorPanel.hidden = !open;
    els.edit.setAttribute('aria-expanded', String(open));
    if (open) {
      els.notationInput.focus();
      setStatus(els.editorStatus, '改完停一下会自动重新渲染；刷新页面即还原。');
    }
  });

  // 边打边渲染太吵，停手 300ms 再应用
  let timer = 0;
  els.notationInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { applyNotation(els.notationInput.value, '当前改动'); }, 300);
  });

  els.revert.addEventListener('click', () => {
    els.notationInput.value = originalNotation;
    if (applyNotation(originalNotation, '原谱')) {
      setStatus(els.editorStatus, '已恢复成仓库里的原谱。');
    }
  });
}

async function initPlayer(score) {
  const player = new ScorePlayer({
    // 播放用的 ABC 由简谱现场合成，音色与速度都从界面取
    buildAbc: (program) => toAbc(currentParsed, { title: score.title, program, bpm: currentBpm }),
    onStatus: (message, level) => setStatus(els.playStatus, message, level === 'error'),
  });
  playerRef = player;

  setControlsEnabled(false);
  try {
    await player.ready();
  } catch (err) {
    console.error(err);
    setStatus(els.playStatus, err.message, true);
    return;
  }

  setControlsEnabled(true);
  setStatus(els.playStatus, '音频就绪，点击播放');
  // 播到结尾的判定要用总时长：简谱时间轴的总长与 abcjs 的音频一致
  player.setDuration(totalSeconds());
  startProgress(noteEls, timeline, () => player.progressTime());

  els.instrument.addEventListener('change', (event) => {
    const option = event.target.selectedOptions[0];
    const label = option ? option.textContent.trim() : '';
    player.setProgram(event.target.value);
    if (label) setStatus(els.playStatus, `音色已切换为「${label}」，点击播放生效`);
  });

  // 速度：拖动时只更新读数，松手才重算时间轴并让播放器重新预渲染（Q: 变了）
  els.tempo.value = String(currentBpm);
  els.tempoValue.textContent = `${currentBpm} BPM`;
  els.tempo.addEventListener('input', () => {
    els.tempoValue.textContent = `${els.tempo.value} BPM`;
  });
  els.tempo.addEventListener('change', () => {
    const bpm = Number.parseInt(els.tempo.value, 10);
    if (!Number.isInteger(bpm) || bpm <= 0) return;
    currentBpm = bpm;
    els.tempoValue.textContent = `${bpm} BPM`;
    // 就地更新 timeline：进度高亮的 rAF 闭包持有的是这个数组的引用
    const next = buildTimeline(currentParsed.notes, bpm);
    timeline.splice(0, timeline.length, ...next);
    player.setDuration(totalSeconds());
    player.reload();
    setStatus(els.playStatus, `速度已设为 ${bpm}，点击播放生效`);
  });

  els.play.addEventListener('click', () => { player.play(); });
  els.pause.addEventListener('click', () => { player.pause(); });
  els.stop.addEventListener('click', () => { player.stop(); });
}

async function main() {
  const id = getScoreIdFromUrl();
  if (!id) {
    fail('地址缺少曲谱参数，请从曲谱列表进入（例如 score.html?id=little-star）。');
    return;
  }

  let score;
  try {
    score = await loadScore(id);
  } catch (err) {
    console.error(err);
    fail(err.code === 'not-found' ? `没有找到曲谱「${id}」。` : `曲谱加载失败：${err.message}`);
    return;
  }

  renderHeader(score);
  els.article.hidden = false;
  els.status.hidden = true;

  originalNotation = score.notation || '';
  try {
    renderNotationToPage(originalNotation);
  } catch (err) {
    console.error(err);
    setStatus(els.playStatus, `简谱渲染失败：${err.message}`, true);
    return;
  }

  initEditor();
  await initPlayer(score);
}

main();
