# P3 — host isolation evidence (target workstation)

Recorded 2026-09-28 on `archonminipc` (Ubuntu 26.04 LTS, kernel `7.0.0-31-generic`,
x86_64, 16 CPUs, systemd 259.5, user `archonminipc`). This record answers one
question only: **which isolation controls are actually enforceable rootlessly on
this host?** Every claim below was produced by running the listed command on this
host and comparing it with an unrestricted control. Nothing here says that an
Archon-launched process is currently restricted: no runtime or workspace service
runs under an isolation profile yet, so the roadmap gate stays open.

Method: transient `systemd-run --user --scope` units and namespaces only. No
`sudo`, no package install, no persistent unit, no host configuration change.
Each probe was bounded with `timeout`, and the created scopes were collected with
`--collect`.

## What is enforceable here

| Control | Mechanism | Command (abridged) | Observed | Control | Verdict |
| --- | --- | --- | --- | --- | --- |
| CPU | cgroup v2 `cpu.max` | `systemd-run --user --scope -p CPUQuota=20% -- python3 cpu_loop.py` | 4.00 s of CPU work took **20.04 s** wall | same loop, no quota: **4.01 s** wall | ENFORCED |
| Memory | `memory.max` + `memory.swap.max=0` | `systemd-run --user --scope -p MemoryMax=128M -p MemorySwapMax=0 -- python3 mem_hog.py` | process killed, exit **137** | same hog unconstrained: allocates 400 MiB, exit 0 | ENFORCED |
| PID | cgroup v2 `pids.max` | `systemd-run --user --scope -p TasksMax=16 -- python3 fork_many.py` | 16th task refused: `fork refused at 15 errno 11 Resource temporarily unavailable` | unconstrained: `spawned 40 refused 0` | ENFORCED |
| Filesystem | bubblewrap mount namespace | `bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc sh -c 'echo x > /tmp/probe'` | `cannot create ...: Read-only file system` | `bwrap ... --bind /tmp/p3-verify /tmp/p3-verify` writes the same path | ENFORCED |
| Network | bubblewrap network namespace | `bwrap --ro-bind / / ... --unshare-net python3 net_probe.py` | `connect_ex ip: 101` (ENETUNREACH), `dns failed: -3` | unshared control: `connect_ex ip: 0`, DNS resolves | ENFORCED |

The memory control is the same mechanism the backend already uses for workspace
services (`systemd-run --user --scope -p MemoryMax=<n>M -p MemorySwapMax=0`),
which is why that path can be described as enforced rather than requested.

## What is not enforceable, and must not be claimed

- **systemd `--user` sandbox properties are unavailable.** `ProtectHome=yes`,
  `ProtectSystem=strict`, `ReadOnlyPaths=` and `PrivateTmp=yes` all fail with
  `Unknown assignment: <property>` (exit 1) when used in a transient user scope.
  The user manager accepts them syntactically but cannot apply them, so a
  configured value is not evidence of enforcement.
- **`IPAddressDeny=any` is accepted and not enforced.** A scope started with
  `-p IPAddressDeny=any` still completed `connect_ex(("1.1.1.1", 443))` with
  `0`. Never report this property as network isolation on this host.
- **Raw `unshare` is blocked.** `unshare -n` and `unshare --user --map-root-user --net`
  fail with `Operation not permitted`: `kernel.apparmor_restrict_unprivileged_userns = 1`
  and the AppArmor `unprivileged_userns` policy deny the capability.
- **bubblewrap depends on its AppArmor profile.** `bwrap` works here because
  `/etc/apparmor.d/bwrap-userns-restrict` grants the `bwrap` profile `userns`,
  `capability` and `mount`. A host without that profile, or a different bwrap
  binary, can fail; the availability of this mechanism must be probed per host
  rather than assumed.

## Consequences for an Archon isolation profile

- A private network namespace would break the workspace service health probe and
  the preview gateway, which dial the service on host loopback. Network isolation
  for a supervised service therefore needs either a redesigned probe path (probe
  from inside the namespace) or an explicit "no network" service profile that
  also loses the preview route.
- The isolation profile must be probed behaviourally per control. A control that
  the manager accepted is not a control that took effect: `IPAddressDeny` above is
  accepted and ineffective.
- CPU and PID limits are recorded only for the memory case today. `isolation_profile`
  in the workspace database is identity metadata and does not attest any control,
  as its own docstring states.

## Reproduction

```bash
# CPU
systemd-run --user --scope --collect --quiet -p CPUQuota=20% -- /usr/bin/python3 /tmp/p3-verify/cpu_loop.py
# Memory
systemd-run --user --scope --collect --quiet -p MemoryMax=128M -p MemorySwapMax=0 -- /usr/bin/python3 /tmp/p3-verify/mem_hog.py
# PID
systemd-run --user --scope --collect --quiet -p TasksMax=16 -- /usr/bin/python3 /tmp/p3-verify/fork_many.py
# Filesystem
bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc /bin/sh -c 'echo probe > /tmp/p3-verify/probe.txt; echo write-exit=$?'
# Network
bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc --unshare-net /usr/bin/python3 /tmp/p3-verify/net_probe.py
# Refusals
systemd-run --user --scope --collect --quiet -p ProtectHome=yes -- /bin/true
systemd-run --user --scope --collect --quiet -p IPAddressDeny=any -- /usr/bin/python3 /tmp/p3-verify/net_probe.py
```

The scratch scripts above (`cpu_loop.py`, `mem_hog.py`, `fork_many.py`,
`net_probe.py`) live outside the repository, under `/tmp/p3-verify/`.
