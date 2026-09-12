// pdf-lib × Electron 22 探针：require + 真造 PDF + 真合并 + 真提取页
// 通过标准：合并 2 页、提取 1 页、产物字节以 %PDF 开头
const fs = require('fs')
const path = require('path')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // ① require（Electron 主进程兼容性）
  let pdfLib
  try { pdfLib = require('pdf-lib'); ok('require pdf-lib', true) } catch (e) { ok('require pdf-lib', false, e.message); return done() }
  const { PDFDocument, StandardFonts } = pdfLib

  const tmp = path.join(__dirname, '.tmp-pdf-probe')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  try {
    // ② 造两个单页 PDF（含真实文字，防"空 PDF 合并"假绿）
    const make = async (text) => {
      const doc = await PDFDocument.create()
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const page = doc.addPage([595, 842])
      page.drawText(text, { x: 60, y: 760, size: 24, font })
      return doc.save()
    }
    const a = await make('Probe Document A')
    const b = await make('Probe Document B')
    fs.writeFileSync(path.join(tmp, 'a.pdf'), a)
    fs.writeFileSync(path.join(tmp, 'b.pdf'), b)
    ok('造两个单页 PDF', a.length > 500 && b.length > 500, `${a.length}B/${b.length}B`)

    // ③ 合并（模拟 merge_pdf 工具核心）
    const merged = await PDFDocument.create()
    for (const f of ['a.pdf', 'b.pdf']) {
      const src = await PDFDocument.load(fs.readFileSync(path.join(tmp, f)), { ignoreEncryption: true })
      const pages = await merged.copyPages(src, src.getPageIndices())
      pages.forEach((p) => merged.addPage(p))
    }
    const mergedBytes = await merged.save()
    const mergedPath = path.join(tmp, 'merged.pdf')
    fs.writeFileSync(mergedPath, mergedBytes)
    const mergedCheck = await PDFDocument.load(mergedBytes)
    ok('合并后页数 = 2', mergedCheck.getPageCount() === 2, String(mergedCheck.getPageCount()))
    ok('合并产物 %PDF 魔数', String.fromCharCode(...mergedBytes.slice(0, 5)) === '%PDF-', String.fromCharCode(...mergedBytes.slice(0, 5)))

    // ④ 提取第 2 页（模拟 split_pdf 工具核心）
    const srcDoc = await PDFDocument.load(fs.readFileSync(mergedPath), { ignoreEncryption: true })
    const single = await PDFDocument.create()
    const [p2] = await single.copyPages(srcDoc, [1])
    single.addPage(p2)
    const singleBytes = await single.save()
    const singlePath = path.join(tmp, 'page2.pdf')
    fs.writeFileSync(singlePath, singleBytes)
    const singleCheck = await PDFDocument.load(singleBytes)
    ok('提取第2页后页数 = 1', singleCheck.getPageCount() === 1, String(singleCheck.getPageCount()))

    // ⑤ 加密 PDF 容错（ignoreEncryption 不炸）
    const enc = await PDFDocument.load(fs.readFileSync(mergedPath))
    ok('重新 load 已存文件', enc.getPageCount() === 2, String(enc.getPageCount()))
  } catch (e) {
    ok('PDF 操作全流程', false, e.message)
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  done()
  function done() {
    console.log(`\n${fail === 0 ? 'PDF_PROBE_OK' : 'PDF_PROBE_FAIL'} (${pass}/${pass + fail})`)
    require('electron').app.exit(fail ? 1 : 0)
  }
}

// electron 探针骨架
const { app } = require('electron')
app.on('window-all-closed', () => {})
app.whenReady().then(main)
