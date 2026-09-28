import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown, parseMarkdown } from './Markdown'

afterEach(() => cleanup())

describe('agent reply markdown', () => {
  it('renders the common reply shapes as elements', () => {
    const { container } = render(<Markdown text={[
      '## Plan',
      '',
      'Run **tests** with `npm test` and see [the docs](https://example.test/docs).',
      '',
      '- first',
      '- second',
      '',
      '1. one',
      '2. two',
      '',
      '```ts',
      'const x = <b>1</b>',
      '```',
      '> quoted',
    ].join('\n')} />)

    expect(container.querySelector('h4')).toHaveTextContent('Plan')
    expect(container.querySelector('strong')).toHaveTextContent('tests')
    expect(container.querySelector('p code')).toHaveTextContent('npm test')
    expect(container.querySelector('.md-link')).toHaveTextContent('the docs (https://example.test/docs)')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(container.querySelector('pre.md-code')).toHaveTextContent('const x = <b>1</b>')
    expect(container.querySelector('pre.md-code')).toHaveAttribute('data-language', 'ts')
    expect(container.querySelector('blockquote')).toHaveTextContent('quoted')
  })

  it('never interprets markup or makes links clickable', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3))'} />)
    expect(container.querySelector('img, script, a')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('(javascript:alert(3))')
  })

  it('leaves underscores inside identifiers alone', () => {
    const { container } = render(<Markdown text={'call snake_case_name and window.__private__value, but _this_ is emphasis'} />)
    expect(container.querySelectorAll('em')).toHaveLength(1)
    expect(container.querySelector('em')).toHaveTextContent('this')
    expect(container.textContent).toContain('snake_case_name and window.__private__value')
  })

  it('keeps an unterminated fence and stays fast on hostile input', () => {
    expect(parseMarkdown('```\ncode without an end')).toEqual([{ kind: 'code', language: '', text: 'code without an end' }])
    const hostile = `# ${' '.repeat(200_000)}x ${'`'.repeat(50_000)} ${'*'.repeat(50_000)} ${'_'.repeat(50_000)}`
    const started = performance.now()
    render(<Markdown text={hostile} />)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
