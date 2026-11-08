// Converts game models (or the built-in demo cab) into the geometry used by the
// 3D viewport and by the texture baker.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { b64ToF32, b64ToU32, type ModelData } from "../lib/api";
import type { V3 } from "../editor/types";

// Fast raycasting on big truck meshes.
(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface PaintMesh {
  /** Increments whenever geometry or UV choice changes (invalidates bake caches). */
  version: number;
  name: string;
  /** All paintable pieces merged: position, normal, uv (= bake uv), index. */
  paint: THREE.BufferGeometry;
  /** Display-only pieces. */
  others: { geometry: THREE.BufferGeometry; color: number }[];
  bboxMin: V3;
  bboxMax: V3;
  /** X coordinate of the left/right symmetry plane. */
  symmetryX: number;
  /** Sum of triangle areas in UV space (0..1²) and world space (m²) → texel density. */
  uvArea: number;
  worldArea: number;
  uvChannels: number;
  /** UV wireframe line segments (x1,y1,x2,y2,...) */
  segments: Float32Array;
}

let versionCounter = 1;

function finalize(name: string, paintParts: THREE.BufferGeometry[], others: PaintMesh["others"], uvChannels: number): PaintMesh {
  const paint = paintParts.length ? mergeGeometries(paintParts, false)! : new THREE.BufferGeometry();
  if (!paint.getAttribute("normal") && paint.getAttribute("position")) paint.computeVertexNormals();
  paint.computeBoundingBox();
  paint.computeBoundingSphere();
  if (paint.getAttribute("position")) (paint as unknown as { computeBoundsTree: () => void }).computeBoundsTree();
  for (const o of others) (o.geometry as unknown as { computeBoundsTree: () => void }).computeBoundsTree();

  const box = new THREE.Box3();
  if (paint.boundingBox) box.union(paint.boundingBox);
  for (const o of others) {
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox!);
  }

  // texel density + uv wireframe
  const pos = paint.getAttribute("position") as THREE.BufferAttribute | undefined;
  const uv = paint.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const idx = paint.getIndex();
  let uvArea = 0, worldArea = 0;
  const seg: number[] = [];
  if (pos && uv && idx) {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      const i0 = idx.getX(i), i1 = idx.getX(i + 1), i2 = idx.getX(i + 2);
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      worldArea += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
      const u0 = uv.getX(i0), v0 = uv.getY(i0), u1 = uv.getX(i1), v1 = uv.getY(i1), u2 = uv.getX(i2), v2 = uv.getY(i2);
      uvArea += Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
      seg.push(u0, v0, u1, v1, u1, v1, u2, v2, u2, v2, u0, v0);
    }
  }
  return {
    version: versionCounter++,
    name,
    paint,
    others,
    bboxMin: [box.min.x, box.min.y, box.min.z],
    bboxMax: [box.max.x, box.max.y, box.max.z],
    symmetryX: Number.isFinite(box.min.x) ? (box.min.x + box.max.x) / 2 : 0,
    uvArea,
    worldArea,
    uvChannels,
    segments: new Float32Array(seg),
  };
}

/** Builds geometry from a game model. `paintable` overrides material detection when given. */
export function buildFromModel(model: ModelData, channel: number, paintable: Set<number> | null): PaintMesh {
  const isPaintable = (m: number) => (paintable ? paintable.has(m) : model.materials[m]?.paintable ?? false);
  const anyPaintable = paintable ? paintable.size > 0 : model.materials.some((m) => m.paintable);
  const paintParts: THREE.BufferGeometry[] = [];
  const others: PaintMesh["others"] = [];
  let maxChannels = 0;
  for (const part of model.parts) {
    for (const piece of part.pieces) {
      maxChannels = Math.max(maxChannels, piece.uvChannels);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(b64ToF32(piece.positions), 3));
      g.setAttribute("normal", new THREE.BufferAttribute(b64ToF32(piece.normals), 3));
      g.setIndex(new THREE.BufferAttribute(b64ToU32(piece.indices), 1));
      const ch = Math.min(channel, piece.uvChannels - 1);
      const paintThis = piece.uvChannels > 0 && (anyPaintable ? isPaintable(piece.material) : true);
      if (paintThis) {
        g.setAttribute("uv", new THREE.BufferAttribute(b64ToF32(piece.uvs[ch]), 2));
        paintParts.push(g);
      } else {
        others.push({ geometry: g, color: 0x6b7078 });
      }
    }
  }
  return finalize(model.path, paintParts, others, maxChannels);
}

// ---------------------------------------------------------------------------
// Demo cab: lets you use the full 3D editor without the game installed.
// SCS axes: +X right, +Y up, -Z forward. UVs: v=0 is the top of the texture.
// ---------------------------------------------------------------------------

interface FaceSpec {
  /** maps (s, t) ∈ [0,1]² (s = viewer's right, t = down) to a world point */
  at: (s: number, t: number) => V3;
  rect: [number, number, number, number]; // u0, v0, u1, v1
}

function face(spec: FaceSpec, seg = 28): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= seg; j++)
    for (let i = 0; i <= seg; i++) {
      const s = i / seg, t = j / seg;
      pos.push(...spec.at(s, t));
      const [u0, v0, u1, v1] = spec.rect;
      uv.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * t);
    }
  for (let j = 0; j < seg; j++)
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure normals point outward (flip triangles when they don't)
  const n = g.getAttribute("normal");
  const c = spec.at(0.5, 0.5);
  const probe = new THREE.Vector3(n.getX(Math.floor(n.count / 2)), n.getY(Math.floor(n.count / 2)), n.getZ(Math.floor(n.count / 2)));
  const outward = new THREE.Vector3(c[0], c[1] - 2.4, c[2]);
  if (probe.dot(outward) < 0) {
    const ix = g.getIndex()!;
    for (let k = 0; k < ix.count; k += 3) {
      const t = ix.getX(k + 1);
      ix.setX(k + 1, ix.getX(k + 2));
      ix.setX(k + 2, t);
    }
    g.computeVertexNormals();
  }
  return g;
}

export function buildDemo(): PaintMesh {
  const W = 1.25, Y0 = 1.25, Y1 = 3.95, Z0 = -1.15, Z1 = 1.15;
  const bulge = (s: number, t: number) => 0.12 * (1 - (2 * s - 1) ** 2) * (1 - (2 * t - 1) ** 2);
  const sideBulge = (s: number, t: number) => 0.05 * (1 - (2 * s - 1) ** 2) * (1 - (2 * t - 1) ** 2);
  const yAt = (t: number) => Y1 - (Y1 - Y0) * t;
  const faces: FaceSpec[] = [
    // left side (viewer at -X, right = +Z)
    { at: (s, t) => [-W - sideBulge(s, t), yAt(t), Z0 + (Z1 - Z0) * s], rect: [0.01, 0.01, 0.49, 0.45] },
    // right side (viewer at +X, right = -Z)
    { at: (s, t) => [W + sideBulge(s, t), yAt(t), Z1 - (Z1 - Z0) * s], rect: [0.51, 0.01, 0.99, 0.45] },
    // front (viewer at -Z, right = -X), slightly curved windscreen-like bulge
    { at: (s, t) => [W - 2 * W * s, yAt(t), Z0 - bulge(s, t)], rect: [0.01, 0.5, 0.49, 0.95] },
    // back (viewer at +Z, right = +X)
    { at: (s, t) => [-W + 2 * W * s, yAt(t), Z1], rect: [0.51, 0.5, 0.99, 0.72] },
    // roof (viewer above, right = +X, down = +Z)
    { at: (s, t) => [-W + 2 * W * s, Y1 + 0.06 * (1 - (2 * s - 1) ** 2), Z0 + (Z1 - Z0) * t], rect: [0.51, 0.75, 0.99, 0.99] },
  ];
  const paintParts = faces.map((f) => face(f));

  const others: PaintMesh["others"] = [];
  const chassis = new THREE.BoxGeometry(2.1, 0.45, 6.2);
  chassis.translate(0, 0.95, 2.0);
  others.push({ geometry: chassis.toNonIndexed(), color: 0x2a2d33 });
  const bumper = new THREE.BoxGeometry(2.5, 0.5, 0.35);
  bumper.translate(0, 1.0, Z0 - 0.1);
  others.push({ geometry: bumper, color: 0x30343a });
  for (const [x, z] of [[-1.05, -0.2], [1.05, -0.2], [-1.05, 3.4], [1.05, 3.4], [-1.05, 4.75], [1.05, 4.75]]) {
    const wheel = new THREE.CylinderGeometry(0.52, 0.52, 0.42, 32);
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(x, 0.52, z);
    others.push({ geometry: wheel, color: 0x18191c });
  }
  return finalize("Demo-cabine", paintParts, others, 1);
}

export function disposeMesh(m: PaintMesh) {
  m.paint.dispose();
  for (const o of m.others) o.geometry.dispose();
}
