// Contract between the React frontend and the Rust (Tauri) backend.
// Every command listed here is implemented in `src-tauri/src/commands.rs`.
// Field names are camelCase on both sides (serde `rename_all = "camelCase"`).

import { invoke } from "@tauri-apps/api/core";

/** True when running inside the Tauri shell (false in a plain browser via `npm run dev`). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------------------
// Game detection / indexing
// ---------------------------------------------------------------------------

export interface Installation {
  /** Game root, e.g. C:\Program Files (x86)\Steam\steamapps\common\Euro Truck Simulator 2 */
  gameDir: string;
  /** Mod folder, e.g. C:\Users\x\Documents\Euro Truck Simulator 2\mod (may not exist yet) */
  modDir: string | null;
  /** Where we found it: "steam-library" | "registry" | "default-path" | "manual" */
  source: string;
}

export interface ArchiveInfo {
  /** File name, e.g. "def.scs" */
  name: string;
  /** "hashfs1" | "hashfs2" | "zip" | "folder" */
  kind: string;
  entryCount: number;
}

export interface CabinInfo {
  /** SII unit name, e.g. "cab_a.scania.r_2016.cabin" — used for suitable_for[] */
  unitName: string;
  /** Display name from the def file (may be empty) */
  name: string;
  /** Virtual path of the def file, e.g. /def/vehicle/truck/scania.r_2016/cabin/cab_a.sii */
  defPath: string;
  /** All .pmd model paths referenced by the cabin def (model, lods, ...) */
  models: string[];
}

export interface PaintJobInfo {
  unitName: string;
  defPath: string;
  name: string;
  /** paint_job_mask path (tobj) when present */
  maskPath: string | null;
  airbrush: boolean;
  alternateUvset: boolean;
}

export interface VehicleInfo {
  /** Vehicle id = directory under /def/vehicle/<truck|trailer_owned>/, e.g. "scania.r_2016" */
  id: string;
  /** "truck" | "trailer_owned" */
  vehicleType: string;
  /** Display name (from data.sii / brand) or the id when unknown */
  name: string;
  cabins: CabinInfo[];
  /** Other .pmd models referenced from def/vehicle/<type>/<id>/** (chassis, body, ...) */
  otherModels: string[];
  paintJobs: PaintJobInfo[];
}

export interface GameIndex {
  gameDir: string;
  archives: ArchiveInfo[];
  vehicles: VehicleInfo[];
  /** Non-fatal problems: unreadable archive, encrypted sii, ... */
  warnings: string[];
}

export interface DirListing {
  dirs: string[];
  files: string[];
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface MaterialInfo {
  /** Virtual path of the .mat file */
  path: string;
  /** Effect name, e.g. "eut2.truckpaint.airbrush" (empty when the .mat could not be read) */
  effect: string;
  /** Texture paths referenced by the material */
  textures: string[];
  /** True when the effect contains "truckpaint" → receives the paint job */
  paintable: boolean;
}

export interface PieceData {
  /** Index into ModelData.materials */
  material: number;
  vertexCount: number;
  /** Number of UV channels (0..n) */
  uvChannels: number;
  /** base64 little-endian f32, xyz per vertex */
  positions: string;
  /** base64 little-endian f32, xyz per vertex */
  normals: string;
  /** one base64 little-endian f32 array (uv per vertex) per channel */
  uvs: string[];
  /** base64 little-endian u32 triangle list */
  indices: string;
}

export interface PartData {
  name: string;
  pieces: PieceData[];
}

export interface ModelData {
  path: string;
  looks: string[];
  variants: string[];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  materials: MaterialInfo[];
  parts: PartData[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportTexture {
  /** File stem inside the mod, e.g. "cab_a" (only [a-z0-9_]) */
  name: string;
  /** PNG, base64 (no data: prefix). Width/height must be powers of two. */
  pngBase64: string;
  /** Cabin unit names for suitable_for[]; empty → paint job applies to every cabin */
  cabinUnits: string[];
}

export interface ExportRequest {
  /** Internal id, [a-z0-9_], max 12 chars recommended (SII token limit) */
  modId: string;
  displayName: string;
  author: string;
  version: string;
  description: string;
  price: number;
  unlockLevel: number;
  /** "truck" | "trailer_owned" */
  vehicleType: string;
  /** e.g. "scania.r_2016" */
  vehicleId: string;
  textures: ExportTexture[];
  alternateUvset: boolean;
  /** Linear 0..1 RGB, used as base_color */
  baseColor: [number, number, number];
  baseColorLocked: boolean;
  /** "rgba8" (lossless, uncompressed DDS) | "bc3" (DXT5, ~4x smaller) */
  format: "rgba8" | "bc3";
  mipmaps: boolean;
  /** Paint job shop icon (PNG base64), rescaled to 256x64 */
  iconPngBase64: string | null;
  /** Mod manager image (PNG base64), rescaled to 276x162 and stored as JPG */
  modManagerPngBase64: string | null;
  /** "folder" (unpacked mod folder) | "scs" (zip archive) */
  packaging: "folder" | "scs";
  /** Target folder, normally the game's mod folder */
  outputDir: string;
  overwrite: boolean;
}

export interface ExportResult {
  /** The created .scs file or folder */
  outputPath: string;
  /** Relative paths of all files written into the mod */
  files: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const api = {
  detectInstallations: () => invoke<Installation[]>("detect_installations"),
  defaultModDir: () => invoke<string | null>("default_mod_dir"),
  openGame: (gameDir: string) => invoke<GameIndex>("open_game", { gameDir }),
  /** Mount an extra .scs/.zip/folder (e.g. a truck mod) on top of the game files. */
  mountExtra: (path: string) => invoke<GameIndex>("mount_extra", { path }),
  listDir: (path: string) => invoke<DirListing>("list_dir", { path }),
  readText: (path: string) => invoke<string>("read_text", { path }),
  loadModel: (pmdPath: string, look: number) =>
    invoke<ModelData>("load_model", { pmdPath, look }),
  exportMod: (request: ExportRequest) => invoke<ExportResult>("export_mod", { request }),
  saveTextFile: (path: string, contents: string) =>
    invoke<void>("save_text_file", { path, contents }),
  loadTextFile: (path: string) => invoke<string>("load_text_file", { path }),
  /** Writes base64 bytes to an arbitrary path (PNG export etc.) */
  saveBinaryFile: (path: string, base64: string) =>
    invoke<void>("save_binary_file", { path, base64 }),
};

// ---------------------------------------------------------------------------
// Helpers for the binary model buffers
// ---------------------------------------------------------------------------

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64ToF32(b64: string): Float32Array {
  const bytes = b64ToBytes(b64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export function b64ToU32(b64: string): Uint32Array {
  const bytes = b64ToBytes(b64);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    s += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(s);
}
