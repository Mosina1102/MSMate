// 真文件试水：实验喵文件夹的素材论文 + 论文格式模板 → applyWordTemplate → 解包断言
const path = require('path')
const fs = require('fs')
const { applyWordTemplate } = require('../ai/office')

const DIR = 'f:/局域网互传2.0/实验喵！'
const PAPER = path.join(DIR, '素材论文.docx')
const TPL = path.join(DIR, '论文格式模板.docx')
const OUT = path.join(DIR, '素材论文-套模板格式.docx')

async function main() {
  const r = await applyWordTemplate(PAPER, TPL, {
    outputPath: OUT,
    cover: { title: '新零售模式下盒马鲜生商业模式创新研究——以重庆市场为例', college: '网络与继续教育学院', major: '工商管理', grade: '2022级', studentId: '20221136040088', name: '张三', advisor: '李四', date: '2026年6月6日' }
  })
  console.log('RESULT', JSON.stringify(r, null, 1))

  // 解包断言
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(fs.readFileSync(OUT))
  const doc = await zip.file('word/document.xml').async('string')
  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)
  ok('输出文件存在', fs.existsSync(OUT))
  ok('节数>=3（封面/摘要/目录/正文分区）', (doc.match(/<w:sectPr[\s>]/g) || []).length >= 3)
  ok('罗马页码分区 upperRoman', doc.includes('upperRoman'))
  ok('正文页码重新起算 start=1', /<w:pgNumType w:start="1"\/>/.test(doc))
  ok('页眉页脚部件存在', !!zip.file('word/header1.xml') && !!zip.file('word/footer1.xml'))
  ok('素材正文迁入（盒马鲜生）', doc.includes('盒马鲜生'))
  ok('章标题保留（第一章 绪论）', doc.includes('第一章 绪论'))
  ok('摘要内容迁入', /摘要内容|数字技术与实体零售/.test(doc))
  ok('关键词行生成', doc.includes('关键词：'))
  ok('题目写入摘要节', doc.includes('新零售模式下盒马鲜生商业模式创新研究'))
  ok('封面字段替换-学院', doc.includes('网络与继续教育学院'))
  ok('封面字段替换-姓名', doc.includes('张三'))
  ok('TOC 域存在', doc.includes('TOC \\o') || doc.includes(' TOC '))
  ok('论文网页色 0F1115 已清除', !doc.includes('0F1115'))
  ok('Segoe UI 中文字体已清除', !doc.includes('w:eastAsia="Segoe UI"'))
  ok('宋体小四正文（sz 24=12pt）', /w:eastAsia="宋体"/.test(doc))
  ok('黑体标题', /w:eastAsia="黑体"/.test(doc))
  ok('outlineLvl 标题层级', doc.includes('<w:outlineLvl'))
  ok('论文 pStyle 引用已清（Normal(Web) 断链）', !doc.includes('w:val="3"/><w:jc'))
  const rels = await zip.file('word/_rels/document.xml.rels').async('string')
  ok('numbering 迁入', !!zip.file('word/numbering.xml') && rels.includes('numbering.xml'))
  ok('rels 无裸 rId 冲突（rIdT 前缀迁移）', rels.includes('rIdT'))
  ok('正文 body 尾有 sectPr', /<\/w:body>/.test(doc) && /<w:sectPr[\s\S]*<\/w:sectPr><\/w:body>|<w:sectPr[\s\S]*<\/w:body>/.test(doc.slice(-3000)))
  // v2.5.79 回归：承诺书/手签行/摘要题目/软换行拆段/单级编号 h3/封面题目下划线（本次修复全套）
  const paras = doc.match(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || []
  const txt = (p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map(x => x.replace(/<[^>]+>/g, '')).join('')
  const texts = paras.map(txt)
  const cmt = texts.find(t => t.includes('我承诺在毕业论文撰写'))
  ok('承诺书正文完整141字（字段行判定不误伤）', cmt && cmt.length === 141 && cmt.endsWith('由本人负完全责任。'))
  ok('手签行"年 月 日"保留不填日期', texts.some(t => /^年\s+月\s+日$/.test(t.trim())) && !texts.some(t => /^年\s+月\s+2026/.test(t.trim())))
  const titleCount = texts.filter(t => t.trim() === '新零售模式下盒马鲜生商业模式创新研究——以重庆市场为例').length
  ok('摘要区题目仅1次（排头不重复插入）', titleCount === 1)
  ok('1.1 研究背景独立成段', texts.some(t => t.trim() === '1.1 研究背景'))
  ok('1.1 不再与正文挤同段', !texts.some(t => /^1\.1\s+研究背景随着/.test(t.trim())))
  ok('1.2 研究意义独立成段', texts.some(t => t.trim() === '1.2 研究意义'))
  ok('单级编号行拆段+h3（黑体小四不加粗）', ['1. 理论意义', '2. 实践意义'].every(w => {
    const p = paras.find(q => txt(q).trim() === w)
    return p && /黑体/.test(p) && /<w:sz w:val="24"/.test(p) && !/<w:b\/>/.test(p)
  }))
  ok('h3 指纹防污染（不采承诺书居中粗）', (() => {
    const p = paras.find(q => txt(q).trim() === '2. 实践意义')
    return p && !/<w:jc w:val="center"\/>/.test(p)
  })())
  ok('1.1 h2 黑体四号不加粗', (() => {
    const p = paras.find(q => txt(q).trim() === '1.1 研究背景')
    return p && /黑体/.test(p) && /<w:sz w:val="28"/.test(p) && !/<w:b\/>/.test(p)
  })())
  ok('封面题目保留下划线', (paras.find(p => txt(p).includes('中文题目：')) || '').includes('<w:u'))
  ok('全文无"标题+正文"挤段残留', !texts.some(t => /^\d{1,2}\.\d{1,2}\s*\S/.test(t.trim()) && t.length > 30 && !/[…]/.test(t.trim())))
  // XML 良构性：linkedom 能解析
  try {
    const { DOMParser } = require('linkedom')
    new DOMParser().parseFromString(doc, 'text/xml')
    ok('document.xml XML 良构', true)
  } catch (e) { ok('document.xml XML 良构: ' + e.message, false) }
  console.log(asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
