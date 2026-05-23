export interface RelayStats {
  relayActive: boolean;
  relayConnected: boolean;
  previewActive: boolean;
  relayBitrateKbps: number | null;
  relayUptimeMs: number;
  relayBytesReceived: number;
  relayFps: number | null;
  relayError: string | null;
}

export type AudioTrackStatus = 'unknown' | 'none' | 'silent' | 'active' | 'parse-fail';

export interface AudioLevels {
  left: number;
  right: number;
  peak: number;
  silent: boolean;
  audioTrack: AudioTrackStatus;
  meterSource?: string;
  meterHint?: string;
  meterDebug?: string;
}

export interface RelayStatsWithAudio extends RelayStats {
  audioLevels: AudioLevels;
}

export interface PeakHold {
  left: number;
  right: number;
  peak: number;
}

export interface ProcessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  wasRunning: boolean;
}

export interface FfmpegCandidate {
  path: string;
  source: string;
}

export interface FfmpegProbeResult {
  ok: boolean;
  versionLine: string | null;
  error: string | null;
}

export interface RelaySrtLatency {
  ingestMs: number;
  obsMs: number;
  ingestUs: number;
  obsUs: number;
}

export type RelayLogLevel = 'quiet' | 'info' | 'verbose';
