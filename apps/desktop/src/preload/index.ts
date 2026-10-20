import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopUpdate } from "../shared/bridge.ts";

const bridge: DesktopBridge = {
  subscribe(target, listener) {
    const receive = (_event: Electron.IpcRendererEvent, receivedTarget: string, update: DesktopUpdate) => { if (receivedTarget === target) listener(update); };
    ipcRenderer.on("desktop:update", receive);
    ipcRenderer.send("desktop:subscribe", target);
    return () => { ipcRenderer.removeListener("desktop:update", receive); };
  },
  request: (target, op, params) => ipcRenderer.invoke("desktop:request", target, op, params),
  pickAttachments: (sessionId, target = "code") => ipcRenderer.invoke("desktop:pick-attachments", sessionId, target),
  pickDraftAttachments: () => ipcRenderer.invoke("desktop:pick-draft-attachments"),
  uploadDraftAttachments: (sessionId, tokens, target = "code") => ipcRenderer.invoke("desktop:upload-draft-attachments", sessionId, tokens, target),
  pickFolder: () => ipcRenderer.invoke("desktop:pick-folder"),
  reveal: path => ipcRenderer.invoke("desktop:reveal", path),
};
contextBridge.exposeInMainWorld("ruukoto", bridge);
