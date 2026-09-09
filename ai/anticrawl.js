// 反反爬模块：浏览器请求头伪装 + 反爬特征识别 + Electron 无头渲染兜底
// 原则：纯 Node 环境（测试/异常）下渲染兜底优雅降级，绝不炸主流程
const UA_WINDOWS = 'Windows NT 10.0; Win64; x64'

// 浏览器身份池：轮换 UA 过"单一 UA 指纹"型反爬；Accept 用主流浏览器真实值
const BROWSER_PROFILES = [
  {
    ua: `Mozilla/5.0 (${UA_WINDOWS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
  },
  {
    ua: `Mozilla/5.0 (${UA_WINDOWS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.65`,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
  },
  {
    ua: `Mozilla/5.0 (${UA_WINDOWS}; rv:125.0) Gecko/20100101 Firefox/125.0`,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
  }
]

// 第 i 套浏览器请求头（循环取，调用方不用关心池子多大）
function browserHeaders(i = 0) {
  const p = BROWSER_PROFILES[((i % BROWSER_PROFILES.length) + BROWSER_PROFILES.length) % BROWSER_PROFILES.length]
  return {
    'User-Agent': p.ua,
    'Accept': p.accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
  }
}

// 标志性反爬/挑战页特征（命中基本没跑）
const ANTICRAWL_STRONG_SIGS = /just a moment\.\.\.|checking your browser|challenge-platform|cf-browser-verification|cf-chl|attention required!|ddos protection by|百度安全验证|verify you are a human|are you a robot|请完成(以下)?(安全)?验证|人机身份验证|滑动验证|拖动(下方)?滑块|访问过于频繁|请求过于频繁/i

// "请开启 JavaScript" 型：正常网站的 <noscript> 提示也很常见，只在页面几乎没正文时才算拦截页
const ANTICRAWL_JS_SIGS = /enable\s+javascript|请开启.{0,8}javascript|开启.{0,6}javascript.{0,24}(浏览|访问|体验)/i

// 反爬判定：status 在拦截集 → 是；页面剥离标签后正文很短且命中特征 → 是（正文长的是真内容，防"讨论验证码的文章"误判）
function looksLikeAntiCrawl(status, bodyText) {
  if ([403, 429, 503, 501].includes(Number(status))) return true
  const s = String(bodyText || '')
  if (!s || s.length > 60000) return false
  const stripped = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
  // 强特征（挑战页）：正文 < 1500 字才算——真挑战页剥离后只剩几十字
  if (stripped.length < 1500 && ANTICRAWL_STRONG_SIGS.test(stripped)) return true
  // "请开启 JavaScript" 型：正常网站 noscript 提示很常见，只在几乎没正文时才算
  if (stripped.length < 300 && ANTICRAWL_JS_SIGS.test(stripped)) return true
  return false
}

// 无头渲染兜底：用 Electron 隐藏窗口（真 Chromium 内核）加载页面，拿 JS 执行后的最终 DOM
// 能过绝大多数"JS 挑战/浏览器指纹/动态渲染"型反爬；非 Electron 环境（测试）抛 RENDER_UNAVAILABLE
// mode='images'：开图片加载 + 自动滚动触发懒加载 → 提取图片直链（百度图片等 JS 动态站点的大杀器：
// 静态 HTML 里图片 URL 是占位符/藏在 JS 里，渲染后的 DOM 属性里全是真实直链）
// mode='videos'：同样渲染+滚动 → 提取视频直链（video 标签/源/网络记录里的 mp4/webm/m3u8 等）
const IMAGE_URL_FIELDS = ['src', 'currentSrc', 'data-src', 'data-original', 'data-imgurl', 'data-backup-imgurl', 'data-lazy-src', 'data-echo', 'data-real-src', 'srcset']

async function renderPage(url, { timeoutMs = 30000, userAgent, mode = 'html' } = {}) {
  let electronMod = null
  try { electronMod = require('electron') } catch {}
  const BrowserWindow = electronMod && electronMod.BrowserWindow
  if (typeof BrowserWindow !== 'function') throw new Error('RENDER_UNAVAILABLE')
  const wantImages = mode === 'images'
  const wantVideos = mode === 'videos'
  const wantMedia = wantImages || wantVideos
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      offscreen: true,        // 离屏渲染，不弹窗不画到屏幕
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      images: wantMedia,      // 媒体直链模式必须真加载图片（懒加载 JS 才会写入真实 src；naturalWidth 才有值）
      webgl: false
    }
  })
  // 超时不销毁窗口，直接 stop 网络然后抓当前已有 DOM（半渲染也比被拦强）
  const timer = setTimeout(() => { try { win.webContents.stop() } catch {} }, timeoutMs)
  try {
    if (userAgent) win.webContents.setUserAgent(userAgent)
    try { await win.loadURL(url) } catch {} // 跳转/慢加载可能 reject，只要页面加载了一部分就继续抓
    await new Promise((r) => setTimeout(r, 1500)) // 给 JS 渲染/懒加载一点时间
    if (wantMedia) {
      // 滚动触发懒加载（图片站标配）：分 4 屏滚到底，每屏 500ms；再回顶等最后一批挂载
      await win.webContents.executeJavaScript(`(async () => {
        try {
          const H = () => Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)
          for (let i = 1; i <= 4; i++) { window.scrollTo(0, H() * i / 4); await new Promise((r) => setTimeout(r, 500)) }
          window.scrollTo(0, 0)
          await new Promise((r) => setTimeout(r, 600))
        } catch (e) {}
        return 'scrolled'
      })()`)
    }
    if (wantVideos) {
      // 提取视频直链：video/source 标签属性 + a[href] 视频扩展名 + performance 网络记录（JS 拉流地址全在这）
      const videoScript = `(() => {
        try {
          const urls = new Map()
          const add = (u, tag) => {
            try {
              if (!u) return
              u = String(u).trim()
              if (!/^https?:\\/\\//i.test(u)) return // data:/blob:/相对路径都下不了
              if (!urls.has(u)) urls.set(u, tag || '')
            } catch (e) {}
          }
          document.querySelectorAll('video').forEach((v) => {
            add(v.getAttribute('src') || v.src, 'video标签')
            add(v.getAttribute('data-src') || v.getAttribute('data-video') || v.getAttribute('data-url'), 'video标签')
            v.querySelectorAll('source').forEach((s) => add(s.getAttribute('src'), 'source标签'))
          })
          document.querySelectorAll('a[href]').forEach((a) => {
            const h = a.getAttribute('href') || ''
            if (/\\.(mp4|webm|m3u8|flv|mov|mkv|avi|m4s|ts)(\\?|$)/i.test(h)) add(h, '下载链接')
          })
          try {
            performance.getEntriesByType('resource').forEach((e) => {
              if (e.initiatorType === 'video' || /\.(mp4|webm|m3u8|flv|mov|mkv|avi|m4s|ts)(\?|$)/i.test(e.name)) add(e.name, '网络请求')
            })
          } catch (e) {}
          return [...urls.entries()].map(([u, tag]) => ({ u, tag })).slice(0, 40)
        } catch (e) { return [] }
      })()`
      const list = await win.webContents.executeJavaScript(videoScript)
      if (!Array.isArray(list) || !list.length) throw new Error('RENDER_NO_VIDEOS')
      return list
    }
    if (wantImages) {
      // 提取图片直链：img 属性全家桶（src/currentSrc/data-*）+ srcset 首选 + performance 网络记录兜底。
      // 同页去重，保留尺寸（naturalWidth 有值说明真加载出来了，这类最可信）
      const imgScript = `(() => {
        try {
          const urls = new Map()
          const add = (u, w) => {
            try {
              if (!u) return
              u = String(u).trim()
              if (!/^https?:\\/\\//i.test(u)) return // data:/blob:/相对路径（相对的组件化站点直链无意义）
              if (/\\.(svg)(\\?|$)/i.test(u)) return
              if (/(loading|placeholder|sprite|blank|spacer|1x1|pixel)/i.test(u.split('?')[0].split('/').pop() || '')) return
              if (!urls.has(u)) urls.set(u, w || 0)
            } catch (e) {}
          }
          document.querySelectorAll('img').forEach((img) => {
            const w = (img.naturalWidth && img.naturalWidth > 40) ? img.naturalWidth : 0
            for (const f of ${JSON.stringify(IMAGE_URL_FIELDS)}) {
              const v = img.getAttribute ? img.getAttribute(f) : img[f]
              if (!v) continue
              if (f === 'srcset') { add(String(v).split(',')[0].trim().split(/\\s+/)[0], w); continue }
              add(v, w)
            }
          })
          try {
            performance.getEntriesByType('resource').forEach((e) => {
              if (e.initiatorType === 'img' || /\\.(jpe?g|png|webp|gif|bmp)(\\?|$)/i.test(e.name)) add(e.name, 0)
            })
          } catch (e) {}
          return [...urls.entries()].map(([u, w]) => ({ u, w })).sort((a, b) => (b.w || 0) - (a.w || 0)).slice(0, 60)
        } catch (e) { return [] }
      })()`
      const list = await win.webContents.executeJavaScript(imgScript)
      if (!Array.isArray(list) || !list.length) throw new Error('RENDER_NO_IMAGES')
      return list
    }
    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
    if (!html || String(html).length < 200) throw new Error('RENDER_EMPTY')
    return String(html)
  } finally {
    clearTimeout(timer)
    try { win.destroy() } catch {}
  }
}

module.exports = { browserHeaders, looksLikeAntiCrawl, renderPage, BROWSER_PROFILES }
