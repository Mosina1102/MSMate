// 并行批次冒烟测试：多 tool 块解析 + 冲突分组（无副作用，不发请求）
const { WorkAgent } = require('../ai/agent')

const agent = Object.create(WorkAgent.prototype)
// JSON 文本里的 \\ 经 JSON.parse 后变成 \
const content = [
  '先做这些：',
  '```tool',
  '{"name":"create_folder","arguments":{"path":"D:\\\\work\\\\a"}}',
  '```',
  '```tool',
  '{"name":"write_file","arguments":{"path":"D:\\\\work\\\\b.txt","content":"hi"}}',
  '```',
  '```tool',
  '{"name":"write_file","arguments":{"path":"D:\\\\work\\\\a\\\\c.txt","content":"x"}}',
  '```',
  '```tool',
  '{"name":"write_file","arguments":{"path":"E:\\\\other\\\\d.txt","content":"y"}}',
  '```',
  '```tool',
  '{"name":"list_dir","arguments":{"dir":"D:\\\\work\\\\a"}}',
  '```'
].join('\n')

const calls = agent.parseToolCalls(content)
console.log('解析到调用数:', calls.length)
if (calls.length !== 5) {
  console.error('❌ 应解析出 5 个调用，实际', calls.length, JSON.stringify(calls))
  process.exit(1)
}

const groups = agent.groupParallel(calls.map((call, i) => ({ call, callId: 'c' + i })))
console.log('分组结果:')
groups.forEach((g, i) => console.log(`  组${i + 1}: ${g.map((it) => `${it.call.name}(${it.call.args.path})`).join('  |  ')}`))

const findGroup = (p) => groups.findIndex((g) => g.some((it) => it.call.args.path === p))
const gDirA = findGroup('D:\\work\\a')
const gFileC = findGroup('D:\\work\\a\\c.txt')
const gFileB = findGroup('D:\\work\\b.txt')

let pass = true
if (gDirA === gFileC) { console.error('❌ D:\\work\\a 与其子文件不应同组并行'); pass = false } else { console.log('✅ 目录与其子文件已分组串行') }
if (gDirA !== gFileB) { console.error('❌ 不相关文件应同组并行'); pass = false } else { console.log('✅ 不相关路径同组并行') }

// 解析错误兜底：坏 JSON 应返回 [{parseError}]
const bad = agent.parseToolCalls('```tool\n{"name":"x","arguments":}\n```')
if (bad && bad.length === 1 && bad[0].parseError) console.log('✅ 坏 JSON 返回 parseError')
else { console.error('❌ 坏 JSON 应返回 parseError'); pass = false }

console.log(pass ? '\n✅ 并行分组冒烟测试通过' : '\n❌ 测试失败')
process.exit(pass ? 0 : 1)
