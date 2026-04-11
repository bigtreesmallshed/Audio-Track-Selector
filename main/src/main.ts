import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "node:url";
import {
  getFfmpegCandidates,
  getFfprobeCandidates,
  getPortableModeInfo,
  initializePortablePaths,
  resolveFfmpegPath,
  resolveFfprobePath
} from "./portable";
import type {
  AudioTrackInfo,
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

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;
let tempDir: string | null = null;
const TEMP_DIR_PREFIX = "audio-track-selector-";
const STALE_TEMP_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 2;
const FFPROBE_TIMEOUT_MS = 30_000;
const PCM_CHUNK_BYTES = 16_384;

type DecoderSession = {
  request: StartLiveDecodeRequest;
  child: ChildProcessWithoutNullStreams;
  stderr: string;
};

const liveDecoders = new Map<number, DecoderSession>();

let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

const sendToRenderer = (channel: string, payload: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  if (mainWindow.webContents.isDestroyed()) {
    return false;
  }
  try {
    mainWindow.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
};

const logToRenderer = (event: LogEvent) => {
  if (!sendToRenderer("log", event)) {
    console[event.level === "error" ? "error" : "info"](`[renderer-log-fallback] ${event.message}`);
  }
};

const emitDecoderStatus = (event: DecoderStatusEvent) => {
  sendToRenderer("decoder-status", event);
};

const ensureTempDir = async () => {
  if (tempDir) {
    return tempDir;
  }
  const base = path.join(app.getPath("temp"), TEMP_DIR_PREFIX);
  tempDir = await fs.mkdtemp(base);
  return tempDir;
};

const cleanupTempDir = async () => {
  if (!tempDir) {
    return;
  }
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    logToRenderer({
      level: "error",
      message: `Failed to clean temp directory: ${(error as Error).message}`
    });
  }
  tempDir = null;
};

const cleanupStaleTempDirs = async () => {
  const tempRoot = app.getPath("temp");
  try {
    const entries = await fs.readdir(tempRoot, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) {
        return;
      }

      const fullPath = path.join(tempRoot, entry.name);
      const stats = await fs.stat(fullPath);
      if (now - stats.mtimeMs < STALE_TEMP_MAX_AGE_MS) {
        return;
      }

      try {
        await fs.rm(fullPath, { recursive: true, force: true });
      } catch (error) {
        logToRenderer({
          level: "info",
          message: `Could not remove stale temp directory ${fullPath}: ${(error as Error).message}`
        });
      }
    }));
  } catch (error) {
    logToRenderer({
      level: "info",
      message: `Unable to scan temp root for stale directories: ${(error as Error).message}`
    });
  }
};

const formatBinaryError = (
  binaryName: "ffmpeg" | "ffprobe",
  error: Error
) => {
  const candidates = binaryName === "ffmpeg" ? getFfmpegCandidates() : getFfprobeCandidates();
  const lookup = candidates.map((candidate) => `- ${candidate}`).join("\n");
  return `${binaryName} failed to start: ${error.message}\nChecked locations:\n${lookup}\n` +
    `If running portable mode, place ${binaryName}.exe in "bin" next to the app executable.`;
};

const checkBinaryReadable = async (binaryName: "ffmpeg" | "ffprobe", resolvedPath: string) => {
  const binaryIsPathLike = resolvedPath.includes(path.sep) || resolvedPath.includes("/");
  if (!binaryIsPathLike) {
    return;
  }

  try {
    await fs.access(resolvedPath);
  } catch {
    const candidates = binaryName === "ffmpeg" ? getFfmpegCandidates() : getFfprobeCandidates();
    const shortList = candidates.map((candidate) => `"${candidate}"`).join(", ");
    logToRenderer({
      level: "info",
      message: `${binaryName} executable was resolved to "${resolvedPath}" but is not readable. Lookup order: ${shortList}`
    });
  }
};

const stopLiveDecoder = (audioIndex: number, reason = "stop requested") => {
  const active = liveDecoders.get(audioIndex);
  if (!active) {
    return;
  }

  logToRenderer({
    level: "info",
    message: `[decoder:${audioIndex}] stopping (${reason})`
  });

  active.child.stdout.removeAllListeners();
  active.child.stderr.removeAllListeners();
  active.child.removeAllListeners();
  active.child.kill();
  liveDecoders.delete(audioIndex);
};

const stopAllLiveDecoders = (reason: string) => {
  [...liveDecoders.keys()].forEach((audioIndex) => {
    stopLiveDecoder(audioIndex, reason);
  });
};

const startLiveDecoder = (request: StartLiveDecodeRequest) => {
  const ffmpegPath = resolveFfmpegPath();
  const clampedStart = Math.max(request.startTimeSec, 0);
  const playbackRate = request.playbackRate > 0 ? request.playbackRate : 1;

  stopLiveDecoder(request.audioIndex, "restart requested");

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-ss",
    clampedStart.toFixed(3),
    "-i",
    request.filePath,
    "-map",
    `0:a:${request.audioIndex}`,
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "s16le",
    "pipe:1"
  ];

  logToRenderer({
    level: "info",
    message: `[decoder:${request.audioIndex}] start @${clampedStart.toFixed(3)}s rate=${playbackRate.toFixed(2)} args=${JSON.stringify(args)}`
  });

  const child = spawn(ffmpegPath, args, { windowsHide: true });
  const session: DecoderSession = {
    request: { ...request, startTimeSec: clampedStart, playbackRate },
    child,
    stderr: ""
  };

  liveDecoders.set(request.audioIndex, session);

  child.stdout.on("data", (chunk: Buffer) => {
    const sessionCheck = liveDecoders.get(request.audioIndex);
    if (!sessionCheck || sessionCheck.child.pid !== child.pid) {
      return;
    }

    let offset = 0;
    while (offset < chunk.length) {
      const end = Math.min(offset + PCM_CHUNK_BYTES, chunk.length);
      const pcmSlice = chunk.subarray(offset, end);
      const payload: DecoderPcmEvent = {
        audioIndex: request.audioIndex,
        pcmBase64: pcmSlice.toString("base64"),
        channels: 2,
        sampleRate: 48000
      };
      sendToRenderer("decoder-pcm", payload);
      offset = end;
    }
  });

  child.stderr.on("data", (data) => {
    session.stderr += data.toString();
  });

  child.on("close", (code, signal) => {
    const active = liveDecoders.get(request.audioIndex);
    if (!active || active.child.pid !== child.pid) {
      return;
    }

    liveDecoders.delete(request.audioIndex);

    const message = `[decoder:${request.audioIndex}] closed code=${code ?? "null"} signal=${signal ?? "null"}`;
    emitDecoderStatus({
      audioIndex: request.audioIndex,
      level: code === 0 ? "info" : "error",
      message: code === 0 ? message : `${message} stderr=${session.stderr.trim() || "<empty>"}`
    });
  });

  child.on("error", (error) => {
    const active = liveDecoders.get(request.audioIndex);
    if (!active || active.child.pid !== child.pid) {
      return;
    }
    liveDecoders.delete(request.audioIndex);
    emitDecoderStatus({
      audioIndex: request.audioIndex,
      level: "error",
      message: formatBinaryError("ffmpeg", error)
    });
  });
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const packagedRendererPath = path.resolve(app.getAppPath(), "renderer", "dist", "index.html");
    const isUncPath = packagedRendererPath.startsWith("\\\\");

    fs.access(packagedRendererPath)
      .then(() => true)
      .catch(() => false)
      .then((rendererEntryExists) => {
        const rendererEntryUrl = pathToFileURL(packagedRendererPath).toString();
        const loadTarget = isUncPath ? "UNC/network-share path" : "local path";
        console.info(
          `[renderer-load] mode=packaged target=${loadTarget} path="${packagedRendererPath}" exists=${rendererEntryExists} url="${rendererEntryUrl}"`
        );

        return mainWindow?.loadURL(rendererEntryUrl).catch((error) => {
          const details = [
            `Renderer failed to load (${(error as { code?: string }).code ?? "unknown"}): ${error.message}`,
            "",
            `Resolved filesystem path (${loadTarget}):`,
            packagedRendererPath,
            "",
            `Exists: ${rendererEntryExists}`,
            "",
            "Resolved file URL:",
            rendererEntryUrl,
            "",
            "Raw error:",
            String(error)
          ];

          if (isUncPath) {
            details.push(
              "",
              "Direct execution from a network-share path can still be blocked by Windows/Electron policy.",
              "If this persists, copy the full portable folder to a local drive and launch it there."
            );
          }

          dialog.showErrorBox("Renderer Load Failure", details.join("\n"));
        });
      });
  }
};

const runFfprobe = async (filePath: string): Promise<ProbeResult> => {
  const ffprobePath = resolveFfprobePath();
  const ffprobeCandidates = getFfprobeCandidates();
  logToRenderer({ level: "info", message: `Probe target file: ${filePath}` });
  logToRenderer({ level: "info", message: `App packaged: ${app.isPackaged}` });
  logToRenderer({ level: "info", message: `process.resourcesPath: ${process.resourcesPath}` });
  logToRenderer({ level: "info", message: `app.getAppPath(): ${app.getAppPath()}` });
  logToRenderer({ level: "info", message: `Resolved ffprobe path: ${ffprobePath}` });
  logToRenderer({
    level: "info",
    message: `ffprobe candidates: ${ffprobeCandidates.map((candidate) => `"${candidate}"`).join(", ")}`
  });

  const ffprobeIsPathLike = ffprobePath.includes(path.sep) || ffprobePath.includes("/");
  if (ffprobeIsPathLike) {
    try {
      await fs.access(ffprobePath);
      logToRenderer({
        level: "info",
        message: `Resolved ffprobe path is readable: "${ffprobePath}"`
      });
    } catch (error) {
      logToRenderer({
        level: "error",
        message: `Resolved ffprobe path is not readable: "${ffprobePath}" (${(error as Error).message})`
      });
    }
  } else {
    logToRenderer({
      level: "info",
      message: `Resolved ffprobe path is not a concrete filesystem path: "${ffprobePath}"`
    });
  }

  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath
  ];
  logToRenderer({ level: "info", message: `Spawning ffprobe with args: ${JSON.stringify(args)}` });

  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, args, { windowsHide: true });
    let output = "";
    let errorOutput = "";
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const finishWithSuccess = (result: ProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finishWithError(new Error(`ffprobe timed out after ${FFPROBE_TIMEOUT_MS}ms`));
    }, FFPROBE_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      logToRenderer({
        level: "info",
        message: `ffprobe close: code=${code ?? "null"} signal=${signal ?? "null"} stdout_len=${output.length} stderr_len=${errorOutput.length}`
      });
      if (code !== 0) {
        return finishWithError(
          new Error(
            `ffprobe exited with code ${code} (signal: ${signal ?? "none"}). stderr: ${errorOutput.trim() || "<empty>"}`
          )
        );
      }

      try {
        const parsed = JSON.parse(output);
        const audioTracks: AudioTrackInfo[] = [];
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];

        let audioIndex = 0;
        for (const stream of streams) {
          if (stream.codec_type !== "audio") {
            continue;
          }
          audioTracks.push({
            audioIndex,
            streamIndex: stream.index,
            codecName: stream.codec_name,
            channels: stream.channels,
            sampleRate: stream.sample_rate ? Number(stream.sample_rate) : undefined,
            bitRate: stream.bit_rate ? Number(stream.bit_rate) : undefined,
            tags: stream.tags
          });
          audioIndex += 1;
        }

        const duration = parsed.format?.duration
          ? Number(parsed.format.duration)
          : undefined;

        finishWithSuccess({
          filePath,
          duration,
          formatName: parsed.format?.format_name,
          formatLongName: parsed.format?.format_long_name,
          audioTracks
        });
      } catch (parseError) {
        const stdoutPreview = output.slice(0, 500).trim();
        const stderrPreview = errorOutput.slice(0, 500).trim();
        finishWithError(new Error(
          `Failed to parse ffprobe output: ${(parseError as Error).message}. ` +
          `stdout preview: ${stdoutPreview || "<empty>"}. stderr preview: ${stderrPreview || "<empty>"}`
        ));
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      finishWithError(new Error(formatBinaryError("ffprobe", error)));
    });
  });
};

const runFfmpegExtraction = async (
  request: ExtractTrackRequest
): Promise<ExtractTrackResponse> => {
  const ffmpegPath = resolveFfmpegPath();
  const outputDir = await ensureTempDir();
  const outputPath = path.join(outputDir, `track_${request.audioIndex}.wav`);

  logToRenderer({
    level: "info",
    message: `Extracting audio index ${request.audioIndex} to ${outputPath}`
  });

  const args = [
    "-y",
    "-i",
    request.filePath,
    "-map",
    `0:a:${request.audioIndex}`,
    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    "-progress",
    "pipe:1",
    "-nostats",
    outputPath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    let buffer = "";

    child.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "out_time_ms" && request.duration) {
          const ms = Number(value);
          const progress = Math.min(ms / (request.duration * 1000000), 1);
          const event: ExtractProgressEvent = {
            audioIndex: request.audioIndex,
            progress
          };
          sendToRenderer("extract-progress", event);
        }
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`ffmpeg exited with code ${code}. ${stderr.trim()}`)
        );
      }
      resolve({ audioIndex: request.audioIndex, outputPath });
    });

    child.on("error", (error) => reject(new Error(formatBinaryError("ffmpeg", error))));
  });
};


const teardownApp = async (reason: string) => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  isShuttingDown = true;
  shutdownPromise = (async () => {
    stopAllLiveDecoders(reason);
    await cleanupTempDir();
  })();

  try {
    await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }
};

initializePortablePaths();

app.on("ready", () => {
  createWindow();
  void cleanupStaleTempDirs();

  const portableInfo = getPortableModeInfo();
  if (portableInfo.enabled) {
    logToRenderer({
      level: "info",
      message: `Portable mode enabled at ${portableInfo.portableRoot}`
    });
  } else if (portableInfo.requested && portableInfo.disabledReason) {
    logToRenderer({
      level: "info",
      message:
        `Portable mode was requested but disabled because data folders are not writable at ` +
        `${portableInfo.dataRoot}: ${portableInfo.disabledReason}. Falling back to default app data paths.`
    });
  }

  void checkBinaryReadable("ffmpeg", resolveFfmpegPath());
  void checkBinaryReadable("ffprobe", resolveFfprobePath());

  ipcMain.handle("open-file", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Video Files", extensions: ["mp4", "mkv"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle("probe-file", async (_event, filePath: string) => {
    if (isShuttingDown) {
      throw new Error("App is shutting down");
    }
    try {
      await cleanupTempDir();
      stopAllLiveDecoders("file reprobe");
      const result = await runFfprobe(filePath);
      return result;
    } catch (error) {
      logToRenderer({
        level: "error",
        message: `Probe failed: ${(error as Error).message}`
      });
      return Promise.reject(error);
    }
  });

  ipcMain.handle("extract-track", async (_event, request: ExtractTrackRequest) => {
    try {
      const response = await runFfmpegExtraction(request);
      return response;
    } catch (error) {
      logToRenderer({
        level: "error",
        message: `Extraction failed: ${(error as Error).message}`
      });
      throw error;
    }
  });

  ipcMain.handle("start-live-decode", async (_event, request: StartLiveDecodeRequest) => {
    if (isShuttingDown) {
      return;
    }
    try {
      startLiveDecoder(request);
    } catch (error) {
      logToRenderer({
        level: "error",
        message: `start-live-decode failed for track ${request.audioIndex}: ${(error as Error).message}`
      });
      throw error;
    }
  });

  ipcMain.handle("stop-live-decode", async (_event, request: StopLiveDecodeRequest) => {
    stopLiveDecoder(request.audioIndex, "stop-live-decode");
  });

  ipcMain.handle("stop-all-live-decodes", async () => {
    stopAllLiveDecoders("stop-all-live-decodes");
  });

  ipcMain.handle("cleanup-temp", async () => {
    await cleanupTempDir();
  });
});

app.on("before-quit", () => {
  void teardownApp("before-quit");
});

app.on("window-all-closed", () => {
  void teardownApp("window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
