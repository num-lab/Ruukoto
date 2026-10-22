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
  pickSkillFolder: (target, instanceId) => ipcRenderer.invoke("desktop:pick-skill-folder", target, instanceId),
  reveal: path => ipcRenderer.invoke("desktop:reveal", path),
  openTerminal: (id, workspaceId, instanceId, cols, rows) => ipcRenderer.invoke("desktop:request", "code", "desktop_terminal_open", { id, workspace_id: workspaceId, instance_id: instanceId, cols, rows }),
  inputTerminal: (id, data) => ipcRenderer.invoke("desktop:request", "code", "desktop_terminal_input", { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke("desktop:request", "code", "desktop_terminal_resize", { id, cols, rows }),
  killTerminal: id => ipcRenderer.invoke("desktop:request", "code", "desktop_terminal_kill", { id }),
};
contextBridge.exposeInMainWorld("ruukoto", bridge);
