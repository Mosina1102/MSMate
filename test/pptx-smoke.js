// PPT 三件套 + validateDocx 冒烟（纯 Node，v2.7.15）
const fs = require('fs')
const path = require('path')
const os = require('os')
const office = require('../ai/office.js')

let pass = 0, fail = 0
function ok(cond, name) { if (cond) { pass++ } else { fail++; console.error('FAIL: ' + name) } }

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-smoke-'))

  // ① createPptx：全页型大纲（封面/目录/章节/内容带表格/引用/卡片/总结）
  const outline = [
    'theme: luxury',
    'style: rounded',
    '---',
    '#cover 2026 产品发布计划',
    '##MSMate 全年路演方案',
    '###产品部 · 2026-09',
    '---',
    '#toc',
    '- 市场回顾',
    '- 产品亮点',
    '- 渠道策略',
    '---',
    '#section 市场回顾',
    '##上半年关键数据一览',
    '---',
    '##关键数据',
    '- 用户规模翻倍增长',
    '- 付费转化率提升 40%',
    '- NPS 达到 62 分',
    '---',
    '##渠道对比',
    '| 渠道 | 投入 | 转化 |',
    '| 线上 | 30万 | 5.2% |',
    '| 线下 | 50万 | 8.1% |',
    '---',
    '##一句话定位',
    '> 让每台电脑都有一位懂文件的 AI 管家',
    '---',
    '#summary 三个关键词',
    '- 稳：免费档稳住基本盘',
    '- 快：两周一个版本',
    '- 狠：渠道敢于取舍',
    '###产品部出品'
  ].join('\n')
  const p1 = path.join(dir, 'full.pptx')
  const size1 = await office.createPptx(p1, { title: '', content: outline })
  ok(size1 > 30000, 'createPptx 产物大小 ' + size1)
  ok(fs.existsSync(p1), 'createPptx 落盘')

  // ② readPptx：逐页文本提取 + 页数 + 顺序
  const r = await office.readPptx(p1)
  ok(r.count === 7, 'readPptx 页数=7 实际 ' + r.count)
  ok(r.text.includes('2026 产品发布计划'), 'readPptx 封面标题')
  ok(r.text.includes('渠道对比'), 'readPptx 内容页标题')
  ok(r.text.includes('30万'), 'readPptx 表格单元格')
  ok(r.text.includes('让每台电脑都有一位懂文件的 AI 管家'), 'readPptx 引用')
  ok(r.text.includes('渠道策略'), 'readPptx 目录')

  // ③ editPptx：单 t 内替换 + 跨 run 替换（"发布计划"与"路演方案"同段不同 run 场景）
  const e1 = await office.editPptx(p1, [{ find: '产品发布计划', replace: '产品升级计划' }])
  ok(e1.replaced >= 1, 'editPptx 替换计数 ' + e1.replaced)
  const r2 = await office.readPptx(p1)
  ok(r2.text.includes('产品升级计划') && !r2.text.includes('产品发布计划'), 'editPptx 替换生效')
  const e2 = await office.editPptx(p1, [{ find: '不存在的文字XYZ' }])
  ok(e2.missed.length === 1 && e2.replaced === 0, 'editPptx miss 上报')

  // ④ 自动封面合成（无 #cover 块，title 参数兜底）+ technight 深色调色板 + pill 风格
  const p2 = path.join(dir, 'auto.pptx')
  await office.createPptx(p2, { title: '自动封面标题', subtitle: '副标题', content: 'theme: technight\nstyle: pill\n---\n##只有一页\n- 要点甲\n- 要点乙' })
  const r3 = await office.readPptx(p2)
  ok(r3.count === 2 && r3.text.includes('自动封面标题'), '自动封面合成')

  // ⑤ 30 页上限
  let threw = false
  try { await office.createPptx(path.join(dir, 'x.pptx'), Array.from({ length: 32 }, () => '---\n##页\n- 点').join('\n')) } catch { threw = true }
  ok(threw, '超 30 页抛错')

  // ⑥ validateDocx：正常文档过关卡 + 损坏文档拦截
  const good = path.join(dir, 'good.docx')
  await office.createDocx(good, { title: '关卡测试', paragraphs: [{ text: '正文一段', style: 'body' }] })
  const v1 = await office.validateDocx(good)
  ok(v1.ok, 'validateDocx 正常文档 ok ' + JSON.stringify(v1.issues))
  const bad = path.join(dir, 'bad.docx')
  fs.copyFileSync(good, bad)
  // 篡改：document.xml 砍掉闭合标签 → 硬错误
  const JSZip = require('jszip')
  const zb = await JSZip.loadAsync(fs.readFileSync(bad))
  let dx = await zb.file('word/document.xml').async('string')
  dx = dx.slice(0, dx.indexOf('</w:document>'))
  zb.file('word/document.xml', dx)
  fs.writeFileSync(bad, await zb.generateAsync({ type: 'nodebuffer' }))
  let gateThrew = false
  try { await office.validateDocx(bad, { throwOnError: true }) } catch (e) { gateThrew = /校验关卡/.test(e.message) }
  ok(gateThrew, 'validateDocx 拦截损坏文档')
  const v2 = await office.validateDocx(bad)
  ok(!v2.ok && v2.issues.length > 0, 'validateDocx 报告模式')

  // ⑦ createDocx 内建关卡不误伤正常流（回归）
  const good2 = path.join(dir, 'good2.docx')
  const s2 = await office.createDocx(good2, { title: '回归', paragraphs: ['一', '二'] })
  ok(s2 > 0, 'createDocx 内建关卡通过')

  // ⑧ 工具层全链路（tools.execute：create_pptx / read_pptx / edit_pptx）
  const { createTools } = require('../ai/tools')
  const fakeSnaps = { backupLocal: () => ({ ok: true, id: 'snap_fake' }), snapshotDir: (id) => path.join(dir, id), register: () => {} }
  const tools = createTools({ tcpAgent: {}, snapshots: fakeSnaps, desktopDir: dir, tmpDir: dir, workspaceDir: dir, getSetting: () => null, setSetting: () => true, log: () => {} })
  const tp = path.join(dir, '工具层.pptx')
  const tr1 = await tools.execute('create_pptx', { path: tp, title: '工具层探针', content: '---\n##页面一\n- 甲\n- 乙\n---\n#summary 完\n- 收工' })
  ok(tr1.ok === true && fs.existsSync(tp), 'tools.create_pptx 成功 ' + (tr1.ok === false ? tr1.message : ''))
  const tr2 = await tools.execute('read_pptx', { path: tp })
  ok(tr2.ok === true && tr2.message.includes('页面一'), 'tools.read_pptx 逐页文本')
  const tr3 = await tools.execute('edit_pptx', { path: tp, replacements: [{ find: '甲', replace: '丙' }] })
  ok(tr3.ok === true && tr3.message.includes('替换'), 'tools.edit_pptx 替换 ' + (tr3.ok === false ? tr3.message : ''))
  const tr4 = await tools.execute('edit_pptx', { path: tp, replacements: [{ find: '不存在的词Q' }] })
  ok(tr4.ok === false && tr4.message.includes('未找到'), 'tools.edit_pptx miss 报错文案')
  // 审批分类：新建不拦截、覆盖标记 destructive
  const cls1 = await tools.classify('create_pptx', { path: path.join(dir, '新的.pptx') })
  const cls2 = await tools.classify('create_pptx', { path: tp })
  ok(cls1.destructive === false && cls2.destructive === true, 'classify：create_pptx 新建免审批/覆盖标记破坏性')

  console.log(`PPTX_SMOKE ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('SMOKE_ERROR ' + (e.stack || e.message)); process.exit(1) })
