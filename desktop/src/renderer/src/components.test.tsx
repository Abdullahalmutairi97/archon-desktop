// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePolling } from './components'

function Probe({ load, interval, onRefresh }: { load: () => Promise<number>; interval: number; onRefresh?: (refresh: () => Promise<void>) => void }) {
  const { data, refresh } = usePolling(load, interval)
  return <><output>{data ?? 'loading'}</output><button onClick={() => void refresh()}>refresh</button></>
}

describe('usePolling', () => {
  afterEach(() => vi.useRealTimers())

  it('does not start overlapping loads when a poll fires during an active request', async () => {
    vi.useFakeTimers()
    let resolve: ((value: number) => void) | undefined
    const load = vi.fn(() => new Promise<number>(done => { resolve = done }))
    render(<Probe load={load} interval={1000} />)
    await act(async () => {})
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => { resolve?.(1); await Promise.resolve() })
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('reloads at the requested interval and stops after unmount', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => load.mock.calls.length)
    const view = render(<Probe load={load} interval={1000} />)
    await act(async () => {})
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('2')).toBeInTheDocument()
    view.unmount()
    await vi.advanceTimersByTimeAsync(2000)
    expect(load).toHaveBeenCalledTimes(2)
  })
})


  it('refresh uses the same in-flight guard as scheduled polls', async () => {
    vi.useFakeTimers()
    let resolve: ((value: number) => void) | undefined
    const load = vi.fn(() => new Promise<number>(done => { resolve = done }))
    const view = render(<Probe load={load} interval={1000} />)
    await act(async () => {})
    await act(async () => { screen.getByText('refresh').click(); await Promise.resolve() })
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => { resolve?.(7); await Promise.resolve() })
    expect(screen.getByText('7')).toBeInTheDocument()
    view.unmount()
  })
