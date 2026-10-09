/**
 * score.js — 曲谱详情页入口
 *
 * 流程：读地址里的 ID → 取数据 → 渲染抬头 → 渲染简谱（notation.js）
 *       → abcjs 播放器接管工具栏 → rAF 驱动播放进度三态
 */

import { loadScore, getScoreIdFromUrl, scoreTitle, scoreComposer } from './data.js';
import { ScorePlayer } from './player.js';
import { parseNotation, renderNotation, buildTimeline, startProgress } from './notation.js';

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

let noteEls = [];   // 每个音符的 <g>，序号与 timeline 对齐
let timeline = [];  // 每个音符的 [start, end)，单位秒

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
  const composer = scoreComposer(score);

  document.title = `${title} · 木琴曲谱库`;
  els.title.textContent = title;

  if (score.subtitle) els.subtitle.textContent = score.subtitle;
  else els.subtitle.hidden = true;

  if (composer) els.byline.textContent = composer;
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

/**
 * 渲染简谱，并算出每个音符的时间区间。
 * 时间轴按简谱自己的速度和拍数算，abcjs 那边用同样的 Q: 保证一致。
 */
function renderScore(score) {
  const parsed = parseNotation(score.notation || '');
  const rendered = renderNotation(els.container, parsed);
  noteEls = rendered.noteEls;

  const bpm = parsed.bpm || (score.abc && score.abc.tempo) || 120;
  timeline = buildTimeline(parsed.notes, bpm);
  return parsed;
}

/** 把结构化字段拼成 abcjs 谱面。Q: 是必须的——否则播放速度与简谱标注不一致，进度就白做了 */
function buildAbc(abc, title, program) {
  return [
    'X:1',
    `T:${title || ''}`,
    `M:${abc.meter || '4/4'}`,
    `L:${abc.length || '1/4'}`,
    `Q:1/4=${abc.tempo || 120}`,
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
    buildAbc: (program) => buildAbc(score.abc || {}, score.title, program),
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
  // 播到结尾的判定要用总时长：简谱时间轴的总长与 abcjs 的音频一致
  player.setDuration(timeline.length ? timeline[timeline.length - 1].end : 0);
  startProgress(noteEls, timeline, () => player.progressTime());

  els.instrument.addEventListener('change', (event) => {
    const option = event.target.selectedOptions[0];
    const label = option ? option.textContent.trim() : '';
    player.setProgram(event.target.value);
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
  els.status.hidden = true;

  try {
    renderScore(score);
  } catch (err) {
    console.error(err);
    setStatus(els.playStatus, `简谱渲染失败：${err.message}`, true);
    return;
  }

  await initPlayer(score);
}

main();
