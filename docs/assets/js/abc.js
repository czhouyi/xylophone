/**
 * abc.js — 把解析好的简谱转成 abcjs 用的 ABC 谱
 *
 * 曲谱数据里只保留 notation（简谱）一份谱，播放用的 ABC 在这里运行时生成。
 * 好处是不会再出现「改了简谱忘了改 ABC」——两边本来就是同一份数据。
 *
 * 简谱是首调记谱（1 2 3 4 5 6 7 是音级），ABC 是固定音高，
 * 所以中间要按调性把音级翻译成音名，并处理调号与临时升降号。
 */

/** 大调音阶：音级 1..7 对应的音名（含该调号内的升降） */
const SCALE = {
  C: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
  G: ['G', 'A', 'B', 'C', 'D', 'E', 'F#'],
  D: ['D', 'E', 'F#', 'G', 'A', 'B', 'C#'],
  A: ['A', 'B', 'C#', 'D', 'E', 'F#', 'G#'],
  E: ['E', 'F#', 'G#', 'A', 'B', 'C#', 'D#'],
  B: ['B', 'C#', 'D#', 'E', 'F#', 'G#', 'A#'],
  'F#': ['F#', 'G#', 'A#', 'B', 'C#', 'D#', 'E#'],
  F: ['F', 'G', 'A', 'Bb', 'C', 'D', 'E'],
  Bb: ['Bb', 'C', 'D', 'Eb', 'F', 'G', 'A'],
  Eb: ['Eb', 'F', 'G', 'Ab', 'Bb', 'C', 'D'],
  Ab: ['Ab', 'Bb', 'C', 'Db', 'Eb', 'F', 'G'],
  Db: ['Db', 'Eb', 'F', 'Gb', 'Ab', 'Bb', 'C'],
  Gb: ['Gb', 'Ab', 'Bb', 'Cb', 'Db', 'Eb', 'F'],
};

/** 调号：哪些字母在调内带升降（用来决定要不要写临时记号） */
const KEY_SIGNATURE = {
  C: {},
  G: { F: 1 },
  D: { F: 1, C: 1 },
  A: { F: 1, C: 1, G: 1 },
  E: { F: 1, C: 1, G: 1, D: 1 },
  B: { F: 1, C: 1, G: 1, D: 1, A: 1 },
  'F#': { F: 1, C: 1, G: 1, D: 1, A: 1, E: 1 },
  F: { B: -1 },
  Bb: { B: -1, E: -1 },
  Eb: { B: -1, E: -1, A: -1 },
  Ab: { B: -1, E: -1, A: -1, D: -1 },
  Db: { B: -1, E: -1, A: -1, D: -1, G: -1 },
  Gb: { B: -1, E: -1, A: -1, D: -1, G: -1, C: -1 },
};

const ABC_LENGTH = '1/4';   // ABC 默认音符长度：四分音符 = 1 拍
const FALLBACK_METER = '4/4';

/** 把音名拆成字母与升降：'C#' -> { letter: 'C', alter: 1 } */
function parsePitchName(name) {
  const letter = name[0];
  let alter = 0;
  for (const ch of name.slice(1)) {
    if (ch === '#') alter += 1;
    else if (ch === 'b') alter -= 1;
  }
  return { letter, alter };
}

/** 以四分音符为单位的时值 → ABC 的长度后缀（1 -> ''，0.5 -> '/2'，1.5 -> '3/2'） */
function abcLength(beat) {
  for (const denominator of [1, 2, 4, 8, 16]) {
    const numerator = beat * denominator;
    if (Math.abs(numerator - Math.round(numerator)) < 1e-9) {
      const n = Math.round(numerator);
      if (denominator === 1) return n === 1 ? '' : String(n);
      return (n === 1 ? '' : String(n)) + '/' + denominator;
    }
  }
  return '';
}

/** 临时记号：与调号一致时留空，否则写 ^ / _ / = */
function accidentalMark(alter, signatureAlter) {
  if (alter === signatureAlter) return '';
  if (alter === 0) return '=';
  return alter > 0 ? '^'.repeat(alter) : '_'.repeat(-alter);
}

/**
 * 推断拍号：数每个小节有多少拍，取出现最多的那个。
 *
 * 简谱里没有拍号这个概念，所以只能这样反推。遇到弱起、变拍子这类谱面，
 * 反推会不准——那种情况请显式写 meter(3/4)。
 */
export function inferMeter(parsed, fallback = FALLBACK_METER) {
  if (parsed.meter) return parsed.meter;   // 谱面里显式写了 meter(3/4) 就以它为准

  const counts = new Map();
  for (const line of parsed.lines) {
    let beats = 0;
    for (const item of line.items) {
      if (item.kind === 'bar') {
        const whole = Math.round(beats);
        if (whole > 0) counts.set(whole, (counts.get(whole) || 0) + 1);
        beats = 0;
      } else if (item.kind === 'note') {
        beats += item.beat;
      }
    }
  }

  let best = 0;
  let bestCount = 0;
  for (const [beats, count] of counts) {
    if (count > bestCount || (count === bestCount && beats > best)) {
      best = beats;
      bestCount = count;
    }
  }
  return best > 0 ? `${best}/4` : fallback;
}

/**
 * 生成 ABC 的谱面正文（不含 X/T/M/L/Q/K 这些头部字段）。
 * 单独导出是为了让自检能对着它做校验。
 */
export function buildBody(parsed, key) {
  const scale = SCALE[key] || SCALE.C;
  const signature = KEY_SIGNATURE[key] || {};
  const lines = [];

  for (const line of parsed.lines) {
    const parts = [];
    for (const item of line.items) {
      if (item.kind === 'bar') {
        parts.push(item.style === '||' ? '||' : item.style === '|]' ? '|]' : '|');
        continue;
      }

      const length = abcLength(item.beat);
      if (item.pitch === '0') {
        parts.push('z' + length);
        continue;
      }

      const base = parsePitchName(scale[Number(item.pitch) - 1]);
      let alter = base.alter;
      for (const ch of item.accidental) {
        if (ch === '#') alter += 1;
        else if (ch === 'b') alter -= 1;
        else if (ch === 'n') alter = 0;
      }

      const mark = accidentalMark(alter, signature[base.letter] || 0);
      const octaveMarks = item.octave >= 1
        ? "'".repeat(item.octave - 1)
        : ','.repeat(-item.octave);
      const letter = item.octave >= 1 ? base.letter.toLowerCase() : base.letter;

      parts.push(mark + letter + octaveMarks + length);
    }
    lines.push(parts.join(' '));
  }

  return lines.join('\n');
}

/**
 * 拼出完整的 ABC 谱。
 * @param {object} parsed parseNotation 的结果
 * @param {object} [meta] { title, program }，program 是 GM 音色编号
 */
export function toAbc(parsed, meta = {}) {
  const key = parsed.key || 'C';
  const tempo = parsed.bpm || 120;
  const program = meta.program === undefined ? 13 : meta.program;

  return [
    'X:1',
    `T:${meta.title || ''}`,
    `M:${inferMeter(parsed)}`,
    `L:${ABC_LENGTH}`,
    `Q:1/4=${tempo}`,
    `K:${key}`,
    `%%MIDI program ${program}`,
    buildBody(parsed, key),
  ].join('\n');
}
