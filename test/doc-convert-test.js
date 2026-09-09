// v2.5.73 旧版 .doc 兼容测试：COM 反向造 .doc 样本 → docToDocx 转回 → 内容断言
// 本机无 WPS/Word COM 引擎时 SKIP（不算失败）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const office = require('../ai/office.js')

const execP = (ps1, args) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args], { timeout: 60000, windowsHide: true, encoding: 'utf8' }, (err, so, se) => {
    if (err) return reject(new Error(String((so || '') + (se || '') + (err.message || '')).slice(-300)))
    resolve(String(so || ''))
  })
})

// COM 探测：KWPS / Word 任一可用即 true
async function hasComEngine() {
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comchk-')), 'probe.ps1')
  fs.writeFileSync(probe, "$found=$false\nforeach($id in @('KWPS.Application','Word.Application')){try{$app=New-Object -ComObject $id;$found=$true;$app.Quit();break}catch{}}\nif($found){Write-Output 'COM_OK'}else{Write-Output 'COM_NONE'}\n")
  try { return (await execP(probe, [])).includes('COM_OK') } catch { return false }
}

// 反向：docx → .doc（SaveAs 0 = wdFormatDocument97）——测试样本生成
async function docxToDoc(srcPath, dstPath) {
  const ps1 = path.join(path.dirname(dstPath), 'saveas-doc.ps1')
  fs.writeFileSync(ps1, [
    'param([string]$Src,[string]$Dst)',
    '$ErrorActionPreference=\'Stop\'',
    '$app=$null',
    'foreach($id in @(\'KWPS.Application\',\'Word.Application\')){try{$app=New-Object -ComObject $id;break}catch{$app=$null}}',
    'if(-not $app){Write-Output \'NO_COM_ENGINE\';exit 1}',
    'try{',
    '  try{$app.DisplayAlerts=0}catch{}',
    '  $doc=$app.Documents.Open($Src,$false,$true)',
    '  $doc.SaveAs($Dst,0)',
    '  $doc.Close($false)',
    '  Write-Output (\'OK \'+$Dst)',
    '}finally{',
    '  try{$app.Quit()}catch{}',
    '  try{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)}catch{}',
    '}'
  ].join('\r\n'))
  return execP(ps1, ['-Src', srcPath, '-Dst', dstPath])
}

async function main() {
  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doccvt-'))

  if (!(await hasComEngine())) {
    console.log('SKIP 本机无 WPS/Word COM 引擎——旧版 .doc 转换链路无法真跑（用户机装 WPS 后生效）')
    process.exit(0)
    return
  }

  // ① 造 docx（文字+表格）→ COM 反向存成 .doc 样本
  const docxSrc = path.join(dir, '样本.docx')
  await office.createDocx(docxSrc, { title: '成教本科毕业论文撰写参考模板', noTitle: true, paragraphs: [
    { text: '第一章 总则', style: 'h1' },
    '正文格式：宋体小四，1.5倍行距。',
    '| 项目 | 要求 |',
    '| --- | --- |',
    '| 页边距 | 上下2.54 左右3.17 |'
  ], fonts: { heading: '黑体', body: '宋体' } })
  const docSample = path.join(dir, '样本.doc')
  await docxToDoc(docxSrc, docSample)
  ok('COM 反向生成 .doc 样本', fs.existsSync(docSample) && fs.statSync(docSample).size > 1000)

  // ② 魔数探测
  ok('isLegacyDoc(.doc)=true', office.isLegacyDoc(docSample) === true)
  ok('isLegacyDoc(.docx)=false', office.isLegacyDoc(docxSrc) === false)

  // ③ docToDocx 转回 → 内容一致（走项目 ai/doc2docx.ps1 正向链路，与线上同一条）
  const JSZip = require('jszip')
  const backDocx = path.join(dir, '样本.back.docx')
  await docxToDocToDocxRoundtrip(docSample, backDocx)
  const z = await JSZip.loadAsync(fs.readFileSync(backDocx))
  const x = await z.file('word/document.xml').async('string')
  ok('转回 docx 内容一致（标题）', x.includes('第一章 总则'))
  ok('转回 docx 内容一致（正文）', x.includes('1.5倍行距'))
  ok('转回 docx 内容一致（表格）', x.includes('页边距') && x.includes('3.17'))

  // ④ 全角括号+中文+空格路径（用户机现场同款："成教本科毕业论文（设计）..."）
  const cnDir = path.join(dir, '测试 喵（设计）目录')
  fs.mkdirSync(cnDir, { recursive: true })
  const cnDoc = path.join(cnDir, '成教本科毕业论文（设计）论文类撰写参考模板.doc')
  fs.copyFileSync(docSample, cnDoc)
  const cnConv = path.join(cnDir, '成教本科毕业论文（设计）转换结果.docx')
  await docxToDocToDocxRoundtrip(cnDoc, cnConv)
  const z2 = await JSZip.loadAsync(fs.readFileSync(cnConv))
  const x2 = await z2.file('word/document.xml').async('string')
  ok('全角括号中文路径转换成功', x2.includes('第一章 总则') && x2.includes('1.5倍行距'))

  // ⑤ 正斜杠路径（AI 传参常带 C:/xxx——WPS COM 对正斜杠挂死，ps1 内 Resolve-Path 必须修正）
  const fwdDoc = docSample.replace(/\\/g, '/')
  const fwdConv = path.join(dir, '正斜杠转换.docx')
  await docxToDocToDocxRoundtrip(fwdDoc, fwdConv)
  const z3 = await JSZip.loadAsync(fs.readFileSync(fwdConv))
  const x3 = await z3.file('word/document.xml').async('string')
  ok('正斜杠路径转换成功（Resolve-Path 修正）', x3.includes('第一章 总则'))

  console.log(asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}

// 复用项目 ai/doc2docx.ps1 走正向转换（与线上同一条链路）
async function docxToDocToDocxRoundtrip(docPath, backDocx) {
  const { execFile: ef } = require('child_process')
  const ps1 = path.join(__dirname, '..', 'ai', 'doc2docx.ps1')
  await new Promise((resolve, reject) => {
    ef('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Src', docPath, '-Dst', backDocx], { timeout: 60000, windowsHide: true, encoding: 'utf8' }, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
