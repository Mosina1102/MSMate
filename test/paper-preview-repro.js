// 复现：create_word 论文 docx → 内置预览（docx-preview）渲染是否失败/丢样式
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createDocx } = require('../ai/office')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-paper-'))
  const file = path.join(dir, '罪恶王冠剧情解析.docx')
  await createDocx(file, {
    title: '《罪恶王冠》剧情深度解析',
    header: 'MSMate 生成',
    pageNumbers: true,
    toc: true,
    cover: { title: '《罪恶王冠》剧情深度解析', subtitle: '——关于王冠、罪孽与救赎', org: 'MSMate 生成', date: '2026/9/6' },
    firstLine: true,
    paragraphs: [
      '# 背景设定',
      '世界观的叙述正文，介绍启示录病毒与王冠的能力体系。',
      '## 核心世界观',
      '超级病毒与虚空武器的设定正文。',
      '# 剧情主线（四幕结构）',
      '## 第一幕：邂逅与觉醒（第 1~6 集）',
      '第一幕正文内容。',
      '## 第二幕：成长与裂痕（第 7~12 集）',
      '第二幕正文内容。',
      '# 人物深度剖析',
      '| 角色 | 定位 | 结局 |',
      '|---|---|---|',
      '| 樱满集 | 主角 | 失明失忆 |',
      '| 恙神涯 | 挚友/对手 | 牺牲 |',
      '> 金句引用：我是王。',
      '# 主题解析',
      '结语正文。'
    ]
  })
  const buf = fs.readFileSync(file)
  console.log('✅ 论文 docx 生成:', (buf.length / 1024).toFixed(1) + 'KB')

  // 结构检查：pStyle 用的什么 ID
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(buf)
  const docXml = await zip.file('word/document.xml').async('string')
  const stylesXml = await zip.file('word/styles.xml').async('string')
  const pStyleIds = [...new Set((docXml.match(/<w:pStyle w:val="([^"]+)"/g) || []).map((s) => s.match(/"([^"]+)"/)[1]))]
  console.log('document.xml 引用的 pStyle ID:', pStyleIds.join(', '))
  const styleIds = [...new Set((stylesXml.match(/w:styleId="([^"]+)"/g) || []).map((s) => s.match(/"([^"]+)"/)[1]))]
  console.log('styles.xml 定义的 styleId:', styleIds.join(', '))

  // jsdom + docx-preview 渲染（等价 preload renderDocxPreview）
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true })
  global.window = dom.window
  global.document = dom.window.document
  global.DOMParser = dom.window.DOMParser
  global.XMLSerializer = dom.window.XMLSerializer
  global.Node = dom.window.Node
  global.HTMLElement = dom.window.HTMLElement
  const dp = require(path.join(__dirname, '..', 'node_modules', 'docx-preview', 'dist', 'docx-preview.js'))
  const host = document.getElementById('host')
  const style = document.createElement('style')
  document.head.appendChild(style)
  try {
    await dp.renderAsync(new Uint8Array(buf), host, style, {
      inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
      useBase64URL: true,
      renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
      ignoreLastRenderedPageBreak: false,
      experimental: true,
      trimXmlDeclaration: true, renderChanges: false, renderComments: false
    })
    const pages = host.querySelectorAll('section.docx')
    const h1s = host.querySelectorAll('h1')
    const h2s = host.querySelectorAll('h2')
    const arts = host.querySelectorAll('.docx-wrapper section.docx > article')
    console.log(`\n✅ renderAsync 成功：页面=${pages.length} article=${arts.length} h1=${h1s.length} h2=${h2s.length}`)
    // 目录字段渲染检查
    const allText = host.textContent
    console.log('目录标题出现:', allText.includes('目  录'))
    console.log('标题页文字出现:', allText.includes('《罪恶王冠》剧情深度解析'))
    console.log('表格内容出现:', allText.includes('樱满集'))
    // 输出每个 h1 的 class 和对齐样式（前 3 个）
    ;[...h1s].slice(0, 3).forEach((h, i) => console.log(`h1[${i}] class="${h.className}" style="${(h.getAttribute('style') || '').slice(0, 120)}"`))
    // section 的分页尺寸样式
    const sec = host.querySelector('section.docx')
    console.log('section.docx style 片段:', (sec.getAttribute('style') || '').slice(0, 200))
    fs.writeFileSync(path.join(dir, 'out.html'), host.innerHTML, 'utf8')
    console.log('渲染 HTML 已存:', path.join(dir, 'out.html'))
  } catch (err) {
    console.log('\n❌ renderAsync 抛错（内置预览会回退 mammoth → 全丢样式，和老大截图吻合）:')
    console.log('   ', err.message)
    console.log(err.stack.split('\n').slice(0, 4).join('\n'))
  }
  console.log('\n临时目录（保留供检查）:', dir)
}
main().catch((e) => { console.error('FAIL', e); process.exit(1) })
