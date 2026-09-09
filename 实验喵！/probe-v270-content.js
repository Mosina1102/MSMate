// v2.7.0 发布前 asar 内容抽查
const asar = require('@electron/asar')
const p = 'release_build_v270/win-unpacked/resources/app.asar'
const icons = asar.extractFile(p, 'src\\js\\icons.js').toString()
console.log('icons.js', icons.length, '字符, iconSvg:', icons.includes('function iconSvg') ? 'OK' : 'MISS')
const app = asar.extractFile(p, 'src\\js\\app.js').toString()
console.log('getFileIcon 修复:', app.includes('return iconSvg(iconMap[ext]') ? 'OK' : 'MISS')
console.log('MS 字标残留:', app.includes('>MS<') ? '有残留!' : '无 OK')
const css = asar.extractFile(p, 'src\\styles\\main.css').toString()
console.log('执事风主题:', css.includes('theme-butler') ? 'OK' : 'MISS')
console.log('btn-accent 紫:', css.includes('background: var(--accent);\n  color: var(--on-accent);') ? 'OK' : 'MISS')
const idx = asar.extractFile(p, 'src\\index.html').toString()
console.log('主题三选项:', idx.includes('value="butler"') ? 'OK' : 'MISS')
console.log('快捷键条已删:', idx.includes('shortcut-hint') ? '有残留!' : '无 OK')
