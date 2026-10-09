#!/usr/bin/env node
/**
 * build-index.mjs — 由曲谱文件生成列表页所需的索引
 *
 * 扫描 docs/data/scores/*.json（跳过 index.json 自身），
 * 从每首曲谱里抽取摘要字段，写出 docs/data/scores/index.json。
 *
 * 用法：
 *   node tools/build-index.mjs
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scoreDir = path.join(projectRoot, 'docs', 'data', 'scores');
const indexFile = path.join(scoreDir, 'index.json');

const files = (await readdir(scoreDir))
  .filter((name) => name.endsWith('.json') && name !== 'index.json')
  .sort();

const scores = [];
for (const file of files) {
  const raw = JSON.parse(await readFile(path.join(scoreDir, file), 'utf8'));
  const id = raw.id || path.basename(file, '.json');
  const info = (raw.jianpu && raw.jianpu.info) || {};

  if (!raw.jianpu || !raw.jianpu.score) {
    console.warn(`跳过 ${file}：缺少 jianpu.score`);
    continue;
  }
  if (id !== path.basename(file, '.json')) {
    console.warn(`注意 ${file}：内部 id「${id}」与文件名不一致，详情页链接会失效`);
  }

  scores.push({
    id,
    title: info.title || id,
    subtitle: raw.subtitle || '',
    composer: info.composer || '',
    difficulty: raw.difficulty || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  });
}

scores.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans'));

await writeFile(indexFile, `${JSON.stringify({ scores }, null, 2)}\n`, 'utf8');
console.log(`已写入 ${path.relative(projectRoot, indexFile)}：${scores.length} 首（${scores.map((s) => s.id).join(', ') || '空'}）`);
