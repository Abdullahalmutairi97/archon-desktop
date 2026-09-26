# MiniPC migration

Migration is staged; do not run duplicate gateways, backup timers, or cron schedules on both machines.

1. In Settings, download the migration manifest and record the server/profile paths.
2. Create and verify a fresh encrypted Archon backup.
3. Install Python 3.12+, Node 22+, Hermes Agent, tmux, Tailscale, and this repository on the MiniPC.
4. Restore Hermes and Archon Desktop state with existing backup tooling.
5. Rebuild `backend/.venv` and the Linux package for the MiniPC architecture.
6. Generate or transfer the Archon Desktop backend token into a private external service environment file outside every workspace root; follow [operator setup](operator-setup.md). Never place it in Git or chat.
7. Start the candidate server on a different loopback port behind the independently verified private HTTPS ingress and verify tasks, events, files, terminals, backups, cron listing, and model/skill controls.
8. Stop the VPS service, perform a final delta backup/restore, then enable the MiniPC service and update the desktop connection.
9. Keep the VPS stopped but intact until the MiniPC has passed normal use and a restore drill.

The server migration manifest API reports required source paths but deliberately excludes secret contents.
