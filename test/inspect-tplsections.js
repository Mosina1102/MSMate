// 诊断：模板转换副本的 splitTplSections 每节首段（节判定为什么全 cover）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const office = require('../ai/office.js')

const TPL = 'C:/Users/ars/Downloads/成教本科毕业论文（设计）论文类撰写参考模板 (1).doc'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpldiag-'))

async function main() {
  // 用项目 ps1 转换（走线上同链路）
  const dst = path.join(tmpDir, 'tpl.docx')
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'ai', 'doc2docx.ps1'), '-Src', TPL, '-Dst', dst], { timeout: 120000, windowsHide: true }, (err) => err ? reject(err) : resolve())
  })
  const JSZip = require('jszip')
  const z = await JSZip.loadAsync(fs.readFileSync(dst))
  const docXml = await z.file('word/document.xml').async('string')

  // 手动复现 splitTplSections（内部函数未导出——用 classify 逻辑要点直接看节首段）
  const bodyOpen = docXml.match(/<w:body(?:\s[^>]*)?>/)
  const bodyInner = docXml.slice(bodyOpen.index + bodyOpen[0].length, docXml.lastIndexOf('</w:body>'))
  const blocks = office.scanWordTables ? null : null
  // 用正则粗切 top-level p（够诊断用）
  const paras = [...bodyInner.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => ({
    xml: m[0],
    text: (m[0].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')
  }))
  const hasSect = /<w:sectPr[\s>]/.test(bodyInner)
  console.log(`总段数 ${paras.length}，body 内 sectPr 数 ${(bodyInner.match(/<w:sectPr/g) || []).length}`)
  // 打印每段（带节标记）——看节边界和每节开头
  let sectIdx = 1
  paras.forEach((p, i) => {
    const isSect = /<w:sectPr[\s>]/.test(p.xml)
    const demo = office.isFormatDemoPara(p.text)
    const txt = p.text.trim().slice(0, 45)
    if (isSect) { console.log(`  --- 节边界(段${i}) ---`); sectIdx++ }
    else if (txt || demo) console.log(`  [${i}]${demo ? '〔示范〕' : ''} "${txt}"`)
  })
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
