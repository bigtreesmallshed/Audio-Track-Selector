import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type {
  AppStatus,
  AudioTrackInfo,
  DecoderPcmEvent,
  ProbeResult
} from "@shared/types";

type TrackState = {
  info: AudioTrackInfo;
  enabled: boolean;
  muted: boolean;
  volume: number;
  error?: string;
};

type TrackAudioRuntime = {
  gain: GainNode;
  nextStartAtSec: number;
  scheduledSources: Set<AudioBufferSourceNode>;
};

const OUTPUT_SAMPLE_RATE = 48000;
const OUTPUT_CHANNELS = 2;
const START_SAFETY_SEC = 0.06;
const MAX_QUEUE_SEC = 0.75;

const formatTime = (value: number) => {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const buildTrackLabel = (track: AudioTrackInfo) => {
  const parts = [
    `Track ${track.audioIndex + 1} (Stream ${track.streamIndex})`
  ];
  if (track.codecName) parts.push(track.codecName);
  if (track.channels) parts.push(`${track.channels}ch`);
  if (track.sampleRate) parts.push(`${track.sampleRate}Hz`);
  if (track.bitRate) parts.push(`${Math.round(track.bitRate / 1000)}kbps`);
  if (track.tags?.title) parts.push(`“${track.tags.title}”`);
  if (track.tags?.language) parts.push(track.tags.language);
  return parts.join(" — ");
};

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName.toLowerCase();
  if (["input", "textarea", "select", "button", "option"].includes(tagName)) {
    return true;
  }
  return target.closest("input, textarea, select, button, [contenteditable='true']") !== null;
};

const decodePcmBase64ToAudioBuffer = (
  audioContext: AudioContext,
  event: DecoderPcmEvent
): AudioBuffer | null => {
  const binary = atob(event.pcmBase64);
  if (binary.length < 4) {
    return null;
  }

  const sampleCount = Math.floor(binary.length / (2 * OUTPUT_CHANNELS));
  if (sampleCount <= 0) {
    return null;
  }

  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i += 1) {
    const frameOffset = i * OUTPUT_CHANNELS * 2;

    const loL = binary.charCodeAt(frameOffset);
    const hiL = binary.charCodeAt(frameOffset + 1);
    let sampleL = (hiL << 8) | loL;
    if (sampleL >= 0x8000) sampleL -= 0x10000;
    left[i] = sampleL / 32768;

    const loR = binary.charCodeAt(frameOffset + 2);
    const hiR = binary.charCodeAt(frameOffset + 3);
    let sampleR = (hiR << 8) | loR;
    if (sampleR >= 0x8000) sampleR -= 0x10000;
    right[i] = sampleR / 32768;
  }

  const buffer = audioContext.createBuffer(OUTPUT_CHANNELS, sampleCount, event.sampleRate || OUTPUT_SAMPLE_RATE);
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  return buffer;
};

export const App = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const isPreviewHoveredRef = useRef(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const trackAudioRef = useRef<Map<number, TrackAudioRuntime>>(new Map());

  const [status, setStatus] = useState<AppStatus>("Ready");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [tracks, setTracks] = useState<TrackState[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const enabledTracks = useMemo(
    () => tracks.filter((track) => track.enabled),
    [tracks]
  );

  const log = useCallback((message: string) => {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} ${message}`]);
  }, []);

  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    }
    return audioContextRef.current;
  }, []);

  const clearTrackRuntime = useCallback((audioIndex: number) => {
    const runtime = trackAudioRef.current.get(audioIndex);
    if (!runtime) {
      return;
    }
    runtime.scheduledSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore stopped nodes
      }
      source.disconnect();
    });
    runtime.scheduledSources.clear();
    runtime.gain.disconnect();
    trackAudioRef.current.delete(audioIndex);
  }, []);

  const clearAllRuntime = useCallback(() => {
    trackAudioRef.current.forEach((_value, audioIndex) => {
      clearTrackRuntime(audioIndex);
    });
    audioContextRef.current?.close();
    audioContextRef.current = null;
  }, [clearTrackRuntime]);

  const ensureTrackRuntime = useCallback((audioIndex: number) => {
    const audioContext = ensureAudioContext();
    const existing = trackAudioRef.current.get(audioIndex);
    if (existing) {
      return existing;
    }

    const gain = audioContext.createGain();
    gain.connect(audioContext.destination);

    const runtime: TrackAudioRuntime = {
      gain,
      nextStartAtSec: audioContext.currentTime + START_SAFETY_SEC,
      scheduledSources: new Set()
    };

    trackAudioRef.current.set(audioIndex, runtime);
    return runtime;
  }, [ensureAudioContext]);

  const applyGainState = useCallback((audioIndex: number, volume: number, muted: boolean) => {
    const runtime = trackAudioRef.current.get(audioIndex);
    if (!runtime) {
      return;
    }
    runtime.gain.gain.value = muted ? 0 : volume / 100;
  }, []);

  const stopTrackDecoder = useCallback(async (audioIndex: number, reason: string) => {
    await window.api.stopLiveDecode({ audioIndex });
    clearTrackRuntime(audioIndex);
    log(`[renderer] track ${audioIndex} decoder stopped (${reason})`);
  }, [clearTrackRuntime, log]);

  const startTrackDecoder = useCallback(async (audioIndex: number, startTimeSec: number) => {
    if (!filePath) {
      return;
    }

    const clampedRate = playbackRate === 1 ? 1 : 1;
    if (playbackRate !== 1) {
      log(`[renderer] track ${audioIndex}: live audio currently forced to 1x.`);
    }

    const audioContext = ensureAudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const runtime = ensureTrackRuntime(audioIndex);
    runtime.nextStartAtSec = audioContext.currentTime + START_SAFETY_SEC;

    await window.api.startLiveDecode({
      filePath,
      audioIndex,
      startTimeSec,
      playbackRate: clampedRate
    });

    log(`[renderer] track ${audioIndex} decoder started at ${startTimeSec.toFixed(3)}s`);
  }, [ensureAudioContext, ensureTrackRuntime, filePath, log, playbackRate]);

  const restartEnabledDecoders = useCallback(async (startTimeSec: number, reason: string) => {
    const enabled = tracks.filter((track) => track.enabled);
    await window.api.stopAllLiveDecodes();
    enabled.forEach((track) => clearTrackRuntime(track.info.audioIndex));
    if (!isPlaying) {
      log(`[renderer] decoder restart skipped (${reason}) while paused.`);
      return;
    }

    for (const track of enabled) {
      await startTrackDecoder(track.info.audioIndex, startTimeSec);
      applyGainState(track.info.audioIndex, track.volume, track.muted);
    }

    if (enabled.length > 0) {
      setStatus("Streaming");
      log(`[renderer] restarted ${enabled.length} decoder(s) from ${startTimeSec.toFixed(3)}s (${reason})`);
    }
  }, [applyGainState, clearTrackRuntime, isPlaying, log, startTrackDecoder, tracks]);

  const handleOpenFile = async () => {
    const selected = await window.api.openFile();
    if (!selected) return;

    setStatus("Probing");
    setLastError(null);
    setFilePath(selected);
    setFileUrl(null);
    setProbeResult(null);
    setTracks([]);
    setLogs([]);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    await window.api.stopAllLiveDecodes();
    clearAllRuntime();

    try {
      setFileUrl(window.api.toFileUrl(selected));
      const result = await window.api.probeFile(selected);
      setProbeResult(result);
      setDuration(result.duration ?? 0);
      setTracks(
        result.audioTracks.map((track) => ({
          info: track,
          enabled: false,
          muted: false,
          volume: 100
        }))
      );
      setStatus("Ready");
      log(`Probed ${result.audioTracks.length} audio track(s).`);
    } catch (error) {
      const message = (error as Error).message;
      setStatus("Error");
      setLastError(message);
      setDetailsOpen(true);
      log(`Open/probe failed: ${message}`);
      console.error("Open/probe failed:", message);
    }
  };

  const handleEnableTrack = async (audioIndex: number, enabled: boolean) => {
    const video = videoRef.current;
    const track = tracks.find((item) => item.info.audioIndex === audioIndex);
    if (!track) {
      return;
    }

    setTracks((prev) => prev.map((item) => (
      item.info.audioIndex === audioIndex
        ? { ...item, enabled, error: undefined }
        : item
    )));

    if (!enabled) {
      await stopTrackDecoder(audioIndex, "track disabled");
      setStatus(tracks.some((item) => item.enabled && item.info.audioIndex !== audioIndex) ? "Streaming" : "Ready");
      return;
    }

    try {
      await startTrackDecoder(audioIndex, video?.currentTime ?? 0);
      applyGainState(audioIndex, track.volume, track.muted);
      if (isPlaying) {
        setStatus("Streaming");
      }
    } catch (error) {
      const message = (error as Error).message;
      setTracks((prev) => prev.map((item) => (
        item.info.audioIndex === audioIndex
          ? { ...item, enabled: false, error: message }
          : item
      )));
      setStatus("Error");
      setLastError(message);
    }
  };

  const updateTrackVolume = (audioIndex: number, volume: number) => {
    setTracks((prev) =>
      prev.map((track) =>
        track.info.audioIndex === audioIndex ? { ...track, volume } : track
      )
    );
    const currentTrack = tracks.find((track) => track.info.audioIndex === audioIndex);
    applyGainState(audioIndex, volume, currentTrack?.muted ?? false);
  };

  const toggleMute = (audioIndex: number) => {
    const current = tracks.find((track) => track.info.audioIndex === audioIndex);
    const nextMuted = !(current?.muted ?? false);

    setTracks((prev) =>
      prev.map((track) =>
        track.info.audioIndex === audioIndex
          ? { ...track, muted: nextMuted }
          : track
      )
    );

    if (current) {
      applyGainState(audioIndex, current.volume, nextMuted);
    }
  };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      await video.play();
      setIsPlaying(true);
      await restartEnabledDecoders(video.currentTime, "play");
    } else {
      video.pause();
      setIsPlaying(false);
      await window.api.stopAllLiveDecodes();
      enabledTracks.forEach((track) => clearTrackRuntime(track.info.audioIndex));
      setStatus("Ready");
      log("[renderer] paused and stopped all decoders.");
    }
  };

  const seekTo = async (time: number) => {
    const video = videoRef.current;
    if (!video) return;

    video.currentTime = time;
    setCurrentTime(time);
    await restartEnabledDecoders(time, "seek");
  };

  useEffect(() => {
    const disposeLog = window.api.onLog((event) => {
      log(`${event.level.toUpperCase()}: ${event.message}`);
    });

    const disposeDecoderStatus = window.api.onDecoderStatus((event) => {
      const message = `[decoder:${event.audioIndex}] ${event.message}`;
      log(message);
      if (event.level === "error") {
        setTracks((prev) => prev.map((track) => (
          track.info.audioIndex === event.audioIndex
            ? { ...track, enabled: false, error: event.message }
            : track
        )));
      }
    });

    const disposeDecoderPcm = window.api.onDecoderPcm((event) => {
      const audioContext = audioContextRef.current;
      if (!audioContext) {
        return;
      }

      const runtime = trackAudioRef.current.get(event.audioIndex);
      if (!runtime) {
        return;
      }

      const queueDepth = runtime.nextStartAtSec - audioContext.currentTime;
      if (queueDepth > MAX_QUEUE_SEC) {
        runtime.nextStartAtSec = audioContext.currentTime + START_SAFETY_SEC;
      }

      const buffer = decodePcmBase64ToAudioBuffer(audioContext, event);
      if (!buffer) {
        return;
      }

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(runtime.gain);

      const startAt = Math.max(audioContext.currentTime + START_SAFETY_SEC, runtime.nextStartAtSec);
      runtime.nextStartAtSec = startAt + buffer.duration;
      runtime.scheduledSources.add(source);
      source.onended = () => {
        source.disconnect();
        runtime.scheduledSources.delete(source);
      };
      source.start(startAt);
    });

    return () => {
      disposeLog();
      disposeDecoderStatus();
      disposeDecoderPcm();
    };
  }, [log]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (video.duration && Number.isFinite(video.duration)) {
        setDuration(video.duration);
      }
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("loadedmetadata", handleTimeUpdate);

    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("loadedmetadata", handleTimeUpdate);
    };
  }, [fileUrl]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") {
        return;
      }
      if (!isPreviewHoveredRef.current) {
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }

      const preview = videoContainerRef.current;
      if (!preview) {
        return;
      }

      event.preventDefault();
      if (document.fullscreenElement === preview) {
        void document.exitFullscreen();
      } else if (!document.fullscreenElement) {
        void preview.requestFullscreen();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    return () => {
      void window.api.stopAllLiveDecodes();
      window.api.cleanupTemp();
      clearAllRuntime();
    };
  }, [clearAllRuntime]);

  return (
    <div className="app">
      <header className="top-bar">
        <button className="primary" onClick={handleOpenFile}>
          Open File
        </button>
        <div className="file-info">
          <div className="file-name">
            {filePath ? filePath.split(/[/\\]/).pop() : "No file loaded"}
          </div>
          <div className={`status status-${status.toLowerCase()}`}>
            Status: {status}
          </div>
          {lastError && (
            <div className="error">Error: {lastError}</div>
          )}
        </div>
      </header>

      <div className="content">
        <aside className="track-panel">
          <h2>Audio Tracks</h2>
          {tracks.length === 0 && (
            <p className="empty">Open a video to see audio tracks.</p>
          )}
          {tracks.map((track) => (
            <div key={track.info.audioIndex} className="track-row">
              <label className="track-toggle">
                <input
                  type="checkbox"
                  checked={track.enabled}
                  onChange={(event) =>
                    void handleEnableTrack(track.info.audioIndex, event.target.checked)
                  }
                />
                <span>{buildTrackLabel(track.info)}</span>
              </label>
              <div className="track-controls">
                <button
                  className={track.muted ? "muted" : ""}
                  onClick={() => toggleMute(track.info.audioIndex)}
                  disabled={!track.enabled}
                >
                  {track.muted ? "Muted" : "Mute"}
                </button>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={track.volume}
                  onChange={(event) =>
                    updateTrackVolume(
                      track.info.audioIndex,
                      Number(event.target.value)
                    )
                  }
                  disabled={!track.enabled}
                />
                <span className="volume-value">{track.volume}%</span>
              </div>
              {track.error && <div className="error">{track.error}</div>}
            </div>
          ))}
        </aside>

        <main className="player-panel">
          <div
            className="video-container"
            ref={videoContainerRef}
            onMouseEnter={() => {
              isPreviewHoveredRef.current = true;
            }}
            onMouseLeave={() => {
              isPreviewHoveredRef.current = false;
            }}
          >
            {fileUrl ? (
              <video ref={videoRef} src={fileUrl} muted />
            ) : (
              <div className="video-placeholder">No video loaded.</div>
            )}
          </div>
        </main>
      </div>

      <footer className="bottom-bar">
        <button className="primary" onClick={() => void togglePlay()} disabled={!fileUrl}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <div className="time-info">
          {formatTime(currentTime)} / {formatTime(duration || 0)}
        </div>
        <input
          className="scrubber"
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={currentTime}
          onChange={(event) => void seekTo(Number(event.target.value))}
          disabled={!fileUrl}
        />
        <label className="rate">
          Speed
          <select
            value={playbackRate}
            onChange={(event) => setPlaybackRate(Number(event.target.value))}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <option key={rate} value={rate}>
                {rate}x
              </option>
            ))}
          </select>
        </label>
      </footer>

      <section className="details">
        <button
          className="details-toggle"
          onClick={() => setDetailsOpen((prev) => !prev)}
        >
          {detailsOpen ? "Hide Details" : "Show Details"}
        </button>
        {detailsOpen && (
          <div className="details-panel">
            <h3>Technical Details</h3>
            {probeResult && (
              <div className="probe-info">
                <div>Format: {probeResult.formatLongName}</div>
                <div>Duration: {probeResult.duration ?? 0}s</div>
                <div>Audio Tracks: {probeResult.audioTracks.length}</div>
              </div>
            )}
            <div className="log-list">
              {logs.length === 0 && <div className="empty">No logs yet.</div>}
              {logs.map((entry, index) => (
                <div key={`${entry}-${index}`} className="log-entry">
                  {entry}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
