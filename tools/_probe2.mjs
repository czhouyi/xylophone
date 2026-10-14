// 临时：渲染用户给的片段，按减时线层级 dump 分组（用完即删）
import { parseNotation, renderNotation } from '../docs/assets/js/notation.js';

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

globalThis.document = { createElementNS: (_ns, name) => new StubNode(name) };

const walk = (node, fn) => { fn(node); for (const c of node.childNodes) walk(c, fn); };

const CASES = [
  ['你这条消息里的写法（八分）', '/key(C)\n3_. 1= 5_5_5_ | 3_0_1_0_|'],
  ['谱面文件里的写法（十六分）', '/key(C)\n3_. 1= 5=5=5= | 3_0_1_0_|'],
];

for (const [label, INPUT] of CASES) {
const parsed = parseNotation(INPUT);

console.log(`\n========== ${label} ==========`);
console.log('输入：', JSON.stringify(INPUT.split('\n')[1]));
console.log('解析出的音符：');
for (const it of parsed.lines[0].items) {
  if (it.kind === 'bar') console.log(`  小节线 |`);
  else console.log(`  ${it.pitch}  时值=${it.beat} 拍`);
}

// 小节内的拍位（renderNotation 的算法）
const notes = parsed.lines[0].items.filter((it) => it.kind === 'note');
let beat = 0;
let barNo = 1;
console.log('\n小节内拍位与 floor（决定减时线分组）：');
for (const it of parsed.lines[0].items) {
  if (it.kind === 'bar') { beat = 0; barNo += 1; continue; }
  const f = Math.floor(beat + 1e-9);
  console.log(`  第${barNo}小节 ${it.pitch}  拍位=${beat.toFixed(2)}  floor=${f}`);
  beat += it.beat;
}

const container = new StubNode('div');
renderNotation(container, parsed);

const digis = [];
const segs = [];
walk(container, (n) => {
  if (n.nodeName === 'text' && n.classList.contains('nt-digit')) digis.push(n);
  if (n.nodeName === 'line' && n.classList.contains('nt-underline')) {
    segs.push({
      y: Number(n.attrs.y1),
      x1: Number(n.attrs.x1),
      x2: Number(n.attrs.x2),
    });
  }
});

console.log('\n数字 x：', digis.map((d) => Number(d.attrs.x).toFixed(1)).join('  '));

const layers = [...new Set(segs.map((s) => s.y))].sort((a, b) => a - b);
layers.forEach((y, i) => {
  const layer = segs.filter((s) => s.y === y).sort((a, b) => a.x1 - b.x1);
  console.log(`\n第 ${i + 1} 层减时线（y=${y}）共 ${layer.length} 段：`);
  layer.forEach((s, k) => {
    const prev = layer[k - 1];
    const join = prev ? (Math.abs(s.x1 - prev.x2) < 0.001 ? '相接' : `断开(${(s.x1 - prev.x2).toFixed(1)}px)`) : '';
    console.log(`  [${s.x1.toFixed(1)} → ${s.x2.toFixed(1)}] ${join}`);
  });
});
}
