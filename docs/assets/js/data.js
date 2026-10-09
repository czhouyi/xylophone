/**
 * data.js — 数据访问层
 *
 * 唯一负责读取 docs/data/scores/ 下 JSON 的模块：
 *   - index.json          曲谱索引（列表页用）
 *   - <id>.json           单首曲谱（详情页用）
 *
 * 页面只依赖这里暴露的函数，不直接拼接数据路径。
 */

const SCORE_DIR = new URL('../../data/scores/', import.meta.url);
const INDEX_URL = new URL('index.json', SCORE_DIR);

/** 合法曲谱 ID：字母数字开头，只含字母、数字、点、下划线、连字符 */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * 读取曲谱索引。
 * @returns {Promise<Array<object>>} 曲谱摘要数组
 */
export async function loadScoreList() {
  const data = await fetchJson(INDEX_URL);
  const scores = Array.isArray(data) ? data : data && data.scores;
  if (!Array.isArray(scores)) {
    throw new Error('index.json 格式不正确：应为 { "scores": [...] }');
  }
  return scores;
}

/**
 * 读取单首曲谱的完整数据。
 * @param {string} id 曲谱 ID，如 "little-star"
 */
export async function loadScore(id) {
  if (!id || !ID_PATTERN.test(id)) {
    const err = new Error('缺少或非法的曲谱 ID');
    err.code = 'bad-id';
    throw err;
  }
  try {
    return await fetchJson(new URL(`${id}.json`, SCORE_DIR));
  } catch (err) {
    if (err.status === 404) {
      const notFound = new Error(`没有找到曲谱「${id}」`);
      notFound.code = 'not-found';
      throw notFound;
    }
    throw err;
  }
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

/** 取展示用作曲者/改编者 */
export function scoreComposer(score) {
  return (score && score.composer) || '';
}
