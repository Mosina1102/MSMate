// sniffMagic 魔数识别测试（野生狗奶事故：镜像站 AVIF 伪装 .jpg → 识图全拒）
// 运行：node test/sniff-test.js
const fs = require('fs')
const path = require('path')
const os = require('os')
const { sniffMagic } = require('../ai/tools')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL: ' + name + (extra ? ' | ' + extra : '')) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-test-'))
const write = (name, bytes) => { const p = path.join(tmp, name); fs.writeFileSync(p, Buffer.from(bytes)); return p }

// 各格式魔数（部分用真实文件头字节）
const cases = [
  ['伪装.jpg', [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46], 'jpg'],
  ['伪装2.jpg', [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 'png'],
  ['伪装.png', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'gif'],
  ['伪装.webp', [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 'webp'],
  ['伪装.jpg.avif-case', [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 'avif'],
  ['伪装.mp4', [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D], 'mp4'],
  ['伪装.txt', [0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37], 'pdf'],
  ['伪装.bin', [0x50, 0x4B, 0x03, 0x04, 0x14, 0x00], 'zip'],
]

for (const [name, bytes, expect] of cases) {
  const r = sniffMagic(write(name, bytes))
  ok(`${name} → ${expect}`, r && r.ext === expect, r ? r.ext : 'null')
}

// 文本文件返回 null（无魔数匹配）
ok('纯文本 → null', sniffMagic(write('plain.txt', [0x68, 0x65, 0x6C, 0x6C, 0x6F])) === null)
// 不存在的文件不炸
ok('文件不存在 → null 不炸', sniffMagic(path.join(tmp, 'nope.jpg')) === null)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'} (${pass}/${pass + fail})`)
process.exit(fail ? 1 : 0)
