import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { ArchonApi } from '../lib/api'

export function TerminalViewport({ api, name, compact = false }: { api: ArchonApi; name: string; compact?: boolean }) {
  const mount = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mount.current) return
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: compact ? 12 : 14,
      fontFamily: 'JetBrains Mono, DejaVu Sans Mono, monospace',
      scrollback: 5000,
      theme: { background: '#0a0d13', foreground: '#dfe5f2', cursor: '#cfc9c1' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(mount.current)
    fit.fit()
    const socket = api.terminalSocket(name)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      socket.send(JSON.stringify({ token: api.token }))
      socket.send(JSON.stringify({ resize: { cols: terminal.cols, rows: terminal.rows } }))
    }
    socket.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data)
          if (message.error) terminal.writeln(`\r\n[${message.error}]`)
          else terminal.write(event.data)
        } catch { terminal.write(event.data) }
      } else if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data))
      else if (event.data instanceof Blob) terminal.write(new Uint8Array(await event.data.arrayBuffer()))
    }
    socket.onerror = () => terminal.writeln('\r\n[connection interrupted — tmux session is still running]')
    const input = terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(data) })
    const resize = new ResizeObserver(() => {
      fit.fit()
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ resize: { cols: terminal.cols, rows: terminal.rows } }))
    })
    resize.observe(mount.current)
    return () => { resize.disconnect(); input.dispose(); socket.close(); terminal.dispose() }
  }, [api, compact, name])

  return <div className={`terminal-viewport ${compact ? 'compact' : ''}`} ref={mount}/>
}
