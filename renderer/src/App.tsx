import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type {
  AppStatus,
  AudioTrackInfo,
  ExtractProgressEvent,
  ExtractTrackResponse,
  ProbeResult
} from "@shared/types";

type TrackState = {
  info: AudioTrackInfo;
  enabled: boolean;
  muted: boolean;
  volume: number;
  extracting: boolean;
  progress: number;
  error?: string;
  outputPath?: string;
};

type AudioNodeState = {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
};

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

export const App = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioNodesRef = useRef<Map<number, AudioNodeState>>(new Map());

  const [status, setStatus] = useState<AppStatus>("Ready");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [tracks, setTracks] = useState<TrackState[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const enabledTracks = useMemo(
    () => tracks.filter((track) => track.enabled && track.outputPath),
    [tracks]
  );

  const ensureAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  };

  const resetAudioGraph = useCallback(() => {
    audioNodesRef.current.forEach((node) => {
      node.element.pause();
      node.source.disconnect();
      node.gain.disconnect();
    });
    audioNodesRef.current.clear();
    audioContextRef.current?.close();
    audioContextRef.current = null;
  }, []);

  const log = useCallback((message: string) => {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()} ${message}`]);
  }, []);

  const handleOpenFile = async () => {
    const selected = await window.api.openFile();
    if (!selected) return;

    setStatus("Probing");
    setFilePath(selected);
    setFileUrl(window.api.toFileUrl(selected));
    setProbeResult(null);
    setTracks([]);
    setLogs([]);
    resetAudioGraph();
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    try {
      const result = await window.api.probeFile(selected);
      setProbeResult(result);
      setDuration(result.duration ?? 0);
      setTracks(
        result.audioTracks.map((track) => ({
          info: track,
          enabled: false,
          muted: false,
          volume: 100,
          extracting: false,
          progress: 0
        }))
      );
      setStatus("Ready");
      log(`Probed ${result.audioTracks.length} audio track(s).`);
    } catch (error) {
      setStatus("Error");
      log(`Probe failed: ${(error as Error).message}`);
    }
  };

  const handleEnableTrack = async (audioIndex: number, enabled: boolean) => {
    setTracks((prev) =>
      prev.map((track) =>
        track.info.audioIndex === audioIndex
          ? { ...track, enabled, error: undefined }
          : track
      )
    );

    if (!enabled) {
      const node = audioNodesRef.current.get(audioIndex);
      if (node) {
        node.element.pause();
      }
      return;
    }

    const target = tracks.find((track) => track.info.audioIndex === audioIndex);
    if (!target || !filePath) return;

    let outputPath = target.outputPath;
    if (!outputPath) {
      setTracks((prev) =>
        prev.map((track) =>
          track.info.audioIndex === audioIndex
            ? { ...track, extracting: true, progress: 0 }
            : track
        )
      );
      setStatus("Extracting");
      try {
        const response: ExtractTrackResponse = await window.api.extractTrack({
          filePath,
          audioIndex,
          duration: probeResult?.duration
        });
        outputPath = response.outputPath;
        setTracks((prev) =>
          prev.map((track) =>
            track.info.audioIndex === audioIndex
              ? {
                  ...track,
                  extracting: false,
                  progress: 1,
                  outputPath
                }
              : track
          )
        );
        setStatus("Ready");
      } catch (error) {
        setTracks((prev) =>
          prev.map((track) =>
            track.info.audioIndex === audioIndex
              ? {
                  ...track,
                  extracting: false,
                  error: (error as Error).message
                }
              : track
          )
        );
        setStatus("Error");
        return;
      }
    }

    if (!outputPath) return;

    const audioContext = ensureAudioContext();
    const existing = audioNodesRef.current.get(audioIndex);
    if (!existing) {
      const audioElement = new Audio(window.api.toFileUrl(outputPath));
      audioElement.crossOrigin = "anonymous";
      audioElement.preload = "auto";
      audioElement.loop = false;
      audioElement.playbackRate = playbackRate;
      const source = audioContext.createMediaElementSource(audioElement);
      const gain = audioContext.createGain();
      source.connect(gain).connect(audioContext.destination);
      audioNodesRef.current.set(audioIndex, { element: audioElement, source, gain });
    }

    if (isPlaying) {
      syncAllAudioToVideo();
      await playAllEnabled();
    }
  };

  const updateTrackVolume = (audioIndex: number, volume: number) => {
    setTracks((prev) =>
      prev.map((track) =>
        track.info.audioIndex === audioIndex ? { ...track, volume } : track
      )
    );
    const node = audioNodesRef.current.get(audioIndex);
    if (node) {
      node.gain.gain.value = volume / 100;
    }
  };

  const toggleMute = (audioIndex: number) => {
    setTracks((prev) =>
      prev.map((track) =>
        track.info.audioIndex === audioIndex
          ? { ...track, muted: !track.muted }
          : track
      )
    );
    const node = audioNodesRef.current.get(audioIndex);
    const track = tracks.find((item) => item.info.audioIndex === audioIndex);
    if (node && track) {
      const nextMuted = !track.muted;
      node.gain.gain.value = nextMuted ? 0 : track.volume / 100;
    }
  };

  const syncAllAudioToVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    enabledTracks.forEach((track) => {
      const node = audioNodesRef.current.get(track.info.audioIndex);
      if (node) {
        node.element.currentTime = video.currentTime;
      }
    });
  };

  const playAllEnabled = async () => {
    const video = videoRef.current;
    if (!video) return;
    const nodes = enabledTracks
      .map((track) => audioNodesRef.current.get(track.info.audioIndex))
      .filter(Boolean) as AudioNodeState[];
    for (const node of nodes) {
      node.element.playbackRate = playbackRate;
      await node.element.play();
    }
  };

  const pauseAllEnabled = () => {
    enabledTracks.forEach((track) => {
      const node = audioNodesRef.current.get(track.info.audioIndex);
      if (node) {
        node.element.pause();
      }
    });
  };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await video.play();
      syncAllAudioToVideo();
      await playAllEnabled();
      setIsPlaying(true);
    } else {
      video.pause();
      pauseAllEnabled();
      setIsPlaying(false);
    }
  };

  const seekTo = async (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    pauseAllEnabled();
    video.currentTime = time;
    syncAllAudioToVideo();
    if (isPlaying) {
      await playAllEnabled();
    }
  };

  useEffect(() => {
    const disposeLog = window.api.onLog((event) => {
      log(`${event.level.toUpperCase()}: ${event.message}`);
    });
    const disposeProgress = window.api.onExtractProgress(
      (event: ExtractProgressEvent) => {
        setTracks((prev) =>
          prev.map((track) =>
            track.info.audioIndex === event.audioIndex
              ? { ...track, progress: event.progress }
              : track
          )
        );
      }
    );
    return () => {
      disposeLog();
      disposeProgress();
    };
  }, [log]);

  useEffect(() => {
    enabledTracks.forEach((track) => {
      const node = audioNodesRef.current.get(track.info.audioIndex);
      if (node) {
        node.gain.gain.value = track.muted ? 0 : track.volume / 100;
      }
    });
  }, [enabledTracks]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackRate;
    enabledTracks.forEach((track) => {
      const node = audioNodesRef.current.get(track.info.audioIndex);
      if (node) {
        node.element.playbackRate = playbackRate;
      }
    });
  }, [playbackRate, enabledTracks]);

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
    if (!isPlaying) return;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      enabledTracks.forEach((track) => {
        const node = audioNodesRef.current.get(track.info.audioIndex);
        if (!node) return;
        const drift = node.element.currentTime - video.currentTime;
        const abs = Math.abs(drift);
        if (abs > 0.25) {
          node.element.currentTime = video.currentTime;
          node.element.playbackRate = playbackRate;
          return;
        }
        if (abs > 0.08) {
          const correction = drift > 0 ? 0.97 : 1.03;
          node.element.playbackRate = playbackRate * correction;
        } else {
          node.element.playbackRate = playbackRate;
        }
      });
    }, 250);
    return () => window.clearInterval(interval);
  }, [enabledTracks, isPlaying, playbackRate]);

  useEffect(() => {
    return () => {
      window.api.cleanupTemp();
      resetAudioGraph();
    };
  }, [resetAudioGraph]);

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
                    handleEnableTrack(track.info.audioIndex, event.target.checked)
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
              {track.extracting && (
                <div className="progress">
                  Extracting... {Math.round(track.progress * 100)}%
                </div>
              )}
              {track.error && <div className="error">{track.error}</div>}
            </div>
          ))}
        </aside>

        <main className="player-panel">
          <div className="video-container">
            {fileUrl ? (
              <video ref={videoRef} src={fileUrl} muted />
            ) : (
              <div className="video-placeholder">No video loaded.</div>
            )}
          </div>
        </main>
      </div>

      <footer className="bottom-bar">
        <button className="primary" onClick={togglePlay} disabled={!fileUrl}>
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
          onChange={(event) => seekTo(Number(event.target.value))}
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
