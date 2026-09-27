# Version policy

The official Archon Desktop release is **v0.3.0**, selected from the verified installed build and represented by the active `current/` reconstruction kit. A higher number from an old local build does not make that build the current release.

The frozen v0.3.0 input archive has SHA-256 `36d3ae03bd6b20c4e9ea5fc690461ef972b16eb0c9433bfb1305daeb068e549b`. The candidate builder applies the Browser, IDE, Codex, connection, and collaboration patches to that input. Candidate artifacts are app payloads and are kept outside Git.

The Python backend has its independent package version (`0.2.0`). It is shared by configured clients and is not renumbered when the desktop release changes.

Old desktop source trees, design snapshots, launchers, and dated operational reports were removed from the repository because they were not used by the active build. Their commits remain in Git history for provenance.

## Authored reconstruction channel

The `desktop/` source build uses **0.3.0-reconstruction.2**, a separate development identity and an isolated user-data namespace. It does not replace or renumber the official v0.3.0 baseline. Build metadata records the source revision and `baselineParity: unverified`. Automatic update/install is disabled in this route.

P2A builds an authored synthetic reference shell without the private ASAR. P2B.1 adds the trusted read-only bridge and memory-only backend transport under fake-service checks. Later P2B/C increments add profile storage, local Codex and complete feature integration; P2D separately qualifies native behavior, protected credential storage, packaging and recovery. A successful source build alone does not authorize a new official baseline or installer release.
