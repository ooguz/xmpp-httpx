import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge between the chrome UI and the main process. Nothing here
 * touches page content — page views have no preload at all.
 */
contextBridge.exposeInMainWorld("httpx", {
  navigate: (url: string) => ipcRenderer.invoke("httpx:navigate", url),
  newTab: () => ipcRenderer.invoke("httpx:new-tab"),
  selectTab: (id: number) => ipcRenderer.invoke("httpx:select-tab", id),
  closeTab: (id: number) => ipcRenderer.invoke("httpx:close-tab", id),
  back: () => ipcRenderer.invoke("httpx:back"),
  forward: () => ipcRenderer.invoke("httpx:forward"),
  reload: () => ipcRenderer.invoke("httpx:reload"),
  state: () => ipcRenderer.invoke("httpx:state"),
  connect: (settings: { service: string; jid: string; password: string }) =>
    ipcRenderer.invoke("httpx:connect", settings),
  onState: (listener: (state: unknown) => void) => {
    ipcRenderer.on("httpx:state", (_event, state) => listener(state));
  },
  onSettings: (listener: (settings: unknown) => void) => {
    ipcRenderer.on("httpx:settings", (_event, settings) => listener(settings));
  },
});
