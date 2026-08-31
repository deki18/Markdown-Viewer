const fs = require('fs')
const path = require('path')
const file = path.join(__dirname, '..', 'src', 'renderer', 'app.js')
let s = fs.readFileSync(file, 'utf8')

// 把元素/窗口级 addEventListener 调用改为防御式 on(target, event, ...) 调用
const re = /(\$\('[^']+'\)|\$\("[^"]+"\)|el\.[a-zA-Z0-9_]+|window|btn|node|n|row)\.addEventListener\(/g
let n = 0
s = s.replace(re, (m, t) => { n++; return `on(${t}, ` })

fs.writeFileSync(file, s, 'utf8')
console.log(`已将 ${n} 处 addEventListener 替换为防御式 on() 调用`)
