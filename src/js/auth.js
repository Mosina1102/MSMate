// ============================================
// 账号（auth 域）：邮箱登录 / 注册 + 侧栏账号行 + 账号弹窗
// 游客可用：互传核心不依赖账号；登录解锁云同步 / 远程等在线能力
// token 由主进程存 userData/settings.json，渲染层只拿 user 信息
// ============================================

const authState = { user: null, mode: 'login', busy: false }

function authEmailOk(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim())
}

// 侧栏账号行 + 弹窗内容渲染
function authRender() {
  const user = authState.user
  const rowName = $('accountName')
  const rowSub = $('accountSub')
  const rowAvatar = $('accountAvatar')
  const displayName = user ? (user.nickname || (user.email || '').split('@')[0]) : ''
  if (user) {
    rowName.textContent = displayName || '已登录'
    rowSub.textContent = user.email || ''
    // 头像取昵称/邮箱首字符（纯文本，无 SVG 乱码风险）
    rowAvatar.textContent = (displayName || 'M').charAt(0).toUpperCase()
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
    $('authProfileAvatar').textContent = (displayName || 'M').charAt(0).toUpperCase()
  } else {
    $('authSubmit').textContent = authState.mode === 'login' ? '登录' : '注册'
    $('authNicknameField').classList.toggle('hidden', authState.mode !== 'register')
  }
}

function authShowError(msg) {
  const el = $('authError')
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return }
  el.textContent = msg
  el.classList.remove('hidden')
}

function authOpenModal() {
  authShowError('')
  authRender()
  $('accountModal').classList.remove('hidden')
  // 聚焦第一个可输入项
  const first = authState.user ? null : $('authEmail')
  if (first) setTimeout(() => first.focus(), 50)
}

function authCloseModal() {
  $('accountModal').classList.add('hidden')
}

async function authSubmit() {
  if (authState.busy) return
  const email = $('authEmail').value.trim()
  const password = $('authPassword').value
  const nickname = $('authNickname').value.trim()
  if (!authEmailOk(email)) { authShowError('邮箱格式不正确'); return }
  if (!password || password.length < 8) { authShowError('密码至少 8 位'); return }
  if (password.length > 72) { authShowError('密码最长 72 位'); return }

  authState.busy = true
  const btn = $('authSubmit')
  const btnText = btn.textContent
  btn.disabled = true
  btn.textContent = authState.mode === 'login' ? '登录中…' : '注册中…'
  authShowError('')
  try {
    const r = authState.mode === 'login'
      ? await window.api.authLogin(email, password)
      : await window.api.authRegister(email, password, nickname)
    if (r && r.ok) {
      authState.user = r.user
      authRender()
      authCloseModal()
      showToast(authState.mode === 'login' ? `登录成功，欢迎回来` : '注册成功，已自动登录', 'success')
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
  authRender()
  showToast('已退出登录', 'success')
}

function initAuthUI() {
  if (!window.api || window.api._fallback) return

  $('accountRow').addEventListener('click', authOpenModal)
  $('authCancel').addEventListener('click', authCloseModal)
  $('authSubmit').addEventListener('click', authSubmit)
  $('authLogout').addEventListener('click', authLogout)

  // 登录 / 注册页签切换
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      authState.mode = tab.getAttribute('data-authtab') === 'register' ? 'register' : 'login'
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab))
      authShowError('')
      authRender()
      $('authEmail').focus()
    })
  })

  // 密码框回车直接提交
  $('authPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') authSubmit()
  })
  $('authEmail').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('authPassword').focus()
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

document.addEventListener('DOMContentLoaded', initAuthUI)
