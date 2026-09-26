import type { SVGProps } from 'react'

/** Authored preview mark: a fresh three-stroke wing approximation, not an imported logo asset. */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
    <path d="M4 9.5c7.4.2 14.5-2.1 22.6-6.3" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/>
    <path d="M6.8 16.4c7.8.1 14.3-1.8 21.7-6.4" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round"/>
    <path d="M10 23.2c7.2-.3 12.8-2.1 18.6-6.3" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" opacity=".48"/>
  </svg>
}
