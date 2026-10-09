/**
 * list.js — 曲谱列表页入口（index.html）
 */

import { loadScoreList, scoreUrl } from './data.js';

const listEl = document.getElementById('score-list');
const statusEl = document.getElementById('list-status');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderCard(score) {
  const li = el('li', 'score-card');
  const a = el('a', 'card-link');
  a.href = scoreUrl(score.id);

  a.append(el('h2', 'title', score.title || score.id));

  if (score.subtitle) {
    a.append(el('p', 'subtitle', score.subtitle));
  }
  if (score.composer) {
    a.append(el('p', 'composer', score.composer));
  }

  const tags = [];
  if (score.difficulty) tags.push(String(score.difficulty));
  if (Array.isArray(score.tags)) tags.push(...score.tags);
  if (tags.length) {
    const tagBox = el('div', 'tags');
    tags.forEach((t) => tagBox.append(el('span', 'chip', String(t))));
    a.append(tagBox);
  }

  li.append(a);
  return li;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

async function main() {
  try {
    const scores = await loadScoreList();
    if (!scores.length) {
      setStatus('曲谱库还是空的。往 docs/data/scores/ 里添加曲谱后运行 node tools/build-index.mjs。');
      return;
    }
    const fragment = document.createDocumentFragment();
    scores.forEach((score) => fragment.append(renderCard(score)));
    listEl.append(fragment);
    setStatus(`共 ${scores.length} 首曲谱`);
  } catch (err) {
    console.error(err);
    setStatus(`曲谱列表加载失败：${err.message}`, true);
  }
}

main();
