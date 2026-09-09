// v2.5.76 套模板工作流测试：说明书式模板的节判定/示范段剔除/封面字段——纯逻辑单测 + 真素材全链路（缺失 SKIP）
const path = require('path')
const fs = require('fs')
const os = require('os')
const office = require('../ai/office.js')

const TPL = 'C:/Users/ars/Downloads/成教本科毕业论文（设计）论文类撰写参考模板 (1).doc'
const PAPER = 'C:/Users/ars/Downloads/人工智能对中小企业财务管理的影响与对策_成教毕业论文_生成版 (1).docx'

async function main() {
  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)

  // ① isFormatDemoPara：说明书式模板的示范段形态全覆盖
  const demos = ['三号黑体，居中', '四号宋体，居中', '五号宋体，页眉之下有一条下划线', '五号宋体，表格逐章单独编序', '小四号宋体', '小四号黑体', '小三号黑体', '空一行', '空一格', 'Times New Roman,三号粗，居中', 'Times New Roman 小四号', '用罗马字母编号号', '用罗马字母编号', '3～5个，关键词用一个空格分隔，小四号宋体', '3～5个，用分号分隔', '右缩进两个字', '……', '第二……', '五号宋']
  demos.forEach((d) => ok(`示范段识别："${d}"`, office.isFormatDemoPara(d) === true))
  // 非示范段（正文真句子不能误杀）
  const notDemos = ['绩效考核也称成绩或成果测评，绩效考核是企业为了实现生产经营目的，运用特定的标准和指标，采取特定的方法', '本文在前期成功地制备出Nd:YAG透明陶瓷', '三号黑体是比较常见的标题字号选择，很多学校都这么要求', '摘要']
  notDemos.forEach((d) => ok(`正文不误杀："${d.slice(0, 18)}…"`, office.isFormatDemoPara(d) === false))

  // ② classifyTplSection：内容特征判定（说明书式模板无结构排头）
  const P = (text) => ({ text })
  ok('目录条目特征（≥3 段"……页码"）→ toc', office.classifyTplSection([P('用罗马字母编号'), P('ABSTRACT……………………………………………II'), P('一  员工绩效考核基本理论综述…………………………1'), P('(一)员工绩效考核概念及其理论基础. …………………1')], null) === 'toc')
  ok('关键词行特征 → abstract', office.classifyTplSection([P('小四号宋体'), P('钇铝石榴石具有良好的光学性能，是一种重要的激光基质材料。与YAG不同的是它采用陶瓷工艺制备'), P('关键词：钇铝石榴石  两步烧结  YAG  透明陶瓷')], null) === 'abstract')
  ok('Keywords 行特征 → enAbstract', office.classifyTplSection([P('Times New Roman 小四号'), P('Yttrium aluminum garnet is an important laser host material'), P('Keywords: yttrium aluminum garnet; two-step sintering')], null) === 'enAbstract')
  ok('文献条目特征（[1][2] ≥2）→ refs', office.classifyTplSection([P('三号黑体，居中'), P('[1] 唐卓尧．电气传动的微机控制[M]．重庆：重庆大学出版社 1999:16-34'), P('[2] 王兆安．电路电子技术[M]．北京：机械工业出版社 2005: 60-104')], null) === 'refs')
  ok('编号标题特征（"1.xx"≥2）→ body', office.classifyTplSection([P('绩效考核也称成绩或成果测评，是企业为了实现生产经营目的运用特定的标准和指标'), P('1.员工绩效考核含义'), P('2.员工绩效考核建立的理论基础')], null) === 'body')
  ok('封面段 → cover（兜底）', office.classifyTplSection([P('重庆科技大学高等学历继续教育'), P('毕业论文（设计）'), P('题 目      ×××××××××××的研究')], null) === 'cover')
  ok('示范段开路不打瞎判定（"三号黑体，居中"+目录条目 → toc）', office.classifyTplSection([P('三号黑体，居中'), P('空一行'), P('ABSTRACT……………………………………………II'), P('一  绪论…………………………1'), P('二  现状…………………………3')], null) === 'toc')

  // ③ 真素材全链路（素材缺失 SKIP）
  if (!fs.existsSync(TPL) || !fs.existsSync(PAPER)) {
    console.log(asserts.join('\n'))
    console.log('\nSKIP 真素材全链路（Downloads 素材不在——单测部分已覆盖）')
    const fail0 = asserts.filter((a) => a.startsWith('FAIL')).length
    console.log(fail0 ? `\n${fail0} FAILED` : '\nALL PASS')
    process.exit(fail0 ? 1 : 0)
  }
  const { createTools } = require('../ai/tools.js')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tplgraft-'))
  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: (p) => ({ ok: true, id: 'snap_x' }), snapshotDir: () => tmpDir, register: () => {} },
    tmpDir, workspaceDir: tmpDir, log: () => {}, getSetting: () => null, setSetting: () => {},
  })
  const OUT = path.join(tmpDir, '产出.docx')
  const r = await tools.execute('apply_word_template', {
    path: PAPER, templatePath: TPL, outputPath: OUT,
    cover: { title: '人工智能对中小企业财务管理的影响与对策', college: '继续教育学院', name: '（作者姓名）', date: '2026年9月' }
  })
  ok('套模板执行成功', r.ok)
  if (r.ok) {
    const JSZip = require('jszip')
    const z = await JSZip.loadAsync(fs.readFileSync(OUT))
    const docXml = await z.file('word/document.xml').async('string')
    const images = Object.keys(z.files).filter((f) => /^word\/media\//.test(f) && !z.files[f].dir)
    ok('封面校徽图片迁入（≥3 张）', images.length >= 3)
    ok('目录域注入', docXml.includes(' TOC '))
    ok('正文宋体（模板指纹）', /w:eastAsia="宋体"/.test(docXml))
    ok('格式示范段剔除（无"三号黑体，居中"）', !/>三号黑体，居中</.test(docXml.replace(/<[^>]+>/g, '>')) && !docXml.includes('三号黑体，居中'))
    ok('注意事项页剔除（无"定稿删除此页"）', !docXml.includes('定稿删除此页') && !docXml.includes('论文字数要求'))
    ok('原创声明保留（毕业论文必备）', docXml.includes('原创性声明'))
    ok('封面题目替换（无 ××× 残留）', !/×××/.test((docXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('').slice(0, 3000)))
    // 体检闭环（v2.5.77：逐节对照进度表——分段循环工作流的"对比模板"环节程序化）
    const chk = await tools.execute('check_paper_format', { path: OUT, templatePath: TPL })
    ok('体检通过（0 项或仅剩内容级缺失）', chk.ok && (chk.issues || []).every((i) => /关键词|参考文献/.test(i.item)))
    const msg = String(chk.message || '')
    ok('逐节对照进度表输出', msg.includes('【逐节对照进度】') && msg.includes('✓ 封面') && msg.includes('✓ 正文'))
    ok('说明书式模板板块判定不漏检（摘要/目录不再误判"模板无此板块"）', !msg.includes('摘要：模板无此板块') && !msg.includes('目录：模板无此板块'))
  }

  console.log(asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
