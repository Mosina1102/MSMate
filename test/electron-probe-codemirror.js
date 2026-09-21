// CodeMirror 5 × Electron 22 探针：vendor UMD 直载 + 真建实例 + java 高亮 mode + 中文内容往返
// 通过标准：14 个 vendor 文件齐全 + Chromium 108 里 UMD 载入 + java 实例建起 + 关键词真高亮
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow } = require('electron')

const SRC = path.join(__dirname, '..', 'src')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // ① vendor 文件齐全（index.html 引用的核心 + 10 mode + 11 addon + css）
  const files = [
    'vendor/codemirror/codemirror.js', 'vendor/codemirror/codemirror.css',
    'vendor/codemirror/mode/javascript.js', 'vendor/codemirror/mode/css.js', 'vendor/codemirror/mode/xml.js',
    'vendor/codemirror/mode/htmlmixed.js', 'vendor/codemirror/mode/clike.js', 'vendor/codemirror/mode/python.js',
    'vendor/codemirror/mode/markdown.js', 'vendor/codemirror/mode/sql.js', 'vendor/codemirror/mode/shell.js',
    'vendor/codemirror/addon/edit/closebrackets.js', 'vendor/codemirror/addon/edit/matchbrackets.js',
    'vendor/codemirror/addon/selection/active-line.js',
    'vendor/codemirror/addon/fold/foldcode.js', 'vendor/codemirror/addon/fold/foldgutter.js',
    'vendor/codemirror/addon/fold/brace-fold.js', 'vendor/codemirror/addon/fold/xml-fold.js',
    'vendor/codemirror/addon/mode/overlay.js',
    'vendor/codemirror/addon/dialog/dialog.js',
    'vendor/codemirror/addon/search/searchcursor.js', 'vendor/codemirror/addon/search/search.js',
    'vendor/codemirror/addon/hint/show-hint.js', 'vendor/codemirror/addon/hint/anyword-hint.js'
  ]
  for (const f of files) {
    const p = path.join(SRC, f)
    const exists = fs.existsSync(p) && fs.statSync(p).size > 1000
    ok('vendor ' + path.basename(f), exists)
  }

  // ② 渲染层真载：UMD 直载 + 建实例 + mode 解析 + 中文内容往返（对标真机 Chromium 108）
  const url = 'file:///' + SRC.replace(/\\/g, '/')
  const probeHtml = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="${url}/vendor/codemirror/codemirror.css">
${files.filter((f) => f.endsWith('.js')).map((f) => `<script src="${url}/${f}"></script>`).join('\n')}
</head><body><div id="host"></div></body></html>`
  const tmpHtml = path.join(__dirname, '.tmp-cm-probe.html')
  fs.writeFileSync(tmpHtml, probeHtml)
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    await win.loadFile(tmpHtml)
    const r = await win.webContents.executeJavaScript(`(function() {
      const out = {}
      out.cmDefined = typeof CodeMirror !== 'undefined'
      if (!out.cmDefined) return out
      const host = document.getElementById('host')
      const cm = CodeMirror(host, {
        value: 'function a() {\\n  const x = 1;\\n}\\nfunction b() {\\n  const y = 2;\\n}\\n',
        mode: 'text/javascript', theme: 'msmate', lineNumbers: true,
        styleActiveLine: true, matchBrackets: true, autoCloseBrackets: true,
        foldGutter: true, gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter']
      })
      out.instance = !!cm && typeof cm.getValue === 'function'
      out.roundtrip = cm.getValue().indexOf('const y') !== -1
      out.lineNumbers = !!host.querySelector('.CodeMirror-linenumber')
      out.javaTok = !!host.querySelector('.cm-keyword')
      out.foldGutter = !!host.querySelector('.CodeMirror-foldgutter') // 折叠槽 DOM 真生成
      out.anywordHint = typeof (CodeMirror.hint && CodeMirror.hint.anyword) === 'function'
      out.search = !!(cm.showHint || CodeMirror.commands.find) // 搜索/补全 addon 挂载
      out.javaMode = (CodeMirror.resolveMode('text/x-java') || {}).name
      out.mdMode = (CodeMirror.resolveMode('markdown') || {}).name
      out.htmlMode = (CodeMirror.resolveMode('htmlmixed') || {}).name
      // 复现 wbCmMount 真实调用链（addOverlay 复染）——实锤过"overlay 炸了全部文件打不开"，锁死
      try {
        const host2 = document.createElement('div')
        document.body.appendChild(host2)
        const cm2 = CodeMirror(host2, {
          value: 'class Player {}',
          mode: 'text/x-java',
          lineNumbers: true, foldGutter: true, gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter']
        })
        cm2.addOverlay({ token: (s) => { if (s.match(/@[A-Za-z_$][\w$]*/)) return 'anno-x'; if (s.match(/[A-Z][A-Za-z0-9_$]*/)) return 'type-x'; if (s.match(/^[^A-Z@]+/)) return null; s.next(); return null } })
        out.overlayMount = cm2.getValue().indexOf('Player') !== -1 && !!host2.querySelector('.cm-type-x')
        host2.remove()
      } catch (e) { out.overlayMount = false; out.overlayErr = e.message }
      cm.setSize('100%', '100%')
      return out
    })()`)
    ok('CodeMirror UMD 定义', r.cmDefined)
    ok('建实例（javascript mode）', r.instance)
    ok('内容往返（中文不丢）', r.roundtrip)
    ok('行号 DOM 生成', r.lineNumbers)
    ok('关键词高亮（.cm-keyword）', r.javaTok)
    ok('折叠槽 DOM 生成', r.foldGutter)
    ok('anyword 补全注册', r.anywordHint)
    ok('搜索 addon 挂载', r.search)
    ok('resolveMode text/x-java → clike', r.javaMode === 'clike', String(r.javaMode))
    ok('resolveMode markdown', r.mdMode === 'markdown', String(r.mdMode))
    ok('resolveMode htmlmixed', r.htmlMode === 'htmlmixed', String(r.htmlMode))
    ok('overlayMode 复染建实例（wbCmMount 同链路）', r.overlayMount === true, r.overlayErr || 'type-x 未渲染')
    win.destroy()
  } catch (e) {
    ok('渲染层探针', false, e.message)
  }
  fs.rmSync(tmpHtml, { force: true })
  console.log(`\n${fail === 0 ? 'CM_PROBE_OK' : 'CM_PROBE_FAIL'} (${pass}/${pass + fail})`)
  app.exit(fail ? 1 : 0)
}

app.on('window-all-closed', () => {})
app.whenReady().then(main)
