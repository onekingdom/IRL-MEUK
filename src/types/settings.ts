export interface ObsSettings {
  host: string;
  port: number;
  password: string;
}

export interface SceneSettings {
  ok: string;
  fail: string;
  intro: string;
  bypass: string[];
  lowBitrateSuffix: string;
  lowBitrateEnabled: boolean;
  lbrBitrateThresholdKbps: number;
}

export interface StreamSettings {
  id: string;
  label: string;
  enabled: boolean;
  type: string;
  mediaSourceName: string;
  srtBindHost: string;
  srtPort: number;
  srtLatencyMs: number;
  frozenDetectSeconds: number;
  ristFailMode?: boolean;
}

export interface MonitorConfig {
  pollIntervalMs: number;
  streamFailDelaySeconds: number;
  recoveryDelaySeconds: number;
  frozenThresholdMs: number;
  mediaStateDebounceMs: number;
  relayWarmupSeconds: number;
  connectionsLog: boolean;
  cameraMeterGainDb: number;
}

export interface SrtLiveServerSettings {
  enabled: boolean;
  host: string;
  port: number;
  statsPath: string;
  publisherPath: string;
  bitrateLowKbps: number;
  bitrateFailKbps: number;
  pollIntervalSeconds: number;
}

export interface RelayConfig {
  enabled: boolean;
  listenPort: number;
  obsPort: number;
  ffmpegPath: string;
  startWithMonitoring: boolean;
  logLevel: string;
  obsLatencyMs?: number;
}

export interface StreamEndSettings {
  sceneName: string;
  delayMinutes: number;
}

export interface ServerSettings {
  host: string;
  port: number;
  lanHost?: string;
  wanHost?: string;
}

export interface Settings {
  server: ServerSettings;
  obs: ObsSettings;
  scenes: SceneSettings;
  streams: StreamSettings[];
  monitor: MonitorConfig;
  srtLiveServer: SrtLiveServerSettings;
  relay: RelayConfig;
  streamEnd: StreamEndSettings;
}

export interface RelaySrtLatencyResult {
  ingestMs: number;
  obsMs: number;
  ingestUs: number;
  obsUs: number;
}
