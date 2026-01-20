import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import type {
  AudioTrackInfo,
  ExtractProgressEvent,
  ExtractTrackRequest,
  ExtractTrackResponse,
  LogEvent,
  ProbeResult
} from "@shared/types";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;
let tempDir: string | null = null;

const logToRenderer = (event: LogEvent) => {
  if (mainWindow) {
    mainWindow.webContents.send("log", event);
  }
};

const resolveBinary = (candidate: string | null | undefined, fallbackName: string) => {
  if (candidate && candidate.length > 0) {
    return candidate;
  }
  return fallbackName;
};

const getFfprobePath = () => resolveBinary(ffprobeStatic as string | null, "ffprobe");
const getFfmpegPath = () => resolveBinary(ffmpegStatic as string | null, "ffmpeg");

const ensureTempDir = async () => {
  if (tempDir) {
    return tempDir;
  }
  const base = path.join(os.tmpdir(), "audio-track-selector-");
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

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../renderer/dist/index.html"));
  }
};

const runFfprobe = async (filePath: string): Promise<ProbeResult> => {
  const ffprobePath = getFfprobePath();
  logToRenderer({ level: "info", message: `Running ffprobe: ${ffprobePath}` });

  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, args);
    let output = "";
    let errorOutput = "";

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `ffprobe exited with code ${code}. ${errorOutput.trim()}`
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

        resolve({
          filePath,
          duration,
          formatName: parsed.format?.format_name,
          formatLongName: parsed.format?.format_long_name,
          audioTracks
        });
      } catch (parseError) {
        reject(parseError);
      }
    });

    child.on("error", (error) => reject(error));
  });
};

const runFfmpegExtraction = async (
  request: ExtractTrackRequest
): Promise<ExtractTrackResponse> => {
  const ffmpegPath = getFfmpegPath();
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
    const child = spawn(ffmpegPath, args);
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
          if (mainWindow) {
            mainWindow.webContents.send("extract-progress", event);
          }
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

    child.on("error", (error) => reject(error));
  });
};

app.on("ready", () => {
  createWindow();

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
    await cleanupTempDir();
    try {
      const result = await runFfprobe(filePath);
      return result;
    } catch (error) {
      logToRenderer({
        level: "error",
        message: `Probe failed: ${(error as Error).message}`
      });
      throw error;
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

  ipcMain.handle("cleanup-temp", async () => {
    await cleanupTempDir();
  });
});

app.on("before-quit", async () => {
  await cleanupTempDir();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
