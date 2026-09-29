import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function stylesheets(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return stylesheets(path)
    return name.endsWith('.css') ? [path] : []
  })
}

/**
 * A stylesheet with an unclosed block or comment builds without error but
 * swallows every rule bundled after it, leaving the app unstyled. Unit tests
 * never load CSS, so check the structure here.
 */
describe('stylesheets', () => {
  it('close every block and comment', () => {
    const broken: string[] = []
    for (const file of stylesheets(join(__dirname))) {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      if (text.includes('/*') || text.includes('*/')) { broken.push(`${file}: unterminated comment`); continue }
      let depth = 0
      for (const character of text) {
        if (character === '{') depth += 1
        if (character === '}') depth -= 1
        if (depth < 0) break
      }
      if (depth !== 0) broken.push(`${file}: brace depth ${depth}`)
    }
    expect(broken).toEqual([])
  })
})
