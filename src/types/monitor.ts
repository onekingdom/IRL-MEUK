import type { AudioLevels } from './relay';

export type SceneMode =
  | 'stopped'
  | 'idle'
  | 'intro'
  | 'ok'
  | 'fail'
  | 'low-bitrate'
  | 'bypass'
  | 'waiting';

export interface StreamResult {
  label: string;
  healthy: boolean;
  failed: boolean;
  lowBitrate: boolean;
  reason: string | null;
  mediaState: string | null;
  mediaStateRaw: string | null;
  mediaStateDebounced?: boolean;
  mediaCursor: number | null;
  frozenMs: number;
}

export interface SessionStats {
  brbSwitchCount: number;
  okSwitchCount: number;
  lbrSwitchCount: number;
  introSwitchCount: number;
  totalAutoSwitches: number;
  totalFailEvents: number;
}

export interface LastSceneChange {
  at: string;
  scene: string;
  mode: SceneMode;
}

export interface StreamSummary {
  label: string;
  mediaState: string | null;
  mediaStateRaw: string | null;
  frozenMs: number;
  healthy: boolean;
  failed: boolean;
  reason: string | null;
  srtLatencyMs: number | null;
  relayIngest: 'connected' | 'waiting' | 'off' | null;
}

export interface MonitorState {
  monitoringActive: boolean;
  obsSessionActive: boolean;
  obsConnected: boolean;
  obsOutputActive: boolean;
  obsOutputReconnecting: boolean;
  obsError: string | null;
  mediaSourceName: string;
  currentScene: string | null;
  targetScene: string | null;
  mode: SceneMode;
  bypassActive: boolean;
  relayEnabled: boolean;
  relayActive: boolean;
  relayConnected: boolean;
  relayBitrateKbps: number | null;
  relayUptimeMs: number;
  relayBytesReceived: number;
  totalBytesIngested: number;
  relayFps: number | null;
  relayError: string | null;
  previewActive: boolean;
  cameraAudioLevels: AudioLevels;
  streams: Record<string, StreamResult>;
  streamSummary: StreamSummary | null;
  lastChangeAt: string | null;
  lastSceneChange: LastSceneChange | null;
  startedAt: string | null;
  stats: SessionStats;
  streamEndPending: boolean;
  streamEndAt: string | null;
  streamEndSceneName: string | null;
  mediaInputMuted: boolean | null;
}

export interface MediaDebounceTrack {
  stable: string;
  candidate: string;
  candidateSince: number;
}

export interface CursorHistoryEntry {
  cursor: number;
  since: number;
}
