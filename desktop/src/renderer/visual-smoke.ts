/**
 * Manual renderer smoke matrix. These are authored reconstruction captures,
 * never screenshots or proof of parity with the unavailable installed v0.3.0.
 */
export const VISUAL_SMOKE_CASES = [
  {
    id: 'reconstruction-1440-obsidian-ltr',
    label: 'P2A reconstruction shell · 1440×900 · Obsidian · LTR · parity unverified',
    viewport: { width: 1440, height: 900 },
    theme: 'obsidian', direction: 'ltr', navigationSide: 'left', fontScale: 1,
  },
  {
    id: 'reconstruction-1040-ivory-rtl-right-rail',
    label: 'P2A reconstruction shell · 1040×680 · Ivory · RTL · right navigation · parity unverified',
    viewport: { width: 1040, height: 680 },
    theme: 'ivory', direction: 'rtl', navigationSide: 'right', fontScale: 1.1,
  },
  {
    id: 'reconstruction-820-moss-collapsed',
    label: 'P2A reconstruction shell · 820×760 · Moss · collapsed sidebar · parity unverified',
    viewport: { width: 820, height: 760 },
    theme: 'moss', direction: 'ltr', navigationSide: 'left', fontScale: 1.2,
  },
] as const
