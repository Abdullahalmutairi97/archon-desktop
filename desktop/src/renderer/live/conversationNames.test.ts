import { describe, expect, it } from 'vitest'
import { cleanConversationName, readConversationNames, writeConversationName } from './conversationNames'

function memory() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, values }
}

describe('local conversation names', () => {
  it('keeps names per server and clears them', () => {
    const storage = memory()
    let names = writeConversationName('http://a', {}, 'prime-1', '  Queue   refactor\n', storage)
    expect(names).toEqual({ 'prime-1': 'Queue refactor' })
    expect(readConversationNames('http://a', storage)).toEqual({ 'prime-1': 'Queue refactor' })
    expect(readConversationNames('http://b', storage)).toEqual({})
    names = writeConversationName('http://a', names, 'prime-1', null, storage)
    expect(readConversationNames('http://a', storage)).toEqual({})
    expect(readConversationNames(null, storage)).toEqual({})
  })

  it('ignores corrupt or hostile stored data', () => {
    const storage = memory()
    storage.values.set('archon.reconstruction.conversationNames.v1:http://a', '{"../x":"bad","prime-2":42,"prime-3":"ok"}')
    expect(readConversationNames('http://a', storage)).toEqual({ 'prime-3': 'ok' })
    storage.values.set('archon.reconstruction.conversationNames.v1:http://a', 'not json')
    expect(readConversationNames('http://a', storage)).toEqual({})
    expect(cleanConversationName('   ')).toBeNull()
    expect(cleanConversationName('x'.repeat(500))).toHaveLength(120)
  })
})
