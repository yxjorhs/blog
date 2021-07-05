const fs = require("fs")

const files = fs.readdirSync(__dirname).filter(v => /^[\w\W!]+\.md$/.test(v) && v !== "README.md")

let text = `# blog\n\n`

files.forEach(v => {
  text += `[${v.split(".md")[0]}](./${v})\n\n`
})

fs.writeFileSync(`${__dirname}/README.md`, text)
