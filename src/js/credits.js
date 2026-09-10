// ============================================
// 积分充值（credits 域）：微信收款码 + 付款凭证人工批款
// 流程：选档位 / 自定义金额 → 下单 → 扫码付款（备注带订单短号）→ 提交转账单号 → 人工核对后到账
// 依赖：app.js 的 $ / showToast，auth.js 的 authState / authOpenModal，icons.js 的 iconSvg
// ============================================

const creditsState = {
  amount: 0,      // 当前选定的充值金额（元）
  order: null,    // 已创建待付款的订单
  orders: [],     // 我的订单列表
  busy: false
}

const CREDITS_STATUS_TEXT = {
  pending: '待支付',
  reviewing: '审核中',
  done: '已到账',
  rejected: '已拒绝',
  cancelled: '已取消'
}

// 订单备注短号：方便人工对账（完整单号太长，取尾 8 位）
function creditsShortId(order) {
  return order && order.id ? String(order.id).slice(-8) : ''
}

function creditsFmtTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// === 打开 / 关闭 ===

function creditsOpen() {
  if (!authState.user) {
    showToast('请先登录再充值', 'info')
    authOpenModal()
    return
  }
  creditsResetStepAmount()
  $('creditsModal').classList.remove('hidden')
  creditsRenderSignin()
  creditsRefreshBalance()
  creditsLoadOrders()
}

// === 每日签到（+50/天，累计封顶 200） ===

function creditsToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function creditsRenderSignin() {
  const row = $('creditsSigninRow')
  if (!row) return
  const u = authState.user
  if (!u) { row.classList.add('hidden'); return }
  row.classList.remove('hidden')
  const sign = u.sign || { total: 0, lastDate: '' }
  const total = sign.total || 0
  const signedToday = sign.lastDate === creditsToday()
  const capped = total >= 200
  $('creditsSigninProgress').textContent = `累计 ${total}/200`
  const fill = $('creditsSigninBarFill')
  if (fill) fill.style.width = `${Math.min(100, Math.round(total / 200 * 100))}%`
  const btn = $('creditsSigninBtn')
  btn.disabled = signedToday || capped
  btn.textContent = capped ? '已拿满' : (signedToday ? '已签到' : '签到')
}

async function creditsSignin() {
  const btn = $('creditsSigninBtn')
  if (btn) btn.disabled = true
  try {
    const r = await window.api.creditsSignin()
    if (r && r.ok) {
      if (authState.user) {
        authState.user.credits = r.credits
        authState.user.sign = { total: r.total, lastDate: creditsToday() }
      }
      showToast(`签到成功，+${r.awarded} 积分`, 'success')
      creditsRefreshBalance()
    } else {
      showToast((r && r.error) || '签到失败', 'error')
      // 服务端带回来的最新进度/余额（如"今天已签到"），同步到本地态
      if (authState.user && r && typeof r.credits === 'number') {
        authState.user.credits = r.credits
        if (typeof r.total === 'number') authState.user.sign = { ...(authState.user.sign || { lastDate: '' }), total: r.total }
      }
    }
  } catch (err) {
    showToast(`签到失败：${err.message}`, 'error')
  }
  creditsRenderSignin()
}

function creditsCloseModal() {
  $('creditsModal').classList.add('hidden')
}

// === 第一步：选金额 ===

function creditsResetStepAmount() {
  creditsState.amount = 0
  creditsState.order = null
  creditsSetStep('amount')
  document.querySelectorAll('#creditsGrid .credits-tier').forEach((b) => b.classList.remove('active'))
  $('creditsNextBtn').disabled = true
  creditsShowError('')
}

function creditsSetStep(step) {
  $('creditsStepAmount').classList.toggle('hidden', step !== 'amount')
  $('creditsStepPay').classList.toggle('hidden', step !== 'pay')
}

function creditsShowError(msg) {
  const el = $('creditsError')
  el.textContent = msg || ''
  el.classList.toggle('hidden', !msg)
}

function creditsPickTier(btn) {
  const amount = Math.round(+btn.dataset.amount)
  if (!Number.isFinite(amount)) return
  creditsState.amount = amount
  document.querySelectorAll('#creditsGrid .credits-tier').forEach((b) => b.classList.toggle('active', b === btn))
  $('creditsNextBtn').disabled = false
  creditsShowError('')
}

async function creditsNext() {
  if (creditsState.busy || !creditsState.amount) return
  if (creditsState.order && creditsState.order.amount === creditsState.amount) {
    // 已有同金额待付款订单，直接回到支付页避免重复下单
    creditsEnterPayStep(creditsState.order)
    return
  }
  creditsState.busy = true
  $('creditsNextBtn').disabled = true
  $('creditsNextBtn').textContent = '下单中…'
  try {
    const r = await window.api.creditsOrderCreate(creditsState.amount)
    if (r && r.ok) {
      creditsEnterPayStep(r.order)
    } else {
      creditsShowError((r && r.error) || '下单失败，请稍后再试')
    }
  } catch (err) {
    creditsShowError(`网络错误：${err.message}`)
  } finally {
    creditsState.busy = false
    $('creditsNextBtn').disabled = !creditsState.amount
    $('creditsNextBtn').textContent = '下一步：微信支付'
  }
}

// === 第二步：扫码付款 + 提交凭证 ===

function creditsEnterPayStep(order) {
  creditsState.order = order
  creditsSetStep('pay')
  $('creditsPayAmount').textContent = `¥${order.amount}`
  $('creditsOrderId').textContent = `单号 ${order.id}`
  $('creditsOrderShort').textContent = creditsShortId(order)
  $('creditsVoucher').value = order.voucher || ''
  creditsShowPayError('')
  setTimeout(() => $('creditsVoucher').focus(), 60)
}

function creditsShowPayError(msg) {
  const el = $('creditsPayError')
  el.textContent = msg || ''
  el.classList.toggle('hidden', !msg)
}

function creditsBack() {
  creditsState.order = null
  creditsSetStep('amount')
  $('creditsNextBtn').disabled = !creditsState.amount
}

async function creditsSubmitVoucher() {
  if (creditsState.busy || !creditsState.order) return
  const voucher = $('creditsVoucher').value.trim()
  if (voucher.length < 4) {
    creditsShowPayError('请填写微信账单里的转账单号')
    return
  }
  creditsState.busy = true
  $('creditsSubmitVoucher').disabled = true
  $('creditsSubmitVoucher').textContent = '提交中…'
  try {
    const r = await window.api.creditsOrderVoucher(creditsState.order.id, voucher)
    if (r && r.ok) {
      showToast('凭证已提交，人工核对后自动到账', 'success')
      creditsState.order = null
      creditsSetStep('amount')
      $('creditsNextBtn').disabled = !creditsState.amount
      creditsLoadOrders()
    } else {
      creditsShowPayError((r && r.error) || '提交失败，请稍后再试')
    }
  } catch (err) {
    creditsShowPayError(`网络错误：${err.message}`)
  } finally {
    creditsState.busy = false
    $('creditsSubmitVoucher').disabled = false
    $('creditsSubmitVoucher').textContent = '我已付款，提交审核'
  }
}

// === 余额 + 我的订单 ===

async function creditsRefreshBalance() {
  try {
    const r = await window.api.creditsBalance()
    if (r && r.ok && authState.user) {
      authState.user.credits = r.credits
      $('creditsBalanceVal').textContent = Number(r.credits || 0).toLocaleString()
      const badge = $('creditValue')
      if (badge) badge.textContent = r.credits
    }
  } catch { /* 离线时保留本地显示 */ }
}

async function creditsLoadOrders() {
  const list = $('creditsOrdersList')
  try {
    const r = await window.api.creditsOrdersMy()
    if (r && r.ok) {
      creditsState.orders = r.orders || []
    }
  } catch { /* 网络异常时保留旧列表 */ }
  creditsRenderOrders(list)
}

function creditsRenderOrders(box) {
  if (!box) return
  if (!creditsState.orders.length) {
    box.innerHTML = '<div class="credits-orders-empty">暂无订单</div>'
    return
  }
  box.innerHTML = creditsState.orders.map((o) => {
    const cls = CREDITS_STATUS_TEXT[o.status] ? `cs-${o.status}` : 'cs-pending'
    const reason = o.status === 'rejected' && o.rejectReason
      ? `<div class="meta" style="color:var(--status-err)">原因：${o.rejectReason}</div>` : ''
    const cancellable = o.status === 'pending' || o.status === 'reviewing'
    return `<div class="credits-order-item">
      <div>
        <div>¥${o.amount} · ${(o.credits || 0).toLocaleString()} 积分</div>
        <div class="meta">${creditsFmtTime(o.createdAt)} · 尾号 ${creditsShortId(o)}</div>
        ${reason}
      </div>
      <span class="credits-order-status ${cls}">${CREDITS_STATUS_TEXT[o.status] || o.status}</span>
      ${cancellable ? `<button type="button" class="credits-order-cancel" data-id="${o.id}" title="不打算付款就取消，避免占用待审核名额">取消</button>` : ''}
    </div>`
  }).join('')
}

async function creditsCancelOrder(id) {
  try {
    const r = await window.api.creditsOrderCancel(id)
    if (r && r.ok) {
      showToast('订单已取消', 'success')
      creditsLoadOrders()
    } else {
      showToast((r && r.error) || '取消失败', 'error')
    }
  } catch (err) {
    showToast(`取消失败: ${err.message}`, 'error')
  }
}

// === 事件绑定（脚本在 body 尾部加载，DOM 已就绪） ===

(function initCreditsUI() {
  if (!window.api || window.api._fallback) return

  $('creditsCloseX').addEventListener('click', creditsCloseModal)
  $('creditsCloseBtn').addEventListener('click', creditsCloseModal)
  $('creditsModal').addEventListener('mousedown', (e) => {
    if (e.target === $('creditsModal')) creditsCloseModal()
  })

  $('creditsGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.credits-tier')
    if (btn) creditsPickTier(btn)
  })
  $('creditsNextBtn').addEventListener('click', creditsNext)
  $('creditsBackBtn').addEventListener('click', creditsBack)
  $('creditsSubmitVoucher').addEventListener('click', creditsSubmitVoucher)
  $('creditsVoucher').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') creditsSubmitVoucher()
  })
  // 我的订单：取消待支付/审核中订单（事件委托）
  $('creditsOrdersList').addEventListener('click', (e) => {
    const btn = e.target.closest('.credits-order-cancel')
    if (btn) creditsCancelOrder(btn.dataset.id)
  })
  // 每日签到
  $('creditsSigninBtn').addEventListener('click', creditsSignin)
})()
