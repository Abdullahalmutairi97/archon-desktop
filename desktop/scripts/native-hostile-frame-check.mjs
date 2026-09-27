#!/usr/bin/env node
// Native hostile-frame check for the packaged or built Archon Desktop app.
//
// It launches the real Electron app with an isolated user-data profile and uses
// the DevTools protocol to try the frame/IPC escapes a hostile embedded frame
// would attempt. Unit tests with jsdom cannot show that the preload bridge is
// absent from a subframe or that a new window is refused; this runs the actual
// Electron binary.
//
// The Chromium OS sandbox is a separate gate. This host cannot provide one
// (chrome-sandbox is not setuid root and the AppArmor policy blocks
// unprivileged user namespaces), so the harness first tries the sandbox-intact
// launch, records that failure verbatim, and only then re-runs the
// application-level checks with --no-sandbox. A disabled sandbox proves nothing
// about OS sandboxing, and the report says so.
//
// Usage:
//   node scripts/native-hostile-frame-check.mjs --app <app dir> --electron <electron binary> \
//     --report <json path> [--timeout-ms 90000]

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SANDBOX_FATAL_MARKERS = [
  'The SUID sandbox helper binary was found, but is not configured correctly',
  'No usable sandbox!',
]

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) args[key] = true
    else { args[key] = value; index += 1 }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const appPath = resolve(String(args.app || ''))
const electronPath = resolve(String(args.electron || ''))
const reportPath = resolve(String(args.report || 'native-hostile-frame-report.json'))
const timeoutMs = Number(args['timeout-ms'] || 90000)
const keepProfile = args['keep-profile'] === true

if (!appPath || !electronPath || args.app === true || args.electron === true) {
  console.error('usage: native-hostile-frame-check.mjs --app <app dir> --electron <electron binary> --report <json path>')
  process.exit(2)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function launchOptions(debuggingPort, extraArgs) {
  const electronArgs = [
    appPath,
    `--remote-debugging-port=${debuggingPort}`,
    '--no-first-run',
    ...extraArgs,
  ]
  if (process.env.DISPLAY) {
    return { command: electronPath, args: electronArgs, wrapper: null }
  }
  return { command: 'xvfb-run', args: ['-a', electronPath, ...electronArgs], wrapper: 'xvfb-run -a' }
}

// Electron derives the app profile from $XDG_CONFIG_HOME, not from Chromium's
// --user-data-dir switch, so the fixture root must be supplied through the XDG
// environment. Otherwise the run would write into the operator's real profile.
function fixtureEnvironment(root) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    TMPDIR: join(root, 'tmp'),
    ELECTRON_ENABLE_LOGGING: '1',
  }
}

function startApp(debuggingPort, extraArgs, environment) {
  const options = launchOptions(debuggingPort, extraArgs)
  const child = spawn(options.command, options.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  const output = []
  const record = (chunk) => {
    const text = String(chunk)
    output.push(text)
    if (output.length > 400) output.shift()
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  return { child, output, wrapper: options.wrapper, command: options.command }
}

async function waitForTargets(port, deadline, output) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const list = await response.json()
        const page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (page) return { list, page }
      }
    } catch {
      // not listening yet
    }
    await delay(300)
  }
  throw new Error('the app exposed no page target within the deadline: ' + output.join('').slice(-600))
}

function connect(url) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => rejectSocket(new Error('devtools socket timed out')), 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolveSocket(socket) })
    socket.addEventListener('error', () => { clearTimeout(timer); rejectSocket(new Error('devtools socket failed')) })
  })
}

function makeClient(socket) {
  let nextId = 0
  const events = []
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (data.id === undefined && data.method) events.push(data)
  })
  function call(method, params, sessionId) {
    const id = ++nextId
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        socket.removeEventListener('message', onMessage)
        rejectCall(new Error(method + ' timed out'))
      }, 15000)
      const onMessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.id !== id) return
        clearTimeout(timer)
        socket.removeEventListener('message', onMessage)
        if (data.error) rejectCall(new Error(method + ': ' + JSON.stringify(data.error)))
        else resolveCall(data.result)
      }
      socket.addEventListener('message', onMessage)
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  return { call, events }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'archon-native-frame-'))
  for (const directory of ['config', 'cache', 'data', 'state', 'tmp']) {
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 })
  }
  const environment = fixtureEnvironment(root)
  const realConfigRoot = join(homedir(), '.config')
  const before = snapshotDirectoryEntries(realConfigRoot)
  const report = {
    format: 'archon-desktop-native-hostile-frame-check',
    version: 1,
    startedAt: new Date().toISOString(),
    app: appPath,
    electron: electronPath,
    wrappers: {},
    sandbox: { state: 'unknown', detail: null },
    checks: [],
    limits: [
      'Application-level frame and IPC guards only. These checks say nothing about the Chromium OS sandbox when it is disabled to run them.',
      'Launching Electron proves nothing about Windows/macOS behaviour or about the frozen v0.3.0 baseline.',
    ],
  }

  // 1. Sandbox-intact attempt. A host without a usable sandbox must be recorded,
  //    not worked around silently.
  const strictPort = await freePort()
  const strict = startApp(strictPort, [], environment)
  const strictDeadline = Date.now() + 25000
  let strictFailure = null
  let strictPage = null
  try {
    strictPage = await waitForTargets(strictPort, strictDeadline, strict.output)
  } catch (error) {
    strictFailure = error
  }
  const strictOutput = strict.output.join('')
  if (strictPage) {
    report.sandbox = { state: 'available', detail: 'the app exposed a page target with the OS sandbox intact' }
  } else {
    const marker = SANDBOX_FATAL_MARKERS.find((text) => strictOutput.includes(text))
    report.sandbox = {
      state: marker ? 'blocked-on-host' : 'launch-failed',
      detail: marker || (strictFailure ? String(strictFailure.message).slice(0, 600) : 'unknown launch failure'),
      sandboxOutput: strictOutput.slice(-1200),
    }
  }
  strict.child.kill('SIGKILL')
  await delay(500)

  // 2. Application-level checks. Only reached with the sandbox disabled, and the
  //    report records that this run cannot speak to OS sandboxing.
  const runPort = await freePort()
  const run = startApp(runPort, ['--no-sandbox'], environment)
  report.sandbox.applicationChecksSandboxDisabled = true
  report.wrappers.appLaunch = run.wrapper
  const { list, page } = await waitForTargets(runPort, Date.now() + timeoutMs, run.output)
  report.pageUrl = page.url
  report.targetCount = list.length

  const socket = await connect(page.webSocketDebuggerUrl)
  const { call, events } = makeClient(socket)
  await call('Runtime.enable', {})
  await call('Page.enable', {})
  await call('DOM.enable', {})
  await call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

  async function evaluate(expression, contextId, sessionId) {
    const result = await call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
      ...(contextId === undefined ? {} : { contextId }),
    }, sessionId)
    if (result.exceptionDetails) {
      throw new Error('evaluation failed: ' + (result.exceptionDetails.exception?.description || 'exception'))
    }
    return result.result.value
  }

  // Read a frame's own script engine through its default execution context. The
  // shell page enforces a content security policy that blocks inline scripts, so
  // the frame cannot run a probe of its own; evaluating inside the frame context
  // is the native equivalent and proves the frame executed script at all.
  async function probeFrame(elementId) {
    const document = await call('DOM.getDocument', { depth: -1 })
    const found = await call('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#' + elementId })
    if (!found.nodeId) return { context: 'missing-element' }
    const described = await call('DOM.describeNode', { nodeId: found.nodeId, depth: 1, pierce: true })
    const frameId = described.node.frameId || described.node.contentDocument?.frameId
    if (!frameId) return { context: 'no-frame-id' }
    const created = events.filter((event) => event.method === 'Runtime.executionContextCreated')
      .map((event) => event.params.context)
      .filter((context) => context.auxData?.frameId === frameId && context.auxData?.isDefault === true)
    if (created.length === 0) return { context: 'none', frameId }
    const context = created[created.length - 1]
    const observed = await evaluate(
      'JSON.stringify({ bridge: typeof window.archon, require: typeof window.require,'
      + ' process: typeof window.process, origin: String(window.origin) })',
      context.id,
    )
    return { context: 'present', frameId, observed: JSON.parse(observed) }
  }

  function record(name, expected, observed, passed) {
    report.checks.push({ name, expected, observed, passed })
  }

  const globals = JSON.parse(await evaluate(
    'JSON.stringify({ require: typeof window.require, module: typeof window.module, process: typeof window.process, bridge: typeof window.archon })',
  ))
  record('renderer has no node integration',
    'require/module/process are undefined',
    JSON.stringify(globals),
    globals.require === 'undefined' && globals.module === 'undefined' && globals.process === 'undefined')

  const bridge = JSON.parse(await evaluate('JSON.stringify(Object.keys(window.archon || {}))'))
  record('the trusted top frame exposes the preload bridge',
    'the top frame sees the Archon bridge namespaces',
    JSON.stringify(bridge),
    Array.isArray(bridge) && bridge.length > 0)

  // Native credential storage: drive the real preload bridge so the run uses the
  // real Electron safeStorage backend and the real credential store, then look
  // at the profile on disk. A mock of safeStorage cannot qualify this gate.
  const probeToken = process.env.ARCHON_NATIVE_PROBE_TOKEN || ''
  if (probeToken) {
    const asJson = (value) => JSON.stringify(value)
    const describeBefore = JSON.parse(await evaluate('window.archon.connection.describe().then((r) => JSON.stringify(r))'))
    const saved = JSON.parse(await evaluate(
      'window.archon.connection.save({ serverUrl: "http://127.0.0.1:6553", token: '
      + JSON.stringify(probeToken) + ' }).then((r) => JSON.stringify(r))'))
    const recordFile = findCredentialRecord(root, probeToken)
    const disconnected = JSON.parse(await evaluate('window.archon.connection.disconnect().then((r) => JSON.stringify(r))'))
    const recordAfterDisconnect = findCredentialRecord(root, probeToken)
    const savedDescription = saved?.description ?? {}
    const storageMode = savedDescription.storageMode
    report.credentialStorage = { describeBefore, saved, recordFile, disconnected, recordAfterDisconnect }
    // A protected backend persists ciphertext; a host without one must degrade to
    // memory-only and write nothing. The keyring gate itself is qualified only
    // when the protected backend is the one Electron selected.
    report.keyring = {
      storageMode: storageMode ?? 'unknown',
      qualification: storageMode === 'protected' ? 'qualified' : 'blocked-on-host',
      detail: storageMode === 'protected'
        ? 'Electron selected a protected Linux backend and the credential was persisted as ciphertext'
        : 'Electron selected no protected Linux backend here, so the credential stayed in main-process memory and nothing was written to the profile',
      limit: 'The concrete safeStorage backend identifier is main-process state and is not exposed to this harness; this record reports the observed storage mode and the on-disk result.',
    }
    record('the credential is genuinely protected or memory-only',
      'protected mode keeps a ciphertext record with no plaintext; memory mode stores nothing',
      asJson({ storageMode: storageMode ?? null, recordFile }),
      (storageMode === 'protected' && recordFile.present === true && recordFile.containsPlaintext === false)
        || (storageMode === 'memory' && recordFile.present === false))
    record('disconnect removes the stored credential record',
      'no credential record file remains after disconnect',
      asJson(recordAfterDisconnect),
      recordAfterDisconnect.present === false,
    )
  } else {
    report.credentialStorage = { skipped: 'no ARCHON_NATIVE_PROBE_TOKEN was provided' }
  }

  // Two hostile-frame shapes: a same-origin embedded frame (injected content in
  // the shell document) and an opaquely sandboxed frame. Both are read through
  // their own execution context, so the check does not rely on cross-origin
  // property access.
  await evaluate(`(() => {
    const frame = document.createElement('iframe')
    frame.id = 'archon-hostile-same-origin-probe'
    frame.srcdoc = '<html><body>probe</body></html>'
    document.body.appendChild(frame)
    return true
  })()`)
  await delay(600)
  const sameOriginFrame = await probeFrame('archon-hostile-same-origin-probe')
  record('an embedded same-origin frame cannot reach the privileged bridge',
    'the frame has a live script context that sees no bridge and no node globals',
    JSON.stringify(sameOriginFrame),
    sameOriginFrame.context === 'present'
      && sameOriginFrame.observed.bridge === 'undefined'
      && sameOriginFrame.observed.require === 'undefined'
      && sameOriginFrame.observed.process === 'undefined')

  await evaluate(`(() => {
    const frame = document.createElement('iframe')
    frame.id = 'archon-hostile-sandboxed-probe'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.srcdoc = '<html><body>probe</body></html>'
    document.body.appendChild(frame)
    return true
  })()`)
  await delay(600)
  // An opaquely sandboxed srcdoc frame is an out-of-process frame: Chromium
  // gives it its own target, so its script is read through an attached session
  // rather than through the shell page.
  const attachedFrames = events
    .filter((event) => event.method === 'Target.attachedToTarget')
    .map((event) => ({ sessionId: event.params.sessionId, info: event.params.targetInfo }))
    .filter((entry) => entry.info.type === 'iframe')
  let sandboxedFrame = { attachedTargets: attachedFrames.length, context: 'none' }
  if (attachedFrames.length > 0) {
    const entry = attachedFrames[attachedFrames.length - 1]
    await call('Runtime.enable', {}, entry.sessionId)
    const observed = JSON.parse(await evaluate(
      'JSON.stringify({ bridge: typeof window.archon, require: typeof window.require,'
      + ' process: typeof window.process, origin: String(window.origin) })',
      undefined,
      entry.sessionId,
    ))
    sandboxedFrame = {
      attachedTargets: attachedFrames.length,
      targetUrl: entry.info.url,
      targetType: entry.info.type,
      context: 'present',
      observed,
    }
  }
  record('an opaquely sandboxed frame cannot reach the privileged bridge',
    'the frame is a separate target in an opaque origin and sees no bridge',
    JSON.stringify(sandboxedFrame),
    sandboxedFrame.context === 'present'
      && sandboxedFrame.observed.bridge === 'undefined'
      && sandboxedFrame.observed.require === 'undefined'
      && sandboxedFrame.observed.process === 'undefined'
      && sandboxedFrame.observed.origin === 'null')

  const newWindow = JSON.parse(await evaluate(`(async () => {
    const opened = window.open('https://example.com/archon-native-probe', '_blank')
    await new Promise((resolveWait) => setTimeout(resolveWait, 700))
    return JSON.stringify({ opened: opened === null ? 'null' : 'object' })
  })()`))
  await delay(600)
  const afterOpen = await (await fetch(`http://127.0.0.1:${runPort}/json/list`)).json()
  const extra = afterOpen.filter((target) => target.url.includes('example.com'))
  record('a new remote window is refused',
    'window.open returns null and opens no remote target',
    JSON.stringify({
      opened: newWindow.opened,
      targets: afterOpen.map((target) => target.type + ':' + target.url),
      remoteTargets: extra.length,
    }),
    newWindow.opened === 'null' && extra.length === 0)

  const beforeNavigation = page.url
  const navigation = JSON.parse(await evaluate(`(async () => {
    let blocked = false
    try { window.location.assign('https://example.com/archon-native-probe') } catch (error) { blocked = true }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200))
    return JSON.stringify({ blocked, url: window.location.href })
  })()`))
  record('the shell frame cannot navigate to a remote origin',
    'the documented shell URL stays loaded',
    JSON.stringify({ before: beforeNavigation, after: navigation.url }),
    navigation.url === beforeNavigation)

  // A top-level navigation attempt must also revoke the frame's IPC trust, so
  // the shell fails closed instead of keeping privileged access after a redirect.
  const lockdown = await evaluate(
    'window.archon.connection.describe().then(() => "allowed").catch((error) => "refused:" + String(error && error.message))',
  )
  report.lockdown = lockdown
  record('a remote navigation attempt revokes the frame IPC trust',
    'privileged IPC is refused after the navigation attempt',
    JSON.stringify(lockdown),
    typeof lockdown === 'string' && lockdown.startsWith('refused:'))

  const storage = JSON.parse(await evaluate(`JSON.stringify({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    indexedDb: typeof indexedDB === 'object',
  })`))
  const storageText = JSON.stringify(storage).toLowerCase()
  record('renderer storage carries no credential',
    'no stored key or value looks like a bearer token',
    JSON.stringify(storage),
    !storageText.includes('token') && !storageText.includes('bearer') && !storageText.includes('credential'))

  socket.close()
  run.child.kill('SIGKILL')
  await delay(300)

  report.pageUrlAfter = navigation.url
  await delay(700)
  const scanned = scanProfileForToken(root)
  report.profileScan = scanned
  record('the app profile was written inside the isolated fixture root',
    'the fixture config/data roots hold the app profile files',
    JSON.stringify({ files: scanned.files, roots: scanned.roots }),
    scanned.files > 0)
  record('no plaintext probe token is stored under the fixture root',
    'no profile file contains the fake token',
    JSON.stringify({ plaintextHits: scanned.plaintextHits, tokenChecked: scanned.tokenChecked }),
    scanned.tokenChecked === true && scanned.plaintextHits === 0)

  const after = snapshotDirectoryEntries(realConfigRoot)
  const changed = Object.keys(after).filter((name) => before[name] !== after[name])
  const added = Object.keys(after).filter((name) => !(name in before))
  report.realConfigRoot = realConfigRoot
  record('the run did not write into the real user config root',
    'no entry under the real ~/.config changes or appears during the run',
    JSON.stringify({ changed, added }),
    changed.length === 0 && added.length === 0)

  report.passed = report.checks.every((check) => check.passed)
  report.finishedAt = new Date().toISOString()
  mkdirSync(resolve(reportPath, '..'), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  if (!keepProfile) rmSync(root, { recursive: true, force: true })

  for (const check of report.checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.observed}`)
  }
  console.log(`sandbox gate: ${report.sandbox.state}`)
  console.log(`report: ${reportPath}`)
  process.exit(report.passed ? 0 : 1)
}

// The fake token is passed by the caller through the environment so the harness
// never writes a real credential anywhere.
function snapshotDirectoryEntries(directory) {
  const snapshot = {}
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      try {
        const info = statSync(join(directory, entry.name))
        snapshot[entry.name] = `${Math.round(info.mtimeMs)}:${info.size}`
      } catch {
        snapshot[entry.name] = 'unreadable'
      }
    }
  } catch {
    return {}
  }
  return snapshot
}

// Locate the on-disk credential record the store writes, and report whether the
// plaintext token appears in it.
function findCredentialRecord(root, token) {
  const marker = 'archon-desktop-connection-credential'
  const found = { present: false, path: null, containsPlaintext: null, bytes: 0 }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile()) continue
      try {
        const info = statSync(path)
        if (info.size > 8 * 1024 * 1024) continue
        const bytes = readFileSync(path)
        if (!bytes.includes(marker)) continue
        found.present = true
        found.path = path.slice(root.length + 1)
        found.bytes = bytes.length
        found.containsPlaintext = token ? bytes.includes(token) : null
      } catch {
        // unreadable entries are ignored
      }
    }
  }
  try {
    walk(root)
  } catch (error) {
    found.error = String(error).slice(0, 160)
  }
  return found
}

function scanProfileForToken(root) {
  const token = process.env.ARCHON_NATIVE_PROBE_TOKEN || ''
  const roots = {}
  let files = 0
  let plaintextHits = 0
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.isFile()) continue
      files += 1
      if (!token) continue
      try {
        if (statSync(path).size > 8 * 1024 * 1024) continue
        if (readFileSync(path).includes(token)) plaintextHits += 1
      } catch {
        // unreadable entries are counted as files only
      }
    }
  }
  for (const name of ['config', 'data', 'state']) {
    const directory = join(root, name)
    let count = 0
    try {
      const before = files
      walk(directory)
      count = files - before
    } catch (error) {
      roots[name] = `unreadable: ${String(error).slice(0, 80)}`
      continue
    }
    roots[name] = count
  }
  return { files, plaintextHits, roots, tokenChecked: token.length > 0 }
}

main().catch((error) => {
  console.error('native hostile-frame check failed:', error)
  process.exit(1)
})
