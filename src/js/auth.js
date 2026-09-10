// ============================================
// 账号（auth 域）：邮箱登录 / 注册（验证码）/ 找回密码 + 个人资料（昵称/头像）+ 积分入口
// 入口：顶栏账号头像按钮（两种模式）+ 互联模式侧栏底部账号行
// 游客可用：互传核心不依赖账号；登录解锁云同步 / 远程 / 积分等在线能力
// token 由主进程存 userData/settings.json，渲染层只拿 user 信息
// ============================================

const authState = { user: null, mode: 'login', busy: false, eyeOn: false, codeLeft: 0 }

function authEmailOk(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim())
}

// 账号展示名：昵称 > 邮箱前缀
function authDisplayName() {
  const u = authState.user
  if (!u) return ''
  return u.nickname || String(u.email || '').split('@')[0]
}

// 头像地址：有 avatarUrl 用图，否则首字母
function authApplyAvatarImg(el, fallbackChar) {
  const u = authState.user
  const url = u && u.avatarUrl
  if (url) {
    el.innerHTML = `<img class="avatar-mini-img" src="${url}" alt="">`
  } else {
    el.textContent = fallbackChar
  }
}

// === 渲染：顶栏头像 + 积分徽标 + 侧栏账号行 + 弹窗内容 ===
function authRender() {
  const user = authState.user
  const displayName = authDisplayName()

  // 顶栏头像按钮（未登录人形图标 / 已登录首字母或头像图）
  const btnInner = $('accountBtnInner')
  if (user) {
    authApplyAvatarImg(btnInner, (displayName || 'M').charAt(0).toUpperCase())
    btnInner.classList.add('authed')
  } else {
    btnInner.innerHTML = iconSvg('user')
    btnInner.classList.remove('authed')
  }
  // 积分徽标：登录后常驻，点击打开充值面板
  const credits = user && Number.isFinite(user.credits) ? user.credits : 0
  $('creditBadge').classList.toggle('hidden', !user)
  $('creditValue').textContent = credits
  $('authCreditVal').textContent = credits

  // 侧栏账号行（互联模式）
  const rowName = $('accountName')
  const rowSub = $('accountSub')
  const rowAvatar = $('accountAvatar')
  if (user) {
    rowName.textContent = displayName || '已登录'
    rowSub.textContent = user.email || ''
    authApplyAvatarImg(rowAvatar, (displayName || 'M').charAt(0).toUpperCase())
    rowAvatar.classList.add('authed')
  } else {
    rowName.textContent = '未登录'
    rowSub.textContent = '点击登录 / 注册'
    rowAvatar.innerHTML = iconSvg('user')
    rowAvatar.classList.remove('authed')
  }

  // 弹窗：表单 / 资料卡 二选一
  const isLogin = !!user
  $('authForms').classList.toggle('hidden', isLogin)
  $('authProfile').classList.toggle('hidden', !isLogin)
  $('authLogout').classList.toggle('hidden', !isLogin)
  $('authSubmit').classList.toggle('hidden', isLogin)
  if (user) {
    $('authProfileName').textContent = displayName || '已登录'
    $('authProfileEmail').textContent = user.email || ''
    // 资料卡头像：图 / 首字母
    const avatarBig = $('authProfileAvatar')
    if (user.avatarUrl) {
      const img = $('authProfileAvatarImg')
      img.src = user.avatarUrl
      img.classList.remove('hidden')
      avatarBig.classList.add('hidden')
    } else {
      avatarBig.textContent = (displayName || 'M').charAt(0).toUpperCase()
      avatarBig.classList.remove('hidden')
      $('authProfileAvatarImg').classList.add('hidden')
    }
    authNickExitEdit()
  } else {
    authRenderFormMode()
  }
}

// 未登录表单：login / register / reset 三模式字段切换
function authRenderFormMode() {
  const mode = authState.mode
  const isRegister = mode === 'register'
  const isReset = mode === 'reset'
  $('authTabs').classList.toggle('hidden', isReset)
  $('authNicknameField').classList.toggle('hidden', !isRegister)
  $('authCodeField').classList.toggle('hidden', !isRegister && !isReset)
  $('authAgreeField').classList.toggle('hidden', !isRegister)
  $('authPasswordLabel').textContent = isReset ? '新密码' : '密码'
  $('authPassword').placeholder = isReset ? '设置新密码（至少 8 位）' : '至少 8 位'
  $('authForgotLink').classList.toggle('hidden', isReset)
  $('authBackLogin').classList.toggle('hidden', !isReset)
  const titles = {
    login: ['欢迎回来', '登录 MSMate，继续你的跨设备工作台', '登 录'],
    register: ['创建账号', '30 秒注册，开启跨设备协作', '注 册'],
    reset: ['找回密码', '输入注册邮箱与验证码，设置新密码', '重置密码']
  }
  const t = titles[mode] || titles.login
  $('authBrandTitle').textContent = t[0]
  $('authBrandSub').textContent = t[1]
  $('authSubmit').textContent = t[2]
}

function authShowError(msg) {
  const el = $('authError')
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return }
  el.textContent = msg
  el.classList.remove('hidden')
  // 抖动提醒（重置动画）
  el.classList.remove('shake')
  void el.offsetWidth
  el.classList.add('shake')
}

function authOpenModal() {
  authShowError('')
  authNickExitEdit()
  if (!authState.user && authState.mode === 'reset') authState.mode = 'login'
  authRender()
  $('accountModal').classList.remove('hidden')
  if (!authState.user) setTimeout(() => $('authEmail').focus(), 60)
}

function authCloseModal() {
  $('accountModal').classList.add('hidden')
}

// 密码可见性
function authToggleEye() {
  authState.eyeOn = !authState.eyeOn
  $('authPassword').type = authState.eyeOn ? 'text' : 'password'
  $('authEye').innerHTML = iconSvg(authState.eyeOn ? 'eye-off' : 'eye')
}

// === 邮箱验证码（注册 / 找回密码共用，60 秒冷却倒计时） ===
function authCodeScene() {
  return authState.mode === 'reset' ? 'reset' : 'register'
}

function authCodeTick() {
  const btn = $('authCodeSend')
  if (authState.codeLeft > 0) {
    btn.disabled = true
    btn.textContent = `${authState.codeLeft}s 后重发`
    authState.codeLeft--
    setTimeout(authCodeTick, 1000)
  } else {
    btn.disabled = false
    btn.textContent = authState.mode === 'reset' ? '重新获取' : '获取验证码'
  }
}

async function authSendCode() {
  if (authState.codeLeft > 0 || authState.busy) return
  const email = $('authEmail').value.trim()
  if (!authEmailOk(email)) { authShowError('请先填写正确的邮箱地址'); return }
  authShowError('')
  const btn = $('authCodeSend')
  btn.disabled = true
  btn.textContent = '发送中…'
  try {
    const r = await window.api.authSendCode(email, authCodeScene())
    if (r && r.ok) {
      authState.codeLeft = 60
      authCodeTick()
      showToast(r.sent ? '验证码已发送到邮箱' : '验证码已生成（服务端 dev 模式，见日志）', 'success')
    } else {
      authShowError((r && r.error) || '验证码发送失败，请稍后再试')
      btn.disabled = false
      btn.textContent = '获取验证码'
    }
  } catch (err) {
    authShowError(`网络错误：${err.message}`)
    btn.disabled = false
    btn.textContent = '获取验证码'
  }
}

// === 资料卡：昵称编辑态 ===
function authNickEnterEdit() {
  $('authNickEdit').classList.remove('hidden')
  $('authEditNick').classList.add('hidden')
  const input = $('authNickInput')
  input.value = authDisplayName()
  setTimeout(() => { input.focus(); input.select() }, 40)
}

function authNickExitEdit() {
  const edit = $('authNickEdit')
  if (edit) edit.classList.add('hidden')
  $('authEditNick').classList.remove('hidden')
}

async function authNickSave() {
  if (authState.busy) return
  const nickname = $('authNickInput').value.trim()
  if (!nickname) { authShowError('昵称不能为空'); return }
  authState.busy = true
  try {
    const r = await window.api.authUpdateProfile(nickname)
    if (r && r.ok) {
      authState.user = r.user
      authNickExitEdit()
      authRender()
      showToast('昵称已更新', 'success')
    } else {
      authShowError((r && r.error) || '保存失败，请稍后再试')
    }
  } catch (err) {
    authShowError(`网络错误：${err.message}`)
  } finally {
    authState.busy = false
  }
}

// === 头像上传：选图 → canvas 压 128x128 JPEG → 上传 → 三处同步 ===
function authPickAvatar() {
  if (!authState.user) return
  $('authAvatarFile').value = ''
  $('authAvatarFile').click()
}

function authAvatarFileChosen() {
  const file = $('authAvatarFile').files && $('authAvatarFile').files[0]
  if (!file) return
  if (!/^image\/(png|jpe?g)$/.test(file.type)) { showToast('仅支持 PNG / JPG 图片', 'error'); return }
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = async () => {
      // 居中裁剪成方形再缩到 128x128
      const size = Math.min(img.naturalWidth, img.naturalHeight)
      const sx = (img.naturalWidth - size) / 2
      const sy = (img.naturalHeight - size) / 2
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 128
      canvas.getContext('2d').drawImage(img, sx, sy, size, size, 0, 0, 128, 128)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
      try {
        const r = await window.api.authAvatar(dataUrl)
        if (r && r.ok) {
          authState.user = r.user
          authRender()
          showToast('头像已更新', 'success')
        } else {
          showToast((r && r.error) || '头像上传失败', 'error')
        }
      } catch (err) {
        showToast(`头像上传失败：${err.message}`, 'error')
      }
    }
    img.onerror = () => showToast('图片读取失败', 'error')
    img.src = reader.result
  }
  reader.readAsDataURL(file)
}

// === 登录 / 注册 / 重置密码 提交 ===
async function authSubmit() {
  if (authState.busy) return
  const email = $('authEmail').value.trim()
  const password = $('authPassword').value
  const nickname = $('authNickname').value.trim()
  const code = $('authCode').value.trim()
  if (!authEmailOk(email)) { authShowError('邮箱格式不正确'); return }
  if (authState.mode !== 'login' && !code) { authShowError('请填写邮箱验证码'); return }
  if (authState.mode === 'register' && !$('authAgree').checked) { authShowError('请先阅读并勾选同意《MSMate 用户协议》'); return }
  if (!password || password.length < 8) { authShowError('密码至少 8 位'); return }
  if (password.length > 72) { authShowError('密码最长 72 位'); return }

  authState.busy = true
  const btn = $('authSubmit')
  const btnText = btn.textContent
  btn.disabled = true
  btn.textContent = authState.mode === 'login' ? '登录中…' : authState.mode === 'register' ? '注册中…' : '重置中…'
  authShowError('')
  try {
    let r
    if (authState.mode === 'login') {
      r = await window.api.authLogin(email, password)
    } else if (authState.mode === 'register') {
      r = await window.api.authRegister(email, password, nickname, code)
    } else {
      r = await window.api.authReset(email, code, password)
    }
    if (r && r.ok) {
      authState.user = r.user
      authState.mode = 'login'
      authRender()
      authCloseModal()
      showToast(authState.mode === 'login' && btnText === '登 录' ? '登录成功，欢迎回来' : '操作成功，已自动登录', 'success')
    } else {
      authShowError((r && r.error) || '操作失败，请稍后再试')
    }
  } catch (err) {
    authShowError(`网络错误：${err.message}`)
  } finally {
    authState.busy = false
    btn.disabled = false
    btn.textContent = btnText
  }
}

async function authLogout() {
  try { await window.api.authLogout() } catch { }
  authState.user = null
  authState.mode = 'login'
  authRender()
  showToast('已退出登录', 'success')
}

function initAuthUI() {
  if (!window.api || window.api._fallback) return

  // 入口：顶栏头像按钮（两种模式）+ 互联模式侧栏账号行
  $('accountBtn').addEventListener('click', authOpenModal)
  $('accountRow').addEventListener('click', authOpenModal)
  // 积分徽标 → 充值面板
  $('creditBadge').addEventListener('click', () => {
    if (typeof creditsOpen === 'function') creditsOpen()
  })

  // 弹窗关闭：X / 底部关闭 / 点遮罩
  $('authCloseX').addEventListener('click', authCloseModal)
  $('authCancel').addEventListener('click', authCloseModal)
  $('accountModal').addEventListener('mousedown', (e) => {
    if (e.target === $('accountModal')) authCloseModal()
  })

  $('authSubmit').addEventListener('click', authSubmit)
  $('authLogout').addEventListener('click', authLogout)
  $('authEye').addEventListener('click', authToggleEye)

  // 验证码 / 忘记密码 / 返回登录
  $('authCodeSend').addEventListener('click', authSendCode)
  $('authForgotLink').addEventListener('click', () => {
    authState.mode = 'reset'
    authShowError('')
    authRenderFormMode()
    $('authEmail').focus()
  })
  $('authBackLogin').addEventListener('click', () => {
    authState.mode = 'login'
    authShowError('')
    authRenderFormMode()
  })

  // 用户协议：链接打开弹窗，"我已阅读"或点遮罩关闭（不自动勾选，勾选是用户自己的动作）
  $('authAgreementLink').addEventListener('click', () => {
    $('agreementModal').classList.remove('hidden')
  })
  $('agreementCloseBtn').addEventListener('click', () => {
    $('agreementModal').classList.add('hidden')
  })
  $('agreementModal').addEventListener('mousedown', (e) => {
    if (e.target === $('agreementModal')) $('agreementModal').classList.add('hidden')
  })

  // 头像上传
  $('authAvatarWrap').addEventListener('click', authPickAvatar)
  $('authAvatarFile').addEventListener('change', authAvatarFileChosen)

  // 充值按钮
  $('authRechargeBtn').addEventListener('click', () => {
    authCloseModal()
    if (typeof creditsOpen === 'function') creditsOpen()
  })

  // 昵称编辑
  $('authEditNick').addEventListener('click', authNickEnterEdit)
  $('authNickSave').addEventListener('click', authNickSave)
  $('authNickCancel').addEventListener('click', authNickExitEdit)
  $('authNickInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authNickSave()
    if (e.key === 'Escape') authNickExitEdit()
  })

  // 登录 / 注册页签切换（限定 #authTabs 作用域：反馈弹窗的 .auth-tab 页签不得被误绑）
  document.querySelectorAll('#authTabs .auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      authState.mode = tab.getAttribute('data-authtab') === 'register' ? 'register' : 'login'
      document.querySelectorAll('#authTabs .auth-tab').forEach((t) => t.classList.toggle('active', t === tab))
      authShowError('')
      authRenderFormMode()
      $('authEmail').focus()
    })
  })

  // ===== 问题反馈（v2.7.16）：须登录；服务端存档 + ntfy 通知；复杂问题引导 GitHub Issues =====
  $('authFeedbackBtn').addEventListener('click', feedbackOpen)
  $('feedbackCloseX').addEventListener('click', feedbackClose)
  $('feedbackCancel').addEventListener('click', feedbackClose)
  $('feedbackSubmitBtn').addEventListener('click', feedbackSubmit)
  document.querySelectorAll('#feedbackTypeTabs .auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      feedbackState.type = tab.getAttribute('data-ftype') === 'idea' ? 'idea' : 'bug'
      document.querySelectorAll('#feedbackTypeTabs .auth-tab').forEach((t) => t.classList.toggle('active', t === tab))
    })
  })
  $('feedbackGithubLink').addEventListener('click', (e) => {
    e.preventDefault()
    try { window.api.openExternalFallback({ url: 'https://github.com/Mosina1102/MSMate/issues' }) } catch { }
  })
  $('feedbackContent').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') feedbackSubmit()
  })

  // 回车流转：邮箱 → 验证码/密码 → 提交
  $('authEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (!$('authCodeField').classList.contains('hidden')) $('authCode').focus()
      else $('authPassword').focus()
    }
  })
  $('authCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('authPassword').focus()
  })
  $('authPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authSubmit()
  })

  // 恢复登录态：本地有 token 就先展示，再后台向服务端校验（过期静默清除，离线保留本地态）
  ;(async () => {
    try {
      const st = await window.api.authGetState()
      if (st && st.user) {
        authState.user = st.user
        authRender()
        const me = await window.api.authMe()
        if (me && me.user !== undefined) {
          authState.user = me.user || null
          authRender()
        }
      }
    } catch { }
  })()
}

// ===== 问题反馈弹窗（v2.7.16）=====
const feedbackState = { type: 'bug', busy: false }
function feedbackOpen() {
  const m = $('feedbackModal')
  if (!m) return
  feedbackShowError('')
  m.classList.remove('hidden')
  setTimeout(() => { const t = $('feedbackContent'); if (t) t.focus() }, 100)
}
function feedbackClose() {
  const m = $('feedbackModal')
  if (m) m.classList.add('hidden')
}
function feedbackShowError(msg) {
  const el = $('feedbackError')
  if (!el) return
  if (msg) { el.textContent = msg; el.classList.remove('hidden') }
  else el.classList.add('hidden')
}
async function feedbackSubmit() {
  if (feedbackState.busy) return
  const content = ($('feedbackContent') || {}).value || ''
  if (content.trim().length < 5) { feedbackShowError('反馈内容太短了（至少 5 个字）'); return }
  feedbackState.busy = true
  const btn = $('feedbackSubmitBtn')
  const oldText = btn.textContent
  btn.disabled = true
  btn.textContent = '提交中...'
  try {
    const r = await window.api.feedbackSubmit(feedbackState.type, content.trim(), (($('feedbackContact') || {}).value || '').trim())
    if (r && r.ok) {
      feedbackClose()
      $('feedbackContent').value = ''
      $('feedbackContact').value = ''
      showToast('反馈已提交，感谢支持（seq #' + r.seq + '）', 'success')
    } else {
      feedbackShowError((r && r.error) || '提交失败，请稍后再试')
    }
  } catch (err) {
    feedbackShowError(`提交失败: ${err.message}`)
  } finally {
    feedbackState.busy = false
    btn.disabled = false
    btn.textContent = oldText
  }
}

document.addEventListener('DOMContentLoaded', initAuthUI)
