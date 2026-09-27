// Drive the installed Prime Agent session-lease implementation directly.
//
// Modes: acquire (take and release), acquire-hold (take and stay alive until
// killed), try (report ACQUIRED or REFUSED without failing the process).
import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV } from '/home/archonminipc/.local/lib/node_modules/prime-agent/dist/core/session-lease.js'

const [sessionPath, agentDir, mode] = process.argv.slice(2)
process.env[SESSION_LEASES_ENABLED_ENV] = '1'

if (mode === 'acquire-hold') {
  const lease = acquireSessionLease(sessionPath, agentDir)
  console.log('ACQUIRED ' + (lease ? lease.directory : 'none'))
  process.stdin.resume()
} else if (mode === 'acquire') {
  const lease = acquireSessionLease(sessionPath, agentDir)
  console.log('ACQUIRED ' + (lease ? lease.directory : 'none'))
  if (lease) lease.release()
  console.log('RELEASED')
} else {
  try {
    const lease = acquireSessionLease(sessionPath, agentDir)
    console.log('ACQUIRED ' + (lease ? lease.directory : 'none'))
    if (lease) lease.release()
  } catch (error) {
    console.log('REFUSED ' + error.name + ' ' + error.code + ' ' + error.message)
  }
}
