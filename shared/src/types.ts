export type AppStatus = "Ready" | "Probing" | "Extracting" | "Error";

export interface AudioTrackInfo {
  audioIndex: number;
  streamIndex: number;
  codecName?: string;
  channels?: number;
  sampleRate?: number;
  bitRate?: number;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  filePath: string;
  duration?: number;
  formatName?: string;
  formatLongName?: string;
  audioTracks: AudioTrackInfo[];
}

export interface ExtractTrackRequest {
  filePath: string;
  audioIndex: number;
  duration?: number;
}

export interface ExtractTrackResponse {
  audioIndex: number;
  outputPath: string;
}

export interface ExtractProgressEvent {
  audioIndex: number;
  progress: number;
}

export interface LogEvent {
  level: "info" | "error";
  message: string;
}
