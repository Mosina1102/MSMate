// v2.5.75 素材真跑验证：read_paper_spec → apply_word_format(map source) → check_paper_format
// 同时验证 docToDocx 缓存（第二次读同一 .doc 不再走 COM）
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createTools } = require('../ai/tools.js')

const TPL = 'C:/Users/ars/Downloads/成教本科毕业论文（设计）论文类撰写参考模板.doc'
const PAPER = 'C:/Users/ars/Downloads/人工智能对中小企业财务管理的影响与对策_成教毕业论文_生成版.docx'
const OUT = 'C:/Users/ars/Downloads/人工智能对中小企业财务管理的影响与对策_成教毕业论文_格式校正.docx'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-'))

const tools = createTools({
  tcpAgent: { getConnectedDevices: () => [] },
  snapshots: { backupLocal: (p) => { try { const id = 'snap_' + Date.now(); fs.copyFileSync(p, path.join(tmpDir, id + '.bak')); return { ok: true, id } } catch (e) { return { ok: false, reason: e.message } } }, snapshotDir: () => tmpDir, register: () => {} },
  tmpDir,
  workspaceDir: tmpDir,
  log: () => {},
  getSetting: () => null,
  setSetting: () => {},
})

async function main() {
  // ① 第一次 read_paper_spec（走 COM 转换）
  let t0 = Date.now()
  const r1 = await tools.execute('read_paper_spec', { path: TPL })
  console.log(`① read_paper_spec 首次（COM 转换）: ok=${r1.ok} 耗时${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(String(r1.message || '').slice(0, 600) + '\n')
  if (!r1.ok) process.exit(1)

  // ② 第二次 read_paper_spec（走缓存——耗时应骤降）
  t0 = Date.now()
  const r2 = await tools.execute('read_paper_spec', { path: TPL })
  const dt2 = (Date.now() - t0) / 1000
  console.log(`② read_paper_spec 二次（缓存复用）: ok=${r2.ok} 耗时${dt2.toFixed(1)}s（<1s 即缓存生效）`)
  if (!r2.ok) process.exit(1)

  // ③ apply_word_format：模板格式整体套到生成版论文
  t0 = Date.now()
  const r3 = await tools.execute('apply_word_format', {
    path: PAPER,
    formatPath: TPL,
    rules: { map: { title: 'source', h1: 'source', h2: 'source', h3: 'source', body: 'source' } }
  })
  console.log(`③ apply_word_format: ok=${r3.ok} 耗时${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(String(r3.message || '').slice(0, 500) + '\n')
  if (!r3.ok) process.exit(1)

  // ④ check_paper_format 体检套用结果
  const r4 = await tools.execute('check_paper_format', { path: PAPER, templatePath: TPL })
  console.log(`④ check_paper_format: ok=${r4.ok}`)
  console.log(String(r4.message || '').slice(0, 800))
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
