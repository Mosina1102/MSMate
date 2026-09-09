// 称呼自然入句实测：复刻老大天气场景
const fs = require('fs')
const { assembleSystemPrompt } = require('../ai/prompt')

const settings = JSON.parse(fs.readFileSync('C:/Users/ars/AppData/Roaming/ms-interconnect/settings.json', 'utf8'))
const KEY = settings.aiApiKey
const BASE = (settings.aiBaseUrl || 'https://api.siliconflow.cn/v1').replace(/\/$/, '')
const MODEL = 'deepseek-ai/DeepSeek-V4-Flash'

const sys = assembleSystemPrompt({
  hostName: 'ARS-PC', isChild: false, rules: [], memory: [], bigNotes: '', sessionNotes: '',
  desktopDir: 'C:\\Users\\ars\\Desktop', localUserDir: 'C:\\Users\\ars',
  workspaceDir: 'C:\\x', deviceLines: '  - 本机「ARS-PC」',
  toolPromptSection: '（本轮只测人设）', manualsDir: ''
})

// 模拟已查完天气的上下文（工具已执行），看纯文本轮的语气
const CASES = [
  [['user', '帮我查一下重庆最近的天气'], ['assistant', '根据中国天气网的预报，重庆近期天气如下：\n\n今天（9月8日）：多云，29℃\n明天（9月9日）：晴转多云，38℃/30℃\n后天（9月10日）：多云转小雨，31℃/22℃\n\n简要建议：\n\n明天白天炎热（38℃），注意防暑降温，避免长时间户外活动。'], ['user', '好的，谢谢你']],
  [['user', '我最近老是熬夜到两点多']], // 顺带测关怀+变称呼
]

;(async () => {
  for (const msgs of CASES) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, ...msgs.map(([r, c]) => ({ role: r, content: c }))], max_tokens: 300, temperature: 0.7 })
    })
    const j = await res.json()
    console.log('═══ 场景: ' + msgs[msgs.length - 1][1].slice(0, 15) + ' ═══')
    console.log('莫西:', (j.choices && j.choices[0] ? j.choices[0].message.content : JSON.stringify(j).slice(0, 200)) + '\n')
  }
})()
