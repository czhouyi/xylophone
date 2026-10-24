/**
 * score_to_json.mjs — 把 .jianpu 谱面导出成合成视频用的 JSON。
 *
 * 用法：node tools/performance-video/score_to_json.mjs docs/data/scores/two-tigers.jianpu
 *
 * 输出字段：
 *   notes[]  { pitch, accidental, octave, type, mul, dots, beat, lyric, index }
 *   bars[]   每个小节线落在第几个音符之后（用于字幕条画竖线）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseNotation } from '../../docs/assets/js/notation.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node score_to_json.mjs <score.jianpu>');
  process.exit(2);
}

const parsed = parseNotation(readFileSync(file, 'utf8'));

// 小节线：记下它前面已经过了多少个音符
const bars = [];
let seenNotes = 0;
for (const line of parsed.lines) {
  for (const item of line.items) {
    if (item.kind === 'note') seenNotes += 1;
    else if (item.kind === 'bar' && seenNotes > 0) bars.push(seenNotes);
  }
}

const notes = parsed.notes.map((n) => ({
  index: n.index,
  pitch: n.pitch,
  accidental: n.accidental,
  octave: n.octave,
  type: n.type,
  mul: n.mul,
  dots: n.dots,
  beat: n.beat,
  lyric: n.lyric,
}));

process.stdout.write(JSON.stringify({
  source: path.resolve(file),
  key: parsed.key,
  meter: parsed.meter,
  notes,
  bars,
}, null, 2));
