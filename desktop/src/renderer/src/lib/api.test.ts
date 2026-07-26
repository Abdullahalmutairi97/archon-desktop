import { ArchonApi } from './api'

describe('ArchonApi', () => {
  it('persists a background task through the authenticated VPS API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task: { id: 't1', status: 'queued' } }), { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })

    const task = await api.createTask({ prompt: 'finish while my PC is off', skills: [] })

    expect(task.id).toBe('t1')
    expect(fetchMock).toHaveBeenCalledWith('http://vps:8765/api/tasks', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer secret' })
    }))
  })

  it('sends explicit confirmation for cron mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })

    await api.cronAction('abc123def456', 'pause', true)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ action: 'pause', confirm: true })
  })

  it('streams ordered authenticated SSE events and resumes from the cursor', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 41\nevent: task.running\ndata: {"seq":41,"task_id":"t1","type":"task.running","data":{"status":"running"}}\n\n'))
        controller.enqueue(new TextEncoder().encode('id: 42\nevent: output\ndata: {"seq":42,"task_id":"t1","type":"output","data":{"text":"done"}}\n\n'))
        controller.close()
      },
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: Array<{ seq: number; type: string }> = []

    const cursor = await api.streamEvents(40, (event) => events.push(event))

    expect(fetchMock).toHaveBeenCalledWith('http://vps:8787/api/events?after=40', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret', Accept: 'text/event-stream' }) }))
    expect(events.map(({ seq, type }) => ({ seq, type }))).toEqual([{ seq: 41, type: 'task.running' }, { seq: 42, type: 'output' }])
    expect(cursor).toBe(42)
  })
})
