import { modelKey, readPinnedModels, togglePinnedModel } from './modelPreferences'
import type { ModelCatalog } from './types'

const catalog: ModelCatalog = {
  current: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  providers: [
    { id: 'openai-codex', models: ['gpt-5.6-sol', 'gpt-5.6-terra'] },
    { id: 'xai', models: ['grok-4'] },
  ],
  choices: [],
}

beforeEach(() => localStorage.clear())

it('uses the current server model as the initial chat model', () => {
  expect(readPinnedModels(catalog)).toEqual([{ provider: 'openai-codex', model: 'gpt-5.6-sol' }])
})

it('persists exactly the models selected for the chat picker', () => {
  togglePinnedModel({ provider: 'xai', model: 'grok-4' }, catalog)
  expect(readPinnedModels(catalog).map(modelKey)).toEqual(['openai-codex\u0000gpt-5.6-sol', 'xai\u0000grok-4'])
  togglePinnedModel({ provider: 'openai-codex', model: 'gpt-5.6-sol' }, catalog)
  expect(readPinnedModels(catalog)).toEqual([{ provider: 'xai', model: 'grok-4' }])
})

it('drops stale models that are no longer available', () => {
  localStorage.setItem('archon.chatModels', JSON.stringify(['missing\u0000gone', 'xai\u0000grok-4']))
  expect(readPinnedModels(catalog)).toEqual([{ provider: 'xai', model: 'grok-4' }])
})
