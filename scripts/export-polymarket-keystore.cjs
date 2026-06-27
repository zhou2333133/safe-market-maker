// 一次性脚本：从 runtime-secrets 导出 Polymarket 私钥，生成 keystore
// 用法: node scripts/export-polymarket-keystore.cjs
// 需要先设置环境变量 SAFE_MM_PASSPHRASE=你的密码

const path = require('path');
const fs = require('fs');

const DATA_DIR = '.safe-mm';
const VENUE = 'polymarket';
const PASSPHRASE = process.env.SAFE_MM_PASSPHRASE;

if (!PASSPHRASE) {
  console.error('错误: 请先设置环境变量 SAFE_MM_PASSPHRASE');
  console.error('PowerShell: $env:SAFE_MM_PASSPHRASE="你的密码"');
  console.error('再运行: node scripts/export-polymarket-keystore.cjs');
  process.exit(1);
}

// 加载本地加密模块（CommonJS 兼容）
const crypto = require('../dist/src/secrets/crypto.js');
const keystore = require('../dist/src/secrets/keystore.js');

// 1. 从 runtime-secrets 读取 Polymarket 私钥
const runtimePath = path.join(DATA_DIR, 'runtime-secrets', `${VENUE}.runtime-wallet.json`);
const masterKeyPath = path.join(DATA_DIR, 'runtime-secrets', 'local-master.key');

if (!fs.existsSync(runtimePath)) {
  console.error('错误: 找不到 runtime wallet:', runtimePath);
  process.exit(1);
}
if (!fs.existsSync(masterKeyPath)) {
  console.error('错误: 找不到 local-master.key:', masterKeyPath);
  process.exit(1);
}

const masterKey = fs.readFileSync(masterKeyPath, 'utf8').trim();
const vault = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

if (vault.kind !== 'runtime-wallet' || vault.venue !== VENUE) {
  console.error('错误: runtime wallet 格式不对');
  process.exit(1);
}

const privateKey = keystore.normalizePrivateKey(
  crypto.decryptUtf8(vault.envelope, masterKey)
);

console.log('已从 runtime-secrets 解密私钥');
console.log('地址:', vault.address);

// 2. 检查是否已有 keystore
if (keystore.hasWallet(DATA_DIR, VENUE)) {
  console.log('Polymarket keystore 已存在，跳过创建');
} else {
  const addr = keystore.importWallet(DATA_DIR, VENUE, privateKey, PASSPHRASE);
  console.log('已创建 keystore:', addr);
}

console.log('完成! 现在 .safe-mm/keystores/polymarket.wallet.json 可以用密码 SAFE_MM_PASSPHRASE 解密');
