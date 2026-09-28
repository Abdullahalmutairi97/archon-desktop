# Phase 2B.2 — Isolated profile and credential storage core

This increment adds injected profile paths, versioned settings and asset migration, and an Electron `safeStorage` credential core. No live user profile or credential is read or changed by the source checks. These modules are not yet wired into the desktop main process or renderer; P2B.1 still keeps the active connection token in main-process memory.

`ProfileStore` preserves unknown nonsecret settings, omits credential-shaped keys and values, and requires an explicit source directory plus preview ID before copying legacy settings and allowed assets. The source is not modified. It rejects corrupt/future records and symlinked path segments. New-profile settings writes leave a retryable initialized profile if the first settings write fails.

`CredentialStore` encrypts a token before writing a private versioned record only when Electron reports a protected OS storage backend. Linux `basic_text`, unavailable, and unknown backends keep the token in memory. Corrupt/future credential records are left unchanged. Renderer code does not receive saved tokens.

## Validation boundary

Focused tests use temporary fixture directories and fake `safeStorage`; they cover migration, secret omission, symlinked ancestors, atomic-write recovery, protected ciphertext, and memory-only fallback. The integrated desktop check passed typechecking, **86 tests in 16 files**, license inventory and source build. The manifest recorded **63 inputs and 5 outputs** with matching sizes and SHA-256 hashes. No real keyring, installed profile, native Electron window, or migration of user data is exercised. Native protected-storage qualification and main-process wiring remain open.
