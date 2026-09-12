// onnxruntime-node × Electron 22 探针：require + 真下载 u2netp 模型 + 真推理（抠图 mask）
// 通过标准：session 创建成功、推理输出 [1,1,320,320]、数值在 0-1
const path = require('path')
const fs = require('fs')
const https = require('https')

const MODEL_URLS = [
  'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
  'https://gh-proxy.com/https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
  'https://mirror.ghproxy.com/https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
  'https://hf-mirror.com/tomjackson2023/rembg/resolve/main/u2netp.onnx',
  'https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx'
]
const modelPath = path.join(__dirname, '.tmp-u2netp.onnx')

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(download(res.headers.location))
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode))
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // ① require（Electron 主进程 N-API 兼容性）
  let ort
  try { ort = require('onnxruntime-node'); ok('require onnxruntime-node', true) } catch (e) { ok('require onnxruntime-node', false, e.message); return done() }

  // ② 模型下载（4.4MB u2netp）
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 1000000) {
    let got = null
    for (const u of MODEL_URLS) {
      try { console.log('下载模型:', u); got = await download(u); if (got.length > 1000000) { fs.writeFileSync(modelPath, got); break } } catch (e) { console.log('  失败:', e.message) }
    }
    ok('模型下载 u2netp', got && got.length > 1000000, got ? got.length + 'B' : '全部源失败')
    if (!got || got.length < 1000000) return done()
  } else ok('模型已缓存', true)

  // ③ session + 真推理（构造 320x320 假图输入）
  try {
    const session = await ort.InferenceSession.create(modelPath)
    ok('InferenceSession 创建', true)
    const W = 320, H = 320
    const data = new Float32Array(3 * W * H)
    for (let i = 0; i < data.length; i++) data[i] = (i % W) / W // 随便一个渐变
    const input = new ort.Tensor('float32', data, [1, 3, H, W])
    const feeds = {}
    feeds[session.inputNames[0]] = input
    const out = await session.run(feeds)
    const t = out[session.outputNames[0]]
    const dimsOk = JSON.stringify(t.dims) === JSON.stringify([1, 1, H, W])
    let inRange = true
    for (let i = 0; i < Math.min(t.data.length, 5000); i++) { const v = t.data[i]; if (v < -0.1 || v > 1.1) { inRange = false; break } }
    ok('推理输出 dims [1,1,320,320]', dimsOk, JSON.stringify(t.dims))
    ok('mask 数值范围 0-1', inRange)
  } catch (e) { ok('推理', false, e.message) }

  done()
  function done() {
    console.log(`\n${fail === 0 ? 'ONNX_PROBE_OK' : 'ONNX_PROBE_FAIL'} (${pass}/${pass + fail})`)
    app2()
  }
  function app2() { require('electron').app.exit(fail ? 1 : 0) }
}

// electron 探针骨架
const { app } = require('electron')
app.on('window-all-closed', () => {})
app.whenReady().then(main)
