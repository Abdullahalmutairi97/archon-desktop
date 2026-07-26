import type { Backup, ChatMessage, ConnectionConfig, CronJob, FileItem, HermesSession, LogEntry, ModelCatalog, Project, Skill, SpeechResult, Task, TaskEvent, TerminalSession, TranscriptionResult, VoiceStatus } from './types'

export class ArchonApi {
  readonly serverUrl: string
  readonly token: string
  constructor(config: ConnectionConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '')
    this.token = config.token
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => { headers[key] = value })
    headers.Authorization = `Bearer ${this.token}`
    if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json'
    const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers })
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`
      try { message = (await response.json()).detail || message } catch { /* response was not JSON */ }
      throw new Error(message)
    }
    return response.json() as Promise<T>
  }

  health() { return fetch(`${this.serverUrl}/api/health`).then(async (r) => { if (!r.ok) throw new Error('Server unavailable'); return r.json() }) }
  server() { return this.request<{ profile: string; archon_root: string; hermes_home: string }>('/api/server') }
  async listTasks() { return (await this.request<{ tasks: Task[] }>('/api/tasks')).tasks }
  async createTask(payload: { prompt: string; cwd?: string; model?: string; provider?: string; session_id?: string; approval_mode?: 'auto' | 'approve' | 'plan'; chat_only?: boolean; skills: string[] }) { return (await this.request<{ task: Task }>('/api/tasks', { method: 'POST', body: JSON.stringify(payload) })).task }
  async taskEvents(id: string, after = 0) { return (await this.request<{ events: TaskEvent[] }>(`/api/tasks/${id}/events?after=${after}`)).events }
  async streamEvents(after: number, onEvent: (event: TaskEvent) => void, signal?: AbortSignal): Promise<number> {
    const response = await fetch(`${this.serverUrl}/api/events?after=${after}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal,
    })
    if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let cursor = after
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim()
        if (!data) continue
        const event = JSON.parse(data) as TaskEvent
        cursor = Math.max(cursor, event.seq)
        onEvent(event)
      }
      if (done) break
    }
    return cursor
  }
  cancelTask(id: string) { return this.request(`/api/tasks/${id}/cancel`, { method: 'POST' }) }
  status() { return this.request<Record<string, any>>('/api/status') }
  async logs(sources: string[] = [], level = '', limit = 1000) { const query = new URLSearchParams({ limit: String(limit) }); if (sources.length) query.set('sources', sources.join(',')); if (level) query.set('level', level); return (await this.request<{ logs: LogEntry[] }>(`/api/logs?${query}`)).logs }
  audioStatus() { return this.request<VoiceStatus>('/api/audio/status') }
  async transcribeAudio(audio: Blob) { const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error || new Error('Could not read microphone audio')); reader.onload = () => resolve(String(reader.result || '')); reader.readAsDataURL(audio) }); return this.request<TranscriptionResult>('/api/audio/transcribe', { method: 'POST', body: JSON.stringify({ data_url: dataUrl, mime_type: audio.type }) }) }
  speakText(text: string) { return this.request<SpeechResult>('/api/audio/speak', { method: 'POST', body: JSON.stringify({ text }) }) }
  models() { return this.request<ModelCatalog>('/api/models') }
  async projects() { return (await this.request<{ projects: Project[] }>('/api/projects')).projects }
  async sessions(projectId?: string) { const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''; return (await this.request<{ sessions: HermesSession[] }>(`/api/sessions${query}`)).sessions }
  async sessionMessages(id: string) { return (await this.request<{ messages: ChatMessage[] }>(`/api/sessions/${encodeURIComponent(id)}/messages`)).messages }
  setModel(provider: string, model: string) { return this.request('/api/models/default', { method: 'PUT', body: JSON.stringify({ provider, model }) }) }
  async skills() { return (await this.request<{ skills: Skill[] }>('/api/skills')).skills }
  inspectSkill(name: string) { return this.request<Skill>(`/api/skills/${encodeURIComponent(name)}`) }
  toggleSkill(name: string, enabled: boolean) { return this.request<Skill>('/api/skills/toggle', { method: 'PUT', body: JSON.stringify({ name, enabled }) }) }
  async files(path = '.') { return (await this.request<{ items: FileItem[] }>(`/api/files?path=${encodeURIComponent(path)}`)).items }
  readFile(path: string) { return this.request<{ content: string; size: number }>(`/api/files/read?path=${encodeURIComponent(path)}`) }
  writeFile(path: string, content: string) { return this.request('/api/files/text', { method: 'PUT', body: JSON.stringify({ path, content }) }) }
  deleteFile(path: string, confirm: boolean) { return this.request('/api/files', { method: 'DELETE', body: JSON.stringify({ path, confirm }) }) }
  async uploadFile(path: string, file: File) { const form = new FormData(); form.set('upload', file); return this.request<{ path: string; size: number }>(`/api/files/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: form }) }
  async downloadFile(path: string) { const response = await fetch(`${this.serverUrl}/api/files/download?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${this.token}` } }); if (!response.ok) throw new Error('Download failed'); return response.blob() }
  async backups() { return (await this.request<{ backups: Backup[] }>('/api/backups')).backups }
  createBackup(confirm: boolean) { return this.request('/api/backups', { method: 'POST', body: JSON.stringify({ confirm }) }) }
  inspectBackup(source: string) { return this.request<{ contents: string }>('/api/backups/inspect', { method: 'POST', body: JSON.stringify({ source }) }) }
  restoreBackup(source: string, paths: string[], all_files: boolean, confirm: boolean) { return this.request('/api/backups/restore', { method: 'POST', body: JSON.stringify({ source, paths, all_files, confirm }) }) }
  backupSchedule() { return this.request<Record<string, string>>('/api/backups/schedule') }
  setBackupSchedule(calendar: string, confirm: boolean) { return this.request('/api/backups/schedule', { method: 'PUT', body: JSON.stringify({ calendar, confirm }) }) }
  async cronJobs() { return (await this.request<{ jobs: CronJob[] }>('/api/cron')).jobs }
  createCron(payload: Record<string, unknown>) { return this.request('/api/cron', { method: 'POST', body: JSON.stringify(payload) }) }
  editCron(id: string, fields: Record<string, unknown>, confirm: boolean) { return this.request(`/api/cron/${id}`, { method: 'PUT', body: JSON.stringify({ fields, confirm }) }) }
  cronAction(id: string, action: string, confirm: boolean) { return this.request(`/api/cron/${id}/action`, { method: 'POST', body: JSON.stringify({ action, confirm }) }) }
  migrationManifest() { return this.request<Record<string, unknown>>('/api/migration/manifest') }
  async terminals() { return (await this.request<{ terminals: TerminalSession[] }>('/api/terminals')).terminals }
  createTerminal(label: string, cwd = '.') { return this.request<TerminalSession>('/api/terminals', { method: 'POST', body: JSON.stringify({ label, cwd }) }) }
  killTerminal(name: string, confirm: boolean) { return this.request(`/api/terminals/${encodeURIComponent(name)}`, { method: 'DELETE', body: JSON.stringify({ confirm }) }) }
  terminalSocket(name: string) { const url = new URL(this.serverUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = `/api/terminals/${encodeURIComponent(name)}/ws`; return new WebSocket(url) }
}
