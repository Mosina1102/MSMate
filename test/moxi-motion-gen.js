// 莫西连续打字序列生成：MSMate 自家 generate_image（带参考图=改图保造型）
// 运行：node test/moxi-motion-gen.js
// 流程：读 userData 配置 → generate_image(Q版立绘参考 + 连续动作指令) → 魔数校验
// 生成产物：桌宠版本素材/打字序列-raw.png（之后用 moxi-asset-prep 的 cutStrip 切成 typing-loop.webp）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createTools } = require('../ai/tools')

function resolveSettingsDir() {
  const candidates = [
    process.env.MSC_USER_DATA,
    path.join(os.homedir(), 'AppData', 'Roaming', 'MSMate-moxi-test'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'MSWork'), // 旧目录迁移兼容
    path.join(os.homedir(), 'AppData', 'Roaming', 'MSMate')
  ].filter(Boolean)
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'settings.json'))) return dir
  }
  return null
}

async function main() {
  const dir = resolveSettingsDir()
  if (!dir) { console.error('FAIL 未找到 userData/settings.json（先在 MSMate 里配置好生图模型）'); process.exit(1) }
  console.log('配置目录:', dir)
  const settingsPath = path.join(dir, 'settings.json')
  const readS = () => { try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return {} } }
  const getSetting = (k) => readS()[k]
  const setSetting = (k, v) => { const s = readS(); s[k] = v; fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2)); return true }

  const base = path.join(__dirname, '.tmp-moxi-motion')
  fs.mkdirSync(base, { recursive: true })
  const refPath = path.join(__dirname, '..', '桌宠版本素材', 'Q版立绘.png')
  if (!fs.existsSync(refPath)) { console.error('FAIL 参考图不存在:', refPath); process.exit(1) }

  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [], uploadFile: async () => ({ success: true }), downloadFile: async () => ({ success: true }) },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试' }) },
    desktopDir: base,
    tmpDir: base,
    workspaceDir: base,
    getSetting,
    setSetting,
    log: (m) => console.log('[log]', m)
  })

  // hatch-pet 方法论：参考图 grounding + 姿势渐进 + 全格一致 + 透明底
  const prompt = [
    '将这个角色改编为 4x4 连续动作精灵图（sprite sheet），共 16 格按阅读顺序排列：',
    '她坐在同一台银色笔记本电脑前打字，16 格是连续微动作序列：双手放键盘准备→左手敲键→左手抬起→双手打字→头微低看屏→头回正→右手敲键→右手抬起→双手打字→身体微前倾→眨眼→回正→双手快速打字→头微歪→动作放慢→回到准备姿势（首尾可无缝循环）。',
    '硬性要求：每格角色造型完全一致（紫色长发/猫耳/女仆装/表情不变），只有手部头部微小动作渐变；每格同角度同大小同位置，居中不重叠；透明背景；Q版二头身厚描边可爱风。'
  ].join('\n')

  console.log('开始生成（走自家生图管线，带参考图）…')
  const t0 = Date.now()
  const r = await tools.execute('generate_image', {
    prompt,
    image: [refPath],
    size: '2048x2048',
    save_path: path.join(__dirname, '..', '桌宠版本素材', '打字序列-raw.png')
  })
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s ok=${r.ok}`)
  console.log((r.message || '').slice(0, 400))
  if (!r.ok) process.exit(1)

  // 产物魔数校验（防假成功）
  const rawPath = path.join(__dirname, '..', '桌宠版本素材', '打字序列-raw.png')
  if (!fs.existsSync(rawPath)) { console.error('FAIL 产物不存在:', rawPath); process.exit(1) }
  const head = fs.readFileSync(rawPath).subarray(0, 8).toString('latin1')
  const size = fs.statSync(rawPath).size
  const magicOk = head.startsWith('\x89PNG') || head.startsWith('RIFF') || head.startsWith('\xff\xd8')
  console.log(`${magicOk && size > 50000 ? 'OK' : 'FAIL'} 产物 ${rawPath} ${(size / 1024).toFixed(0)}KB magic=${JSON.stringify(head.slice(0, 4))}`)
  process.exit(magicOk && size > 50000 ? 0 : 1)
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1) })
