// 复现：真文件 → 渲染 → dump 生成的 CSS
const fs = require('fs')
const path = require('path')
const REAL = 'C:\\Users\\ars\\Desktop\\罪恶王冠剧情解析.docx'

async function main() {
  const buf = fs.readFileSync(REAL)
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true })
  global.window = dom.window
  global.document = dom.window.document
  global.DOMParser = dom.window.DOMParser
  global.XMLSerializer = dom.window.XMLSerializer
  global.Node = dom.window.Node
  global.HTMLElement = dom.window.HTMLElement
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  const dp = require(path.join(__dirname, '..', 'node_modules', 'docx-preview', 'dist', 'docx-preview.js'))
  const host = document.getElementById('host')
  const style = document.createElement('style')
  document.head.appendChild(style)
  await dp.renderAsync(new Uint8Array(buf), host, style, {
    inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
    useBase64URL: true,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
    ignoreLastRenderedPageBreak: false,
    experimental: true,
    trimXmlDeclaration: true, renderChanges: false, renderComments: false
  })
  const css = style.textContent || ''
  console.log('生成 CSS 长度:', css.length)
  console.log('含 .docx_heading1 规则:', css.includes('docx_heading1'))
  console.log('含 docx-wrapper 背景:', /docx-wrapper[^}]*background/.test(css))
  // 打印 heading 相关规则
  const rules = css.split('}').filter((r) => r.includes('docx_heading1'))
  console.log('--- docx_heading1 相关 CSS ---')
  console.log(rules.join('}\n').slice(0, 800))
  // 图片 src 检查
  const imgs = host.querySelectorAll('img')
  console.log('\nimg 总数:', imgs.length, '有src:', [...imgs].filter((i) => i.getAttribute('src')).length)
  // blob 还是无
  const w2 = host.querySelector('img')
  console.log('第1个 img 外层HTML片段:', (w2 && w2.outerHTML.slice(0, 120)))
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
