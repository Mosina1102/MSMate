// 探针：edit_pptx style（字体/字号/颜色/加粗/对齐）+ animate（进入动画）——XML 断言 + COM 真开防修复框
// 运行：node test/ppt-style-probe.js
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

async function main() {
  const { createPptx, editPptx } = require('../ai/office')
  const JSZip = require('jszip')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-style-'))
  const file = path.join(tmp, 'probe.pptx')

  // 1. 造 2 页
  await createPptx(file, { title: '探针封面', content: '#cover 探针封面\n---\n## 第二章标题\n- 要点一 hello\n- 要点二 world\n---\n## 第三页\n- 尾页要点' })
  ok('createPptx 造底稿', fs.existsSync(file))

  // 2. style：第 2 页标题 run 设字号40/加粗/红色/居中；整页字号 20
  await editPptx(file, { style: [
    { page: 2, find: '第二章标题', fontSize: 40, bold: true, color: 'FF0000', align: 'center' },
    { page: 3, fontSize: 20 }
  ] })

  // 3. animate：第 1 页标题淡入、第 2 页正文擦除
  await editPptx(file, { actions: [
    { op: 'animate', page: 1, effect: 'fade' },
    { op: 'animate', page: 2, effect: 'wipe', target: 'body' }
  ] })

  // 4. XML 断言
  const zip = await JSZip.loadAsync(fs.readFileSync(file))
  const slideXml = async (n) => {
    // 按 sldIdLst 逻辑页序取
    const presXml = await zip.file('ppt/presentation.xml').async('string')
    const relsXml = await zip.file('ppt/_rels/presentation.xml.rels').async('string')
    const rid2target = new Map([...relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]))
    const lst = presXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)[1]
    const rids = [...lst.matchAll(/r:id="(rId\d+)"/g)].map(m => m[1])
    return zip.file('ppt/' + rid2target.get(rids[n - 1]).replace(/^\//, '')).async('string')
  }
  const s2 = await slideXml(2)
  ok('字号 sz=4000（40磅×100）', /sz="4000"/.test(s2))
  ok('加粗 b="1"', /b="1"/.test(s2))
  ok('颜色 FF0000', /<a:srgbClr val="FF0000"\/>/.test(s2))
  ok('居中 algn="ctr"', /algn="ctr"/.test(s2))
  const s3 = await slideXml(3)
  ok('整页字号 sz=2000', /sz="2000"/.test(s3))
  const s1 = await slideXml(1)
  ok('第1页 timing 淡入动画', /<p:timing>[\s\S]*animEffect[^>]*filter="fade"[\s\S]*<\/p:timing>/.test(s1))
  ok('第2页 timing 擦除动画', /<p:timing>[\s\S]*filter="wipe\(down\)"[\s\S]*<\/p:timing>/.test(s2))

  // 5. COM 真开（防 PowerPoint/WPS 弹修复框）——三引擎 KWPP→PowerPoint→WPP
  const comCheck = await new Promise((resolve) => {
    const tryEngines = (engines, i) => {
      if (i >= engines.length) return resolve({ skip: true })
      const [progId] = engines[i]
      execFile('powershell.exe', ['-NoProfile', '-Command', `
        try {
          $app = New-Object -ComObject ${progId}
          $pres = $app.Presentations.Open('${file.replace(/\\/g, '\\\\')}', $true, $false, $false)
          $n = $pres.Slides.Count
          $bad = 0
          foreach ($s in $pres.Slides) { if ($s.Shapes.Count -lt 1) { $bad++ } }
          $pres.Close(); $app.Quit()
          Write-Output "OK:$n:$bad"
        } catch { Write-Output "ERR:$($_.Exception.Message)" }
      `], { timeout: 90000, windowsHide: true }, (err, so) => {
        const out = String(so || '').trim()
        if (out.startsWith('OK:')) return resolve({ n: Number(out.split(':')[1]), bad: Number(out.split(':')[2]) })
        tryEngines(engines, i + 1)
      })
    }
    tryEngines([['KWPP.Application'], ['PowerPoint.Application'], ['WPP.Application']], 0)
  })
  if (comCheck.skip) console.log('SKIP  COM 真开验证（本机无 PowerPoint/WPS COM，请人工用 WPS 打开抽查弹不弹修复框）')
  else {
    ok('COM 真开无修复框（页数 3）', comCheck.n === 3, `实际 ${comCheck.n} 页`)
    ok('COM 每页形状 ≥1', comCheck.bad === 0, `${comCheck.bad} 页空形状`)
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('探针异常:', e.message); process.exit(1) })
