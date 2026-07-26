export function RoseGlyph({ size = 18 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" width={size} height={size}><circle cx="12" cy="12" r="10.2" fill="none" stroke="currentColor" strokeWidth="1.1" opacity=".55"/><circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" strokeWidth=".7" opacity=".25"/><path d="M22 12l-8.6 2L12 12l1.4-2zM2 12l8.6-2L12 12l-1.4 2zM12 22l-2-8.6L12 12l2 1.4z" fill="currentColor" opacity=".55"/><path d="M12 2l2 8.6L12 12l-2-1.4z" fill="var(--accent)"/><circle cx="12" cy="12" r="1" fill="var(--accent)"/></svg>
}
export function QuillGlyph({ size = 16 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" width={size} height={size}><path d="M20.6 12 8.2 5.6l2.1 6.4-2.1 6.4z" fill="currentColor"/><path d="M3.4 12h4.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" opacity=".55"/><path d="M5.6 8.3h1.9M5.6 15.7h1.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".28"/></svg>
}
export function WaveGlyph({ size = 15, live = false }: { size?: number; live?: boolean }) {
  const bars = [7, 12, 18, 13, 8, 15, 10]
  return <svg viewBox="0 0 24 24" aria-hidden="true" width={size} height={size}>{bars.map((height, index) => <rect key={index} x={2.2 + index * 3.1} y={12 - height / 2} width="1.7" height={height} rx=".85" fill="currentColor" opacity={index % 2 ? .55 : 1} className={live ? 'wave-live' : ''} style={{ animationDelay: `${index * .09}s` }}/>)}</svg>
}
