/**
 * notation.js — 简谱解析与渲染（自研实现）
 *
 * 谱面格式沿用 jianpu.space 的写法，好处是可以直接把现成曲谱粘进来：
 *
 *   1 2 3 4 5 6 7      音高；0 为休止符
 *   #1  b2  n3        升 / 降 / 还原（前缀，可叠写，如 ##1）
 *   1'  1,            高八度 / 低八度（后缀，可叠写，如 1''）
 *   1_  1=            八分音符 / 十六分音符（后缀）
 *   1-                延长一拍（每多一个 - 再多一拍）
 *   1.                附点（最多两个）
 *   |  ||  |]         小节线 / 双纵线 / 终止线
 *   L:歌词            歌词行；一个中文字对一个音符，* 表示该音符不填词
 *   /key(D)           调性，只能写在谱面开头
 *   ｂｐｍ70           速度，只能写在谱面开头
 *
 * 渲染结果是一行一个 <svg>，每个音符是一个
 * <g class="nt-note" data-i="序号">，内部含一个透明的
 * <rect class="nt-mark">；播放进度高亮（startProgress）就是给它加 class。
 */

/* 排版常量 */
const DIGIT_SIZE = 21;   // 数字字号
const LYRIC_SIZE = 14;   // 歌词字号
const DIGIT_W = 14;      // 数字占位宽度
const TIE_W = 22;        // 每个延音横杠的宽度
const DOT_GAP = 5;       // 附点距数字右边缘
const DOT_W = 6;         // 附点之间的间距
const DOT_R = 1.8;       // 附点半径
const MARK_PAD = 3;      // 高亮块相对内容的外扩
const MIN_NOTE_W = 22;   // 单音符最小宽度
const BAR_W = 14;        // 小节线占位宽度
const BASE_Y = 44;       // 数字基线（自 svg 顶部起算）
const LINE_H = 96;       // 单行高度

/* ---------- 解析 ---------- */

/**
 * 从 text[start] 起读一个音符记号。
 * 解析顺序：升降号 → 数字 → 八度 → 时值 → 附点
 * @returns {{note: object, end: number}|null}
 */
function readNote(text, start) {
  let i = start;

  let accidental = '';
  while (i < text.length && '#bn'.includes(text[i])) accidental += text[i++];

  const digit = text[i];
  if (digit === undefined || digit < '0' || digit > '7') return null;
  i += 1;

  let octave = 0;
  while (text[i] === "'" || text[i] === ',') octave += text[i++] === "'" ? 1 : -1;

  // '-' 表示延长，'=' / '_' 表示减时线，两者互斥
  let type = 0;
  let mul = 1;
  if (text[i] === '-') {
    while (text[i] === '-') { mul += 1; i += 1; }
  } else {
    while (text[i] === '=') { type += 2; i += 1; }
    if (text[i] === '_') { type += 1; i += 1; }
  }

  let dots = 0;
  while (text[i] === '.' && dots < 2) { dots += 1; i += 1; }

  // 时值以四分音符为 1 拍
  const beat = Math.pow(0.5, type) * mul * (2 - Math.pow(0.5, dots));

  return {
    end: i,
    note: {
      kind: 'note',
      pitch: digit,
      accidental,
      octave,
      type,
      mul,
      dots,
      beat,
      lyric: '',
      index: -1,
    },
  };
}

/** 读一个小节线记号 */
function readBar(text, start) {
  if (text[start] !== '|') return null;
  let i = start + 1;
  let kind = '|';
  if (text[i] === '|' || text[i] === ']') {
    kind += text[i];
    i += 1;
  }
  return { item: { kind: 'bar', style: kind }, end: i };
}

/** 解析一行音符 */
function readMusicLine(text) {
  const items = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }

    const bar = readBar(text, i);
    if (bar) { items.push(bar.item); i = bar.end; continue; }

    const read = readNote(text, i);
    if (read) { items.push(read.note); i = read.end; continue; }

    i += 1; // 无法识别就跳过
  }
  return items;
}

/**
 * 摘掉行内的 key(X) / bpmNN 标记。
 * 必须真摘掉而不是只跳过：否则 “bpm88” 里的 8 会被当成音符。
 */
function stripDirectives(line, state) {
  let out = line;

  const keyMatch = /\/?key\(\s*([A-Ga-g])([#b]?)\s*\)/.exec(out);
  if (keyMatch) {
    if (!state.key) state.key = keyMatch[1].toUpperCase() + keyMatch[2];
    out = out.replace(keyMatch[0], ' ');
  }

  const bpmMatch = /[ｂb][ｐp][ｍm]\s*([0-9.]+)/.exec(out);
  if (bpmMatch) {
    const value = Number.parseFloat(bpmMatch[1]);
    if (value >= 20 && value <= 500) state.bpm = value;
    out = out.replace(bpmMatch[0], ' ');
  }

  return out;
}

/**
 * 把一行歌词切成与音符一一对应的槽位。
 * 规则：空白分隔；`*` 表示"这个音符不唱词"；其余按字切（英文用 - 分音节）。
 */
function splitLyric(text) {
  const slots = [];
  for (const chunk of text.split(/\s+/)) {
    if (!chunk) continue;
    if (chunk === '*') { slots.push(''); continue; }
    if (/^[\x20-\x7F]+$/.test(chunk) && chunk.includes('-')) {
      for (const part of chunk.split('-')) slots.push(part);
      continue;
    }
    // '_' 表示前一个字的音延续到这个音符上，占位但不显示
    for (const ch of chunk) slots.push(ch === '_' ? '' : ch);
  }
  return slots;
}

/**
 * 解析整份谱面。
 * @returns {{key: string|null, bpm: number|null, lines: Array, notes: Array}}
 */
export function parseNotation(text) {
  const lines = [];
  const state = { key: null, bpm: null };
  let pendingMusic = null; // 等待配对歌词的音乐行

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('L:')) {
      if (pendingMusic) {
        pendingMusic.lyric = splitLyric(trimmed.slice(2));
        pendingMusic = null;
      }
      continue;
    }

    const line = stripDirectives(trimmed, state);
    const items = readMusicLine(line);
    if (items.length) {
      const entry = { items, lyric: [] };
      lines.push(entry);
      pendingMusic = entry;
    }
  }

  // 歌词逐字分给能唱的音符（休止符 0 不占歌词位）
  const notes = [];
  for (const line of lines) {
    let slot = 0;
    for (const item of line.items) {
      if (item.kind !== 'note') continue;
      if (item.pitch !== '0') {
        item.lyric = line.lyric[slot] || '';
        slot += 1;
      }
      item.index = notes.length;
      notes.push(item);
    }
  }

  return { key: state.key, bpm: state.bpm, lines, notes };
}

/* ---------- 时间轴 ---------- */

/**
 * 按速度把拍数换算成秒，得到每个音符的 [start, end)。
 * @param {Array} notes parseNotation 产出的音符数组
 * @param {number} bpm 每分钟四分音符数
 */
export function buildTimeline(notes, bpm) {
  const secondsPerBeat = 60 / (bpm > 0 ? bpm : 120);
  let cursor = 0;
  return notes.map((note) => {
    const start = cursor;
    cursor += note.beat * secondsPerBeat;
    return { start, end: cursor };
  });
}

/* ---------- 播放进度 ---------- */

/** 清掉所有高亮，回到三态里的“未播放” */
export function resetProgress(noteEls, state) {
  for (const node of noteEls) {
    if (node) node.classList.remove('past', 'current');
  }
  state.prevIndex = -1;
}

/**
 * 画一帧：把播放位置 time 映射成 已播放 past / 正在播放 current / 未播放（无类）。
 *
 * 不碰定时器——跨帧状态放在 state 里由调用方持有，
 * 所以测试可以逐帧确定性驱动，不用等真实的动画帧。
 *
 * @param {Array<Element>} noteEls renderNotation 产出的音符 <g>
 * @param {Array<{start:number,end:number}>} timeline buildTimeline 产出的时间轴
 * @param {number|null} time 播放位置（秒）；null 表示当前没有进度（未播放 / 已停止）
 * @param {{prevTime:number, prevIndex:number}} state 跨帧状态，原地更新
 */
export function paintProgress(noteEls, timeline, time, state) {
  if (time == null) {
    // 三态里的“未播放”：不留任何高亮
    if (state.prevIndex !== -1) resetProgress(noteEls, state);
    state.prevTime = -1;
    return;
  }
  if (!timeline.length) return;

  if (time + 0.05 < state.prevTime) resetProgress(noteEls, state); // 时间回退：停止或重新播放
  state.prevTime = time;

  let index = timeline.length;
  for (let i = Math.max(state.prevIndex, 0); i < timeline.length; i += 1) {
    if (time < timeline[i].end) { index = i; break; }
  }
  if (index === state.prevIndex) return;

  // 从上一个"正在播放"到新的位置之间，统统记为已播放
  for (let i = Math.max(state.prevIndex, 0); i < index && i < timeline.length; i += 1) {
    const node = noteEls[i];
    if (!node) continue;
    node.classList.remove('current');
    node.classList.add('past');
  }
  if (index < timeline.length && noteEls[index]) {
    noteEls[index].classList.add('current');
  }
  state.prevIndex = index;
}

/**
 * 用动画帧持续把播放位置画成三态高亮。
 * 时间来源由 getTime() 注入，而不是直接抓播放器对象：
 * 这样换播放器不用改这里，测试也能喂假时间。
 *
 * @param {() => number|null} getTime 取当前播放位置（秒）；null 表示未播放 / 已停止
 * @returns {() => void} 停止函数（取消动画帧）
 */
export function startProgress(noteEls, timeline, getTime) {
  const state = { prevTime: -1, prevIndex: -1 };
  let raf = 0;

  resetProgress(noteEls, state);

  const tick = () => {
    raf = requestAnimationFrame(tick);
    paintProgress(noteEls, timeline, getTime(), state);
  };
  tick();

  return () => cancelAnimationFrame(raf);
}

/* ---------- 渲染 ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
  }
  return node;
}

function text(content, attrs) {
  const node = el('text', attrs);
  node.textContent = content;
  return node;
}

/** 粗略估算文本宽度：CJK 按全宽、其余按半宽 */
export function estimateTextWidth(value, fontSize) {
  let width = 0;
  for (const ch of String(value)) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? fontSize : fontSize * 0.56;
  }
  return width;
}

const ACCIDENTAL_GLYPH = { '#': '\u266F', b: '\u266D', n: '\u266E' };

function accidentalGlyphs(accidental) {
  return [...accidental].map((ch) => ACCIDENTAL_GLYPH[ch] || ch).join('');
}

/**
 * 一个音符的横向排版。
 *
 * 渲染和播放高亮共用这一份计算，避免两边各算一套导致高亮块和数字对不齐。
 * 内容（升降号 + 数字 + 延音杠/附点）在槽位里居中，槽位宽度就代表这个音占的版面。
 */
function layoutNote(note) {
  const accidental = accidentalGlyphs(note.accidental);
  const accidentalW = accidental ? estimateTextWidth(accidental, DIGIT_SIZE * 0.62) : 0;
  const tieCount = Math.max(0, note.mul - 1);
  const dotW = note.dots ? DOT_GAP + (note.dots - 1) * DOT_W + DOT_R * 2 : 0;
  const contentW = accidentalW + DIGIT_W + Math.max(tieCount * TIE_W, dotW);
  const lyricW = note.lyric ? estimateTextWidth(note.lyric, LYRIC_SIZE) : 0;
  const slotW = Math.max(MIN_NOTE_W, contentW, lyricW);
  return { accidental, accidentalW, tieCount, contentW, slotW };
}

function measureNote(note) {
  return layoutNote(note).slotW;
}

function drawNote(note, x) {
  const group = el('g', { class: 'nt-note', 'data-i': note.index });
  const { accidental, accidentalW, tieCount, contentW, slotW } = layoutNote(note);

  const contentX = x + (slotW - contentW) / 2;   // 内容在槽位里居中
  const digitX = contentX + accidentalW + DIGIT_W / 2;

  // 高亮块只包住数字本身（升降号 + 数字）并居中于它：
  // 延音杠、附点不参与，这样不管音符多宽，数字都正好落在块的正中。
  // （默认透明，播放时由 CSS 上色）
  const markW = accidentalW + DIGIT_W + MARK_PAD * 2;
  const mark = el('rect', {
    x: digitX - markW / 2,
    y: BASE_Y - DIGIT_SIZE - 12,
    width: markW,
    height: DIGIT_SIZE + 26,
    rx: 3,
    class: 'nt-mark',
  });
  group.appendChild(mark);

  const isRest = note.pitch === '0';

  if (accidental) {
    group.appendChild(text(accidental, {
      x: contentX,
      y: BASE_Y - 1,
      class: 'nt-accidental',
      'font-size': DIGIT_SIZE * 0.62,
    }));
  }

  group.appendChild(text(note.pitch, {
    x: digitX,
    y: BASE_Y,
    class: isRest ? 'nt-digit nt-rest' : 'nt-digit',
    'font-size': DIGIT_SIZE,
    'text-anchor': 'middle',
  }));

  // 八度点：高八度在上方叠加，低八度在减时线之下
  for (let i = 0; i < note.octave; i += 1) {
    group.appendChild(el('circle', {
      cx: digitX,
      cy: BASE_Y - DIGIT_SIZE - 7 - i * 6,
      r: 1.7,
      class: 'nt-dot',
    }));
  }
  const lowDotBase = BASE_Y + 8 + note.type * 5;
  for (let i = 0; i < -note.octave; i += 1) {
    group.appendChild(el('circle', {
      cx: digitX,
      cy: lowDotBase + i * 6,
      r: 1.7,
      class: 'nt-dot',
    }));
  }

  // 减时线（下划线）：铺满整个槽位，相邻音符的线自然接成一条；
  // 跨小节时中间隔着小节线的空位，会正确断开
  for (let i = 0; i < note.type; i += 1) {
    const y = BASE_Y + 7 + i * 5;
    group.appendChild(el('line', {
      x1: x,
      y1: y,
      x2: x + slotW,
      y2: y,
      class: 'nt-underline',
    }));
  }

  // 附点
  for (let i = 0; i < note.dots; i += 1) {
    group.appendChild(el('circle', {
      cx: digitX + DIGIT_W / 2 + DOT_GAP + i * DOT_W,
      cy: BASE_Y - DIGIT_SIZE * 0.32,
      r: DOT_R,
      class: 'nt-dot',
    }));
  }

  // 延音横杠
  for (let i = 0; i < tieCount; i += 1) {
    const dashX = contentX + accidentalW + DIGIT_W + i * TIE_W;
    group.appendChild(text('-', {
      x: dashX + TIE_W / 2,
      y: BASE_Y,
      class: 'nt-tie',
      'font-size': DIGIT_SIZE,
      'text-anchor': 'middle',
    }));
  }

  // 歌词
  if (note.lyric) {
    group.appendChild(text(note.lyric, {
      x: x + slotW / 2,
      y: BASE_Y + 34,
      class: 'nt-lyric',
      'font-size': LYRIC_SIZE,
      'text-anchor': 'middle',
    }));
  }

  return group;
}

function drawBar(style, x) {
  const group = el('g', { class: 'nt-bar' });
  const top = BASE_Y - DIGIT_SIZE - 8;
  const bottom = BASE_Y + 10;
  const line = (offset) => el('line', {
    x1: x + offset,
    y1: top,
    x2: x + offset,
    y2: bottom,
    class: 'nt-barline',
  });
  const count = style === '||' || style === '|]' ? 2 : 1;
  if (style === '|]') {
    group.appendChild(line(0));
    group.appendChild(el('rect', {
      x: x + 4,
      y: top,
      width: 2.5,
      height: bottom - top,
      class: 'nt-barfill',
    }));
  } else {
    for (let i = 0; i < count; i += 1) group.appendChild(line(i * 5));
  }
  return group;
}

/**
 * 把解析结果渲染进容器。
 * @returns {{noteEls: Array<Element>, lineEls: Array<Element>}}
 */
export function renderNotation(container, parsed) {
  container.textContent = '';
  const noteEls = new Array(parsed.notes.length);
  const lineEls = [];

  for (const line of parsed.lines) {
    const measured = [];
    let width = 0;

    for (const item of line.items) {
      const itemWidth = item.kind === 'note' ? measureNote(item) : BAR_W;
      measured.push({ item, width: itemWidth });
      width += itemWidth;
    }
    if (!measured.length) continue;

    const svg = el('svg', {
      class: 'nt-line',
      width: Math.max(width + 8, 40),
      height: LINE_H,
      viewBox: `0 0 ${Math.max(width + 8, 40)} ${LINE_H}`,
    });

    let x = 4;
    for (const entry of measured) {
      if (entry.item.kind === 'note') {
        const group = drawNote(entry.item, x);
        svg.appendChild(group);
        noteEls[entry.item.index] = group;
      } else {
        svg.appendChild(drawBar(entry.item.style, x));
      }
      x += entry.width;
    }

    container.appendChild(svg);
    lineEls.push(svg);
  }

  return { noteEls, lineEls };
}
