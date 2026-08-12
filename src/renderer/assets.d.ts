/**
 * Vite rewrites an asset import to the URL of the emitted file. This file
 * is deliberately a global script (no imports, no exports) so the ambient
 * module declaration applies across the renderer.
 */
declare module '*.webp' {
  const src: string
  export default src
}
