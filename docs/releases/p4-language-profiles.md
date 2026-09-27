# P4 — pinned language profiles for the workspace IDE

Recorded 2026-09-28 on `archonminipc` (Ubuntu 26.04 LTS, x86_64, code-server
4.139.1 with Code 1.139.1). Every value below was measured on this host: the
VSIX was downloaded from Open VSX, its digest was computed locally, the licence
file was fetched from the same version and digested, and the extracted extension
directory was digested after installation.

This is an **artefact record**, not a behavioural qualification. An extension
being installed and unmodified says nothing about whether its language features
work in the IDE, and the profile endpoint reports unsupported features instead of
assuming them.

## Verified pins

| Extension | Version | Marketplace | Declared licence | VSIX sha256 | Licence file sha256 |
| --- | --- | --- | --- | --- | --- |
| `ms-python.python` | 2026.4.0 | open-vsx | MIT | `232aeafb01f069824fdd92d3e628c1c442bbcfa1d3cc945ff97076340bb2b4a6` | `b3e677dfc054c000e37274dfb8bfcaefc221b71eb92b4f0b7502751b6d1f0210` |
| `ms-python.debugpy` (linux-x64) | 2026.6.0 | open-vsx | MIT | `c7744af4bf72978f5792624a71c80e2b622a1118574fada3a903d70ac03d5bca` | `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383` |
| `redhat.vscode-yaml` | 1.25.2026092308 | open-vsx | MIT | `11fd0c6fef26e548458b25748a62ffaab70a3c5915aa43b468a03058f0a6aea8` | `2a6ebc3c5b441f0aef19c5190d17f5bfc1ab4f729db49fabb2db7d10bd9a6146` |
| `dbaeumer.vscode-eslint` | 3.0.34 | open-vsx | MIT | `ca5334d46f6a39079e751ef4601bfc9f86bc3a46483e87291ec609239d161308` | `976f8ed671d885872afac0021bd78b3d84fe8d4783a98b46deb5a7dc4e29dbff` |

Download URLs are the version-pinned Open VSX file URLs, for example
`https://open-vsx.org/api/ms-python/python/2026.4.0/file/ms-python.python-2026.4.0.vsix`,
and each pin in `backend/archon_server/language_profiles.py` records its own URL.

The declared licence of `ms-python.python` comes from the Open VSX metadata; the
licence file it serves is Microsoft's Python-extension notice, which states that
the extension itself is MIT while the Python Debugger extension is MIT and
Pylance is proprietary. The digest above is of that notice as served, so the
recorded value can be re-checked rather than trusted.

Installed directory digests, measured with the same algorithm the endpoint uses
(sorted relative path plus file content digest):

| Extension | Installed directory | Files | Directory sha256 |
| --- | --- | --- | --- |
| `ms-python.python` | `ms-python.python-2026.4.0` | 2381 | `8bb2ceec4e052f3bb12be5b8d2fad9dca3b68c3b60436a0fd97fdd7306759358` |
| `ms-python.debugpy` | `ms-python.debugpy-2026.6.0` | 337 | `22e2156c05315b2836e6d4d1c71349f78a33311ca5a66754f4f83c82da3b2ae4` |
| `redhat.vscode-yaml` | `redhat.vscode-yaml-1.25.2026092308` | 41 | `f6edc9e8823323b44fa37a32c5d5621537c4823e0b3247d8cd22ead5fe849be8` |
| `dbaeumer.vscode-eslint` | `dbaeumer.vscode-eslint-3.0.34` | 15 | `0522243e2ae31661f7ec9f17f0e55877ac82d280e15f5377f33936b14d65950a` |

## Installation performed

The VSIX files were installed into the extensions directory code-server uses by
default on this host (`~/.local/share/code-server/extensions`), so the workspace
IDE sees them without extra flags:

```bash
~/.local/opt/code-server-4.139.1/bin/code-server --install-extension <file.vsix> \
  --extensions-dir ~/.local/share/code-server/extensions --force --disable-telemetry
~/.local/opt/code-server-4.139.1/bin/code-server --list-extensions --show-versions \
  --extensions-dir ~/.local/share/code-server/extensions
```

`--list-extensions` reports `dbaeumer.vscode-eslint@3.0.34`,
`ms-python.debugpy@2026.6.0`, `ms-python.python@2026.4.0`,
`ms-python.vscode-python-envs@1.38.0` and `redhat.vscode-yaml@1.25.2026092308`.

## Honest gaps

- **Pylance is missing and cannot be pinned here.** `ms-python.python` declares
  `ms-python.vscode-pylance` as an extension dependency, but Pylance is
  proprietary and is not published to this marketplace. The profile reports
  `pylance-language-server` as unsupported with that reason, so Pylance-based
  completion, type checking and refactoring are not claimed.
- **One automatically installed dependency is unpinned.** Installing the Python
  extension also installed `ms-python.vscode-python-envs@1.38.0`, whose
  `package.json` has no `license` field. It is reported under
  `unpinnedInstalled` with its measured digest rather than being treated as
  verified, because its licence and source were not checked.
- **No JavaScript debugger adapter is pinned**, so the
  `javascript-typescript` profile reports breakpoint debugging as unsupported
  instead of advertising a debugger that is not installed.
- **Installation is not feature qualification.** No language server, debugger
  session or IDE interaction was exercised, and nothing here was verified inside
  the packaged desktop app.

## Endpoint

`GET /api/local/workspaces/{id}/language-profiles` (owner credential, workspace
ownership re-checked) returns the directory it inspected, every profile with its
extension and debugger states, the unsupported features with reasons, and the
unpinned installed extensions. States are `installed` (pinned version present and
the directory still hashes to the recorded value), `modified`, `unverified`,
`missing`, and `unpinned` for the extra list.
