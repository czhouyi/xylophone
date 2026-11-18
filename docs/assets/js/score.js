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
import { parseNotation, renderNotation, buildTimeline, startProgress, DEFAULT_BPM, describeSkipped, FULLSCREEN_SCALE } from './notation.js';
import { toAbc } from './abc.js';

const els = {
  status: document.getElementById('page-status'),
  article: document.getElementById('score-article'),
  title: document.getElementById('score-title'),
  subtitle: document.getElementById('score-subtitle'),
  byline: document.getElementById('score-byline'),
  tags: document.getElementById('score-tags'),
  container: document.getElementById('notation-container'),
  stage: document.getElementById('score-stage'),
  fullscreenBtn: document.getElementById('btn-fullscreen'),
  fsTitle: document.getElementById('fs-title'),
  fsPlay: document.getElementById('fs-play'),
  fsPause: document.getElementById('fs-pause'),
  fsStop: document.getElementById('fs-stop'),
  fsShare: document.getElementById('fs-share'),
  fsExit: document.getElementById('fs-exit'),
  shareModal: document.getElementById('share-modal'),
  shareImage: document.getElementById('share-image'),
  shareStatus: document.getElementById('share-status'),
  shareDownload: document.getElementById('share-download'),
  shareNative: document.getElementById('share-native'),
  shareClose: document.getElementById('share-close'),
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
let stopProgress = null;       // 进度高亮的 rAF 停止函数
let layoutWidth = 0;           // 上次排版用的容器宽度（宽度变了就重新断行）
let viewScale = 1;             // 全屏看谱时整行放大（数字 60px / 歌词 40px）
let isFullscreen = false;
let shareUrl = '';             // 分享图 blob URL
let shareBlob = null;
let shareFileName = '';
let shareReturnFocus = null;
let shareRequest = 0;          // 关闭弹层后忽略仍在生成的旧请求

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

/** 歌词对没对上：歌词是全局铺开的，看总数就行（编辑器靠它给即时反馈） */
function lyricProblems(parsed) {
  const singable = parsed.notes.filter((n) => n.pitch !== '0' && n.pitch !== '-').length;
  const slots = parsed.lines.reduce((n, l) => n + l.lyric.length, 0);
  if (slots > singable) {
    return [`歌词 ${slots} 个字 > 可唱音符 ${singable} 个，多出的 ${slots - singable} 个字会被丢弃`];
  }
  if (slots < singable) {
    return [`歌词 ${slots} 个字 < 可唱音符 ${singable} 个，最后 ${singable - slots} 个音没词`];
  }
  return [];
}

function describeParsed(parsed) {
  const head = `${parsed.notes.length} 个音符 · ${parsed.lines.length} 行 · ${parsed.key || 'C'} 调`;
  const parts = [];

  const problems = lyricProblems(parsed);
  parts.push(problems.length ? `歌词对不上：${problems.join('，')}` : '歌词与音符对齐');

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

  const rendered = renderNotation(els.container, parsed, { scale: viewScale });
  noteEls.splice(0, noteEls.length, ...rendered.noteEls);
  timeline.splice(0, timeline.length, ...buildTimeline(parsed.notes, currentBpm));
  currentParsed = parsed;
  layoutWidth = els.container.clientWidth;
  return parsed;
}

/**
 * 重新启动进度高亮。
 * 重排会重建一整批音符节点，而 rAF 闭包里的跨帧状态还记着旧的序号，
 * 不重来就不会给新节点上色。
 */
function restartProgress() {
  if (stopProgress) {
    stopProgress();
    stopProgress = null;
  }
  if (playerRef) stopProgress = startProgress(noteEls, timeline, () => playerRef.progressTime());
}

/**
 * 容器宽度变了：只重新断行，不重新解析。
 * 音符、歌词、时间轴都没变，变的只是「这一行放几个小节」。
 */
function relayout() {
  if (!currentParsed) return;
  const width = els.container.clientWidth;
  if (!width || width === layoutWidth) return;
  const rendered = renderNotation(els.container, currentParsed, { scale: viewScale });
  noteEls.splice(0, noteEls.length, ...rendered.noteEls);
  layoutWidth = width;
  restartProgress();
}

/**
 * 按当前缩放重画一遍（全屏进出用）。
 * 只重新排版与绘制，不重新解析：音符、歌词、时间轴都没变。
 */
function rerender() {
  if (!currentParsed) return;
  const rendered = renderNotation(els.container, currentParsed, { scale: viewScale });
  noteEls.splice(0, noteEls.length, ...rendered.noteEls);
  layoutWidth = els.container.clientWidth;
  restartProgress();
}

/** 进入 / 退出全屏看谱：放大谱面、隐藏页面其余部分，Esc 或按钮退出 */
function setFullscreen(on) {
  if (on === isFullscreen) return;
  isFullscreen = on;
  viewScale = on ? FULLSCREEN_SCALE : 1;

  document.body.classList.toggle('nt-fullscreen', on);
  els.fullscreenBtn.setAttribute('aria-pressed', String(on));
  if (on) els.fsTitle.textContent = els.title.textContent;

  // 先切 class、再读 clientWidth：rerender 会按新宽度重新装小节
  rerender();

  if (on) {
    els.fsExit.focus({ preventScroll: true });
    // 桌面浏览器用原生全屏；iOS Safari 没有元素级全屏，CSS 铺满照样可用
    try {
      const request = els.stage.requestFullscreen?.();
      if (request && typeof request.catch === 'function') request.catch(() => {});
    } catch {
      // 原生全屏不可用或被拒绝：CSS 铺满已经生效，不用管
    }
  } else {
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        const exit = document.exitFullscreen();
        if (exit && typeof exit.catch === 'function') exit.catch(() => {});
      }
    } catch {
      // 已经退出原生全屏了，忽略
    }
    els.fullscreenBtn.focus({ preventScroll: true });
  }
}

function initFullscreen() {
  els.fullscreenBtn.addEventListener('click', () => setFullscreen(true));
  els.fsExit.addEventListener('click', () => setFullscreen(false));

  // 用浏览器原生全屏时，按 Esc / 浏览器手势退出也要把页面恢复原样
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isFullscreen) {
      if (!els.shareModal.hidden) closeShare();
      setFullscreen(false);
    }
  });

  // 没有原生全屏（iOS Safari）时，Esc 只对键盘有意义，但留着不碍事
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isFullscreen) setFullscreen(false);
  });
}

/* ---------- 分享曲谱图 ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function safeFileName(value) {
  const name = String(value || '曲谱')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return name || '曲谱';
}

function svgNode(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function svgText(content, attrs = {}) {
  const node = svgNode('text', attrs);
  node.textContent = content;
  return node;
}

/**
 * 把当前曲谱的全部 SVG 行拼成一张适合分享的长图。
 * 坐标沿用 notation.js 的「逻辑坐标」，外层只做一次整体 scale。
 */
function buildShareSvg() {
  const lineNodes = [...els.container.querySelectorAll('svg.nt-line')];
  if (!lineNodes.length) throw new Error('还没有可分享的曲谱');

  const lines = lineNodes.map((svg) => {
    const box = svg.viewBox && svg.viewBox.baseVal;
    const width = box && box.width ? box.width : (parseFloat(svg.getAttribute('width')) || 0);
    const height = box && box.height ? box.height : (parseFloat(svg.getAttribute('height')) || 96);
    return { svg, width, height };
  }).filter((line) => line.width > 0);
  if (!lines.length) throw new Error('曲谱没有可用的排版尺寸');

  const maxLineWidth = Math.max(...lines.map((line) => line.width));
  const lineHeight = Math.max(...lines.map((line) => line.height));
  const pad = 56;
  const headerHeight = 176;
  const gap = 10;

  // 输出宽度约 1200px；行数特别多时再按最大高度缩一点
  let scale = Math.min(2.6, (1200 - pad * 2) / maxLineWidth);
  const heightFor = (value) => headerHeight
    + lines.length * lineHeight * value
    + (lines.length - 1) * gap
    + pad;
  if (heightFor(scale) > 8000) {
    scale = (8000 - headerHeight - pad - (lines.length - 1) * gap)
      / (lines.length * lineHeight);
  }
  scale = Math.max(0.8, scale);

  const width = Math.ceil(maxLineWidth * scale + pad * 2);
  const height = Math.ceil(heightFor(scale));

  const out = svgNode('svg', {
    xmlns: SVG_NS,
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
  });

  const style = svgNode('style');
  style.textContent = `
    text { font-family: "Times New Roman", Times, "Songti SC", "SimSun", serif; }
    .nt-digit { fill: #2d2823; }
    .nt-rest { fill: #8a7f73; }
    .nt-accidental { fill: #2d2823; }
    .nt-dot { fill: #2d2823; }
    .nt-tie { fill: #2d2823; }
    .nt-underline, .nt-barline { stroke: #2d2823; stroke-width: 1.2; }
    .nt-barfill { fill: #2d2823; }
    .nt-lyric { fill: #8a7f73; }
    .nt-mark { fill: transparent; }
  `;
  out.appendChild(style);

  out.appendChild(svgNode('rect', {
    x: 0, y: 0, width, height, fill: '#faf7f2',
  }));

  const title = (els.title.textContent || '曲谱').trim();
  const subtitle = els.subtitle.hidden ? '' : (els.subtitle.textContent || '').trim();
  const byline = els.byline.hidden ? '' : (els.byline.textContent || '').trim();
  const titleSize = Math.max(22, Math.min(46, (width - pad * 2 - 24) / Math.max(title.length, 1)));
  const subtitleSize = Math.max(14, Math.min(21, (width - pad * 2 - 24) / Math.max(subtitle.length || 1, 1)));
  const bylineSize = Math.max(13, Math.min(19, (width - pad * 2 - 24) / Math.max(byline.length || 1, 1)));

  out.appendChild(svgNode('rect', {
    x: pad, y: 54, width: 5, height: 40, rx: 2, fill: '#c1633a',
  }));
  out.appendChild(svgText(title, {
    x: pad + 16, y: 88,
    style: 'font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;',
    'font-size': titleSize, 'font-weight': 700, fill: '#2d2823',
  }));

  if (subtitle) {
    out.appendChild(svgText(subtitle, {
      x: pad + 16, y: 122, 'font-size': subtitleSize, fill: '#8a7f73',
    }));
  }
  if (byline) {
    out.appendChild(svgText(byline, {
      x: pad + 16, y: subtitle ? 152 : 124, 'font-size': bylineSize, fill: '#8a7f73',
    }));
  }

  out.appendChild(svgNode('line', {
    x1: pad, y1: headerHeight - 12, x2: width - pad, y2: headerHeight - 12,
    stroke: '#e7ded2', 'stroke-width': 1,
  }));

  const contentWidth = width - pad * 2;
  let y = headerHeight;
  for (const line of lines) {
    const x = pad + (contentWidth - line.width * scale) / 2;
    const group = svgNode('g', { transform: `translate(${x} ${y}) scale(${scale})` });
    for (const child of line.svg.childNodes) {
      group.appendChild(child.cloneNode(true));
    }
    out.appendChild(group);
    y += line.height * scale + gap;
  }

  return { svg: out, width, height };
}

function svgToPng(svg, width, height) {
  return new Promise((resolve, reject) => {
    const xml = new XMLSerializer().serializeToString(svg);
    const source = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(source);
    const image = new Image();

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#faf7f2';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error('图片编码失败'));
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG 转图片失败'));
    };
    image.src = url;
  });
}

function closeShare() {
  if (els.shareModal.hidden) return;
  shareRequest += 1;
  els.shareModal.hidden = true;
  document.body.classList.remove('share-open');

  if (shareUrl) {
    URL.revokeObjectURL(shareUrl);
    shareUrl = '';
  }
  shareBlob = null;
  els.shareImage.removeAttribute('src');
  els.shareImage.hidden = true;
  els.shareDownload.hidden = true;
  els.shareNative.hidden = true;

  if (shareReturnFocus && typeof shareReturnFocus.focus === 'function') {
    shareReturnFocus.focus({ preventScroll: true });
  }
  shareReturnFocus = null;
}

async function openShare() {
  if (!currentParsed || !els.shareModal.hidden) return;

  const requestId = (shareRequest += 1);
  shareReturnFocus = document.activeElement;
  els.shareModal.hidden = false;
  document.body.classList.add('share-open');
  els.shareImage.hidden = true;
  els.shareImage.removeAttribute('src');
  els.shareStatus.hidden = false;
  els.shareDownload.hidden = true;
  els.shareNative.hidden = true;
  setStatus(els.shareStatus, '正在生成曲谱图片…');
  els.shareClose.focus({ preventScroll: true });

  try {
    const { svg, width, height } = buildShareSvg();
    const blob = await svgToPng(svg, width, height);
    if (requestId !== shareRequest || els.shareModal.hidden) return;

    if (shareUrl) URL.revokeObjectURL(shareUrl);
    shareBlob = blob;
    shareUrl = URL.createObjectURL(blob);
    shareFileName = `${safeFileName(els.title.textContent)}-简谱.png`;

    els.shareImage.src = shareUrl;
    els.shareImage.alt = `${els.title.textContent || '曲谱'} 简谱`;
    els.shareImage.title = '点击查看原图';
    els.shareImage.hidden = false;
    els.shareStatus.hidden = true;
    els.shareDownload.hidden = false;

    try {
      const file = new File([blob], shareFileName, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        els.shareNative.hidden = false;
      }
    } catch {
      // 浏览器不支持 File 构造：只保留下载
    }
  } catch (err) {
    console.error(err);
    if (requestId === shareRequest) {
      setStatus(els.shareStatus, `生成失败：${err.message}`, true);
    }
  }
}

function downloadShare() {
  if (!shareUrl) return;
  const link = document.createElement('a');
  link.href = shareUrl;
  link.download = shareFileName || '曲谱.png';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function nativeShare() {
  if (!shareBlob) return;
  try {
    const file = new File([shareBlob], shareFileName, { type: 'image/png' });
    await navigator.share({
      files: [file],
      title: els.title.textContent || '曲谱',
    });
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      setStatus(els.shareStatus, `系统分享失败：${err.message}`, true);
      els.shareStatus.hidden = false;
    }
  }
}

function initShare() {
  els.fsShare.addEventListener('click', openShare);
  els.shareClose.addEventListener('click', closeShare);
  els.shareDownload.addEventListener('click', downloadShare);
  els.shareNative.addEventListener('click', nativeShare);
  els.shareImage.addEventListener('click', () => {
    if (shareUrl) window.open(shareUrl, '_blank', 'noopener');
  });

  els.shareModal.addEventListener('click', (event) => {
    if (event.target === els.shareModal) closeShare();
  });

  // 弹层打开时先关弹层，别让 Esc 同时退出全屏
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.shareModal.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeShare();
    }
  }, true);
}

/** 监听容器宽度：优先 ResizeObserver（比 window.resize 准，手机地址栏收起也会触发） */
function watchWidth() {
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(relayout, 120);
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(els.container);
  } else {
    window.addEventListener('resize', schedule);
  }
}

/** 谱面总时长（秒），用来判定「播放到底」 */
function totalSeconds() {
  return timeline.length ? timeline[timeline.length - 1].end : 0;
}

function setControlsEnabled(enabled) {
  [els.play, els.pause, els.stop, els.fsPlay, els.fsPause, els.fsStop]
    .forEach((btn) => { btn.disabled = !enabled; });
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
  // 用 restartProgress 而不是直接 startProgress：全屏切换可能已经启动过一条
  // 进度动画（此时进度时间还是 null），先停掉旧的，避免两条 rAF 同时跑。
  restartProgress();

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

  // 全屏栏上的播放控制：与工具栏按钮同一套播放器
  els.fsPlay.addEventListener('click', () => { player.play(); });
  els.fsPause.addEventListener('click', () => { player.pause(); });
  els.fsStop.addEventListener('click', () => { player.stop(); });
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

  // 每首歌的默认速度写在 index.json 的 bpm 里；0 或没写就用 120
  if (Number.isFinite(score.bpm) && score.bpm > 0) currentBpm = score.bpm;

  originalNotation = score.notation || '';
  try {
    renderNotationToPage(originalNotation);
  } catch (err) {
    console.error(err);
    setStatus(els.playStatus, `简谱渲染失败：${err.message}`, true);
    return;
  }

  initEditor();
  initFullscreen();
  initShare();
  watchWidth();
  await initPlayer(score);
}

main();
