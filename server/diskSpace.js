// 磁盘空间查询（兼容 Electron 22 / Node 16，不支持 fs.statfsSync 时用 wmic 降级）
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function getDiskSpaceWmic(targetPath) {
  if (process.platform !== 'win32') throw new Error('unsupported platform')
  const drive = path.parse(path.resolve(targetPath)).root.replace('\\', '')
  const output = execFileSync('wmic', [
    'logicaldisk', 'where', `DeviceID='${drive}'`, 'get', 'Size,FreeSpace', '/format:list'
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  let total = 0
  let free = 0
  for (const line of output.split('\n')) {
    const t = line.trim()
    if (t.startsWith('FreeSpace=')) free = parseInt(t.slice(10), 10) || 0
    else if (t.startsWith('Size=')) total = parseInt(t.slice(5), 10) || 0
  }
  if (!total) throw new Error('wmic query failed')
  return { total, used: total - free, free }
}

function getDiskSpace(targetPath) {
  if (typeof fs.statfsSync === 'function') {
    const stats = fs.statfsSync(targetPath)
    const total = stats.bsize * stats.blocks
    const free = stats.bsize * stats.bfree
    return { total, used: total - free, free }
  }
  return getDiskSpaceWmic(targetPath)
}

module.exports = { getDiskSpace }
