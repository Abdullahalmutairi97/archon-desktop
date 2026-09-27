# Portable Linux package

From a clean checkout with the pinned desktop dependencies installed, run:

    npm run desktop:package:portable

The command rebuilds the Electron main, preload, renderer and runner outputs, then creates a Linux x64 tarball in desktop/release. Extract it and launch the archon-desktop-reconstruction file inside the extracted directory. Verify the adjacent .sha256 file before moving the package.

This is the isolated reconstruction build. It uses the Archon Desktop Reconstruction app identity and its own user-data profile; it does not replace or modify the frozen v0.3.0 application. It does not install or start the backend. Server operations need an already-running, configured backend. Local Codex needs the Codex CLI on this computer. The chat and general project/session/task views and some workbench panels still show fixture data.

The archive contains the pinned Electron runtime, compiled app outputs, runtime package metadata and license notices. It contains no source checkout, node_modules, backend, user profile, token, or settings. Linux x64 is the only package target here; other architectures require their own build and native qualification.
