// read_file 大文件分段读 + 旧版对端提示 冒烟测试
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createTools } = require('../ai/tools')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-read-'))
  const tools = createTools({
    tcpAgent: {
      getConnectedDevices: () => [
        { deviceId: 'new-dev', name: '新机', hostname: 'new', ip: '', platform: 'win32', appVersion: '2.1.0' },
        { deviceId: 'old-dev', name: '旧机', hostname: 'old', ip: '', platform: 'win32', appVersion: '' }
      ],
      downloadFile: async (deviceId, remotePath, localPath) => {
        // 模拟远程文件：remote: 前缀 = 大文件，其余 = 小文件
        const src = remotePath.startsWith('remote:') ? path.join(base, 'big.txt') : path.join(base, 'small.txt')
        fs.copyFileSync(src, localPath)
        return { success: true }
      },
      uploadFile: async () => ({ success: true })
    },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试' }) },
    desktopDir: base,
    tmpDir: base,
    workspaceDir: base,
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })

  // 造一个 150KB 文本文件 + 小文件 + 二进制文件
  const bigPath = path.join(base, 'big.txt')
  const unit = 'A'.repeat(99) + '\n'
  fs.writeFileSync(bigPath, unit.repeat(1536)) // ~150KB
  const smallPath = path.join(base, 'small.txt')
  fs.writeFileSync(smallPath, '你好，小文件')
  const binPath = path.join(base, 'bin.dat')
  fs.writeFileSync(binPath, Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02]))

  // 1) 小文件：原样返回，无分段提示
  const r1 = await tools.execute('read_file', { path: smallPath })
  ok('小文件原样返回', r1.ok && r1.message === '你好，小文件', r1.message.slice(0, 60))

  // 2) 大文件首段：附总大小与续读提示
  const r2 = await tools.execute('read_file', { path: bigPath })
  const orig = fs.readFileSync(bigPath)
  ok('大文件首段返回64KB', r2.ok && /大文件共/.test(r2.message) && /续读传 offset: 65536/.test(r2.message), r2.message.slice(-80))
  const seg1Body = r2.message.split('\n').slice(1).join('\n').replace(/\n（内容未完，续读传 offset: 65536）$/, '')
  ok('首段内容与原文一致', seg1Body === orig.slice(0, 65536).toString('utf8'), '长度 ' + seg1Body.length)

  // 3) 续读第二段：内容衔接正确
  const r3 = await tools.execute('read_file', { path: bigPath, offset: 65536 })
  const seg2 = r3.message.split('\n').slice(1).join('\n')
  ok('第二段含范围标注', /第 65536-131072 字节/.test(r3.message), r3.message.slice(0, 80))
  ok('第二段内容衔接', seg2.replace(/\n（内容未完，续读传 offset: 131072）$/, '').replace(/（第 65536-131072 字节 \/ 共 \d+ 字节）\n/, '') !== '' &&
    r3.message.includes('续读传 offset: 131072'), r3.message.slice(-60))

  // 4) 最后一段：提示已到末尾
  const r4 = await tools.execute('read_file', { path: bigPath, offset: 131072 })
  ok('末段提示到文件末尾', r4.ok && /已到文件末尾/.test(r4.message), r4.message.slice(-60))

  // 5) offset 越界
  const r5 = await tools.execute('read_file', { path: bigPath, offset: 999999999 })
  ok('offset 越界报错', !r5.ok && /超出文件大小/.test(r5.message), r5.message)

  // 6) 二进制拒绝
  const r6 = await tools.execute('read_file', { path: binPath })
  ok('二进制文件拒绝', !r6.ok && /二进制/.test(r6.message), r6.message)

  // 7) 远程大文件同样分段（模拟 tcpAgent）
  const r7 = await tools.execute('read_file', { path: 'remote:big.txt', target: '新机' })
  ok('远程大文件分段', r7.ok && /大文件共/.test(r7.message), r7.message.slice(0, 60))

  // 8) 新版对端无提示
  const r8 = await tools.execute('transfer_file', { src_path: smallPath, dest_dir: 'C:\\dest', dest_target: '新机' })
  ok('新版对端无升级提示', r8.ok && !/旧版本/.test(r8.message), r8.message)

  // 9) 旧版对端附加升级提示
  const r9 = await tools.execute('transfer_file', { src_path: smallPath, dest_dir: 'C:\\dest', dest_target: '旧机' })
  ok('旧版对端附升级提示', r9.ok && /旧版本.*升级/.test(r9.message), r9.message)

  console.log(`\n${pass}/${pass + fail} 通过`)
  fs.rmSync(base, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
