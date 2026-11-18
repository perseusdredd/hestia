export const HILL_W = 200;
export const HILL_H = 64;
export const HILL_BASE = 54;
const AMP = 46;

/** Point on the hill curve for a 0-100 position. */
export function hillPoint(position: number): { x: number; y: number } {
  const t = Math.min(100, Math.max(0, position)) / 100;
  return { x: t * HILL_W, y: HILL_BASE - AMP * Math.sin(Math.PI * t) };
}
