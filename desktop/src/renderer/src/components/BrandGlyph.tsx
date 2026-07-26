import { useEffect, useState, type SVGProps } from 'react'
import { readAppearance, type AppearanceConfig } from '../lib/appearance'
import { MarkGlyph, type MarkId } from '../lib/marks'

export function BrandGlyph({ className = '', mark: requestedMark, ...props }: SVGProps<SVGSVGElement> & { mark?: MarkId }) {
  const [mark, setMark] = useState<MarkId>(() => requestedMark || readAppearance().mark)
  const [customMark, setCustomMark] = useState(() => requestedMark ? '' : readAppearance().customMark)

  useEffect(() => {
    if (requestedMark) { setMark(requestedMark); setCustomMark(''); return }
    const update = (event: Event) => {
      const appearance = (event as CustomEvent<AppearanceConfig>).detail
      setMark(appearance?.mark || readAppearance().mark)
      setCustomMark(appearance?.customMark || readAppearance().customMark)
    }
    window.addEventListener('archon:appearance-changed', update)
    return () => window.removeEventListener('archon:appearance-changed', update)
  }, [requestedMark])

  if (customMark) return <svg viewBox="0 0 24 24" className={`brand-glyph ${className}`} {...props}><image href={customMark} width="24" height="24" preserveAspectRatio="xMidYMid meet" pointerEvents="none"/></svg>
  return <MarkGlyph mark={mark} className={className} {...props}/>
}
