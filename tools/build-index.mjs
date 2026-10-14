#!/usr/bin/env node
/**
 * build-index.mjs — 整理 index.json（曲谱 meta 的唯一来源）
 *
 * meta 只维护在 docs/data/scores/index.json 里，谱面是独立的
 * <id>.jianpu 文件，所以这里不再「从曲谱里抽摘要」，而是做三件事：
 *
 *   1. 检查 index.json 与 .jianpu 文件是否一一对应（漏了哪边都报出来）
 *   2. 补齐缺省字段、按固定字段顺序重写（避免每次 diff 都是人肉排序）
 *   3. 按标题排序，让列表页顺序稳定
 *
 * 用法：
 *   node tools/build-index.mjs
 *
 * 退出码非 0 表示有需要手动补齐的地方（meta 仍会按现状写回）。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scoreDir = path.join(projectRoot, 'docs', 'data', 'scores');
const indexFile = path.join(scoreDir, 'index.json');
const NOTATION_EXT = 'jianpu';

const files = await readdir(scoreDir);
const notationIds = new Set(
  files
    .filter((name) => name.endsWith(`.${NOTATION_EXT}`))
    .map((name) => path.basename(name, `.${NOTATION_EXT}`)),
);

let raw;
try {
  raw = JSON.parse(await readFile(indexFile, 'utf8'));
} catch (err) {
  console.error(`读不了 ${path.relative(projectRoot, indexFile)}：${err.message}`);
  process.exit(1);
}

const scores = Array.isArray(raw) ? raw : raw && raw.scores;
if (!Array.isArray(scores)) {
  console.error('index.json 格式不正确：应为 { "scores": [...] }');
  process.exit(1);
}

let problems = 0;
const seen = new Set();
const normalized = [];

for (const meta of scores) {
  const id = meta && meta.id;
  if (!id) {
    console.error('有一条 meta 缺少 id');
    problems += 1;
    continue;
  }
  if (seen.has(id)) {
    console.error(`id 重复：${id}`);
    problems += 1;
    continue;
  }
  seen.add(id);

  if (!meta.title) {
    console.error(`${id}：缺少 title`);
    problems += 1;
  }
  if (!notationIds.has(id)) {
    console.error(`${id}：index.json 里有 meta，但找不到 ${id}.${NOTATION_EXT} 谱面文件`);
    problems += 1;
  }
  if ('notation' in meta) {
    console.error(`${id}：meta 里不该再存 notation，谱面请放 ${id}.${NOTATION_EXT}`);
    problems += 1;
  }

  normalized.push({
    id,
    title: meta.title || id,
    subtitle: meta.subtitle || '',
    composer: meta.composer || '',
    lyricist: meta.lyricist || '',
    difficulty: meta.difficulty || '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
  });
}

for (const id of notationIds) {
  if (!seen.has(id)) {
    console.error(`${id}.${NOTATION_EXT}：有谱面文件，但 index.json 里没有对应的 meta`);
    problems += 1;
  }
}

normalized.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans'));

await writeFile(indexFile, `${JSON.stringify({ scores: normalized }, null, 2)}\n`, 'utf8');
console.log(
  `已整理 ${path.relative(projectRoot, indexFile)}：${normalized.length} 首`
    + `（${normalized.map((s) => s.id).join(', ') || '空'}）`,
);

if (problems) {
  console.error(`\n${problems} 处需要手动补齐（meta 已按现状写回，补完再跑一次）`);
  process.exit(1);
}
