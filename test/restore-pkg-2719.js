// 从 ada8769~1 恢复完整 package.json，版本号保持 2.7.19（一次性修复）
const { execSync } = require('child_process')
const fs = require('fs')
const full = execSync('"C:/Program Files/Git/cmd/git.exe" show ada8769~1:package.json')
const fixed = full.toString('utf8').replace('"version": "2.7.18"', '"version": "2.7.19"')
const p = JSON.parse(fixed)
if (!p.scripts || !p.build || !p.devDependencies || p.version !== '2.7.19') {
  console.error('恢复校验失败', { scripts: !!p.scripts, build: !!p.build, devDeps: !!p.devDependencies, version: p.version })
  process.exit(1)
}
fs.writeFileSync('package.json', fixed)
console.log('restored full package.json @2.7.19,', fixed.length, 'bytes')
