# xylophone

木琴简谱曲谱库 —— 一个纯静态站点（GitHub Pages），包含**曲谱列表**与**曲谱详情**，
支持在线渲染简谱、abcjs 合成音频试听，并带播放进度高亮。

## 设计原则

- **数据与页面分离**：曲谱内容全部放在 `docs/data/scores/*.json`，页面不内嵌任何曲谱数据。
- **JS / CSS / HTML 分离**：页面只做结构，样式在 `docs/assets/css/`，逻辑在 `docs/assets/js/`（ES module）。
- **零构建、零依赖安装**：不需要打包工具，push 即可发布。
- **记谱格式沿用 [jianpu.space](https://jianpu.space) 的写法**：现成曲谱可以直接粘进来。

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
│   │   └── score.css          ← 详情页样式（含简谱与进度三态样式）
│   └── js/
│       ├── data.js            ← 数据访问层（唯一读取 JSON 的模块）
│       ├── notation.js        ← 简谱解析、SVG 渲染、播放进度三态
│       ├── player.js          ← 音频播放控制器（abcjs 封装）
│       ├── list.js            ← 列表页入口
│       └── score.js           ← 详情页入口
└── data/
    └── scores/
        ├── index.json         ← 曲谱索引（由脚本生成，列表页读取）
        └── <曲谱ID>.json      ← 单首曲谱
tools/
├── build-index.mjs            ← 扫描曲谱文件，重新生成 index.json
└── check.mjs                  ← 自检：数据、渲染、进度三态、资源连通性
```

## 数据格式

单首曲谱 `docs/data/scores/<曲谱ID>.json`：

```jsonc
{
  "id": "little-star",                        // 必须与文件名一致
  "title": "小星星",                           // 详情页标题（也用于列表页）
  "composer": "莫扎特 改编",                    // 可选，详情页署名
  "subtitle": "Twinkle Twinkle Little Star",  // 可选，副标题
  "difficulty": "入门",                        // 可选
  "tags": ["儿歌"],                            // 可选，列表页标签

  // 简谱：整块交给 notation.js 解析渲染，格式见下一节
  "notation": "key(C) bpm88\n1155|665-|\nL:一闪一闪亮晶晶\n...",

  // 音频：拼成 abcjs 谱面的结构化字段（音色由页面的下拉框决定，见下方说明）
  "abc": {
    "meter": "4/4",
    "length": "1/4",
    "key": "C",
    "tempo": 88,                              // 必须与 notation 里的 bpm 一致
    "body": "C C G G | A A G2 | ..."
  }
}
```

`docs/data/scores/index.json`（列表页只读这个文件，由脚本生成，不要手改）：

```jsonc
{
  "scores": [
    { "id": "little-star", "title": "小星星", "subtitle": "...", "composer": "...", "difficulty": "入门", "tags": ["儿歌"] }
  ]
}
```

### 为什么同一首要写两份谱

`notation` 负责**看**，`abc` 负责**听**——前者是简谱排版，后者是 abcjs 的音频输入，两套记号不同，目前各自独立维护。
`node tools/check.mjs` 会强制两边的速度一致：**如果 `bpm` 与 `abc.tempo` 对不上，播放进度高亮就会和实际发声错位**。

## 简谱记谱速查（`notation` 字段）

写法沿用 [jianpu.space](https://jianpu.space)，可直接粘贴现成曲谱：

| 写法 | 含义 |
| --- | --- |
| `1` … `7` | 音高；`0` 为休止符 |
| `#1` / `b2` / `n3` | 升 / 降 / 还原（前缀，可叠写，如 `##1`） |
| `1'` / `1,` | 高八度 / 低八度（后缀，可叠写，如 `1''`） |
| `1_` / `1=` | 八分音符 / 十六分音符（后缀） |
| `1-` | 延长一拍（多一个 `-` 就再多一拍） |
| `1.` | 附点（最多两个） |
| `\|` `\|\|` `\|]` | 小节线 / 双纵线 / 终止线 |
| `L:歌词` | 歌词行，紧跟在它所属的乐谱行后面 |
| `/key(D)` | 调性，写在谱面开头 |
| `bpm70` | 速度，写在谱面开头 |

其它约定：

- **一行乐谱 = 谱面上的一行**（常见每行 2~4 小节，跟着乐句走更自然）；`L:` 行必须紧跟在其所属乐谱行下面。
- **歌词与音符逐字对应**：一个中文字对一个可唱音符（休止符 `0` 不占歌词位）。
  需要占位但不显示字时写 `_`（如 `妈妈_好` 让「好」落在后面的音上）；某个音符不填词时用 `*`。
- **标点不占音符位**：`，。！？` 这类标点会跟在它前面那个字后面一起显示，不会多出一个槽位，
  所以带标点的歌词可以直接粘。
- `node tools/check.mjs` 会校验歌词槽位与音符数是否逐行对齐。

## 播放与进度高亮

- 音频由 **abcjs** 合成，音色在下拉框里选（木琴 / 马林巴 / 颤音琴 / 钟琴 / 钢片琴 / 钢琴）。
- 音色切换**在下次播放时生效**（切完会重新加载音色并回到开头）。
- **暂停后再点播放，从暂停处继续**，不会回到开头；「停止」才会回到开头。
- 每个音符在谱面上是三态之一：**已播放**（浅色底）、**正在播放**（高亮底 + 反白字）、**未播放**（无底）。
  进度位置由 `notation.js` 的时间轴按 `bpm` 与拍数换算，播放器只负责提供当前秒数。
  高亮块只包住数字本身，所以不管音符多宽（带延音杠、附点），数字都落在块的正中。
- 播到结尾会提示「播放完毕」并回到未播放状态；小节内连续的八分音符共用一条连在一起的减时线，跨小节会断开。

## 新增一首曲谱

1. 在 `docs/data/scores/` 新建 `<曲谱ID>.json`（ID 用小写字母数字与连字符，如 `happy-birthday`），
   按上面的格式填写，`id` 字段与文件名保持一致。
2. 重新生成索引并自检：

   ```bash
   node tools/build-index.mjs
   node tools/check.mjs
   ```

3. 本地预览确认后提交推送。曲谱详情链接形如 `score.html?id=happy-birthday`。

## 自检

```bash
node tools/check.mjs
```

会检查这些事（任一失败即退出码非 0）：

- 每首曲谱 JSON 可解析、没有 BOM / 乱码、必需字段齐全、`id` 与文件名一致；
- `index.json` 与实际曲谱文件双向一致；
- 简谱能解析出音符、歌词与音符逐行对齐、`bpm` 与 `abc.tempo` 一致；
- 渲染出的音符节点数与解析结果一致、序号连续；
- 播放进度三态在起点 / 跨音 / 播完 / 时间回退 / 未播放时都正确；
- 音色编号解析正确（钢琴是 GM 0，不能被当成空值吞掉），下拉默认项与代码默认一致；
- HTML 引用的本地资源都存在、JS 用到的 DOM id 都存在；
- 起临时服务器逐个 URL 探活（页面 / 样式 / 脚本 / 数据 / 404）。

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

- [abcjs](https://abcjs.net/) — 音频合成；音色使用 FluidR3_GM 音色库

简谱渲染是本站自研的（`docs/assets/js/notation.js`），不依赖任何外部简谱库。
