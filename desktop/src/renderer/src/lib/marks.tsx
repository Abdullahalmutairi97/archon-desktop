import type { SVGProps } from 'react'

type MarkPath = { k: 'p'; d: string; sw?: number; role?: 'accent' | 'ink'; fill?: boolean; opacity?: number; transform?: string }
type MarkRect = { k: 'r'; x: number; y: number; width: number; height: number; rx?: number; role?: 'accent' | 'ink'; opacity?: number; transform?: string }
type MarkShape = MarkPath | MarkRect
export type MarkDefinition = { label: string; shapes: MarkShape[] }

export const MARKS = {
  wing: { label: 'Wing', shapes: [
    { k: 'p', d: 'M3.5 20.5c8.5.5 15-3 19.5-10.5', sw: 2.5 },
    { k: 'p', d: 'M7 25c8.5 0 15-3.5 19.5-11', role: 'accent', sw: 2.5 },
    { k: 'p', d: 'M14 28.5c6.5-.5 11.5-3.5 15-8.5', sw: 2.3, opacity: .45 },
  ] },
  caduceus: { label: 'Caduceus', shapes: [
    { k: 'p', d: 'M16 4v24', sw: 2.4 },
    { k: 'p', d: 'M16 8.5c-4.5 2-4.5 5.5 0 7.5s4.5 5.5 0 7.5', role: 'accent', sw: 2 },
    { k: 'p', d: 'M16 8.5c4.5 2 4.5 5.5 0 7.5s-4.5 5.5 0 7.5', role: 'accent', sw: 2 },
    { k: 'p', d: 'M11.5 5.5 16 3l4.5 2.5', sw: 2.2 },
  ] },
  aegis: { label: 'Aegis', shapes: [
    { k: 'p', d: 'M16 3.6l9.5 3.6v7.9c0 6.4-4.8 10.2-9.5 12.3-4.7-2.1-9.5-5.9-9.5-12.3V7.2z', sw: 2 },
    { k: 'p', d: 'M16 10.5v9', role: 'accent', sw: 2.6 },
    { k: 'p', d: 'M12 14.5h8', role: 'accent', sw: 2.2, opacity: .6 },
  ] },
  prism: { label: 'Prism', shapes: [
    { k: 'p', d: 'M16 4 28 26H4z', role: 'accent', fill: true, opacity: .22 },
    { k: 'p', d: 'M16 4 28 26H4z', sw: 2.2 },
    { k: 'p', d: 'M16 4v22', role: 'accent', sw: 2.2 },
  ] },
  helix: { label: 'Helix', shapes: [
    { k: 'p', d: 'M10.5 4c9 4 9 8.5 0 12s-9 8 0 12', sw: 2.3 },
    { k: 'p', d: 'M21.5 4c-9 4-9 8.5 0 12s9 8 0 12', role: 'accent', sw: 2.3 },
  ] },
  orbit: { label: 'Orbit', shapes: [
    { k: 'p', d: 'M6 16a10 4.6 0 0 1 20 0 10 4.6 0 0 1-20 0', sw: 1.9, transform: 'rotate(-28 16 16)' },
    { k: 'p', d: 'M16 11.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2z', role: 'accent', fill: true },
    { k: 'p', d: 'M26.5 8.5v.01', role: 'accent', sw: 3 },
  ] },
  gate: { label: 'Gate', shapes: [
    { k: 'p', d: 'M6 27.5V12l10-7.5L26 12v15.5', sw: 2.2 },
    { k: 'p', d: 'M12 27.5v-6.5a4 4 0 0 1 8 0v6.5', role: 'accent', sw: 2.2 },
    { k: 'p', d: 'M4 27.5h24', sw: 2.2, opacity: .5 },
  ] },
  eclipse: { label: 'Eclipse', shapes: [
    { k: 'p', d: 'M14 5.2a10.8 10.8 0 1 0 0 21.6 10.8 10.8 0 0 0 0-21.6z', sw: 1.9 },
    { k: 'p', d: 'M19.5 7.4a10 10 0 1 1 0 17.2 12.4 12.4 0 0 0 0-17.2z', role: 'accent', fill: true },
  ] },
  cipher: { label: 'Cipher', shapes: [
    { k: 'p', d: 'M9 9v.01M16 9v.01M23 9v.01M9 16v.01M23 16v.01M9 23v.01M16 23v.01M23 23v.01', sw: 3 },
    { k: 'p', d: 'M9.5 22.5 22.5 9.5', role: 'accent', sw: 2.2 },
    { k: 'p', d: 'M16 16v.01', role: 'accent', sw: 3.4 },
  ] },
  ridge: { label: 'Ridge', shapes: [
    { k: 'p', d: 'M4 25.5 12 13l4.5 6.5', sw: 2.3 },
    { k: 'p', d: 'M12.5 25.5 20 11l8 14.5z', role: 'accent', fill: true, opacity: .25 },
    { k: 'p', d: 'M12.5 25.5 20 11l8 14.5', role: 'accent', sw: 2.3 },
  ] },
  meander: { label: 'Meander', shapes: [
    { k: 'p', d: 'M6.5 26V6.5h19V26h-14V12.5h9v8h-4', sw: 2.3 },
    { k: 'p', d: 'M16 24.5h4', role: 'accent', sw: 2.3 },
  ] },
  column: { label: 'Column', shapes: [
    { k: 'r', x: 5, y: 5.5, width: 22, height: 3.2, role: 'accent' },
    { k: 'p', d: 'M11 11.5v9.5M16 11.5v9.5M21 11.5v9.5', sw: 2.2 },
    { k: 'r', x: 4, y: 23.6, width: 24, height: 3.4, role: 'accent' },
  ] },
  keystone: { label: 'Keystone', shapes: [
    { k: 'p', d: 'M4.5 27.5V16.5a11.5 11.5 0 0 1 23 0v11', role: 'accent', sw: 2.1 },
    { k: 'p', d: 'M16 4.5 21.4 13H10.6z', role: 'accent', fill: true },
    { k: 'p', d: 'M11.2 27.5 16 17.6l4.8 9.9', sw: 2.1 },
  ] },
  stroke: { label: 'One stroke', shapes: [
    { k: 'p', d: 'M6 26 16 6l10 20', sw: 2.8 },
    { k: 'p', d: 'M11.5 20h9', role: 'accent', sw: 2.8 },
  ] },
  stele: { label: 'Stele', shapes: [
    { k: 'p', d: 'M13 11h6l1.6 16H11.4z', sw: 2 },
    { k: 'p', d: 'M16 4.5 19 10h-6z', role: 'accent', fill: true },
    { k: 'p', d: 'M12.4 17h7.2M12 21.5h8', role: 'accent', sw: 1.7 },
  ] },
  sigil: { label: 'Sigil', shapes: [
    { k: 'p', d: 'M16 5 27 16 16 27 5 16z', sw: 2.2 },
    { k: 'p', d: 'M16 11.5 20.5 16 16 20.5 11.5 16z', role: 'accent', sw: 2.2 },
  ] },
  laurel: { label: 'Laurel', shapes: [
    { k: 'p', d: 'M11 27a13 13 0 0 1 0-22M21 27a13 13 0 0 0 0-22', sw: 2.1 },
    { k: 'p', d: 'M16 9v14', role: 'accent', sw: 2.4 },
  ] },
  omega: { label: 'Omega', shapes: [
    { k: 'p', d: 'M8 26h5.5a9.5 9.5 0 1 1 5 0H24', sw: 2.6 },
  ] },
  obelisk: { label: 'Obelisk', shapes: [
    { k: 'p', d: 'M14 10h4l1.4 17h-6.8z', sw: 2 },
    { k: 'p', d: 'M16 4 19.4 10h-6.8z', role: 'accent', fill: true },
    { k: 'p', d: 'M11 27h10', role: 'accent', sw: 2.2 },
  ] },
  seal: { label: 'Seal', shapes: [
    { k: 'p', d: 'M16 4.6a11.4 11.4 0 1 1 0 22.8 11.4 11.4 0 0 1 0-22.8z', sw: 1.9 },
    { k: 'p', d: 'M16 10.5 21 21h-10z', role: 'accent', fill: true },
  ] },
  triglyph: { label: 'Triglyph', shapes: [
    { k: 'r', x: 5, y: 6, width: 22, height: 3 },
    { k: 'p', d: 'M11 12v14M16 12v14M21 12v14', role: 'accent', sw: 2.4 },
  ] },
  delta: { label: 'Delta', shapes: [
    { k: 'p', d: 'M16 5.5 27.5 26h-23z', role: 'accent', fill: true },
    { k: 'p', d: 'M16 13.5v7', sw: 2.4 },
  ] },
} as const satisfies Record<string, MarkDefinition>

export type MarkId = keyof typeof MARKS
export const MARK_IDS = Object.keys(MARKS) as MarkId[]

export function MarkGlyph({ mark = 'wing', className = '', ...props }: SVGProps<SVGSVGElement> & { mark?: MarkId }) {
  const definition = MARKS[mark] || MARKS.wing
  const shapes = definition.shapes as readonly MarkShape[]
  return <svg className={`brand-glyph ${className}`} viewBox="0 0 32 32" role="img" aria-label={`Archon ${definition.label} mark`} {...props}>
    {shapes.map((shape, index) => {
      const color = shape.role === 'accent' ? 'var(--accent)' : 'currentColor'
      if (shape.k === 'r') return <rect key={index} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx ?? .6} fill={color} opacity={shape.opacity ?? 1} transform={shape.transform}/>
      return <path key={index} d={shape.d} fill={shape.fill ? color : 'none'} stroke={shape.fill ? 'none' : color} strokeWidth={shape.sw ?? 2.2} opacity={shape.opacity ?? 1} transform={shape.transform} strokeLinecap="round" strokeLinejoin="round"/>
    })}
  </svg>
}
