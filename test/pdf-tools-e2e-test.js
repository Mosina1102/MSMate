// merge_pdf / split_pdf 端到端测试（纯 Node，真跑 createTools 工具层）
// 运行：node test/pdf-tools-e2e-test.js
const fs = require('fs')
const path = require('path')
const os = require('os')
const { PDFDocument, StandardFonts } = require('pdf-lib')
const { SnapshotManager } = require('../ai/snapshots')
const { createTools } = require('../ai/tools')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL: ' + name + (extra ? ' | ' + extra : '')) } }

async function makePdf(file, pages, tag) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([595, 842])
    p.drawText(`${tag} page ${i}`, { x: 60, y: 760, size: 20, font })
  }
  fs.writeFileSync(file, await doc.save())
}

const pageCount = async (file) => (await PDFDocument.load(fs.readFileSync(file))).getPageCount()

;(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-tools-e2e-'))
  const snapshots = new SnapshotManager({ dir: path.join(tmp, 'snapshots'), log: () => {} })
  const tools = createTools({ tcpAgent: { getConnectedDevices: () => [] }, snapshots, desktopDir: tmp, tmpDir: tmp, log: () => {} })

  const a = path.join(tmp, '合同.pdf'), b = path.join(tmp, '发票.pdf'), c = path.join(tmp, '报告.pdf')
  await makePdf(a, 3, 'Contract'); await makePdf(b, 2, 'Invoice'); await makePdf(c, 1, 'Report')

  // ① merge：三合一，页序保持
  const m1 = await tools.execute('merge_pdf', { paths: [a, b, c] })
  ok('merge 成功', m1.ok === true, m1.message)
  const mergedPath = path.join(tmp, '合同-合并.pdf')
  ok('merge 默认输出名 = 首文件旁-合并.pdf', fs.existsSync(mergedPath), m1.message)
  ok('merge 页数 = 3+2+1', (await pageCount(mergedPath)) === 6, String(await pageCount(mergedPath)))

  // ② merge 分号分隔写法 + 指定 out
  const m2path = path.join(tmp, '拼好的.pdf')
  const m2 = await tools.execute('merge_pdf', { paths: `${b};${c}`, out: m2path })
  ok('merge 分号写法 + out 指定', m2.ok === true && (await pageCount(m2path)) === 3, m2.message)

  // ③ merge 单文件报错
  const m3 = await tools.execute('merge_pdf', { paths: [a] })
  ok('merge 单文件被拒', m3.ok === false, m3.message)

  // ④ split 提取范围 2-4
  const s1 = await tools.execute('split_pdf', { path: mergedPath, pages: '2-4' })
  const s1Path = path.join(tmp, '合同-合并-第2-4页.pdf')
  ok('split 2-4 成功', s1.ok === true && fs.existsSync(s1Path), s1.message)
  ok('split 2-4 页数 = 3', (await pageCount(s1Path)) === 3, String(await pageCount(s1Path)))

  // ⑤ split 组合 1,5（乱序输入按升序收敛）
  const s2 = await tools.execute('split_pdf', { path: mergedPath, pages: '1,5', out: path.join(tmp, '抽页.pdf') })
  ok('split 1,5 页数 = 2', s2.ok === true && (await pageCount(path.join(tmp, '抽页.pdf'))) === 2, s2.message)

  // ⑥ split 留空 = 逐页拆
  const s3 = await tools.execute('split_pdf', { path: mergedPath })
  const dir = path.join(tmp, '合同-合并-逐页')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')) : []
  ok('split 逐页拆 6 个文件', s3.ok === true && files.length === 6, s3.message + ` 实际 ${files.length}`)

  // ⑦ split 越界页码报错
  const s4 = await tools.execute('split_pdf', { path: mergedPath, pages: '99' })
  ok('split 越界被拒', s4.ok === false && /共 6 页/.test(s4.message), s4.message)

  // ⑧ split 花写法被拒
  const s5 = await tools.execute('split_pdf', { path: mergedPath, pages: 'abc' })
  ok('split 非法写法被拒', s5.ok === false, s5.message)

  // ⑨ 源文件未被改动（merge/split 都不改源）
  ok('源 PDF 未被改动', (await pageCount(a)) === 3 && (await pageCount(mergedPath)) === 6)

  // ⑩ classify 审批：新文件=非破坏，已存在=破坏提示
  const clsNew = await tools.classify('merge_pdf', { paths: [b, c] }) // 发票-合并.pdf 不存在
  ok('classify 新文件非破坏', clsNew.destructive === false, JSON.stringify(clsNew))
  const clsOld = await tools.classify('split_pdf', { path: mergedPath, pages: '1-2', out: s1Path })
  ok('classify 覆盖已有=破坏提示', clsOld.destructive === true && /备份/.test(clsOld.note), JSON.stringify(clsOld))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'} (${pass}/${pass + fail})`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
