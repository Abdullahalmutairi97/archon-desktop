import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionDescription, DesktopBridge } from '../../shared/bridge/types'
import { ServerCollections } from './ServerCollections'

afterEach(cleanup)

function connection(configured = true, generation = 1, localPairingAvailable = false): ConnectionDescription {
  return {
    serverUrl: configured ? 'https://archon.example' : null,
    configured,
    storageMode: 'memory',
    generation,
    ...(localPairingAvailable ? { localPairingAvailable: true } : {}),
  }
}

function fakeBridge(
  invoke: (operation: string, payload?: unknown) => Promise<unknown>,
  registerWorkspace: (input: { workspaceId: string }) => Promise<unknown> = vi.fn(async (_input: { workspaceId: string }) => ({
    id: 'local-project-1', name: 'Local checkout', rootPath: '/private/local/root',
  })),
) {
  const apiInvoke = vi.fn(invoke)
  const startTurn = vi.fn()
  const bridge = { api: { invoke: apiInvoke }, localCodex: { registerWorkspace, startTurn } } as unknown as DesktopBridge
  return { bridge, apiInvoke, registerWorkspace, startTurn }
}

function collections(projects: unknown[] = [], sessions: unknown[] = [], tasks: unknown[] = [], workspaces: unknown[] = []) {
  return (operation: string) => {
    if (operation === 'projects.list') return Promise.resolve({ projects })
    if (operation === 'sessions.list') return Promise.resolve({ sessions })
    if (operation === 'tasks.list') return Promise.resolve({ tasks })
    if (operation === 'workspaces.list') return Promise.resolve({ workspaces })
    return Promise.reject(new Error(`Unexpected operation: ${operation}`))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type DeferredValue = { promise: Promise<unknown>; resolve(value: unknown): void; reject(reason?: unknown): void }

describe('ServerCollections', () => {
  it('labels the browser preview unavailable and does not show fixture collections', () => {
    render(<ServerCollections connection={null} />)

    expect(screen.getByText('SERVER unavailable')).toBeInTheDocument()
    expect(screen.getByText(/browser preview is offline/i)).toBeInTheDocument()
    expect(screen.queryByText('SERVER PROJECTS')).not.toBeInTheDocument()
  })

  it('shows the disconnected state without querying the backend', () => {
    const { bridge, apiInvoke } = fakeBridge(collections())
    render(<ServerCollections bridge={bridge} connection={connection(false, 4)} />)

    expect(screen.getByText('SERVER disconnected')).toBeInTheDocument()
    expect(apiInvoke).not.toHaveBeenCalled()
  })

  it('registers an existing backend Git project and refreshes the project collection', async () => {
    const pendingCreate = deferred<unknown>()
    let registered = false
    const { bridge, apiInvoke } = fakeBridge((operation, payload) => {
      if (operation === 'projects.create') {
        expect(payload).toEqual({ name: 'Backend project', path: '/home/archon/backend-project' })
        registered = true
        return pendingCreate.promise
      }
      return collections(registered ? [{ id: 'project-new', name: 'Backend project' }] : [])(operation)
    })
    render(<ServerCollections bridge={bridge} connection={connection()} />)

    expect(screen.getByText('Use an absolute path inside the backend’s allowed project area. The directory must already exist and contain a Git repository.')).toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'Project name' })
    const path = screen.getByRole('textbox', { name: 'Backend Git directory path' })
    const submit = screen.getByRole('button', { name: 'Register server project' })
    fireEvent.change(name, { target: { value: 'Backend project' } })
    fireEvent.change(path, { target: { value: 'relative/project' } })
    expect(submit).toBeDisabled()
    expect(apiInvoke.mock.calls.some(([operation]) => operation === 'projects.create')).toBe(false)

    fireEvent.change(path, { target: { value: ' /home/archon/backend-project ' } })
    fireEvent.click(submit)
    expect(await screen.findByRole('button', { name: 'Registering project…' })).toBeDisabled()
    expect(apiInvoke.mock.calls.find(([operation]) => operation === 'projects.create')?.[1]).toEqual({
      name: 'Backend project', path: '/home/archon/backend-project',
    })

    await act(async () => { pendingCreate.resolve({ project: { id: 'project-new', name: 'Backend project' } }) })
    const registration = screen.getByRole('region', { name: 'Register server project' })
    expect(await within(registration).findByRole('status')).toHaveTextContent('Registered “Backend project” from the server Git repository.')
    expect(await screen.findByText('Backend project')).toBeInTheDocument()
    await waitFor(() => expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'projects.list')).toHaveLength(2))
  })

  it('explains that server-side registration needs an existing Git directory when rejected', async () => {
    const { bridge } = fakeBridge((operation) => {
      if (operation === 'projects.create') return Promise.reject(Object.assign(new Error('bad path'), { code: 'http_error' }))
      return collections()(operation)
    })
    render(<ServerCollections bridge={bridge} connection={connection()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: 'Missing project' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Backend Git directory path' }), { target: { value: '/srv/missing/project' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register server project' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Check that the directory exists, is a Git repository, and is inside the backend’s allowed project area.')
  })

  it('refreshes projects after an ambiguous registration failure before allowing a retry', async () => {
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (operation === 'projects.create') return Promise.reject(Object.assign(new Error('connection lost'), { code: 'network_error' }))
      return collections()(operation)
    })
    render(<ServerCollections bridge={bridge} connection={connection()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: 'Maybe registered' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Backend Git directory path' }), { target: { value: '/home/archon/maybe-registered' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register server project' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm whether registration completed. The project list was refreshed; check for this project before retrying.')
    await waitFor(() => expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'projects.list')).toHaveLength(2))
  })

  it('uses only the finite list operations and renders only bounded fixed fields as server data', async () => {
    const htmlLikeName = '<img src=x onerror=alert(1)>'
    const { bridge, apiInvoke } = fakeBridge(collections(
      [{ id: 'project-1', name: htmlLikeName, path: '/private/path', token: 'TOKEN_SENTINEL' }],
      [{ id: 'session-1', title: 'Session one', runtime: 'prime', prompt: 'PRIVATE_PROMPT' }],
      [{ id: 'task-1', title: 'Task one', status: 'running', command: 'PRIVATE_COMMAND' }],
    ))

    const { container } = render(<ServerCollections bridge={bridge} connection={connection()} />)

    expect(await screen.findByText(htmlLikeName)).toBeInTheDocument()
    expect(screen.getByText('SERVER PROJECTS')).toBeInTheDocument()
    expect(screen.getByText('SERVER SESSIONS')).toBeInTheDocument()
    expect(screen.getByText('SERVER TASKS')).toBeInTheDocument()
    expect(screen.getByText('prime')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('/private/path')
    expect(container.textContent).not.toContain('TOKEN_SENTINEL')
    expect(container.textContent).not.toContain('PRIVATE_PROMPT')
    expect(container.textContent).not.toContain('PRIVATE_COMMAND')
    expect(apiInvoke.mock.calls.map(([operation]) => operation).filter((operation) =>
      ['projects.list', 'sessions.list', 'tasks.list', 'workspaces.list'].includes(operation)).sort()).toEqual([
      'projects.list', 'sessions.list', 'tasks.list', 'workspaces.list',
    ])
  })

  it('renders every row in a bounded backend collection, including sessions after row 100', async () => {
    const sessions = Array.from({ length: 120 }, (_, index) => ({
      id: `session-${index + 1}`,
      title: `Session ${index + 1}`,
    }))
    const { bridge } = fakeBridge(collections([], sessions, []))

    render(<ServerCollections bridge={bridge} connection={connection()} />)

    expect(await screen.findByText('Session 120')).toBeInTheDocument()
    const section = screen.getByRole('region', { name: 'SERVER SESSIONS' })
    expect(within(section).getAllByRole('listitem')).toHaveLength(120)
    expect(within(section).getByText('120 shown')).toBeInTheDocument()
    expect(screen.getByText(/server may cap session, task and workspace lists/i)).toBeInTheDocument()
  })

  it('shows server-managed workspace identity and states that native isolation is not enabled', async () => {
    const workspace = {
      workspace_id: 'workspace-123',
      root: '/srv/archon/workspaces/workspace-123',
      project_id: 'project-1',
      base_revision: 'a'.repeat(40),
      head_revision: 'b'.repeat(40),
      generation: 3,
    }
    const { bridge } = fakeBridge(collections([], [], [], [workspace]))

    render(<ServerCollections bridge={bridge} connection={connection()} />)

    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    expect(within(section).getByText('workspace-123')).toBeInTheDocument()
    expect(within(section).getByText('Project: project-1 · Generation: 3')).toBeInTheDocument()
    expect(within(section).getByText(`Base revision: ${'a'.repeat(40)}`)).toBeInTheDocument()
    expect(within(section).getByText(`Head revision: ${'b'.repeat(40)}`)).toBeInTheDocument()
    expect(within(section).getByText(`Authoritative root: ${workspace.root}`)).toBeInTheDocument()
    expect(within(section).getByText('Server Git checkout; Local Codex remains Electron-owned and native execution isolation is not enabled.')).toBeInTheDocument()
  })

  it('offers local Codex registration only for valid workspaces on an active local pairing', async () => {
    const eligibleId = `workspace-${'a'.repeat(32)}`
    const { bridge } = fakeBridge(collections([], [], [], [
      { workspace_id: eligibleId, root: '/srv/workspace', project_id: 'project-1' },
    ]))
    const { rerender } = render(<ServerCollections bridge={bridge} connection={connection()} />)
    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })

    expect(within(section).queryByRole('button', { name: 'Add to Local Codex' })).not.toBeInTheDocument()

    rerender(<ServerCollections bridge={bridge} connection={connection(true, 1, true)} />)
    expect(await within(section).findByRole('button', { name: 'Add to Local Codex' })).toBeInTheDocument()
  })

  it('registers the workspace identity with Local Codex without starting a task', async () => {
    const workspaceId = `workspace-${'b'.repeat(32)}`
    const localRoot = '/private/local/codex/root'
    const pendingRegistration = deferred<unknown>()
    const registerWorkspace = vi.fn((_input: { workspaceId: string }) => pendingRegistration.promise)
    const { bridge, apiInvoke, startTurn } = fakeBridge(collections([], [], [], [{
      workspace_id: workspaceId,
      root: '/srv/archon/workspaces/server-root',
      project_id: 'project-1',
    }]), registerWorkspace)
    const onLocalCodexProjectRegistered = vi.fn()
    const { container } = render(<ServerCollections bridge={bridge} connection={connection(true, 1, true)} onLocalCodexProjectRegistered={onLocalCodexProjectRegistered} />)

    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    const button = within(section).getByRole('button', { name: 'Add to Local Codex' })
    fireEvent.click(button)

    expect(await within(section).findByRole('button', { name: 'Registering…' })).toBeDisabled()
    expect(registerWorkspace).toHaveBeenCalledTimes(1)
    expect(registerWorkspace).toHaveBeenCalledWith({ workspaceId })
    expect(startTurn).not.toHaveBeenCalled()
    expect(apiInvoke.mock.calls.some(([operation]) => operation === 'workspaces.provision')).toBe(false)

    const project = { id: 'local-project-1', name: 'Local checkout', rootPath: localRoot }
    pendingRegistration.resolve(project)
    expect(await within(section).findByText('Added to Local Codex. You can enter a prompt now.')).toBeInTheDocument()
    expect(onLocalCodexProjectRegistered).toHaveBeenCalledWith(project)
    expect(container.textContent).not.toContain(localRoot)
    expect(registerWorkspace.mock.calls).toEqual([[{ workspaceId }]])
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('keeps malformed workspace identifiers out of the Local Codex handoff action', async () => {
    const { bridge } = fakeBridge(collections([], [], [], [
      { workspace_id: `workspace-${'C'.repeat(32)}`, root: '/srv/workspaces/uppercase' },
      { workspace_id: 'workspace-123', root: '/srv/workspaces/short' },
    ]))

    render(<ServerCollections bridge={bridge} connection={connection(true, 1, true)} />)

    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    expect(within(section).queryByRole('button', { name: 'Add to Local Codex' })).not.toBeInTheDocument()
  })

  it('shows a concise error if Local Codex cannot register the workspace', async () => {
    const workspaceId = `workspace-${'c'.repeat(32)}`
    const registerWorkspace = vi.fn((_input: { workspaceId: string }) => Promise.reject(new Error('/private/source failed for internal reason')))
    const { bridge, startTurn } = fakeBridge(collections([], [], [], [{ workspace_id: workspaceId, root: '/srv/workspace' }]), registerWorkspace)

    render(<ServerCollections bridge={bridge} connection={connection(true, 1, true)} />)

    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    fireEvent.click(within(section).getByRole('button', { name: 'Add to Local Codex' }))

    const alert = await within(section).findByRole('alert')
    expect(alert).toHaveTextContent('Could not add this workspace to Local Codex. Try again.')
    expect(alert.textContent).not.toContain('/private/source')
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('opens and saves a small workspace file through the fixed bridge operations', async () => {
    const workspaceId = `workspace-${'a'.repeat(32)}`
    const workspace = {
      workspace_id: workspaceId, root: `/srv/archon/workspaces/${workspaceId}`,
      project_id: 'project-1', base_revision: 'a'.repeat(40), head_revision: 'a'.repeat(40), generation: 1,
    }
    const { bridge, apiInvoke } = fakeBridge((operation, payload) => {
      if (operation === 'workspaces.files.list') return Promise.resolve({
        path: '', entries: [{ name: 'README.md', path: 'README.md', kind: 'file', size: 5 }], truncated: false,
      })
      if (operation === 'workspaces.files.read') {
        const path = typeof payload === 'object' && payload !== null && 'path' in payload
          ? String(payload.path) : 'README.md'
        return Promise.resolve({ path, content: path === 'draft.md' ? '# Draft' : 'hello', truncated: false })
      }
      if (operation === 'workspaces.files.write') return Promise.resolve({ path: 'README.md', content: 'updated' })
      if (operation === 'workspaces.files.create') return Promise.resolve({ path: 'draft.md', content: '# Draft' })
      if (operation === 'workspaces.files.diff') return Promise.resolve({ path: 'README.md', diff: '@@ -1 +1 @@', truncated: false })
      return collections([], [], [], [workspace])(operation)
    })
    render(<ServerCollections bridge={bridge} connection={connection()} />)

    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    fireEvent.click(within(section).getByRole('button', { name: 'Browse files' }))
    const browser = await screen.findByRole('region', { name: 'Workspace files' })
    fireEvent.click(await within(browser).findByRole('button', { name: 'README.md 5 B' }))
    expect(await within(browser).findByText('hello')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.files.list')[0][1])
      .toEqual({ workspaceId, path: '', limit: 100 })
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.files.read')[0][1])
      .toEqual({ workspaceId, path: 'README.md', maxBytes: 65_536 })
    fireEvent.click(within(browser).getByRole('button', { name: 'Show Git diff' }))
    expect(await within(browser).findByText('@@ -1 +1 @@')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.find(([operation]) => operation === 'workspaces.files.diff')?.[1]).toEqual({ workspaceId, path: 'README.md' })
    fireEvent.click(within(browser).getByRole('button', { name: 'Edit' }))
    fireEvent.change(within(browser).getByRole('textbox', { name: 'Edit README.md' }), { target: { value: 'updated' } })
    await act(async () => {
      fireEvent.click(within(browser).getByRole('button', { name: 'Save' }))
      await Promise.resolve()
    })
    expect(await within(browser).findByText('updated')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.find(([operation]) => operation === 'workspaces.files.write')?.[1]).toEqual({
      workspaceId, path: 'README.md', expectedContent: 'hello', content: 'updated',
    })
    await waitFor(() => expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.files.list')).toHaveLength(2))

    fireEvent.click(within(browser).getByRole('button', { name: 'New text file' }))
    fireEvent.change(within(browser).getByRole('textbox', { name: 'Relative file path' }), { target: { value: 'draft.md' } })
    fireEvent.change(within(browser).getByRole('textbox', { name: 'New file content' }), { target: { value: '# Draft' } })
    fireEvent.click(within(browser).getByRole('button', { name: 'Create file' }))
    await waitFor(() => expect(apiInvoke.mock.calls.some(([operation]) => operation === 'workspaces.files.create')).toBe(true))
    expect(await within(browser).findByText('# Draft')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.find(([operation]) => operation === 'workspaces.files.create')?.[1]).toEqual({
      workspaceId, path: 'draft.md', content: '# Draft',
    })
  })

  it('creates one checkout from a registered project and refreshes the list after success', async () => {
    const pendingProvision = deferred<unknown>()
    const workspace = {
      workspace_id: 'workspace-created',
      root: '/srv/archon/workspaces/workspace-created',
      project_id: 'project-1',
      base_revision: 'a'.repeat(40),
      head_revision: 'a'.repeat(40),
      generation: 1,
    }
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (operation === 'workspaces.provision') return pendingProvision.promise
      if (operation === 'projects.head') return Promise.resolve({ revision: 'a'.repeat(40) })
      return collections(
        [{ id: 'project-1', name: 'Registered project', primary_path: '/private/source' }],
        [],
        [],
        [],
      )(operation)
    })
    const { container } = render(<ServerCollections bridge={bridge} connection={connection()} />)

    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    const projectSelect = within(section).getByRole('combobox', { name: 'Registered project' })
    expect(within(projectSelect).getByRole('option', { name: 'Registered project · project-1' })).toBeInTheDocument()
    const revisionInput = within(section).getByRole('textbox', { name: 'Full commit SHA' })
    fireEvent.click(within(section).getByRole('button', { name: 'Use current HEAD' }))
    await waitFor(() => expect(revisionInput).toHaveValue('a'.repeat(40)))
    const form = within(section).getByRole('button', { name: 'Create Git checkout' }).closest('form')!
    const submit = within(section).getByRole('button', { name: 'Create Git checkout' })
    fireEvent.click(submit)

    expect(await screen.findByRole('button', { name: 'Creating checkout…' })).toBeDisabled()
    fireEvent.submit(form)
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.provision')).toHaveLength(1)
    expect(container.textContent).not.toContain('/private/source')

    pendingProvision.resolve({ workspace })
    expect(await within(section).findByText('Workspace workspace-created was created.')).toBeInTheDocument()
    await waitFor(() => expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.list')).toHaveLength(2))
    expect(apiInvoke.mock.calls.find(([operation]) => operation === 'workspaces.provision')?.[1]).toEqual({
      projectId: 'project-1', revision: 'a'.repeat(40),
    })
  })

  it('surfaces ambiguous checkout results and requires a list refresh before retry', async () => {
    const networkFailure = Object.assign(new Error('connection dropped'), { code: 'network_error' })
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (operation === 'workspaces.provision') return Promise.reject(networkFailure)
      return collections([{ id: 'project-1', name: 'Registered project' }], [], [], [])(operation)
    })

    render(<ServerCollections bridge={bridge} connection={connection()} />)

    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    fireEvent.change(within(section).getByRole('textbox', { name: 'Full commit SHA' }), { target: { value: 'b'.repeat(64) } })
    fireEvent.click(within(section).getByRole('button', { name: 'Create Git checkout' }))

    expect(await within(section).findByText('Could not confirm whether the checkout was created. Refresh the workspace list before retrying.')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.provision')).toHaveLength(1)
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.list')).toHaveLength(1)
    fireEvent.click(within(section).getByRole('button', { name: 'Refresh workspace list' }))
    await waitFor(() => expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.list')).toHaveLength(2))
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.provision')).toHaveLength(1)
  })

  it('keeps existing server data available when an older server has no workspace endpoint', async () => {
    let workspaceAvailable = false
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (operation === 'workspaces.list') {
        return workspaceAvailable
          ? Promise.resolve({ workspaces: [] })
          : Promise.reject(new Error('not found'))
      }
      return collections([{ id: 'project-1', name: 'Existing server project' }], [], [])(operation)
    })

    render(<ServerCollections bridge={bridge} connection={connection()} />)

    expect(await screen.findByText('Existing server project')).toBeInTheDocument()
    const section = await screen.findByRole('region', { name: 'SERVER WORKSPACES' })
    expect(within(section).getByRole('alert')).toHaveTextContent('Workspace data is unavailable for this server connection.')
    expect(screen.getByText('SERVER connected · data loaded')).toBeInTheDocument()

    workspaceAvailable = true
    fireEvent.click(within(section).getByRole('button', { name: 'Retry workspaces' }))
    expect(await within(section).findByText('No server workspaces returned.')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.filter(([operation]) => ['projects.list', 'sessions.list', 'tasks.list'].includes(operation))).toHaveLength(3)
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.list')).toHaveLength(2)
  })

  it('ignores late responses from a previous generation', async () => {
    const oldProjects = deferred<unknown>()
    const oldSessions = deferred<unknown>()
    const oldTasks = deferred<unknown>()
    const oldWorkspaces = deferred<unknown>()
    let generation = 1
    const pendingOld = new Map<string, DeferredValue>([
      ['projects.list', oldProjects], ['sessions.list', oldSessions], ['tasks.list', oldTasks],
      ['workspaces.list', oldWorkspaces],
    ])
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (generation === 1) return pendingOld.get(operation)!.promise
      return collections([{ id: 'new-project', name: 'New server project' }], [], [])(operation)
    })
    const { rerender } = render(<ServerCollections bridge={bridge} connection={connection(true, 1)} />)

    await waitFor(() => expect(apiInvoke).toHaveBeenCalledTimes(4))
    generation = 2
    rerender(<ServerCollections bridge={bridge} connection={connection(true, 2)} />)

    expect(screen.queryByText('Old server project')).not.toBeInTheDocument()
    expect(await screen.findByText('New server project')).toBeInTheDocument()

    oldProjects.resolve({ projects: [{ id: 'old-project', name: 'Old server project' }] })
    oldSessions.resolve({ sessions: [] })
    oldTasks.resolve({ tasks: [] })
    oldWorkspaces.resolve({ workspaces: [] })
    await waitFor(() => expect(screen.queryByText('Old server project')).not.toBeInTheDocument())
    expect(screen.getByText('New server project')).toBeInTheDocument()
  })

  it('hides already loaded rows as soon as the connection generation changes', async () => {
    const newProjects = deferred<unknown>()
    const newSessions = deferred<unknown>()
    const newTasks = deferred<unknown>()
    const newWorkspaces = deferred<unknown>()
    let generation = 1
    const pendingNew = new Map<string, DeferredValue>([
      ['projects.list', newProjects], ['sessions.list', newSessions], ['tasks.list', newTasks],
      ['workspaces.list', newWorkspaces],
    ])
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (generation === 1) return collections([{ id: 'old-project', name: 'Previous server project' }], [], [])(operation)
      return pendingNew.get(operation)?.promise ?? Promise.reject(new Error(`Unexpected operation: ${operation}`))
    })
    const { rerender } = render(<ServerCollections bridge={bridge} connection={connection(true, 1)} />)

    expect(await screen.findByText('Previous server project')).toBeInTheDocument()
    generation = 2
    rerender(<ServerCollections bridge={bridge} connection={connection(true, 2)} />)

    expect(screen.queryByText('Previous server project')).not.toBeInTheDocument()
    expect(screen.getByText('SERVER data loading')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.filter(([operation]) => ['projects.list', 'sessions.list', 'tasks.list'].includes(operation))).toHaveLength(6)
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.list')).toHaveLength(2)

    newProjects.resolve({ projects: [{ id: 'new-project', name: 'Current server project' }] })
    newSessions.resolve({ sessions: [] })
    newTasks.resolve({ tasks: [] })
    newWorkspaces.resolve({ workspaces: [] })
    expect(await screen.findByText('Current server project')).toBeInTheDocument()
  })

  it('clears loaded data after disconnecting', async () => {
    const { bridge, apiInvoke } = fakeBridge(collections([{ id: 'project-1', name: 'Project from server' }]))
    const { rerender } = render(<ServerCollections bridge={bridge} connection={connection(true, 1)} />)

    expect(await screen.findByText('Project from server')).toBeInTheDocument()
    rerender(<ServerCollections bridge={bridge} connection={connection(false, 2)} />)

    expect(screen.getByText('SERVER disconnected')).toBeInTheDocument()
    expect(screen.queryByText('Project from server')).not.toBeInTheDocument()
    expect(apiInvoke.mock.calls.filter(([operation]) => ['projects.list', 'sessions.list', 'tasks.list', 'workspaces.list'].includes(operation))).toHaveLength(4)
  })

  it('shows an unavailable state when any read fails and offers a retry', async () => {
    let shouldFail = true
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (shouldFail && operation === 'sessions.list') return Promise.reject(new Error('offline'))
      return collections([{ id: 'project-1', name: 'Project after retry' }], [], [])(operation)
    })
    render(<ServerCollections bridge={bridge} connection={connection()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Check the server connection and token, then retry.')
    expect(screen.queryByText('Project after retry')).not.toBeInTheDocument()

    shouldFail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry SERVER data' }))
    expect(await screen.findByText('Project after retry')).toBeInTheDocument()
    expect(apiInvoke.mock.calls.filter(([operation]) => ['projects.list', 'sessions.list', 'tasks.list'].includes(operation))).toHaveLength(6)
    expect(apiInvoke.mock.calls.filter(([operation]) => operation === 'workspaces.list')).toHaveLength(1)
  })

  it('shows access rejection and directs the user to re-enter the token instead of retrying', async () => {
    const unauthorized = Object.assign(new Error('Server rejected credentials'), { code: 'unauthorized' })
    const { bridge, apiInvoke } = fakeBridge((operation) => {
      if (operation === 'sessions.list') return Promise.reject(unauthorized)
      return collections([], [], [])(operation)
    })

    render(<ServerCollections bridge={bridge} connection={connection()} />)

    expect(await screen.findByText('SERVER access rejected')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Return to Connection to re-enter the server token.')
    expect(screen.queryByRole('button', { name: 'Retry SERVER data' })).not.toBeInTheDocument()
    expect(apiInvoke).toHaveBeenCalledTimes(4)
  })
})
