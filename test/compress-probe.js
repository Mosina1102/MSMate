// 压缩效果探针（一次性）：验证 view_image 新压缩逻辑对 4.4MB 大图的表现
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

app.on('window-all-closed', () => {})
app.whenReady().then(() => {
  try {
    const p = path.join(__dirname, 'fixtures', 'design-demo-huge.png')
    let buf = fs.readFileSync(p)
    const before = { bytes: buf.length, mb: (buf.length / 1048576).toFixed(2) }
    const img = nativeImage.createFromBuffer(buf)
    const size = img.getSize()
    const long = Math.max(size.width, size.height)
    const resized = long > 1800
      ? img.resize({ width: Math.round(size.width * 1800 / long), height: Math.round(size.height * 1800 / long) })
      : img
    const jpeg = resized.toJPEG(82)
    if (jpeg && jpeg.length > 0 && jpeg.length < buf.length) { buf = jpeg }
    const after = { bytes: buf.length, kb: Math.round(buf.length / 1024) }
    const base64Bytes = Math.round(buf.length * 1.3333)
    const sz2 = resized.getSize()
    console.log(`BEFORE ${before.mb}MB | AFTER ${after.kb}KB (${sz2.width}x${sz2.height}) | base64 后约 ${(base64Bytes / 1048576).toFixed(2)}MB`)
    console.log(base64Bytes < 2 * 1024 * 1024 ? 'COMPRESS_OK（base64 过 2MB 服务端上限，体积缩减 ' + Math.round((1 - buf.length / fs.statSync(p).size) * 100) + '%）' : 'COMPRESS_STILL_BIG')
  } catch (e) { console.error('FAIL', e.message); process.exitCode = 1 }
  app.exit(process.exitCode || 0)
})
