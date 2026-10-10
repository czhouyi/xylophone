/** _probe.mjs — 临时调查：soundfont 可达性 + abcjs 6.3.0 的音色加载逻辑（用完即删） */
const SF = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/';

for (const file of ['xylophone-mp3.js', 'xylophone-ogg.js', 'xylophone-mp3-mp3.js']) {
  try {
    const res = await fetch(SF + file, { method: 'GET' });
    const text = await res.text();
    console.log(`GET ${file} -> ${res.status} len=${text.length} ` +
      `ACAO=${res.headers.get('access-control-allow-origin')} ` +
      `ct=${res.headers.get('content-type')}`);
    console.log(`   head: ${text.slice(0, 120).replace(/\n/g, ' ')}`);
  } catch (err) {
    console.log(`GET ${file} -> ERROR ${err.message}`);
  }
}

const res = await fetch('https://cdn.jsdelivr.net/npm/abcjs@6.3.0/dist/abcjs-basic-min.js');
const src = await res.text();
console.log(`\nabcjs-basic-min.js len=${src.length}`);

const needles = [
  '-mp3', '-ogg', 'AudioContext', 'webkitAudioContext', 'resume', 'prime',
  'soundFontUrl', 'createBufferSource', 'decodeAudioData', 'supportsAudio', 'mute',
];
for (const n of needles) {
  const idx = [];
  let i = src.indexOf(n);
  while (i !== -1 && idx.length < 4) { idx.push(i); i = src.indexOf(n, i + 1); }
  console.log(`${n.padEnd(20)} ${idx.length ? idx.map((p) => `@${p}`).join(' ') : '(none)'}`);
}

console.log('\n--- soundfont 相关上下文 ---');
for (const m of src.matchAll(/[^;{}]{0,160}(?:-mp3|-ogg)[^;{}]{0,160}/g)) {
  console.log('  ' + m[0].replace(/\s+/g, ' '));
}
