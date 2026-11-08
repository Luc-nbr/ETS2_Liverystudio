// Projector-plane math shared by the baker, the 3D tools and the gizmos.

import type { Projection, V3 } from "../editor/types";

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Orthonormal decal frame. U = image right, D = image down, N = towards the viewer. */
export interface Frame {
  O: V3;
  U: V3;
  D: V3;
  N: V3;
  upp: number;
}

/** Picks a sensible "up" on a plane with normal n: world +Y, or forward (-Z) on roof-like surfaces. */
export function defaultUp(n: V3, prevUp?: V3): V3 {
  const tryUp = (u: V3): V3 | null => {
    const p = sub(u, mul(n, dot(n, u)));
    return len(p) > 0.25 ? norm(p) : null;
  };
  return (prevUp && tryUp(prevUp)) || tryUp([0, 1, 0]) || tryUp([0, 0, -1])!;
}

export function frameOf(p: Projection): Frame {
  const N = norm(p.normal);
  const up = defaultUp(N, p.up);
  const U = norm(cross(up, N));
  const D = mul(up, -1);
  return { O: p.origin, U, D, N, upp: p.unitsPerPx };
}

/** World point → plane pixel coordinates (+ signed distance along N in metres). */
export function toPlane(f: Frame, w: V3): { x: number; y: number; z: number } {
  const d = sub(w, f.O);
  return { x: dot(d, f.U) / f.upp, y: dot(d, f.D) / f.upp, z: dot(d, f.N) };
}

export function fromPlane(f: Frame, x: number, y: number): V3 {
  return add(f.O, add(mul(f.U, x * f.upp), mul(f.D, y * f.upp)));
}

/** Ray/plane intersection in plane pixel coordinates (null when parallel/behind). */
export function rayToPlane(f: Frame, origin: V3, dir: V3): { x: number; y: number } | null {
  const denom = dot(dir, f.N);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(sub(f.O, origin), f.N) / denom;
  if (t < 0) return null;
  const hit = add(origin, mul(dir, t));
  const p = toPlane(f, hit);
  return { x: p.x, y: p.y };
}

// --- symmetry (left/right) --------------------------------------------------

export const mirrorPoint = (p: V3, cx: number): V3 => [2 * cx - p[0], p[1], p[2]];
export const mirrorDir = (v: V3): V3 => [-v[0], v[1], v[2]];

/** Frame of the mirrored copy. `readable` flips U back so text is not mirrored. */
export function mirrorFrame(f: Frame, cx: number, readable: boolean): Frame {
  const U = mirrorDir(f.U);
  return { O: mirrorPoint(f.O, cx), U: readable ? mul(U, -1) : U, D: mirrorDir(f.D), N: mirrorDir(f.N), upp: f.upp };
}
