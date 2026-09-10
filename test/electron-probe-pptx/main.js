// Electron 22 探针（pptxgenjs）：新引包必须过探针的规矩——
// 在打包同版本的 Electron 运行时里真跑 require 链 + office.js 三件套全链路，防开发机高版本 Node 假阳性
const path = require('path')
const os = require('os')
const fs = require('fs')
const { app } = require('electron')

app.whenReady().then(async () => {
  try {
    // ① CJS require 链可加载（含 https/image-size/jszip 嵌套依赖）
    const PptxGenJS = require('pptxgenjs')

    // ② 最小生成链路：封面 + 内容页 + 页码徽标（MiniMax 设计系统关键元素）
    const pres = new PptxGenJS()
    pres.layout = 'LAYOUT_16x9'
    const theme = { primary: '22223b', secondary: '4a4e69', accent: '9a8c98', light: 'c9ada7', bg: 'f2e9e4' }

    const cover = pres.addSlide()
    cover.background = { color: theme.bg }
    cover.addText('探针封面', { x: 0.5, y: 2, w: 9, h: 1.2, fontSize: 44, fontFace: 'Microsoft YaHei', color: theme.primary, bold: true, align: 'center', fit: 'shrink' })
    cover.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 4.1, y: 3.4, w: 1.8, h: 0.5, fill: { color: theme.accent }, rectRadius: 0.15 })

    const body = pres.addSlide()
    body.background = { color: 'FFFFFF' }
    body.addText('内容页标题', { x: 0.5, y: 0.4, w: 9, h: 0.7, fontSize: 30, bold: true, color: theme.primary, fontFace: 'Microsoft YaHei' })
    body.addText('要点正文（不加粗）', { x: 0.6, y: 1.4, w: 8.8, h: 0.5, fontSize: 14, color: theme.secondary, fontFace: 'Microsoft YaHei', align: 'left' })
    body.addShape(pres.shapes.OVAL, { x: 9.3, y: 5.1, w: 0.4, h: 0.4, fill: { color: theme.accent } })
    body.addText('2', { x: 9.3, y: 5.1, w: 0.4, h: 0.4, fontSize: 12, color: 'FFFFFF', bold: true, align: 'center', valign: 'middle' })

    const outP = path.join(os.tmpdir(), 'probe-pptx-' + Date.now() + '.pptx')
    await pres.writeFile({ fileName: outP })
    if (!fs.existsSync(outP) || fs.statSync(outP).size < 20000) throw new Error('产物缺失或过小')

    // ③ office.js 三件套全链路（设计系统 + 大纲解析 + 读取 + 编辑）
    const office = require(path.join(__dirname, '..', '..', 'ai', 'office.js'))
    const outline = [
      'theme: technight',
      'style: pill',
      '---',
      '#cover 探针演示',
      '##副标题',
      '---',
      '#toc',
      '- 第一章',
      '- 第二章',
      '---',
      '#section 第一章',
      '---',
      '##数据页',
      '- 要点甲',
      '- 要点乙',
      '- 要点丙',
      '- 要点丁',
      '| 指标 | 数值 |',
      '| 增长 | 42% |',
      '---',
      '#summary 收尾',
      '- 完成链路验证'
    ].join('\n')
    const fullP = path.join(os.tmpdir(), 'probe-pptx-full-' + Date.now() + '.pptx')
    const size = await office.createPptx(fullP, { title: '', content: outline })
    if (size < 30000) throw new Error('office.createPptx 产物过小: ' + size)
    const r = await office.readPptx(fullP)
    if (r.count !== 5 || !r.text.includes('数据页') || !r.text.includes('42%')) throw new Error('office.readPptx 异常: count=' + r.count)
    const e = await office.editPptx(fullP, [{ find: '要点甲', replace: '改点甲' }])
    if (e.replaced < 1) throw new Error('office.editPptx 替换失败')
    const r2 = await office.readPptx(fullP)
    if (!r2.text.includes('改点甲')) throw new Error('office.editPptx 回读失败')

    // ④ validateDocx 关卡（Electron 运行时内）
    const goodP = path.join(os.tmpdir(), 'probe-gate-' + Date.now() + '.docx')
    await office.createDocx(goodP, { title: '探针', paragraphs: [{ text: '正文', style: 'body' }] })
    const v = await office.validateDocx(goodP)
    if (!v.ok) throw new Error('validateDocx 误报: ' + JSON.stringify(v.issues))

    // ⑤ anticrawl 过盾一致性（Electron 侧）：engineUA 与真引擎版本对齐、无 Electron 尾巴
    const { engineUA } = require(path.join(__dirname, '..', '..', 'ai', 'anticrawl.js'))
    const eu = engineUA()
    if (!new RegExp('Chrome/' + process.versions.chrome.replace(/\./g, '\\.')).test(eu)) throw new Error('engineUA 未对齐真引擎版本: ' + eu + ' vs ' + process.versions.chrome)
    if (/Electron/i.test(eu)) throw new Error('engineUA 泄露 Electron 尾巴: ' + eu)

    fs.unlinkSync(outP); fs.unlinkSync(fullP); fs.unlinkSync(goodP)
    console.log('PPTX_PROBE_OK node=' + process.versions.node + ' electron=' + process.versions.electron + ' pptxgenjs=4.0.1 pages=' + r.count + ' engineUA=' + process.versions.chrome)
    app.exit(0)
  } catch (e) {
    console.error('PPTX_PROBE_FAIL ' + (e.message || e))
    app.exit(1)
  }
})
