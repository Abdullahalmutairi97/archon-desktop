import type { StatusSnapshot } from '../../shared/bridge/types'
import type { LiveScope } from '../live/useLiveServer'
import { formatBytes, OpsHeader, OpsLoadState, useOpsResource } from './shared'

export const STATUS_POLL_MS = 5_000

function Meter({ label, value }: { label: string; value: number }) {
  const clamped = Math.min(100, Math.max(0, value))
  return <div className="ops-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped}>
    <i style={{ inlineSize: `${clamped}%` }} />
  </div>
}

function uptime(seconds: number): string {
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`
}

function Metric({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  return <article className="ops-metric">
    <div className="ops-metric-head"><span>{label}</span><strong>{percent}%</strong></div>
    <Meter label={`${label} usage`} value={percent} />
    <small dir="auto">{detail}</small>
  </article>
}

export function StatusPage({ scope }: { scope: LiveScope }) {
  const { resource, reload } = useOpsResource<StatusSnapshot>(scope, (bridge) => bridge.api.invoke('status.get', {}), STATUS_POLL_MS)
  const data = resource.data
  return <section className="collection-view ops-page" aria-label="Server status">
    <OpsHeader eyebrow="SERVER STATUS" description="Live resource usage from the machine hosting the Archon server. Refreshes every 5 seconds.">
      <button type="button" className="text-button" onClick={reload}>Refresh</button>
    </OpsHeader>
    <OpsLoadState resource={resource} subject="status figures" onRetry={reload} />
    {data && <>
      <div className="ops-host">
        <h3 dir="ltr">{data.hostname}</h3>
        <p dir="ltr">{data.system} {data.kernel} · {data.architecture}</p>
        <p>Uptime {uptime(data.uptime_seconds)}</p>
      </div>
      <div className="ops-metrics">
        <Metric label="CPU" percent={data.cpu.percent} detail={`${data.cpu.cores} cores · load ${data.cpu.load_1.toFixed(2)} / ${data.cpu.load_5.toFixed(2)} / ${data.cpu.load_15.toFixed(2)}`} />
        <Metric label="Memory" percent={data.memory.percent} detail={`${formatBytes(data.memory.used)} of ${formatBytes(data.memory.total)}`} />
        <Metric label="Disk" percent={data.disk.percent} detail={`${formatBytes(data.disk.used)} of ${formatBytes(data.disk.total)} · ${formatBytes(data.disk.free)} free`} />
        <Metric label="Swap" percent={data.swap.percent} detail={`${formatBytes(data.swap.used)} of ${formatBytes(data.swap.total)}`} />
        <Metric label="Archon" percent={data.archon.cpu_percent} detail={`${formatBytes(data.archon.memory_used)} memory (${data.archon.memory_percent}%) · ${data.archon.processes} processes`} />
      </div>
      <p className="ops-note">Disk figures are for <code dir="ltr">{data.disk.path}</code>. Archon usage is measured by {data.archon.accounting === 'systemd-cgroup' ? 'its systemd service cgroup' : 'the server process tree'}.</p>
    </>}
  </section>
}
