'use strict';

/**
 * 本地版查询工具打包脚本（Node.js SEA 单文件 Windows / macOS 方案）
 *
 * 产物：Windows 为 local/dist/codex-quota.exe，macOS 为 local/dist/codex-quota.command；
 *       免装 Node.js，双击即可运行；
 *       仅封装查询逻辑，运行机器仍需装有 Codex CLI 且登录过（~/.codex/auth.json）。
 *
 * 构建步骤：
 *   1. node --experimental-sea-config sea-config.json 生成脚本注入 blob；
 *   2. 复制本机 Node 可执行文件作为程序壳；
 *   3. npx postject 把 blob 注入壳内。
 *
 * 运行：node scripts/build-exe.js   （需要 Node.js ≥ 22，构建过程需联网拉取 postject）
 *
 * @author 黄杰
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'local', 'dist');
const IS_MAC = process.platform === 'darwin';
const EXE_PATH = path.join(DIST_DIR, IS_MAC ? 'codex-quota.command' : 'codex-quota.exe');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
/** 固定注入工具版本，避免未来下载版本改变构建结果。 */
const POSTJECT_VERSION = '1.0.0-alpha.6';
const MIN_NODE_MAJOR = 22;

/** 先生成临时产物，注入成功后才原子替换稳定入口；失败保留原产物。 */
function buildExe() {
  if (process.platform !== 'win32' && !IS_MAC) {
    throw new Error('此构建入口仅支持 Windows 和 macOS，请在目标平台原生构建。');
  }
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    throw new Error('构建需要 Node.js 22 或更高版本。');
  }
  const nodeDir = path.dirname(process.execPath);
  // Windows 的 npm 与 node 同目录，macOS 的 npm 通常位于 ../lib/node_modules。
  const npxCli = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!npxCli) throw new Error('当前 Node 安装中未找到 npm/npx，请安装包含 npm 的 Node.js。');

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(DIST_DIR, '.build-'));
  const blobPath = path.join(tempDir, 'sea-prep.blob');
  const tempExe = path.join(tempDir, path.basename(EXE_PATH));
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
    if (IS_MAC) {
      fs.chmodSync(tempExe, 0o755);
      execFileSync('codesign', ['--remove-signature', tempExe], { stdio: 'inherit' });
    }
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const env = { ...process.env, [pathKey]: nodeDir + path.delimiter + (process.env[pathKey] || '') };
    const injectArgs = [npxCli, '--yes', '--package=postject@' + POSTJECT_VERSION,
      'postject', tempExe, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL_FUSE];
    if (IS_MAC) injectArgs.push('--macho-segment-name', 'NODE_SEA');
    execFileSync(process.execPath, injectArgs, { cwd: ROOT, stdio: 'inherit', env });
    // macOS 在注入后必须重新签名；临时签名不等于 Apple 开发者签名或公证。
    if (IS_MAC) {
      execFileSync('codesign', ['--sign', '-', tempExe], { stdio: 'inherit' });
      execFileSync('codesign', ['--verify', '--strict', tempExe], { stdio: 'inherit' });
    }

    // postject 完成后检查熔丝，拒绝把未注入的 Node 壳发布为查询程序。
    const binary = fs.readFileSync(tempExe);
    if (!binary.includes(Buffer.from(SENTINEL_FUSE + ':1'))) {
      throw new Error('SEA 注入校验失败，原有产物已保留。');
    }
    // 用隔离的空凭据目录检查真实启动，避免构建时读取个人账号或访问接口。
    const smokeHome = path.join(tempDir, 'smoke-home');
    fs.mkdirSync(smokeHome);
    const smoke = spawnSync(tempExe, ['--json'], {
      env: { ...env, CODEX_HOME: smokeHome }, encoding: 'utf8', timeout: 30000,
    });
    if (smoke.error || smoke.status !== 1 || !smoke.stderr.includes('未找到 ChatGPT 登录凭据')) {
      throw new Error('产物启动检查失败：' + (smoke.error ? smoke.error.message : smoke.stderr));
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
