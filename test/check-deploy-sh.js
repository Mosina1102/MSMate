// deploy.sh 校验（一次性）：行尾 LF + 动态版本校验 + 无写死版本号
const s = require('fs').readFileSync('api-server/deploy.sh', 'utf8')
const crlf = (s.match(/\r\n/g) || []).length
console.log('CRLF:', crlf, '| 动态校验 CLIV/SVCI:', s.includes('CLIV') && s.includes('SVCI'), '| 无写死 2.7.18:', !s.includes('2.7.18'), '| 镜像tag动态:', s.includes('IMG="msmate-api:v$SVCI"'))
process.exit(crlf === 0 && s.includes('CLIV') && !s.includes('2.7.18') ? 0 : 1)
