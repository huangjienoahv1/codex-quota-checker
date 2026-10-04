'use strict';

/**
 * 本地版查询工具打包脚本（Node.js SEA 单文件 exe 方案）
 *
 * 产物：local/dist/codex-quota.exe —— 免装 Node.js，双击即可运行；
 *       仅封装查询逻辑，运行机器仍需装有 Codex CLI 且登录过（~/.codex/auth.json）。
 *
 * 构建步骤：
 *   1. node --experimental-sea-config sea-config.json 生成脚本注入 blob；
 *   2. 复制本机 node.exe 作为程序壳；
 *   3. npx postject 把 blob 注入壳内。
 *
 * 运行：node scripts/build-exe.js   （需要 Node.js ≥ 22，构建过程需联网拉取 postject）
 *
 * @author 黄杰
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 项目根目录（脚本固定位于 scripts/ 下） */
const ROOT = path.join(__dirname, '..');
/** SEA blob 产物路径 */
const BLOB_PATH = path.join(ROOT, 'sea-prep.blob');
/** 最终 exe 输出目录与文件名 */
const DIST_DIR = path.join(ROOT, 'local', 'dist');
const EXE_PATH = path.join(DIST_DIR, 'codex-quota.exe');
/** SEA 注入所需的哨兵熔丝名（Node.js 官方固定值） */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// 1) 生成包含查询脚本的 blob
execSync('node --experimental-sea-config sea-config.json', { cwd: ROOT, stdio: 'inherit' });

// 2) 复制本机 node.exe 作为 exe 壳（产物架构与本机构建架构一致）
fs.mkdirSync(DIST_DIR, { recursive: true });
fs.copyFileSync(process.execPath, EXE_PATH);

// 3) 注入 blob；npx -y 允许临时拉取 postject（仅构建期依赖，不进入项目目录）
execSync(
  `npx -y postject "${EXE_PATH}" NODE_SEA_BLOB "${BLOB_PATH}" --sentinel-fuse ${SENTINEL_FUSE}`,
  { cwd: ROOT, stdio: 'inherit' }
);

// 4) 清理中间产物
fs.rmSync(BLOB_PATH, { force: true });

const sizeMb = (fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1);
console.log(`\n打包完成：${EXE_PATH}（${sizeMb} MB）`);
