import { normalizeConnection } from './connection'

describe('normalizeConnection', () => {
  it('trims endpoint and bearer token before persistence/use', () => {
    expect(normalizeConnection({ serverUrl: ' https://example.test/// ', token: '  abcdefghijklmnop  ' })).toEqual({ serverUrl: 'https://example.test', token: 'abcdefghijklmnop' })
  })
})
