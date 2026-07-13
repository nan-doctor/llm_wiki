import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

const roots = ["src", "test", "scripts"]
const extensions = new Set([".ts", ".mjs"])
const problems = []

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(file)
    } else if (extensions.has(path.extname(entry.name))) {
      const text = await readFile(file, "utf8")
      if (!text.endsWith("\n")) problems.push(`${file}: 缺少末尾换行`)
      text.split("\n").forEach((line, index) => {
        if (/\s+$/.test(line)) problems.push(`${file}:${index + 1}: 行尾空白`)
        if (line.includes("\t")) problems.push(`${file}:${index + 1}: 制表符`)
      })
    }
  }
}

for (const root of roots) await visit(root)
if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exitCode = 1
}
