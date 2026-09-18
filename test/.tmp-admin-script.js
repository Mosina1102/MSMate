
// 全兼容写法：XHR 替代 fetch（老内核手机浏览器无 fetch/Object.assign），localStorage 防御（隐私模式会抛异常）
function storageGet(k) { try { return localStorage.getItem(k) } catch (e) { return '' } }
function storageSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { } }
function storageDel(k) { try { localStorage.removeItem(k) } catch (e) { } }
var token = storageGet('adm_token') || ''
var cur = 'reviewing'
var counts = {}
var tabNames = { reviewing: '待审核', pending: '未提交凭证', done: '已到账', rejected: '已拒绝', all: '全部' }
function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML }
function xhr(method, path, body, cb) {
  var x = new XMLHttpRequest()
  x.open(method, path, true)
  x.setRequestHeader('Content-Type', 'application/json')
  if (token) x.setRequestHeader('Authorization', 'Bearer ' + token)
  x.onreadystatechange = function () {
    if (x.readyState !== 4) return
    var j = {}
    try { j = JSON.parse(x.responseText) } catch (e) { }
    cb(j)
  }
  x.onerror = function () { cb({ ok: false, error: '网络异常，请重试' }) }
  x.ontimeout = function () { cb({ ok: false, error: '请求超时，请重试' }) }
  x.send(body ? JSON.stringify(body) : null)
}
function login() {
  var btn = document.getElementById('lbtn')
  btn.disabled = true
  btn.textContent = '登录中...'
  xhr('POST', '/admin/api/login', { key: document.getElementById('key').value }, function (j) {
    btn.disabled = false
    btn.textContent = '登录'
    if (j.ok) { token = j.token; storageSet('adm_token', token); showPanel() }
    else document.getElementById('lerr').textContent = j.error || '登录失败'
  })
}
function showPanel() {
  document.getElementById('login').classList.add('hide')
  document.getElementById('panel').classList.remove('hide')
  loadAutoReviewPanel()
  load()
}
function loadAutoReviewPanel() {
  xhr('GET', '/admin/api/autoreview', null, function (j) {
    if (!j.ok || !j.config) return
    document.getElementById('ar_on').checked = !!j.config.enabled
    document.getElementById('ar_payee').value = j.config.payee || ''
    document.getElementById('ar_max').value = j.config.maxAuto || 68
  })
}
function saveAutoReviewPanel() {
  var btn = document.getElementById('ar_save')
  btn.disabled = true
  var body = {
    enabled: document.getElementById('ar_on').checked,
    payee: document.getElementById('ar_payee').value.trim(),
    maxAuto: document.getElementById('ar_max').value
  }
  xhr('POST', '/admin/api/autoreview', body, function (j) {
    btn.disabled = false
    document.getElementById('ar_msg').textContent = j.ok ? '已保存 ✓' : (j.error || '保存失败')
    if (j.ok) setTimeout(function () { document.getElementById('ar_msg').textContent = '' }, 2500)
  })
}
document.getElementById('ar_save').addEventListener('click', saveAutoReviewPanel)
function load() {
  var tabs = document.getElementById('tabs')
  tabs.innerHTML = ''
  var names = Object.keys(tabNames)
  for (var i = 0; i < names.length; i++) {
    (function (s) {
      var b = document.createElement('button')
      if (s === cur) b.className = 'on'
      b.textContent = tabNames[s] + (counts[s] ? ' ' + counts[s] : '')
      b.onclick = function () { cur = s; load() }
      tabs.appendChild(b)
    })(names[i])
  }
  xhr('GET', '/admin/api/orders?status=' + cur, null, function (j) {
    if (!j.ok) { storageDel('adm_token'); token = ''; location.reload(); return }
    counts = j.counts
    var el = document.getElementById('list')
    // 按钮用 data-* + 事件委托，避免内联 onclick 引号嵌套出错（模板字符串转义曾致整页 JS 挂掉）
    el.onclick = function (e) {
      var t = e.target
      if (!t || !t.getAttribute) return
      var id = t.getAttribute('data-oid')
      var what = t.getAttribute('data-what')
      if (id && what) act(id, what)
    }
    if (!j.orders.length) { el.innerHTML = '<div class="empty">暂无订单</div>'; return }
    var html = ''
    for (var i = 0; i < j.orders.length; i++) {
      var o = j.orders[i]
      var cls = { reviewing: 'b-rv', pending: 'b-pd', done: 'b-done', rejected: 'b-rj' }[o.status]
      var name = { reviewing: '待审核', pending: '未提交凭证', done: '已到账', rejected: '已拒绝' }[o.status]
      html += '<div class="card">'
        + '<div class="row" style="justify-content:space-between;align-items:center"><span class="amount">&yen;' + esc(o.amount) + '</span>'
        + '<span class="badge ' + cls + '">' + name + '</span></div>'
        + '<div>' + esc(o.nickname) + ' <span class="meta">' + esc(o.email) + '</span></div>'
        + '<div class="meta">订单 ' + esc(o.id) + ' · 充值 ' + esc(o.credits) + ' 积分</div>'
        + '<div class="meta">提交 ' + esc(o.createdAt) + '</div>'
        + (o.voucher ? '<div>凭证号：<b>' + esc(o.voucher) + '</b></div>' : '')
        + (o.aiReview ? (o.aiReview.verdict === 'auto'
          ? '<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:#e7f6ec;color:#1c6b34;font-size:12px">AI 核验通过 · 已自动到账（' + esc((o.aiReview.at || '').replace('T', ' ').slice(0, 16)) + '）— 请抽查收款记录</div>'
          : '<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:#fdf3e0;color:#8a5a13;font-size:12px">AI 存疑：' + esc((o.aiReview.reasons || []).join('；')) + '</div>') : '')
        + (o.screenshot ? '<div style="margin:6px 0"><img src="/screenshots/' + esc(o.screenshot) + '?t=' + esc(token) + '" alt="付款截图" style="max-width:100%;max-height:300px;border-radius:8px;border:1px solid #e5e7eb"></div>' : '')
        + (o.rejectReason ? '<div class="meta">拒绝原因：' + esc(o.rejectReason) + '</div>' : '')
        + (o.status === 'reviewing' || o.status === 'pending'
          ? '<div class="row" style="margin-top:8px"><button class="ok" data-oid="' + esc(o.id) + '" data-what="approve">通过 · 加 ' + esc(o.credits) + ' 积分</button>'
            + '<button class="no" data-oid="' + esc(o.id) + '" data-what="reject">拒绝</button></div>'
          : '')
        + '</div>'
    }
    el.innerHTML = html
  })
}
function act(id, what) {
  if (what === 'reject' && !confirm('确认拒绝该订单？')) return
  xhr('POST', '/admin/api/orders/' + id + '/' + what, {}, function (j) {
    if (j.ok) load()
    else alert(j.error || '操作失败')
  })
}
// ===== 新单提醒（v0.5）：15s 轮询待审核数，新增即响铃 + 标题闪烁 + 系统通知 =====
var audioCtx = null
var lastReviewing = -1
var soundOn = storageGet('adm_sound') !== 'off'
var BASE_TITLE = document.title
// 近静音高音振荡器：让浏览器把本页标记为"正在播放音频"，豁免后台标签页的定时器限流
// （否则页面挂后台 5 分钟后轮询会降频到 1 次/分钟，提示就不及时了）
function keepAlive() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    audioCtx = audioCtx || new AC()
    var o = audioCtx.createOscillator()
    var g = audioCtx.createGain()
    g.gain.value = 0.0001
    o.frequency.value = 18000
    o.connect(g); g.connect(audioCtx.destination)
    o.start()
  } catch (e) { }
}
function beep() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    audioCtx = audioCtx || new AC()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    var t = audioCtx.currentTime + 0.05
    for (var i = 0; i < 6; i++) {
      var o = audioCtx.createOscillator()
      var g = audioCtx.createGain()
      o.type = 'sine'
      o.frequency.value = (i % 2 === 0) ? 880 : 1320
      g.gain.setValueAtTime(0.0001, t + i * 0.3)
      g.gain.exponentialRampToValueAtTime(0.4, t + i * 0.3 + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.3 + 0.26)
      o.connect(g); g.connect(audioCtx.destination)
      o.start(t + i * 0.3); o.stop(t + i * 0.3 + 0.3)
    }
  } catch (e) { }
}
function renderSndBtn() {
  var b = document.getElementById('sndbtn')
  if (b) b.textContent = soundOn ? '声音：开' : '声音：关'
}
function poll() {
  xhr('GET', '/admin/api/orders?status=reviewing', null, function (j) {
    if (!j.ok) return
    var n = j.orders ? j.orders.length : 0
    var el = document.getElementById('lastcheck')
    if (el) el.textContent = '上次检查 ' + new Date().toLocaleTimeString() + ' · 待审核 ' + n + ' 单'
    if (lastReviewing >= 0 && n > lastReviewing) {
      if (soundOn) beep()
      try { if (window.Notification && Notification.permission === 'granted') new Notification('MSMate 批款后台', { body: n + ' 单待审核，点击打开此页面处理' }) } catch (e) { }
      document.title = '（' + n + ' 单待审核）' + BASE_TITLE
      load()
    }
    if (n === 0) document.title = BASE_TITLE
    lastReviewing = n
  })
}
function showPanel() {
  document.getElementById('login').classList.add('hide')
  document.getElementById('panel').classList.remove('hide')
  renderSndBtn()
  document.getElementById('sndbtn').onclick = function () {
    soundOn = !soundOn
    storageSet('adm_sound', soundOn ? 'on' : 'off')
    renderSndBtn()
  }
  // 通知授权要在用户手势里申请（登录点击链路内），失败静默（http 源可能被浏览器禁）
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission() } catch (e) { }
  keepAlive()
  load()
  poll()
  setInterval(poll, 15000)
}
document.getElementById('key').onkeydown = function (e) { if (e.key === 'Enter' || e.keyCode === 13) login() }
if (token) xhr('GET', '/admin/api/orders?status=reviewing', null, function (j) {
  if (j.ok) showPanel()
  else { storageDel('adm_token'); token = '' }
})
