import { open, save } from "@tauri-apps/plugin-dialog";
import { canvasToPngBlob, preloadDoc, renderToCanvas } from "../editor/render";
import { activeDoc, useEditor } from "../editor/store";
import type { Project, TextureDoc } from "../editor/types";
import { pickFile } from "../editor/importers";
import { api, blobToBase64, isTauri } from "./api";

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Older project files: make sure every layer has the fields introduced later. */
function migrate(p: Project): Project {
  return {
    ...p,
    textures: p.textures.map((t) => ({ ...t, layers: t.layers.map((l) => ({ ...l, projection: l.projection ?? null })) })),
  };
}

export async function saveProject(saveAs = false) {
  const s = useEditor.getState();
  const json = JSON.stringify(s.project);
  try {
    if (isTauri()) {
      let path = s.projectPath;
      if (!path || saveAs) {
        const chosen = await save({ title: "Project opslaan", defaultPath: `${s.project.name}.liveryproj`, filters: [{ name: "Livery project", extensions: ["liveryproj"] }] });
        if (!chosen) return;
        path = chosen;
      }
      await api.saveTextFile(path, json);
      useEditor.setState({ projectPath: path, dirty: false });
    } else {
      download(new Blob([json], { type: "application/json" }), `${s.project.name}.liveryproj`);
      useEditor.setState({ dirty: false });
    }
    s.notify("Project opgeslagen");
  } catch (e) {
    s.notify(`Opslaan mislukt: ${e}`, "error");
  }
}

export async function openProject() {
  const s = useEditor.getState();
  try {
    let text: string;
    let path: string | null = null;
    if (isTauri()) {
      const chosen = await open({ title: "Project openen", filters: [{ name: "Livery project", extensions: ["liveryproj", "json"] }] });
      if (typeof chosen !== "string") return;
      path = chosen;
      text = await api.loadTextFile(chosen);
    } else {
      const f = await pickFile(".liveryproj,.json");
      if (!f) return;
      text = await f.text();
    }
    const p = JSON.parse(text) as Project;
    if (p.version !== 1 || !Array.isArray(p.textures)) throw new Error("Onbekend projectformaat");
    s.setProject(migrate(p), path);
    s.notify(`Project geopend: ${p.name}`);
  } catch (e) {
    s.notify(`Openen mislukt: ${e}`, "error");
  }
}

/** Renders a texture at full resolution, re-rasterising all vector/projected layers. */
export async function renderFull(doc: TextureDoc): Promise<HTMLCanvasElement> {
  const s = useEditor.getState();
  await preloadDoc(doc);
  return renderToCanvas(doc, s.project.palette, doc.width, doc.height, undefined, { exportQuality: true });
}

export async function exportPng() {
  const s = useEditor.getState();
  const doc = activeDoc(s.project);
  try {
    const blob = await canvasToPngBlob(await renderFull(doc));
    if (isTauri()) {
      const path = await save({ title: "Textuur als PNG opslaan", defaultPath: `${doc.name}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
      if (!path) return;
      await api.saveBinaryFile(path, await blobToBase64(blob));
    } else {
      download(blob, `${doc.name}.png`);
    }
    s.notify(`PNG geëxporteerd (${doc.width}×${doc.height})`);
  } catch (e) {
    s.notify(`PNG-export mislukt: ${e}`, "error");
  }
}
