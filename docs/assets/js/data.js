/**
 * data.js — 数据访问层
 *
 * 只有两个数据源，都在 docs/data/scores/ 下：
 *   - index.json       所有曲谱的 meta（标题、词曲作者、难度、标签……）
 *   - <id>.jianpu      单首曲谱的谱面（纯文本简谱，一行一行写着）
 *
 * meta 只在 index.json 里维护一份，详情页不再单独存一份，所以不会出现
 * 「改了标题忘了改列表」。谱面是独立文件，换行就是真的换行。
 * 页面只依赖这里暴露的函数，不直接拼接数据路径。
 */

const SCORE_DIR = new URL('../../data/scores/', import.meta.url);
const INDEX_URL = new URL('index.json', SCORE_DIR);

/** 谱面文件的后缀：docs/data/scores/<id>.jianpu */
const NOTATION_EXT = 'jianpu';

/** 合法曲谱 ID：字母数字开头，只含字母、数字、点、下划线、连字符 */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** index.json 整站只取一次：列表页要，详情页也要 */
let indexPromise = null;

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * 读取曲谱索引（所有曲谱的 meta）。
 * @returns {Promise<Array<object>>} 曲谱 meta 数组
 */
export async function loadScoreList() {
  if (!indexPromise) {
    indexPromise = fetchText(INDEX_URL)
      .then((text) => {
        let data;
        try {
          data = JSON.parse(text);
        } catch (err) {
          throw new Error(`index.json 不是合法 JSON：${err.message}`);
        }
        const scores = Array.isArray(data) ? data : data && data.scores;
        if (!Array.isArray(scores)) {
          throw new Error('index.json 格式不正确：应为 { "scores": [...] }');
        }
        return scores;
      })
      // 失败不缓存，下次进入页面还能重试
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

/**
 * 读取单首曲谱：meta 来自 index.json，谱面来自 <id>.jianpu。
 * 返回值里带 notation，页面用法与以前一致。
 * @param {string} id 曲谱 ID，如 "little-star"
 */
export async function loadScore(id) {
  if (!id || !ID_PATTERN.test(id)) {
    const err = new Error('缺少或非法的曲谱 ID');
    err.code = 'bad-id';
    throw err;
  }

  const scores = await loadScoreList();
  const meta = scores.find((score) => score.id === id);
  if (!meta) {
    const notFound = new Error(`没有找到曲谱「${id}」`);
    notFound.code = 'not-found';
    throw notFound;
  }

  let notation;
  try {
    notation = await fetchText(new URL(`${id}.${NOTATION_EXT}`, SCORE_DIR));
  } catch (err) {
    if (err.status === 404) {
      const missing = new Error(`曲谱「${id}」缺少谱面文件 ${id}.${NOTATION_EXT}`);
      missing.code = 'no-notation';
      throw missing;
    }
    throw err;
  }

  return { ...meta, notation };
}

/** 从当前地址读取曲谱 ID：score.html?id=little-star */
export function getScoreIdFromUrl() {
  return new URLSearchParams(window.location.search).get('id') || '';
}

/** 生成详情页链接 */
export function scoreUrl(id) {
  return `score.html?id=${encodeURIComponent(id)}`;
}

/** 取展示用标题（数据缺失时回退到 ID） */
export function scoreTitle(score) {
  return (score && score.title) || (score && score.id) || '';
}

/**
 * 取展示用署名：唱、曲、词分开写，缺哪个就省哪个。
 *   - 唱曲词都有 → 「唱：陈奕迅　曲：陈辉阳　词：林夕」
 *   - 词曲都有   → 「曲：段福培　词：盛茹茵」
 *   - 只有曲     → 原样显示（「莫扎特 改编」「佚名」）
 *   - 只有词     → 「词：田汉」
 */
export function scoreByline(score) {
  const artist = (score && score.artist) || '';
  const composer = (score && score.composer) || '';
  const lyricist = (score && score.lyricist) || '';

  let credit = '';
  if (composer && lyricist) credit = `曲：${composer}　词：${lyricist}`;
  else if (composer) credit = String(composer);
  else if (lyricist) credit = `词：${lyricist}`;

  if (!artist) return credit;
  return credit ? `唱：${artist}　${credit}` : `唱：${artist}`;
}
