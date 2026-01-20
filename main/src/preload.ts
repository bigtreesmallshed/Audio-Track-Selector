import { contextBridge, ipcRenderer } from "electron";
import { pathToFileURL } from "url";
import type {
  ExtractProgressEvent,
  ExtractTrackRequest,
  ExtractTrackResponse,
  LogEvent,
  ProbeResult
} from "@shared/types";

const api = {
  openFile: (): Promise<string | null> => ipcRenderer.invoke("open-file"),
  probeFile: (filePath: string): Promise<ProbeResult> =>
    ipcRenderer.invoke("probe-file", filePath),
  extractTrack: (request: ExtractTrackRequest): Promise<ExtractTrackResponse> =>
    ipcRenderer.invoke("extract-track", request),
  cleanupTemp: (): Promise<void> => ipcRenderer.invoke("cleanup-temp"),
  onExtractProgress: (callback: (event: ExtractProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: ExtractProgressEvent) =>
      callback(data);
    ipcRenderer.on("extract-progress", listener);
    return () => ipcRenderer.removeListener("extract-progress", listener);
  },
  onLog: (callback: (event: LogEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: LogEvent) =>
      callback(data);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },
  toFileUrl: (filePath: string) => pathToFileURL(filePath).toString()
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
