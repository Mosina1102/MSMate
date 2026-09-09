// 设备解析冒烟：精确匹配 / 昵称模糊匹配 / deviceId 截断 / 多台歧义 / 不存在报错带清单
const { createTools } = require('../ai/tools')

const DEVICES = [
  { deviceId: '0f99c112e0a9', name: '顾夕杀杀杀', hostname: 'PC-20250603NSEW' },
  { deviceId: 'aaaa1111bbbb', name: '一宸溜溜溜', hostname: 'HOME-PC' }
]

function makeTools(list) {
  return createTools({
    tcpAgent: { getConnectedDevices: () => list, listRemoteDirectory: async () => ({ success: true, entries: [] }) },
    snapshots: {},
    getSetting: () => null,
    setSetting: () => true,
    log: () => {}
  })
}

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }

  // ① 昵称模糊匹配：用户说"顾夕" → 唯一命中「顾夕杀杀杀」
  {
    const t = makeTools(DEVICES)
    const r = await t.execute('list_dir', { target: '顾夕', path: 'root' })
    check('昵称"顾夕"模糊命中唯一设备', r.ok === true && r.message.includes('顾夕杀杀杀'))
  }

  // ② deviceId 前缀/包含匹配（提示词里的 id 与实际连接的 id 截断/差异场景）
  {
    const t = makeTools(DEVICES)
    const r = await t.execute('list_dir', { target: '0f99c112', path: 'root' })
    check('deviceId 截断前缀命中', r.ok === true && r.message.includes('顾夕杀杀杀'))
  }

  // ③ 精确 deviceId / 设备名 / 主机名（回归：原有行为不变）
  {
    const t = makeTools(DEVICES)
    const r1 = await t.execute('list_dir', { target: '0f99c112e0a9', path: 'root' })
    const r2 = await t.execute('list_dir', { target: '一宸溜溜溜', path: 'root' })
    const r3 = await t.execute('list_dir', { target: 'HOME-PC', path: 'root' })
    check('精确 deviceId 命中', r1.ok === true && r1.message.includes('顾夕杀杀杀'))
    check('精确设备名命中', r2.ok === true && r2.message.includes('一宸溜溜溜'))
    check('精确主机名命中', r3.ok === true && r3.message.includes('一宸溜溜溜'))
  }

  // ④ 歧义保护：两台设备昵称都叫"顾夕" → 拒绝并点名候选，绝不瞎选
  {
    const t = makeTools([
      { deviceId: 'dev-aaa', name: '顾夕杀杀杀', hostname: 'PC-A' },
      { deviceId: 'dev-bbb', name: '顾夕冲冲冲', hostname: 'PC-B' }
    ])
    const r = await t.execute('list_dir', { target: '顾夕', path: 'root' })
    check('多台歧义 → 拒绝并点名候选', r.ok === false && r.message.includes('匹配到多台设备') && r.message.includes('顾夕杀杀杀') && r.message.includes('顾夕冲冲冲'))
  }

  // ⑤ 完全不存在的目标 → 报错带可用设备清单（含 deviceId，模型可自纠）
  {
    const t = makeTools(DEVICES)
    const r = await t.execute('list_dir', { target: '不存在的设备', path: 'root' })
    check('不存在 → 报错带设备清单和 deviceId', r.ok === false && r.message.includes('顾夕杀杀杀') && r.message.includes('0f99c112e0a9'))
  }

  // ⑥ 传输类工具同样走模糊匹配（transfer 前的 targetExists 链路不受影响）
  {
    const t = makeTools(DEVICES)
    const r = await t.execute('list_dir', { target: '顾', path: 'root' })
    check('单字昵称不做模糊（防误匹配）', r.ok === false)
  }

  console.log(pass ? '\n全部通过' : '\n存在失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
