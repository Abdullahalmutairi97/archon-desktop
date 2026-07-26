# Archon Desktop visual system

Archon uses Abdullah's supplied **A-arch mark**: an architectural arch and crown surrounding the letter A. The mark is used consistently in the window, chat identity, and packaged Linux icon.

The product shell follows the supplied v2 workspace: a slim custom titlebar, one project/session sidebar, a continuous task canvas, and a collapsible right activity/files/terminal bench. Information is shown when it helps a decision; implementation guarantees are not repeated as captions.

## Themes

- **Carbon / Nocturne** — compact blue-grey ground, Inter typography, blurple signal line.
- **Ivory / Classical** — editorial paper, Cormorant over Lora, warm gold actions.
- **Blueprint / Modernist** — white technical grid, Archivo typography, zero-radius geometry and red instrumentation.
- **Moss** — cool deep green, softer forms and botanical highlight.
- **Ember** — warm late-night brown, copper highlight and elevated composer.

Themes alter typography, geometry, background texture, depth, and navigation treatment—not only color.

The 0.5 shell, five visual identities, A-arch mark, titlebar, sidebar, composer, pickup cards, panel geometry, and Phosphor control language are rebuilt from Abdullah's supplied immutable `archon-desktop-themes-icons.zip`. The prototype's fake data is not imported: live Hermes projects, sessions, tasks, models, files, terminals, backups, cron, and status remain authoritative.

## Appearance Studio

Every base identity is an editable starting point. Device-local appearance state controls the shell palette, two ambient colors, type family, scale, weight and spacing, icon scale and stroke, motion speed, density, corner radius, blur, glow, ambient strength, background dim, rail and session-sidebar widths, composer and content widths, glass mode, pattern, navigation side, and a local background image.

The default canvas uses an original bundled sculptural SVG beneath a theme-colored 74% dim layer and vignette. It never repeats, and the same continuous field is used on Connect and inside the workspace. Background dim is adjustable from 35–90%.

Custom setups can be named and recalled. JSON import/export is validated and numeric values are clamped to responsive-safe ranges; malformed state falls back to Carbon. Background image data stays on the device and is never sent to the server.
