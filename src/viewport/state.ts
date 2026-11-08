// Holds the current 3D paint mesh outside of React/zustand (THREE objects are not state).

import { useEditor } from "../editor/store";
import { getBaker } from "./baker";
import { buildDemo, buildFromModel, disposeMesh, type PaintMesh } from "./mesh";

let current: PaintMesh | null = null;

export const currentMesh = () => current;

export function setMesh(m: PaintMesh) {
  if (current && current !== m) disposeMesh(current);
  current = m;
  const s = useEditor.getState();
  getBaker().setMesh(m, s.uv.flipV);
  s.set({
    meshVersion: s.meshVersion + 1,
    uv: { ...s.uv, segments: m.segments, channelsAvailable: Math.max(1, m.uvChannels) },
  });
}

/** (Re)builds the mesh from the loaded game model, or the demo cab when none is loaded. */
export function rebuildMesh() {
  const s = useEditor.getState();
  const model = s.game.model;
  const m = model
    ? buildFromModel(model, s.uv.channel, s.paintableOverride ? new Set(s.paintableOverride) : null)
    : buildDemo();
  setMesh(m);
}

export function setFlipV(flipV: boolean) {
  const s = useEditor.getState();
  s.set({ uv: { ...s.uv, flipV } });
  getBaker().setMesh(current, flipV);
  s.bumpRender();
}
