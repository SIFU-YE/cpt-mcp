// scripts/golden-update.mjs —— golden 基线更新入口（Windows shell 兼容，等价 UPDATE_GOLDEN=1）
// 用法：npm run test:golden:update
process.env.UPDATE_GOLDEN = '1';
await import('../test/golden.test.js');
