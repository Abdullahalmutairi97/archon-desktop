import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, LocalCodexApprovalDto, LocalCodexEvent, LocalCodexTurnDto } from '../../shared/bridge/types'
import { LocalCodexPanel } from './LocalCodexPanel'

afterEach(cleanup)

const project = { id: 'codex-project:one', name: 'Example project', rootPath: '/work/example' }
const turn: LocalCodexTurnDto = { taskId: 'codex-task:one', projectId: project.id, sessionId: 'codex:one', state: 'running' }
const approval: LocalCodexApprovalDto = {
  approvalId: 'approval:one', taskId: turn.taskId, projectId: project.id, kind: 'command',
  reason: 'Check the requested project', cwd: '/work/example', paths: ['/work/example/a.ts', '/work/example/b.ts'],
  command: 'npm test -- --run',
}
const fileApproval: LocalCodexApprovalDto = {
  approvalId: 'approval:file', taskId: turn.taskId, projectId: project.id, kind: 'file',
  reason: 'Review this exact source change', cwd: '/work/example', paths: ['/work/example/src/file.ts'],
  changes: [{ path: '/work/example/src/file.ts', kind: 'update', diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+<script>alert("x")</script>\n' }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fakeBridge() {
  let listener: ((event: LocalCodexEvent) => void) | undefined
  const unsubscribe = vi.fn(() => { listener = undefined })
  const localCodex = {
    listProjects: vi.fn(async () => [project]),
    registerProject: vi.fn(async () => ({ ...project, id: 'codex-project:two', name: 'Chosen folder', rootPath: '/work/chosen' })),
    startTurn: vi.fn(async (_input: { projectId: string; prompt: string }) => turn),
    cancelTurn: vi.fn(async (_input: { taskId: string }) => true),
    answerApproval: vi.fn(async (_input: { approvalId: string; allow: boolean }) => true),
    subscribe: vi.fn((callback: (event: LocalCodexEvent) => void) => { listener = callback; return unsubscribe }),
  }
  return { bridge: { localCodex } as unknown as DesktopBridge, localCodex, unsubscribe,
    emit: (event: LocalCodexEvent) => act(() => { listener?.(event) }) }
}

async function start() {
  await screen.findByRole('option', { name: 'Example project' })
  fireEvent.change(screen.getByLabelText('Local prompt'), { target: { value: 'Summarize this project.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start Codex turn' }))
}

describe('LocalCodexPanel', () => {
  it('subscribes before starting and displays bounded replacement output and completion', async () => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    expect(fake.localCodex.startTurn).toHaveBeenCalledWith({ projectId: project.id, prompt: 'Summarize this project.' })
    expect(fake.localCodex.subscribe.mock.invocationCallOrder[0]).toBeLessThan(fake.localCodex.startTurn.mock.invocationCallOrder[0])
    fake.emit({ type: 'turn.output', taskId: turn.taskId, text: 'First' })
    fake.emit({ type: 'turn.output', taskId: turn.taskId, text: 'Replacement' })
    expect(screen.getByLabelText('Codex output')).toHaveTextContent('Replacement')
    expect(screen.getByLabelText('Codex output')).not.toHaveTextContent('First')
    fake.emit({ type: 'turn.output', taskId: turn.taskId, text: 'x'.repeat(9000) })
    expect(screen.getByLabelText('Codex output').textContent).toHaveLength(8000)
    fake.emit({ type: 'turn.completed', taskId: turn.taskId })
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('uses the native picker without a renderer path argument', async () => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await screen.findByRole('option', { name: 'Example project' })
    fireEvent.click(screen.getByRole('button', { name: 'Add local project' }))
    expect(await screen.findByRole('option', { name: 'Chosen folder' })).toBeInTheDocument()
    expect(fake.localCodex.registerProject).toHaveBeenCalledWith()
    expect(screen.getByLabelText('Local project')).toHaveValue('codex-project:two')
    expect(screen.getByText('/work/chosen')).toBeInTheDocument()
  })

  it('preserves completion received before the start response', async () => {
    const fake = fakeBridge()
    const pending = deferred<LocalCodexTurnDto>()
    fake.localCodex.startTurn.mockReturnValue(pending.promise)
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    fake.emit({ type: 'turn.output', taskId: turn.taskId, text: 'Early result' })
    fake.emit({ type: 'turn.completed', taskId: turn.taskId })
    await act(async () => { pending.resolve(turn) })
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByLabelText('Codex output')).toHaveTextContent('Early result')
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it.each([true, false])('shows exact approval context and sends explicit allow=%s', async (allow) => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fake.emit({ type: 'approval.requested', approval })
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(approval.reason)
    expect(dialog).toHaveTextContent(approval.cwd)
    for (const path of approval.paths) expect(dialog).toHaveTextContent(path)
    expect(dialog).toHaveTextContent(approval.command!)
    expect(fake.localCodex.answerApproval).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Deny' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: allow ? 'Allow' : 'Deny' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: approval.approvalId, allow })
  })

  it('shows each exact file path, change kind, and escaped diff before allowing', async () => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fake.emit({ type: 'approval.requested', approval: fileApproval })

    const dialog = screen.getByRole('dialog')
    const diff = within(dialog).getByLabelText('Exact diff for /work/example/src/file.ts')
    expect(dialog).toHaveTextContent('Update')
    expect(dialog).toHaveTextContent('/work/example/src/file.ts')
    expect(diff.textContent).toBe(fileApproval.changes![0]!.diff)
    expect(dialog.querySelector('script')).toBeNull()
    expect(fake.localCodex.answerApproval).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: fileApproval.approvalId, allow: true }))
  })

  it('denies a file approval that arrives without diff context', async () => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fake.emit({ type: 'approval.requested', approval: { ...fileApproval, changes: undefined } })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: fileApproval.approvalId, allow: false })
  })

  it('keeps state, subscription and approval portal across navigation', async () => {
    const fake = fakeBridge()
    const view = render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    view.rerender(<LocalCodexPanel bridge={fake.bridge} active={false} />)
    fake.emit({ type: 'turn.output', taskId: turn.taskId, text: 'Still working' })
    fake.emit({ type: 'approval.requested', approval })
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByRole('dialog').closest('.local-codex-panel')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: approval.approvalId, allow: false }))
    view.rerender(<LocalCodexPanel bridge={fake.bridge} active />)
    expect(screen.getByLabelText('Codex output')).toHaveTextContent('Still working')
    expect(fake.localCodex.subscribe).toHaveBeenCalledTimes(1)
    expect(fake.unsubscribe).not.toHaveBeenCalled()
  })

  it('denies pending approval on unmount, including an approval awaiting the start response', async () => {
    const fake = fakeBridge()
    const pending = deferred<LocalCodexTurnDto>()
    fake.localCodex.startTurn.mockReturnValue(pending.promise)
    const view = render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    fake.emit({ type: 'approval.requested', approval })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.unmount()
    expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: approval.approvalId, allow: false })
    expect(fake.unsubscribe).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve(turn) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ignores unrelated events and denies stale or mismatched approvals', async () => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fake.emit({ type: 'turn.output', taskId: 'other-task', text: 'Unrelated output' })
    fake.emit({ type: 'turn.completed', taskId: 'other-task' })
    fake.emit({ type: 'approval.requested', approval: { ...approval, projectId: 'other-project' } })
    expect(screen.queryByText('Unrelated output')).not.toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: approval.approvalId, allow: false })
  })

  it('clears approval on terminal events and ignores later output or conflicting terminal events', async () => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fake.emit({ type: 'approval.requested', approval })
    fake.emit({ type: 'turn.completed', taskId: turn.taskId })
    fake.emit({ type: 'turn.failed', taskId: turn.taskId, message: 'Late failure' })
    fake.emit({ type: 'turn.output', taskId: turn.taskId, text: 'Late output' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Late output')).not.toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: approval.approvalId, allow: false })
  })

  it('waits for cancellation confirmation from an event', async () => {
    const fake = fakeBridge()
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel turn' }))
    await waitFor(() => expect(fake.localCodex.cancelTurn).toHaveBeenCalledWith({ taskId: turn.taskId }))
    expect(screen.getByText('Cancellation requested')).toBeInTheDocument()
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument()
    fake.emit({ type: 'turn.cancelled', taskId: turn.taskId })
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
  })

  it('bounds the prompt and blocks duplicate starts while the outcome is unknown', async () => {
    const fake = fakeBridge()
    fake.localCodex.startTurn.mockRejectedValue(new Error('Native transport disconnected'))
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await screen.findByRole('option', { name: 'Example project' })
    fireEvent.change(screen.getByLabelText('Local prompt'), { target: { value: 'x'.repeat(9000) } })
    expect(screen.getByLabelText('Local prompt')).toHaveValue('x'.repeat(8000))
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex turn' }))
    expect(await screen.findByText('Start outcome unknown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start Codex turn' })).toBeDisabled()
    expect(fake.localCodex.startTurn).toHaveBeenCalledOnce()
  })

  it('shows safe start failure text and sign-in guidance without retrying', async () => {
    const fake = fakeBridge()
    fake.localCodex.startTurn.mockRejectedValue(new Error('Codex requires sign-in.'))
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    expect(await screen.findByRole('alert')).toHaveTextContent('Codex requires sign-in.')
    expect(screen.getByRole('alert')).toHaveTextContent('codex login')
    expect(fake.localCodex.startTurn).toHaveBeenCalledOnce()
  })

  it('allows an explicit reset after an unknown outcome without resubmitting', async () => {
    const fake = fakeBridge()
    fake.localCodex.startTurn.mockRejectedValue(new Error('Codex CLI is unavailable.'))
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    expect(await screen.findByRole('alert')).toHaveTextContent('Install the Codex CLI')
    fireEvent.click(screen.getByRole('button', { name: 'Reset after checking' }))
    expect(screen.getByRole('button', { name: 'Start Codex turn' })).toBeEnabled()
    expect(fake.localCodex.startTurn).toHaveBeenCalledOnce()
  })

  it('denies a visible approval when closed or unmounted', async () => {
    const fake = fakeBridge()
    const view = render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fake.emit({ type: 'approval.requested', approval })
    fireEvent.click(screen.getByRole('button', { name: 'Close and deny approval' }))
    expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: approval.approvalId, allow: false })
    fake.emit({ type: 'approval.requested', approval: { ...approval, approvalId: 'approval:two' } })
    view.unmount()
    expect(fake.localCodex.answerApproval).toHaveBeenCalledWith({ approvalId: 'approval:two', allow: false })
  })

  it('does not let an old cancellation response overwrite a newer turn', async () => {
    const fake = fakeBridge()
    const cancel = deferred<boolean>()
    fake.localCodex.cancelTurn.mockReturnValue(cancel.promise)
    render(<LocalCodexPanel bridge={fake.bridge} active />)
    await start()
    await screen.findByText('Running')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel turn' }))
    fake.emit({ type: 'turn.cancelled', taskId: turn.taskId })
    const next = { ...turn, taskId: 'codex-task:two' }
    fake.localCodex.startTurn.mockResolvedValue(next)
    fireEvent.click(screen.getByRole('button', { name: 'Start Codex turn' }))
    await screen.findByText('Running')
    await act(async () => { cancel.resolve(false) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(next.taskId)).toBeInTheDocument()
  })

  it('shows an offline browser preview without an injected desktop bridge', () => {
    render(<LocalCodexPanel active />)
    expect(screen.getByText('Desktop connection unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start Codex turn' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add local project' })).toBeDisabled()
  })
})
