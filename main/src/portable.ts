import { app } from "electron";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

type PortablePaths = {
  enabled: boolean;
  portableRoot: string;
  dataRoot: string;
  configDir: string;
  logsDir: string;
  tempDir: string;
  sessionDir: string;
};

const PORTABLE_ENV_FLAG = "AUDIO_TRACK_SELECTOR_PORTABLE";
const PORTABLE_MARKERS = [".portable", "portable-mode.json"];

const isTruthy = (value: string | undefined) => value === "1" || value === "true";

const resolvePortableRoot = () => path.dirname(app.getPath("exe"));

const shouldUsePortableMode = (portableRoot: string) => {
  if (!app.isPackaged) {
    return isTruthy(process.env[PORTABLE_ENV_FLAG]);
  }

  if (process.platform !== "win32") {
    return false;
  }

  if (isTruthy(process.env[PORTABLE_ENV_FLAG])) {
    return true;
  }

  return PORTABLE_MARKERS.some((marker) => existsSync(path.join(portableRoot, marker)));
};

const createPortablePaths = (): PortablePaths => {
  const portableRoot = resolvePortableRoot();
  const dataRoot = path.join(portableRoot, "data");

  return {
    enabled: shouldUsePortableMode(portableRoot),
    portableRoot,
    dataRoot,
    configDir: path.join(dataRoot, "config"),
    logsDir: path.join(dataRoot, "logs"),
    tempDir: path.join(dataRoot, "temp"),
    sessionDir: path.join(dataRoot, "session")
  };
};

const portablePaths = createPortablePaths();

const ensureDirectory = (directoryPath: string) => {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
};

export const initializePortablePaths = () => {
  if (!portablePaths.enabled) {
    return portablePaths;
  }

  ensureDirectory(portablePaths.configDir);
  ensureDirectory(portablePaths.logsDir);
  ensureDirectory(portablePaths.tempDir);
  ensureDirectory(portablePaths.sessionDir);

  app.setPath("userData", portablePaths.configDir);
  app.setPath("temp", portablePaths.tempDir);
  app.setPath("sessionData", portablePaths.sessionDir);
  app.setAppLogsPath(portablePaths.logsDir);

  return portablePaths;
};

const resolveExistingPath = (candidates: string[]) => {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const resolvePortableBinPath = (binaryName: string) => {
  const executableName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  return path.join(portablePaths.portableRoot, "bin", executableName);
};

const resolvePackagedBinPath = (binaryName: string) => {
  const executableName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  return path.join(process.resourcesPath, "bin", executableName);
};

export const resolveFfmpegPath = () => {
  const fromStaticPackage = typeof ffmpegStatic === "string" ? ffmpegStatic : "";
  const fromPath = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const resolved = resolveExistingPath([
    resolvePortableBinPath("ffmpeg"),
    resolvePackagedBinPath("ffmpeg"),
    fromStaticPackage
  ]);

  return resolved ?? fromPath;
};

export const resolveFfprobePath = () => {
  const fromStaticPackage = typeof ffprobeStatic === "object" && ffprobeStatic?.path
    ? ffprobeStatic.path
    : typeof ffprobeStatic === "string"
      ? ffprobeStatic
      : "";
  const fromPath = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const resolved = resolveExistingPath([
    resolvePortableBinPath("ffprobe"),
    resolvePackagedBinPath("ffprobe"),
    fromStaticPackage
  ]);

  return resolved ?? fromPath;
};

export const getPortableModeInfo = () => portablePaths;
