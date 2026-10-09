/**
 * score.js — 曲谱详情页入口（score.html?id=<曲谱ID>）
 *
 * 流程：读地址里的 ID → 取数据 → 渲染抬头 → simple-notation 画简谱
 *       → abcjs 播放器接管工具栏。
 */

import { loadScore, getScoreIdFromUrl, scoreTitle, scoreComposer } from './data.js';
import { ScorePlayer } from './player.js';

/** simple-notation 以 ES module 形式从 CDN 动态加载 */
const SIMPLE_NOTATION_URL =
  'https://cdn.jsdelivr.net/npm/simple-notation@1.0.27/dist/simple-notation.js';

const els = {
  status: document.getElementById('page-status'),
  article: document.getElementById('score-article'),
  title: document.getElementById('score-title'),
  subtitle: document.getElementById('score-subtitle'),
  byline: document.getElementById('score-byline'),
  tags: document.getElementById('score-tags'),
  container: document.getElementById('notation-container'),
  instrument: document.getElementById('instrument'),
  play: document.getElementById('btn-play'),
  pause: document.getElementById('btn-pause'),
  stop: document.getElementById('btn-stop'),
  playStatus: document.getElementById('play-status'),
};

function setStatus(node, message, isError = false) {
  node.textContent = message;
  node.classList.toggle('error', isError);
}

function fail(message) {
  els.article.hidden = true;
  setStatus(els.status, message, true);
}

/** 渲染抬头：标题、副标题、作曲者、难度与标签 */
function renderHeader(score) {
  const title = scoreTitle(score);
  const composer = scoreComposer(score);

  document.title = `${title} · 木琴曲谱库`;
  els.title.textContent = title;

  if (score.subtitle) {
    els.subtitle.textContent = score.subtitle;
  } else {
    els.subtitle.hidden = true;
  }

  if (composer) {
    els.byline.textContent = composer;
  } else {
    els.byline.hidden = true;
  }

  const tags = [];
  if (score.difficulty) tags.push(String(score.difficulty));
  if (Array.isArray(score.tags)) tags.push(...score.tags);
  tags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = String(t);
    els.tags.append(chip);
  });
}

/** 用 simple-notation 渲染简谱（数据即 jianpu 块，原样透传给引擎） */
async function renderNotation(score) {
  const { SimpleNotation } = await import(SIMPLE_NOTATION_URL);
  const notation = new SimpleNotation(els.container, { resize: true });
  notation.loadData(score.jianpu);
}

/** 把结构化 ABC 字段拼成 abcjs 可读的谱面字符串 */
function buildAbc(abc, program) {
  return [
    'X:1',
    `T:${abc.title || ''}`,
    `M:${abc.meter || '4/4'}`,
    `L:${abc.length || '1/4'}`,
    `K:${abc.key || 'C'}`,
    `%%MIDI program ${program}`,
    abc.body || '',
  ].join('\n');
}

function setControlsEnabled(enabled) {
  [els.play, els.pause, els.stop].forEach((btn) => { btn.disabled = !enabled; });
}

async function initPlayer(score) {
  const player = new ScorePlayer({
    buildAbc: (program) => buildAbc(score.abc || {}, program),
    onStatus: (message, level) => setStatus(els.playStatus, message, level === 'error'),
  });

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

  els.instrument.addEventListener('change', (event) => {
    const option = event.target.selectedOptions[0];
    const label = option ? option.textContent.trim() : '';
    player.setProgram(event.target.value);
    // setProgram 已给出一条状态，这里覆盖成带音色名的提示，便于确认切换已生效
    if (label) setStatus(els.playStatus, `音色已切换为「${label}」，点击播放生效`);
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
  setStatus(els.status, '');
  els.status.hidden = true;

  try {
    await renderNotation(score);
  } catch (err) {
    console.error(err);
    setStatus(els.playStatus, `简谱渲染失败：${err.message}`, true);
    return;
  }

  await initPlayer(score);
}

main();
