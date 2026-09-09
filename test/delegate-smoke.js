// 多Agent分工冒烟测试（不调真实 API）
const { WorkAgent } = require('../ai/agent')

async function main() {
  // 1. 子Agent不能再委派
  const child = Object.create(WorkAgent.prototype)
  child.isChild = true
  child.send = () => {}
  const r1 = await child.execDelegate({ call: { name: 'delegate', args: { task: 'x' } }, callId: 'x' }, 0)
  console.log('isChild拒绝:', r1.ok === false && r1.message.includes('子Agent') ? '✅' : '❌ ' + JSON.stringify(r1))

  // 2. 缺 task 参数拒绝
  const parent = Object.create(WorkAgent.prototype)
  parent.isChild = false
  parent.send = () => {}
  const r2 = await parent.execDelegate({ call: { name: 'delegate', args: {} }, callId: 'y' }, 0)
  console.log('缺task拒绝:', r2.ok === false && r2.message.includes('task') ? '✅' : '❌ ' + JSON.stringify(r2))

  // 3. 分组：两个 delegate 同组并行；delegate 与普通工具保守串行
  const items = [
    { call: { name: 'delegate', args: { task: 'a' } }, callId: '1' },
    { call: { name: 'delegate', args: { task: 'b' } }, callId: '2' },
    { call: { name: 'write_file', args: { path: 'D:\\x.txt' } }, callId: '3' }
  ]
  const g = parent.groupParallel(items)
  console.log('分组:', g.map((gr) => gr.map((i) => i.callId).join(',')).join(' / '))
  const gDelegates = g.find((gr) => gr[0].call.name === 'delegate')
  if (gDelegates && gDelegates.length === 2) console.log('✅ 两个delegate同组（并行）')
  else { console.log('❌ delegate 应同组并行'); process.exitCode = 1 }
  if (!gDelegates.some((i) => i.callId === '3')) console.log('✅ delegate 与普通工具保守串行')
  else { console.log('❌ delegate 不应与普通工具同组'); process.exitCode = 1 }

  // 4. runLimited 限流：并发不超过 limit，results 与输入顺序一致
  let active = 0
  let maxActive = 0
  const ret = await parent.runLimited([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return n * 10
  })
  const seqOk = ret.join(',') === '10,20,30,40,50,60'
  const limitOk = maxActive <= 2
  console.log(`runLimited: 顺序${seqOk ? '✅' : '❌'} 并发峰值${maxActive}${limitOk ? '✅' : '❌'}`)
  if (!seqOk || !limitOk) process.exitCode = 1

  console.log(process.exitCode ? '❌ 有失败项' : '\n✅ 多Agent分工冒烟测试全部通过')
}

main().catch((e) => { console.error('FAIL', e); process.exit(1) })
