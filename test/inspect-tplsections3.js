// 诊断 v3：节1 注意事项段为什么没触发 dropNotes
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const office = require('../ai/office.js')

const TPL = 'C:/Users/ars/Downloads/成教本科毕业论文（设计）论文类撰写参考模板 (1).doc'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpldiag3-'))

async function main() {
  const dst = path.join(tmpDir, 'tpl.docx')
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'ai', 'doc2docx.ps1'), '-Src', TPL, '-Dst', dst], { timeout: 120000, windowsHide: true }, (err) => err ? reject(err) : resolve())
  })
  const JSZip = require('jszip')
  const z = await JSZip.loadAsync(fs.readFileSync(dst))
  const docXml = await z.file('word/document.xml').async('string')
  const secs = office.splitTplSections(docXml)
  const sec1 = secs[0]
  sec1.paras.forEach((p, i) => {
    const t = p.text.trim()
    if (!t) return
    if (/注/.test(t) || /注意/.test(t) || /声明/.test(t) || /原创/.test(t)) {
      console.log(`[${i}] 长度${t.length} 注意事项正则=${/^注\s*意\s*事\s*项/.test(t)} 声明正则=${/(原创性声明|版权使用授权书|版权使用授权)/.test(t)}`)
      console.log(`     原文: "${t.slice(0, 50)}"`)
      console.log(`     码点: ${[...t.slice(0, 8)].map((c) => c.codePointAt(0).toString(16)).join(' ')}`)
    }
  })
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
