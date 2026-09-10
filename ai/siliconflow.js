// ============================================
// 硅基流动 API 客户端（OpenAI 兼容格式，SSE 流式）
// Electron 22 内置 Node 16，无全局 fetch，用 http/https 模块实现
// ============================================
const https = require('https')
const http = require('http')
const { URL } = require('url')

class SiliconFlowClient {
  constructor({ apiKey, baseUrl }) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl || 'https://api.siliconflow.cn/v1'
  }

  // 流式对话：返回异步迭代器，yield { type: 'reasoning'|'content', delta }
  async *chatStream({ model, messages, temperature = 0.3, maxTokens = 8192, signal }) {
    const body = JSON.stringify({
      model,
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens
    })
    const url = new URL(this.baseUrl + '/chat/completions')
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    })

    // 支持中止
    if (signal) {
      if (signal.aborted) { req.destroy(); throw new Error('已中止') }
      signal.addEventListener('abort', () => req.destroy(new Error('已中止')), { once: true })
    }

    // 空闲超时：连接挂起/服务端断流时兜底（socket 60 秒无数据即毁掉，否则 UI 永远"执行操作中"）
    req.setTimeout(60000, () => req.destroy(new Error('AI 接口空闲超时（60 秒无数据）')))

    req.write(body)
    req.end()

    const res = await new Promise((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
    })

    if (res.statusCode !== 200) {
      let errText = ''
      res.on('data', (c) => { errText += c; if (errText.length > 2000) res.destroy() })
      await new Promise((r) => res.on('close', r))
      let msg = `API ${res.statusCode}: ${errText}`
      try {
        const j = JSON.parse(errText)
        // 兼容三种错误体：OpenAI {error:{message}} / 服务端代理 {error:"…"} / 简单 {message}
        const detail = typeof j.error === 'string' ? j.error : (j.error && j.error.message) || j.message
        if (detail) msg = `API ${res.statusCode}: ${detail}`
      } catch {}
      throw new Error(msg)
    }

    // 解析 SSE
    let buffer = ''
    for await (const chunk of res) {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        // [DONE] 不提前 return：服务端扣费回执帧插在 [DONE] 之前，但直连上游/旧服务端可能在 [DONE] 后补帧，
        // 读完直到连接关闭才收流（上游发完 [DONE] 即断开，不会挂起）
        if (data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          // 服务端代理扣费回执帧（无 choices）：透传给调用方
          if (json._msmate) { yield { type: 'msmate', meta: json._msmate }; continue }
          const delta = json.choices && json.choices[0] && json.choices[0].delta
          if (!delta) continue
          if (delta.reasoning_content) yield { type: 'reasoning', delta: delta.reasoning_content }
          if (delta.content) yield { type: 'content', delta: delta.content }
        } catch {}
      }
    }
  }
}

module.exports = { SiliconFlowClient }
