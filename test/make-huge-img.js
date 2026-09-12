// 造大图（一次性）：把 design-demo.png 放大到 ~4000px 宽大 PNG，模拟桌面原图
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

app.on('window-all-closed', () => {})
app.whenReady().then(() => {
  try {
    const src = path.join(__dirname, 'fixtures', 'design-demo.png')
    const img = require('electron').nativeImage.createFromPath(src)
    const sz = img.getSize()
    const targetW = 4200
    const big = sz.width >= targetW ? img : img.resize({ width: targetW })
    const buf = big.toPNG()
    const out = path.join(__dirname, 'fixtures', 'design-demo-huge.png')
    fs.writeFileSync(out, buf)
    console.log(`BIG_OK ${big.getSize().width}x${big.getSize().height} ${(buf.length / 1048576).toFixed(2)}MB -> ${out}`)
  } catch (e) { console.error('BIG_FAIL', e.message); process.exitCode = 1 }
  app.exit(process.exitCode || 0)
})
