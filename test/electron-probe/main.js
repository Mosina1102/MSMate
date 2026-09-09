// Electron 22 探针：在打包同版本的 Electron 运行时里真跑 linkedom 链路——
// 防开发机高版本 Node 的 require(ESM) 容忍造成假阳性（v2.5.5 及之前正式包全炸的根因）
const path = require('path')
const { app } = require('electron')

app.whenReady().then(async () => {
  try {
    const office = require(path.join(__dirname, '..', '..', 'ai', 'office.js'))
    require('pdf-parse') // v2.5.68：pdf-parse CJS require 链在 Electron 22 必须可加载（新引包过探针的规矩）
    const paper = 'f:/局域网互传2.0/实验喵！/素材论文.docx'
    const fp = await office.parseWordFormat(paper) // linkedom: DOMParser text/xml 全链路
    const finger = office.wordFormatFingerprint(fp).fingerprint // 指纹再加工（同为 linkedom 链路）
    const bodyFont = finger && finger.body && finger.body.eastAsiaFont
    if (!finger || !finger.body) throw new Error('指纹无 body 结构')
    // v2.5.72：svgToPng 应用内真渲染（隐藏窗口 offscreen + capturePage 链路——纯 Node 冒烟只能测报错分支）
    const fs2 = require('fs'), os2 = require('os')
    const svgP = path.join(os2.tmpdir(), 'probe-chart.svg')
    const pngP = svgP.replace(/\.svg$/, '.png')
    fs2.writeFileSync(svgP, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#4a6fa5"/><text x="10" y="45" fill="#ffffff" font-size="16">图表中文</text></svg>')
    const svgr = await office.svgToPng(svgP, pngP)
    if (!svgr.size || svgr.size < 500) throw new Error('svgToPng 渲染产物异常: ' + JSON.stringify(svgr))
    if (!fs2.existsSync(pngP)) throw new Error('svgToPng 未产出 PNG')
    console.log('ELECTRON_PROBE_OK node=' + process.versions.node + ' electron=' + process.versions.electron + ' bodyFont=' + (bodyFont || '-') + ' svgPng=' + svgr.width + 'x' + svgr.height + '/' + Math.round(svgr.size / 1024) + 'KB')
    app.exit(0)
  } catch (e) {
    console.error('ELECTRON_PROBE_FAIL ' + (e.message || e))
    app.exit(1)
  }
})
