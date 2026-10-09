# xylophone

木琴简谱曲谱库 —— 一个纯静态站点（GitHub Pages），包含**曲谱列表**与**曲谱详情**，
支持在线渲染简谱并用 abcjs 合成音频试听。

## 设计原则

- **数据与页面分离**：曲谱内容全部放在 `docs/data/scores/*.json`，页面不内嵌任何曲谱数据。
- **JS / CSS / HTML 分离**：页面只做结构，样式在 `docs/assets/css/`，逻辑在 `docs/assets/js/`（ES module）。
- **零构建、零依赖安装**：不需要打包工具，push 即可发布。

## 目录结构

```
docs/                          ← GitHub Pages 站点根目录
├── .nojekyll                  ← 让 Pages 跳过 Jekyll 处理
├── index.html                 ← 曲谱列表页
├── score.html                 ← 曲谱详情页（score.html?id=<曲谱ID>）
├── assets/
│   ├── css/
│   │   ├── base.css           ← 变量、排版、通用组件
│   │   ├── list.css           ← 列表页样式
│   │   └── score.css          ← 详情页样式
│   └── js/
│       ├── data.js            ← 数据访问层（唯一读取 JSON 的模块）
│       ├── player.js          ← 音频播放控制器（abcjs 封装）
│       ├── list.js            ← 列表页入口
│       └── score.js           ← 详情页入口
└── data/
    └── scores/
        ├── index.json         ← 曲谱索引（由脚本生成，列表页读取）
        └── little-star.json   ← 单首曲谱（小星星）
tools/
└── build-index.mjs            ← 扫描曲谱文件，重新生成 index.json
```

## 数据格式

单首曲谱 `docs/data/scores/<曲谱ID>.json`：

```jsonc
{
  "id": "little-star",                 // 必须与文件名一致
  "subtitle": "Twinkle Twinkle Little Star",  // 可选，罗马音/英文名
  "difficulty": "入门",                 // 可选
  "tags": ["儿歌"],                    // 可选，列表页标签

  // 音频：拼成 abcjs 谱面的结构化字段（不写 %%MIDI program，音色由页面选择）
  "abc": {
    "title": "小星星",
    "meter": "4/4",
    "length": "1/4",
    "key": "C",
    "body": "C C G G | A A G2 | ..."
  },

  // 简谱：整块原样传给 simple-notation 的 loadData()
  "jianpu": {
    "info": {
      "title": "小星星",            // 详情页标题
      "composer": "莫扎特 改编",     // 详情页署名
      "key": "C", "time": "4", "beat": "4", "tempo": "88"
    },
    "score": "1,1,5,5|6,6,5,-|...",   // 数字谱
    "lyric": "一闪一闪亮晶晶-\n..."    // 歌词（换行对齐乐句）
  }
}
```

说明：`jianpu` 块是渲染引擎的数据契约，字段保持与 simple-notation 一致；
展示用的标题与作曲者直接取自 `jianpu.info`，避免同一信息两处维护。

`docs/data/scores/index.json`（列表页只读这个文件，由脚本生成）：

```jsonc
{
  "scores": [
    { "id": "little-star", "title": "小星星", "subtitle": "...", "composer": "...", "difficulty": "入门", "tags": ["儿歌"] }
  ]
}
```

## 简谱记谱速查（`jianpu.score` 字段）

写法取自 simple-notation 的模板解析器：

| 写法 | 含义 |
| --- | --- |
| `1` … `7` | 四分音符（下划线由库自动绘制） |
| `1/2` / `1/4` | 八分音符 / 十六分音符 |
| `1.` | 附点 |
| `^1` / `_1` | 高八度 / 低八度（可叠加，如 `^^1`） |
| `#1` / `b1` | 升 / 降 |
| `-` | 延音（延长一拍） |
| `|` | 小节线 |
| `,` | 音符分隔符 |
| `(...)` | 连音线 |
| `<1,3,5>` | 和弦 |

- 换行 = 换一行乐谱（stave）。
- **歌词必须与音符逐字对应**，延音位置用 `-` 占位；`node tools/check.mjs` 会校验这一点。

## 新增一首曲谱

1. 在 `docs/data/scores/` 新建 `<曲谱ID>.json`（ID 用小写字母数字与连字符，如 `happy-birthday`），
   按上面的格式填写，`id` 字段与文件名保持一致。
2. 重新生成索引：

   ```bash
   node tools/build-index.mjs
   ```

3. 本地预览确认后提交推送。曲谱详情链接形如 `score.html?id=happy-birthday`。

## 本地预览

页面用 `fetch` 读取 JSON，**不能直接双击 HTML 打开**（`file://` 会被浏览器拦截），
需要起一个静态服务器：

```bash
npx serve docs          # 或： python -m http.server 8000 -d docs
```

## 部署到 GitHub Pages

仓库 → **Settings → Pages**：

- **Source** 选 `Deploy from a branch`
- **Branch** 选 `main`，目录选 **`/docs`**，保存

稍等片刻站点即可访问：

```
https://czhouyi.github.io/xylophone/
```

之后每次往 `main` 推送，Pages 会自动重新发布。

## 第三方依赖（CDN 引入，无需安装）

- [simple-notation](https://www.npmjs.com/package/simple-notation) — 简谱渲染
- [abcjs](https://abcjs.net/) — 音频合成；音色使用 FluidR3_GM 音色库
