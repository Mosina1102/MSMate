// zip 压缩/解压冒烟测试（D 盘，避开 C 盘保护区）
const path = require('path')
const fs = require('fs')
const { createTools } = require('../ai/tools')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? '✅ ' : '❌ ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // 测试根目录：默认 D 盘（避开 C 盘保护区），可用 MSWORK_TEST_DIR 覆盖
  const testRoot = process.env.MSWORK_TEST_DIR || 'D:\\mswork_test'
  fs.mkdirSync(testRoot, { recursive: true })
  const base = fs.mkdtempSync(path.join(testRoot, 'zip-test-'))
  const srcDir = path.join(base, '项目资料')
  fs.mkdirSync(path.join(srcDir, '子目录'), { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'readme.txt'), '中文内容测试')
  fs.writeFileSync(path.join(srcDir, '子目录', 'data.json'), '{"a":1}')
  fs.writeFileSync(path.join(base, '单独.txt'), 'loose file')

  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试' }) },
    desktopDir: 'D:\\桌面占位',
    tmpDir: base,
    workspaceDir: path.join(base, 'ws'),
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })

  // 1) 压缩文件夹 + 单文件
  const zipPath = path.join(base, '打包.zip')
  const r1 = await tools.execute('zip_compress', { src: [srcDir, path.join(base, '单独.txt')], zip_path: zipPath })
  ok('压缩文件夹+文件', r1.ok && fs.existsSync(zipPath) && fs.statSync(zipPath).size > 50, r1.message)

  // 2) 解压
  const destDir = path.join(base, 'out')
  const r2 = await tools.execute('zip_extract', { zip_path: zipPath, dest_dir: destDir })
  ok('解压执行', r2.ok, r2.message)
  ok('解压内容完整', fs.readFileSync(path.join(destDir, '项目资料', 'readme.txt'), 'utf8') === '中文内容测试'
    && fs.readFileSync(path.join(destDir, '项目资料', '子目录', 'data.json'), 'utf8') === '{"a":1}'
    && fs.readFileSync(path.join(destDir, '单独.txt'), 'utf8') === 'loose file')

  // 3) 缺参数
  const r3 = await tools.execute('zip_compress', { zip_path: zipPath })
  ok('缺 src 拒绝', !r3.ok, r3.message)

  // 4) C 盘保护区拦截
  const r4 = await tools.execute('zip_compress', { src: srcDir, zip_path: 'C:\\Windows\\x.zip' })
  ok('C盘目标拦截', !r4.ok, r4.message)

  // 5) zip-slip 防护（构造恶意条目名；JSZip 会规范化 ../ 前缀，验证不逃逸即可）
  const JSZip = require('jszip')
  const evil = new JSZip()
  evil.file('../../evil.txt', 'bad')
  const evilBuf = await evil.generateAsync({ type: 'nodebuffer' })
  const evilPath = path.join(base, 'evil.zip')
  fs.writeFileSync(evilPath, evilBuf)
  const evilOut = path.join(base, 'evil-out')
  const r5 = await tools.execute('zip_extract', { zip_path: evilPath, dest_dir: evilOut })
  const escaped = fs.existsSync(path.join(base, 'evil.txt'))
  ok('zip-slip 不逃逸', r5.ok && !escaped && fs.existsSync(path.join(evilOut, 'evil.txt')), JSON.stringify(r5.message))

  fs.rmSync(base, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'} (${pass}/${pass + fail})`)
  process.exitCode = fail === 0 ? 0 : 1
}
main().catch((e) => { console.error('测试异常:', e); process.exitCode = 1 })
