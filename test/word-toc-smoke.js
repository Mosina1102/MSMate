// v2.4.19 Word 排版五连修冒烟：目录预填/段距/图片尺寸/对齐/行距
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const { createDocx } = require('../ai/office')

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msdoc-toc-'))
  // 造一张 800x600 测试 PNG
  const PNG_8x6 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAYCAYAAADgLxLCAAAAFklEQVR4nGP8z8DwnwEPYKMDAwMDAwsABx4QAQAAAABJRU5ErkJggg==', 'base64')
  const imgPath = path.join(dir, 't.png')
  fs.writeFileSync(imgPath, PNG_8x6)

  const p1 = path.join(dir, 'toc.docx')
  await createDocx(p1, {
    title: '测试文档',
    toc: true,
    paragraphs: [
      '# 第一章 引言',
      '这是正文段落。',
      '## 1.1 背景',
      '正文第二段。',
      '# 第二章 方法',
      '## 2.1 数据',
      '结尾。'
    ]
  })
  const zip = await JSZip.loadAsync(fs.readFileSync(p1))
  const xml = await zip.file('word/document.xml').async('string')
  check('TOC 域存在', xml.includes('TOC') && xml.includes('fldCharType'))
  check('目录预填静态条目（第一章）', xml.includes('第一章 引言') && xml.includes('第二章 方法'))
  check('目录预填含二级标题', xml.includes('1.1 背景'))
  check('静态条目在 separate 之后', xml.indexOf('第一章 引言') > xml.indexOf('fldCharType="separate"'))
  check('目录点线制表符', xml.includes('w:leader="dot"'))

  const p2 = path.join(dir, 'para.docx')
  await createDocx(p2, { title: '段落间距', paragraphs: ['第一段正文内容。', '第二段正文内容。'] })
  const x2 = await (await JSZip.loadAsync(fs.readFileSync(p2))).file('word/document.xml').async('string')
  check('正文段后距 120', /w:after="120"/.test(x2))
  check('正文行距 340（1.4 倍）', /w:line="340"/.test(x2))

  const p3 = path.join(dir, 'img.docx')
  await createDocx(p3, {
    title: '图片控制',
    paragraphs: [
      '前文。',
      '![小图](' + imgPath + ' =60)',
      '![右图](' + imgPath + ') {width:80, align:right}',
      '![居中](' + imgPath + ')',
      '后文。'
    ]
  })
  const x3 = await (await JSZip.loadAsync(fs.readFileSync(p3))).file('word/document.xml').async('string')
  const exts = [...x3.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)]
  check('图片=60 宽度生效（60*9525=571500）', exts.some((m) => m[1] === '571500'))
  check('图片=80 宽度生效（80*9525=762000）', exts.some((m) => m[1] === '762000'))
  check('右对齐图片 jc=right', x3.includes('<w:jc w:val="right"/>'))
  check('居中兜底 jc=center', x3.includes('<w:jc w:val="center"/>'))

  console.log(pass ? '\n全部通过' : '\n存在失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
