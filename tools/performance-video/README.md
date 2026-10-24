# 演奏视频加曲谱字幕条

把竖屏演奏视频和 `.jianpu` 曲谱合成一条新视频：顶部有一条简谱字幕，
已演奏的音变暗、当前音高亮、未演奏的音是浅色，底部是整首曲子的进度条。
高亮时间来自视频自己的音频，不是固定节拍。

## 依赖

- Python 3.9+，`numpy`、`Pillow`
- Node.js（复用 `docs/assets/js/notation.js` 解析谱面）
- ffmpeg（优先找 PATH，找不到用 `--ffmpeg` 指定）

## 用法

Windows 下可以直接用项目根目录的快捷脚本：

```bat
bin\make-video.cmd xiaoxingxing.mp4 little-star.jianpu
bin\make-video.cmd xiaoxingxing.mp4 little-star.jianpu --top-offset 50
bin\make-video.cmd xiaoxingxing.mp4 little-star.jianpu --middle
bin\make-video.cmd xiaoxingxing.mp4 little-star.jianpu --robust
```

它会自动按 `media\input\<视频>`、`docs\data\scores\<曲谱>` 查找，
输出到 `media\output\<视频名>.mp4`；第三个参数可以覆盖输出路径。

- 不传位置参数时，`bin\make-video.cmd` 默认 `--middle`（这个仓库当前的习惯）。
- `--top-offset 50`：字幕条距画面顶部 50px，显式传入时优先于默认的 middle。
- `--middle`：字幕条放在画面垂直中间，避免被手机顶部状态栏挡住。
- `--robust`：强制使用小节锚点对齐；不传时只在起音数不等于音符数时自动启用。

也可以直接调用 Python：

```bash
python tools/performance-video/make_video.py \
  --video "D:/.../两只老虎-木琴.mp4" \
  --score docs/data/scores/two-tigers.jianpu \
  --out media/out.mp4 \
  --top-offset 50
```

曲名默认从 `docs/data/scores/index.json` 里取；也可以加 `--title "小星星"` 覆盖。

导出给网页播放器用的映射：

```bash
python tools/performance-video/make_video.py \
  --video media/input/xiaoxingxing.mp4 \
  --score docs/data/scores/little-star.jianpu \
  --out media/output/xiaoxingxing.mp4 \
  --top-offset 50 \
  --export-map media/output/xiaoxingxing-map.json
```

只想先看一帧排版：

```bash
python tools/performance-video/make_video.py \
  --video "..." --score docs/data/scores/two-tigers.jianpu \
  --out media/out.mp4 \
  --preview media/preview.jpg --preview-time 5 --preview-only
```

## 对齐怎么做的

1. ffmpeg 抽 44.1kHz 单声道 WAV。
2. numpy 做谱通量起音检测（2048 点窗 / 256 hop），最小间隔 120ms。
3. 丢掉强度低于 0.18 的弱起音（开头的环境声、收尾噪声）。
4. 剩下的起音数必须等于音符数，再按顺序一一对应。
   数量不一致时脚本会列出所有起音时间并退出，**不做硬截断**——截断会让后面全盘错位。

这只适合独奏、无伴奏的素材。有伴奏时起音会多出来，需要先分离伴奏或调
`detect_onsets` 里的阈值/最小间隔。

`make_video.py` 默认在「起音数 == 音符数」时走 1:1；数量不一致时自动切到
`align_robust.py` 的小节锚点对齐。`--robust` 可以强制锚点对齐。

## 稳健对齐 / 网页播放器

- [`align_robust.py`](align_robust.py) — 只对齐小节首音（锚点），用带跳过惩罚的
  DP 抵抗漏音/杂音，小节内部按拍数线性插值。`make_video.py` 在起音数不一致时
  会自动调用它；也可以独立接 librosa 的 `onset_times`。
- [`karaoke-demo.html`](karaoke-demo.html) — 纯前端卡拉 OK 同步示例：曲谱在上、
  视频在下，`requestAnimationFrame` 驱动每个音符的 `scaleX` 下划线，支持暂停/拖拽。
  打开后把 `<video src>` 和 `NOTE_TIMES` 换成自己的即可。
- `make_video.py --export-map media/output/map.json` 会把最终映射导出成
  `{ "0": 2.31, "1": 2.71, ... }`，可以直接贴进 `karaoke-demo.html` 的 `NOTE_TIMES`。

## 输出

- 顶部字幕条 240px 高，窗口约 9 个音，随当前音平滑滚动。
- 默认贴顶；`--top-offset 50` 表示距顶部 50px。
- 加 `--middle` 时字幕条放在画面垂直中间（`(视频高 - 240) / 2`），用来避开手机顶部状态栏。
- 当前音有橙色高亮块；八分/十六分画减时线（同一拍的音连成一条），
  长音画增时线，低八度画下面的点，小节线画竖线。
- 源视频是 10-bit HLG（BT.2020）时会先做 HDR→SDR tone map，再叠字幕条。
  如果源是 SDR，需要把 `render`/`preview` 里的 `zscale` + `tonemap` 去掉。
- 音频原样 copy，不重新编码。
