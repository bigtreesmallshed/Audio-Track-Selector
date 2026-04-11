import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DecoderPcmEvent,
  DecoderStatusEvent,
  ExtractProgressEvent,
  ExtractTrackRequest,
  ExtractTrackResponse,
  LogEvent,
  ProbeResult,
  StartLiveDecodeRequest,
  StopLiveDecodeRequest
} from "./ipc-types";

const encodePathSegment = (segment: string) => encodeURIComponent(segment);

const toFileUrl = (filePath: string): string => {
  if (!filePath) {
    throw new Error("Cannot convert empty file path to file URL");
  }

  if (filePath.startsWith("file://")) {
    return filePath;
  }

  const normalized = filePath.replace(/\\/g, "/");

  if (normalized.startsWith("//")) {
    const trimmed = normalized.replace(/^\/+/, "");
    const [host, ...parts] = trimmed.split("/");
    if (!host) {
      throw new Error(`Invalid UNC path: ${filePath}`);
    }
    const encodedPath = parts.map(encodePathSegment).join("/");
    return encodedPath ? `file://${host}/${encodedPath}` : `file://${host}`;
  }

  if (/^[A-Za-z]:\//.test(normalized)) {
    const [drive, ...parts] = normalized.split("/");
    const encodedPath = parts.map(encodePathSegment).join("/");
    return encodedPath
      ? `file:///${drive}/${encodedPath}`
      : `file:///${drive}`;
  }

  if (normalized.startsWith("/")) {
    const encodedPath = normalized
      .split("/")
      .map((segment, index) => (index === 0 ? "" : encodePathSegment(segment)))
      .join("/");
    return `file://${encodedPath}`;
  }

  const encodedPath = normalized.split("/").map(encodePathSegment).join("/");
  return `file://${encodedPath}`;
};

const api = {
  openFile: (): Promise<string | null> => ipcRenderer.invoke("open-file"),
  probeFile: (filePath: string): Promise<ProbeResult> =>
    ipcRenderer.invoke("probe-file", filePath),
  extractTrack: (request: ExtractTrackRequest): Promise<ExtractTrackResponse> =>
    ipcRenderer.invoke("extract-track", request),
  startLiveDecode: (request: StartLiveDecodeRequest): Promise<void> =>
    ipcRenderer.invoke("start-live-decode", request),
  stopLiveDecode: (request: StopLiveDecodeRequest): Promise<void> =>
    ipcRenderer.invoke("stop-live-decode", request),
  stopAllLiveDecodes: (): Promise<void> => ipcRenderer.invoke("stop-all-live-decodes"),
  cleanupTemp: (): Promise<void> => ipcRenderer.invoke("cleanup-temp"),
  onExtractProgress: (callback: (event: ExtractProgressEvent) => void) => {
    const listener = (_event: IpcRendererEvent, data: ExtractProgressEvent) =>
      callback(data);
    ipcRenderer.on("extract-progress", listener);
    return () => ipcRenderer.removeListener("extract-progress", listener);
  },
  onDecoderPcm: (callback: (event: DecoderPcmEvent) => void) => {
    const listener = (_event: IpcRendererEvent, data: DecoderPcmEvent) =>
      callback(data);
    ipcRenderer.on("decoder-pcm", listener);
    return () => ipcRenderer.removeListener("decoder-pcm", listener);
  },
  onDecoderStatus: (callback: (event: DecoderStatusEvent) => void) => {
    const listener = (_event: IpcRendererEvent, data: DecoderStatusEvent) =>
      callback(data);
    ipcRenderer.on("decoder-status", listener);
    return () => ipcRenderer.removeListener("decoder-status", listener);
  },
  onLog: (callback: (event: LogEvent) => void) => {
    const listener = (_event: IpcRendererEvent, data: LogEvent) =>
      callback(data);
    ipcRenderer.on("log", listener);
    return () => ipcRenderer.removeListener("log", listener);
  },
  toFileUrl
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
