import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'activity' | 'browser' | 'chat' | 'chevron' | 'close' | 'code' | 'file'
  | 'folder' | 'history' | 'menu' | 'plus' | 'search' | 'settings' | 'terminal'

const paths: Record<IconName, ReactNode> = {
  activity: <><path d="M3 12h4l2.2-6 4.2 12L16 10l2 2h3"/><path d="M21 12h1"/></>,
  browser: <><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M8 3.8c2.2 2.2 2.2 14.2 0 16.4M16 3.8c-2.2 2.2-2.2 14.2 0 16.4"/></>,
  chat: <><path d="M20 11.4a7.4 7.4 0 0 1-7.8 7.4 8.6 8.6 0 0 1-3.3-.6L4 20l1.4-4a7 7 0 0 1-1.1-3.7A7.4 7.4 0 0 1 12 5a7.4 7.4 0 0 1 8 6.4Z"/><path d="M8 11h8M8 14h5"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  code: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></>,
  file: <><path d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5Z"/><path d="M13.5 3.5V8H18M8 12h8M8 15.5h8"/></>,
  folder: <path d="M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h5l2 2h7a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 17Z"/>,
  history: <><path d="M4 7v5h5M5.2 11a7 7 0 1 1 .6 5.7"/><path d="M12 8v4l3 2"/></>,
  menu: <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  search: <><circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 4 4"/></>,
  settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.2 13.7 1.1.9-1.2 2.1-1.4-.4a7.8 7.8 0 0 1-1.5.9l-.3 1.5h-2.4l-.5-1.4a7.7 7.7 0 0 1-1.8-.1l-.9 1.1-2.1-1.2.4-1.4a7.8 7.8 0 0 1-.9-1.5l-1.5-.3v-2.4l1.4-.5a7.7 7.7 0 0 1 .1-1.8l-1.1-.9 1.2-2.1 1.4.4a7.8 7.8 0 0 1 1.5-.9l.3-1.5h2.4l.5 1.4a7.7 7.7 0 0 1 1.8.1l.9-1.1 2.1 1.2-.4 1.4a7.8 7.8 0 0 1 .9 1.5l1.5.3v2.4l-1.4.5a7.7 7.7 0 0 1-.1 1.8Z"/></>,
  terminal: <><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7 9 3 2.5L7 14M12.5 15H17"/></>,
}

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>
}
