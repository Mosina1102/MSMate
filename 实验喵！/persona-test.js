// 人设 v0.4 真机实测：3 用例直打真实模型
const fs = require('fs')
const path = require('path')
const { assembleSystemPrompt } = require('../ai/prompt')

const settings = JSON.parse(fs.readFileSync('C:/Users/ars/AppData/Roaming/ms-interconnect/settings.json', 'utf8'))
const KEY = settings.aiApiKey
const BASE = (settings.aiBaseUrl || 'https://api.siliconflow.cn/v1').replace(/\/$/, '')
let MODEL = settings.aiModel || 'deepseek-ai/DeepSeek-V3'
if (MODEL.startsWith('[网页]')) {
  const list = Array.isArray(settings.chatModelList) ? settings.chatModelList : String(settings.chatModelList || '').split(' ')
  MODEL = list.find(m => m && m.includes('DeepSeek') && !m.startsWith('[网页]')) || list.find(m => m && !m.startsWith('[网页]')) || 'deepseek-ai/DeepSeek-V3'
}
if (!KEY) { console.log('未配置 API Key'); process.exit(1) }
console.log(`模型: ${MODEL} @ ${BASE}\n`)

const sys = assembleSystemPrompt({
  hostName: 'ARS-PC', isChild: false, rules: [], memory: [], bigNotes: '', sessionNotes: '',
  desktopDir: 'C:\\Users\\ars\\Desktop', localUserDir: 'C:\\Users\\ars',
  workspaceDir: 'C:\\Users\\ars\\AppData\\Roaming\\ms-interconnect\\workspace',
  deviceLines: '  - 本机「ARS-PC」（target 填 "local" 或省略）',
  toolPromptSection: '（工具清单略——本轮只测人设）', manualsDir: ''
})

const CASES = [
  ['干活语气', '帮我把桌面的文件整理一下，图片归图片文档归文档'],
  ['问真名', '对了，你真名叫什么呀？'],
  ['熬夜关怀', '我昨晚通宵打游戏到现在还没睡，帮我下载几张我的世界壁纸'],
]

;(async () => {
  for (const [tag, q] of CASES) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [
        { role: 'system', content: sys },
        { role: 'user', content: q }
      ], max_tokens: 500, temperature: 0.7 })
    })
    const j = await res.json()
    const reply = j.choices && j.choices[0] ? j.choices[0].message.content : (`请求失败: ` + JSON.stringify(j).slice(0, 200))
    console.log(`═══ ${tag} ═══\n用户: ${q}\n莫西: ${reply}\n`)
  }
})()
