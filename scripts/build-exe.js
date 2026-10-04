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

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'local', 'dist');
const EXE_PATH = path.join(DIST_DIR, 'codex-quota.exe');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
/** 固定注入工具版本，避免未来下载版本改变构建结果。 */
const POSTJECT_VERSION = '1.0.0-alpha.6';
const MIN_NODE_MAJOR = 22;

/** 先生成临时产物，注入成功后才原子替换稳定入口；失败保留原 EXE。 */
function buildExe() {
  if (process.platform !== 'win32') throw new Error('此构建入口仅用于 Windows EXE。');
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    throw new Error('构建需要 Node.js 22 或更高版本。');
  }
  const nodeDir = path.dirname(process.execPath);
  const npxCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!fs.existsSync(npxCli)) throw new Error('当前 Node 安装中未找到 npm/npx，请安装包含 npm 的 Node.js。');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(DIST_DIR, '.build-'));
  const blobPath = path.join(tempDir, 'sea-prep.blob');
  const tempExe = path.join(tempDir, 'codex-quota.exe');
  const configPath = path.join(tempDir, 'sea-config.json');
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'sea-config.json'), 'utf8'));
    config.main = path.resolve(ROOT, config.main);
    config.output = blobPath;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    // blob 与程序壳必须使用同一个 Node 可执行文件，不依赖 PATH 中的 node。
    execFileSync(process.execPath, ['--experimental-sea-config', configPath],
      { cwd: ROOT, stdio: 'inherit' });
    fs.copyFileSync(process.execPath, tempExe);
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const env = { ...process.env, [pathKey]: nodeDir + path.delimiter + (process.env[pathKey] || '') };
    execFileSync(process.execPath, [npxCli, '--yes', '--package=postject@' + POSTJECT_VERSION,
      'postject', tempExe, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL_FUSE],
      { cwd: ROOT, stdio: 'inherit', env });

    // postject 完成后检查熔丝，拒绝把未注入的 Node 壳发布为查询程序。
    const binary = fs.readFileSync(tempExe);
    if (!binary.includes(Buffer.from(SENTINEL_FUSE + ':1'))) {
      throw new Error('SEA 注入校验失败，原有 EXE 已保留。');
    }
    fs.renameSync(tempExe, EXE_PATH);
    const sizeMb = (fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1);
    console.log('\n打包完成：' + EXE_PATH + '（' + sizeMb + ' MB）');
  } finally {
    // 只清理本次在 dist 内创建的临时目录，绝不清空产物目录。
    const relative = path.relative(path.resolve(DIST_DIR), fs.realpathSync(tempDir));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

try {
  buildExe();
} catch (err) {
  console.error('打包失败，原有产物不会在构建失败时被覆盖：' + err.message);
  process.exitCode = 1;
}
