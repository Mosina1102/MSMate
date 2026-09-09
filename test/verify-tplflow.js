// v2.5.76 验证：apply_word_template 正确工作流——模板当骨架（封面图片/页眉/分节全迁）
// 对照 AI 现场跑偏的 apply_word_format(formatPath=另一篇论文) 路线
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createTools } = require('../ai/tools.js')

const TPL = 'C:/Users/ars/Downloads/成教本科毕业论文（设计）论文类撰写参考模板 (1).doc'
const PAPER = 'C:/Users/ars/Downloads/人工智能对中小企业财务管理的影响与对策_成教毕业论文_生成版 (1).docx'
const OUT = 'C:/Users/ars/Downloads/人工智能论文_套模板测试.docx'
if (fs.existsSync(OUT)) fs.unlinkSync(OUT)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tplflow-'))

const tools = createTools({
  tcpAgent: { getConnectedDevices: () => [] },
  snapshots: { backupLocal: (p) => { try { const id = 'snap_' + Date.now(); fs.copyFileSync(p, path.join(tmpDir, id + '.bak')); return { ok: true, id } } catch (e) { return { ok: false, reason: e.message } } }, snapshotDir: () => tmpDir, register: () => {} },
  tmpDir, workspaceDir: tmpDir, log: () => {}, getSetting: () => null, setSetting: () => {},
})

async function main() {
  // ① apply_word_template：论文 + 模板（.doc 自动转换）+ 封面字段
  const r1 = await tools.execute('apply_word_template', {
    path: PAPER, templatePath: TPL, outputPath: OUT,
    cover: { title: '人工智能对中小企业财务管理的影响与对策', college: '继续教育学院', major: '财务管理', grade: '2023级', studentId: '20230001', name: '（作者姓名）', advisor: '（指导教师）', date: '2026年9月' }
  })
  console.log(`① apply_word_template: ok=${r1.ok}`)
  console.log(String(r1.message || '').slice(0, 400) + '\n')
  if (!r1.ok) process.exit(1)

  // ② 产出验证：解包看关键指标
  const JSZip = require('jszip')
  const z = await JSZip.loadAsync(fs.readFileSync(OUT))
  const docXml = await z.file('word/document.xml').async('string')
  const files = Object.keys(z.files).filter((f) => !z.files[f].dir)
  const images = files.filter((f) => /^word\/media\//.test(f))
  console.log(`② 产出结构：${files.length} 个部件，图片 ${images.length} 个（${images.join(', ')}）`)

  // 正文宋体？（模板指纹：正文宋体12pt——绝不能是仿宋）
  const bodyRuns = docXml.match(/<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?w:eastAsia="([^"]+)"(?:(?!<\/w:rPr>)[\s\S])*?<\/w:rPr>/g) || []
  const fonts = {}
  bodyRuns.forEach((r) => { const m = r.match(/w:eastAsia="([^"]+)"/); if (m) fonts[m[1]] = (fonts[m[1]] || 0) + 1 })
  console.log('   字体分布（run 级 eastAsia）:', JSON.stringify(fonts))
  console.log(`   正文宋体: ${docXml.includes('w:eastAsia="宋体"') ? '有' : '无'} | 仿宋残留: ${docXml.includes('仿宋') ? '有（问题！）' : '无'}`)

  // 校徽图片进封面？（apply_word_template 应迁模板图片资产）
  console.log(`   封面图片: ${images.length > 0 ? '已迁 ' + images.length + ' 张' : '无（问题：模板有4张图但没迁）'}`)

  // 页眉？
  let headerTxt = ''
  try { headerTxt = await z.file('word/header1.xml').async('string') } catch {}
  console.log(`   页眉: ${headerTxt ? (headerTxt.includes('重庆科技大学') ? '正确（含校名）' : '有但内容异常') : '无'}`)

  // 目录域？
  console.log(`   目录域: ${docXml.includes('TOC') ? '有' : '无'}`)

  // ③ check_paper_format 体检（templatePath=真模板——对照 AI 现场拿错参考的体检）
  const r2 = await tools.execute('check_paper_format', { path: OUT, templatePath: TPL })
  console.log(`\n③ check_paper_format: ok=${r2.ok}`)
  console.log(String(r2.message || '').slice(0, 900))
  process.exit(0)
}

main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
