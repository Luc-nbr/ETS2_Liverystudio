// Periodic autosave + crash recovery. Desktop: <AppData>/autosave.liveryproj; browser: localStorage.

import { appDataDir, join } from "@tauri-apps/api/path";
import { useEditor } from "../editor/store";
import type { Project } from "../editor/types";
import { api, isTauri } from "./api";

interface AutosaveFile {
  savedAt: string;
  /** true when written right after a normal save → nothing to recover */
  clean: boolean;
  projectPath: string | null;
  project: Project;
}

const KEY = "ets2-livery-autosave";
const INTERVAL = 60_000;

async function filePath(): Promise<string> {
  return join(await appDataDir(), "autosave.liveryproj");
}

export async function writeAutosave(clean: boolean): Promise<void> {
  const s = useEditor.getState();
  const data: AutosaveFile = { savedAt: new Date().toISOString(), clean, projectPath: s.projectPath, project: s.project };
  const json = JSON.stringify(data);
  try {
    if (isTauri()) await api.saveTextFile(await filePath(), json);
    else if (json.length < 4_500_000) localStorage.setItem(KEY, json);
  } catch (e) {
    console.warn("Autosave mislukt", e);
  }
}

export async function readAutosave(): Promise<AutosaveFile | null> {
  try {
    const text = isTauri() ? await api.loadTextFile(await filePath()) : localStorage.getItem(KEY);
    if (!text) return null;
    const data = JSON.parse(text) as AutosaveFile;
    return data?.project?.version === 1 ? data : null;
  } catch {
    return null;
  }
}

let timer = 0;
export function startAutosave() {
  window.clearInterval(timer);
  timer = window.setInterval(() => {
    if (useEditor.getState().dirty) void writeAutosave(false);
  }, INTERVAL);
}
