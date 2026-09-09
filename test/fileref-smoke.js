// file_ref 引用预处理冒烟测试
let msgText = '帮我读 [引用远程文件: 我的笔记本|abc-123|C:\\Users\\Administrator\\Desktop\\论文通.xlsx] 和 [引用文件: C:\\a b\\测试.docx]，还有 [引用文件: D:\\普通.txt]'
msgText = msgText.replace(/\[引用远程文件:\s*([^|\]]*)\|([^|\]]*)\|([^\]]+)\]/g, (m0, dname, devId, p) => `<file_ref target="${(devId || '').trim()}" path="${p.trim()}" />`)
msgText = msgText.replace(/\[引用文件:\s*([^\]]+)\]/g, (m0, p) => `<file_ref target="local" path="${p.trim()}" />`)
console.log(msgText)
const okRemote = msgText.includes('<file_ref target="abc-123" path="C:\\Users\\Administrator\\Desktop\\论文通.xlsx" />')
const okLocal1 = msgText.includes('<file_ref target="local" path="C:\\a b\\测试.docx" />')
const okLocal2 = msgText.includes('<file_ref target="local" path="D:\\普通.txt" />')
const noBrackets = !msgText.includes('[引用')
console.log(okRemote && okLocal1 && okLocal2 && noBrackets ? '✅ file_ref 预处理通过' : '❌ 失败')
process.exitCode = okRemote && okLocal1 && okLocal2 && noBrackets ? 0 : 1
