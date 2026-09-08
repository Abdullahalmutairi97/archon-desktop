import { ArchonApi } from './api'
import type { TaskEvent } from './types'

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

  it('encodes task IDs in event and cancellation URLs', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ events: [] }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })
    const id = 'task/with?reserved=value'

    await api.taskEvents(id)
    await api.cancelTask(id)

    expect(fetchMock.mock.calls[0][0]).toBe('http://vps:8765/api/tasks/task%2Fwith%3Freserved%3Dvalue/events?after=0')
    expect(fetchMock.mock.calls[1][0]).toBe('http://vps:8765/api/tasks/task%2Fwith%3Freserved%3Dvalue/cancel')
  })

  it('encodes cron IDs in mutation URLs', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })
    const id = 'job/with?reserved=value'

    await api.editCron(id, {}, true)
    await api.cronAction(id, 'pause', true)

    expect(fetchMock.mock.calls[0][0]).toBe('http://vps:8765/api/cron/job%2Fwith%3Freserved%3Dvalue')
    expect(fetchMock.mock.calls[1][0]).toBe('http://vps:8765/api/cron/job%2Fwith%3Freserved%3Dvalue/action')
  })

  it('sends explicit confirmation for cron mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })

    await api.cronAction('abc123def456', 'pause', true)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ action: 'pause', confirm: true })
  })

  it('normalizes invalid task-event cursors before requesting replay', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ events: [] }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })

    await api.taskEvents('task-1', -1)

    expect(fetchMock.mock.calls[0][0]).toBe('http://vps:8787/api/tasks/task-1/events?after=0')
  })

  it('normalizes an invalid starting cursor before connecting', async () => {
    const body = new ReadableStream({ start(controller) { controller.close() } })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    await api.streamEvents(-1, () => undefined)
    expect(fetchMock.mock.calls[0][0]).toBe('http://vps:8787/api/events?after=0')
  })

  it('streams ordered authenticated SSE events and resumes from the cursor', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {bad}\n\n'))
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

  it('drains 120 ordered cross-session events across fragmented chunks', async () => {
    const payload = Array.from({ length: 120 }, (_, index) => `data: ${JSON.stringify({ seq: index + 1, task_id: `s${index % 7}`, type: 'output', data: { index } })}\n\n`).join('')
    const chunks = Array.from({ length: Math.ceil(payload.length / 17) }, (_, index) => payload.slice(index * 17, (index + 1) * 17))
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: TaskEvent[] = []

    const cursor = await api.streamEvents(0, (event) => events.push(event))

    expect(events).toHaveLength(120)
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1))
    expect(new Set(events.map((event) => event.task_id)).size).toBe(7)
    expect(cursor).toBe(120)
  })

  it('does not dispatch duplicate or out-of-order sequence events', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"seq\":42,\"type\":\"tick\",\"data\":{}}\n\ndata: {\"seq\":42,\"type\":\"tick\",\"data\":{}}\n\ndata: {\"seq\":41,\"type\":\"tick\",\"data\":{}}\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: unknown[] = []
    await api.streamEvents(40, (event) => events.push(event))
    expect(events).toHaveLength(1)
  })

  it('does not advance the cursor for malformed sequence values', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"seq\":1.5,\"type\":\"tick\",\"data\":{}}\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: TaskEvent[] = []
    const cursor = await api.streamEvents(40, (event) => events.push(event))
    expect(events).toEqual([])
    expect(cursor).toBe(40)
  })

  it('does not advance the cursor for unsafe SSE sequence numbers', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"seq":9007199254740992,"type":"output","data":{}}\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: unknown[] = []

    const cursor = await api.streamEvents(40, (event) => events.push(event))

    expect(events).toEqual([])
    expect(cursor).toBe(40)
  })

  it('parses SSE events that use multiple data lines', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"seq\":43,\ndata: \"task_id\":\"t1\",\ndata: \"type\":\"output\",\ndata: \"data\":{\"text\":\"ok\"}}\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: Array<{ seq: number }> = []

    await api.streamEvents(42, (event) => events.push(event))

    expect(events).toEqual([{ seq: 43, task_id: 't1', type: 'output', data: { text: 'ok' } }])
  })

  it('parses SSE frames separated by lone carriage returns', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"seq\":44,\"type\":\"tick\",\"data\":{}}\r\rdata: {\"seq\":45,\"type\":\"tick\",\"data\":{}}\r\r'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: unknown[] = []
    await api.streamEvents(43, (event) => events.push(event))
    expect(events).toHaveLength(2)
  })

  it('parses SSE streams using CR-only line endings', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"seq\":44,\"type\":\"output\",\"data\":{}}\r\r'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: TaskEvent[] = []

    await api.streamEvents(43, (event) => events.push(event))

    expect(events).toEqual([{ seq: 44, type: 'output', data: {} }])
  })

  it('parses frames with mixed SSE line endings', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {\"seq\":46,\"type\":\"tick\",\"data\":{}}\r\n\ndata: {\"seq\":47,\"type\":\"tick\",\"data\":{}}\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const api = new ArchonApi({ serverUrl: 'http://vps:8787', token: 'secret' })
    const events: unknown[] = []
    await api.streamEvents(45, (event) => events.push(event))
    expect(events).toHaveLength(2)
  })

  it('removes the selected sessions through the authenticated batch endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, deleted: ['one', 'two'] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })

    await api.deleteSessions(['one', 'two'])

    expect(fetchMock).toHaveBeenCalledWith('http://vps:8765/api/sessions', expect.objectContaining({
      method: 'DELETE', headers: expect.objectContaining({ Authorization: 'Bearer secret' }), body: JSON.stringify({ session_ids: ['one', 'two'] }),
    }))
  })

  it('falls back when batch deletion returns a bare 405 response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })

    await api.deleteSessions(['one'])

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('falls back to the existing per-session endpoint when the server lacks batch removal', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Method Not Allowed' }), { status: 405, statusText: 'Method Not Allowed' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ArchonApi({ serverUrl: 'http://vps:8765', token: 'secret' })

    await api.deleteSessions(['one', 'two'])

    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://vps:8765/api/tasks', expect.anything())
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://vps:8765/api/sessions/one', expect.objectContaining({ method: 'DELETE' }))
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://vps:8765/api/sessions/two', expect.objectContaining({ method: 'DELETE' }))
  })
})
