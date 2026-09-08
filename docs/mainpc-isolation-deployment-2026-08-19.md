# MainPC session-isolation deployment — 2026-08-19

Target: `AbdullahPC`, authoritative installed lineage v0.4.0 at `/home/abdullah/Applications/archon-desktop-prime`.

## Provenance

The target's pre-deployment ASAR hash exactly matched the MiniPC pre-isolation v0.4.0 build: `48db21489081f0bc3babf82dfe2785569b53e9eb61d8980dfd98247ba11552e1`.

## Deployment

Installed ASAR: `63a742d49d28f9e5a0d0aef9e2635d847b8d98ca90aac4cb96a271d540e47515`.
Rollback: `/home/abdullah/Applications/archon-desktop-prime.pre-isolation-20260819`.
Launcher still targets the installed path.

## Integrity handling

MainPC's Btrfs `/home` produced repeatable bit flips when large files were written into a normal compressed/COW directory, while the same transferred file was correct in tmpfs. Deployment used a fresh `chattr +C` staging directory. SHA-256 manifests for all 73 files matched the MiniPC package exactly before and after the atomic switch. No corrupted staging tree was installed.
