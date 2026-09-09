// 诊断 v2：清洗+节判定每节首段——为什么节1 还判 body
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const office = require('../ai/office.js')

const TPL = 'C:/Users/ars/Downloads/成教本科毕业论文（设计）论文类撰写参考模板 (1).doc'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpldiag2-'))

async function main() {
  const dst = path.join(tmpDir, 'tpl.docx')
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'ai', 'doc2docx.ps1'), '-Src', TPL, '-Dst', dst], { timeout: 120000, windowsHide: true }, (err) => err ? reject(err) : resolve())
  })
  const JSZip = require('jszip')
  const z = await JSZip.loadAsync(fs.readFileSync(dst))
  const docXml = await z.file('word/document.xml').async('string')

  const secs = office.splitTplSections(docXml)
  let prev = null
  secs.forEach((sec, i) => {
    // 复刻 applyWordTemplate 的预处理（v2.5.76 新停止条件——声明标题段才解禁）
    let dropNotes = false
    const kept = []
    for (const p of sec.paras) {
      const t = (p.text || '').trim()
      if (/^注\s*意\s*事\s*项/.test(t)) { dropNotes = true; continue }
      if (dropNotes && /^(本科毕业论文.{0,8}(原创性声明|版权使用授权书)|原创性声明|版权使用授权书)/.test(t)) dropNotes = false
      if (dropNotes || office.isFormatDemoPara(p.text)) continue
      kept.push(p)
    }
    const kind = office.classifyTplSection(kept, prev)
    prev = kind
    const texts = kept.filter((p) => p.text.trim()).map((p) => p.text.trim())
    console.log(`节${i + 1}: kind=${kind} 段数=${kept.length}/${sec.paras.length} 首三段: ${texts.slice(0, 3).map((t) => `"${t.slice(0, 25)}"`).join(' | ')}`)
    // body 触发特征排查
    if (kind === 'body') {
      const numTitled = texts.filter((t) => /^\d+[\.、]\s*\S/.test(t))
      const cnTitled = texts.filter((t) => /^[（(][一二三四五六七八九十0-9]+[）)]/.test(t))
      console.log(`   body 触发：首段正则=${/^(第[一二三四五六七八九十百0-9]+[章]|引\s*言|绪\s*论|一\s*、|\d+\s+\S)/.test(texts[0] || '')} 数字标题=${numTitled.length}(${numTitled.slice(0, 3).join('/')}) 中文序号标题=${cnTitled.length}(${cnTitled.slice(0, 3).join('/')})`)
    }
  })
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
