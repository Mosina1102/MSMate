// asar 抽查（一次性）：解包到临时目录，验证关键文件/版本/修复点/无残留
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const asar = path.resolve(process.argv[2] || 'release_build_v2715/win-unpacked/resources/app.asar')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-asar-'))
execFileSync('npx.cmd', ['asar', 'extract', asar, tmp], { stdio: 'ignore', shell: true })

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'MISS') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

const read = (p) => { try { return fs.readFileSync(path.join(tmp, p), 'utf8') } catch { return '' } }
const exists = (p) => fs.existsSync(path.join(tmp, p))

ok('ai/manuals/设计.md', exists('ai/manuals/设计.md'))
ok('ai/manuals/工具组合.md', exists('ai/manuals/工具组合.md'))
ok('ai/tools.js', exists('ai/tools.js'))
ok('ai/prompt.js', exists('ai/prompt.js'))

const pkg = read('package.json')
const VER = process.argv[3] || '2.7.18'
ok('package.json 版本 ' + VER, pkg.includes(`"version": "${VER}"`))

const tools = read('ai/tools.js')
ok('tools.js 含 render_html', tools.includes('render_html'))
ok('tools.js 含 setContentSize 钳制修复', tools.includes('setContentSize'))
ok('tools.js 含 C 盘改稿工作流', tools.includes('protectedDraftCopy') && tools.includes('Qwen/Qwen3.8-27B'))

const prompt = read('ai/prompt.js')
ok('prompt.js 注册设计手册', prompt.includes("'设计.md'"))

// 防残留
const creditsShotHit = ['ai/tools.js', 'ai/credits.js', 'src/js/work.js'].some((p) => read(p).includes('creditsShot'))
ok('无 creditsShot 残留', !creditsShotHit)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nASAR_CHECK ${fail === 0 ? 'OK' : 'FAIL'} (${pass}/${pass + fail})`)
process.exit(fail ? 1 : 0)
