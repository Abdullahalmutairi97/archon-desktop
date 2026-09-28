import type { ReactNode } from 'react'
import './Markdown.css'

/**
 * A small Markdown subset for agent replies, rendered as React elements only.
 *
 * Supported: fenced code blocks, ATX headings, bullet and numbered lists,
 * block quotes, horizontal rules, paragraphs, and inline code, bold, italic
 * and links. Raw HTML is never interpreted - it stays visible text - and a
 * link is shown as its label followed by its address, never as a clickable
 * element, because the renderer has no safe way to open one. Parsing is a
 * single linear pass, so a hostile reply cannot make it slow.
 */

type Block =
  | { kind: 'code'; language: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string }

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/u
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/u
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/u
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/u
const QUOTE = /^\s{0,3}>\s?(.*)$/u
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u

/** Drop an optional closing run of '#' without a backtracking pattern. */
function trimClosingHashes(text: string): string {
  let end = text.trimEnd().length
  let hashes = end
  while (hashes > 0 && text[hashes - 1] === '#') hashes -= 1
  if (hashes < end && (hashes === 0 || /\s/u.test(text[hashes - 1]))) end = hashes
  return text.slice(0, end).trimEnd()
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        code.push(lines[index])
        index += 1
      }
      blocks.push({ kind: 'code', language: fence[2], text: code.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = HEADING.exec(line)
    if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1].length, text: trimClosingHashes(heading[2]) }); continue }
    if (RULE.test(line)) { flush(); blocks.push({ kind: 'rule' }); continue }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      flush()
      const ordered = !!numbered
      const previous = blocks.at(-1)
      const item = (bullet ?? numbered)![1]
      if (previous?.kind === 'list' && previous.ordered === ordered && index > 0 && lines[index - 1].trim()) previous.items.push(item)
      else blocks.push({ kind: 'list', ordered, items: [item] })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      const previous = blocks.at(-1)
      if (previous?.kind === 'quote' && index > 0 && QUOTE.test(lines[index - 1])) previous.text += `\n${quote[1]}`
      else blocks.push({ kind: 'quote', text: quote[1] })
      continue
    }
    // A continuation line of a list item stays with that item.
    const previous = blocks.at(-1)
    if (!paragraph.length && previous?.kind === 'list' && /^\s{2,}\S/u.test(line) && lines[index - 1].trim()) {
      previous.items[previous.items.length - 1] += ` ${line.trim()}`
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

const INLINE = /(`)([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])|\*([^*\n]+)\*|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])|\[([^\]\n]+)\]\(([^)\s]+)\)/gu

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let count = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(text.slice(last, start))
    const key = `${keyPrefix}-${count++}`
    if (match[2] !== undefined) nodes.push(<code key={key}>{match[2]}</code>)
    else if (match[3] !== undefined || match[4] !== undefined) nodes.push(<strong key={key}>{match[3] ?? match[4]}</strong>)
    else if (match[5] !== undefined || match[6] !== undefined) nodes.push(<em key={key}>{match[5] ?? match[6]}</em>)
    else nodes.push(<span key={key} className="md-link">{match[7]} <span className="md-link-url" dir="ltr">({match[8]})</span></span>)
    last = start + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  return <div className={`md ${className ?? ''}`.trim()} dir="auto">
    {blocks.map((block, index) => {
      const key = `b-${index}`
      switch (block.kind) {
        case 'code':
          return <pre key={key} className="md-code" dir="ltr" data-language={block.language || undefined}><code>{block.text}</code></pre>
        case 'heading': {
          const level = Math.min(block.level + 2, 6)
          const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6'
          return <Tag key={key} className="md-heading" dir="auto">{renderInline(block.text, key)}</Tag>
        }
        case 'list': {
          const items = block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`} dir="auto">{renderInline(item, `${key}-${itemIndex}`)}</li>)
          return block.ordered ? <ol key={key} className="md-list">{items}</ol> : <ul key={key} className="md-list">{items}</ul>
        }
        case 'quote':
          return <blockquote key={key} className="md-quote" dir="auto">{renderInline(block.text, key)}</blockquote>
        case 'rule':
          return <hr key={key} className="md-rule" />
        case 'paragraph':
          return <p key={key} className="md-paragraph" dir="auto">{renderInline(block.text, key)}</p>
      }
    })}
  </div>
}
