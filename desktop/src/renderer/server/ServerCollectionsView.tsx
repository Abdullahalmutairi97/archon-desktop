import { useEffect, useState } from 'react'
import type { ConnectionDescription, DesktopBridge, LocalCodexProjectDto } from '../../shared/bridge/types'
import { ServerCollections } from './ServerCollections'

/** Resolve the current connection each time this route opens; no server rows are cached across routes. */
export function ServerCollectionsView({
  bridge,
  onLocalCodexProjectRegistered,
}: {
  bridge?: DesktopBridge
  onLocalCodexProjectRegistered?: (project: LocalCodexProjectDto) => void
}) {
  const [description, setDescription] = useState<ConnectionDescription | null>(null)
  const [checking, setChecking] = useState(Boolean(bridge))

  useEffect(() => {
    if (!bridge) return
    let active = true
    void bridge.connection.describe().then((value) => {
      if (active) setDescription(value)
    }).catch(() => {
      if (active) setDescription(null)
    }).finally(() => {
      if (active) setChecking(false)
    })
    return () => { active = false }
  }, [bridge])

  if (checking) {
    return <section className="server-collections" aria-label="Server collections"><p className="server-collections-message">Checking the desktop connection…</p></section>
  }
  return <ServerCollections bridge={bridge} connection={description} onLocalCodexProjectRegistered={onLocalCodexProjectRegistered} />
}
