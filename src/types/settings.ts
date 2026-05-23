export interface RelayConfig {
  listenPort: number;
  obsPort: number;
  ffmpegPath: string;
  logLevel: string;
  obsLatencyMs?: number;
}

export interface Settings {
  relay: RelayConfig;
  streams: Array<{ srtLatencyMs?: number }>;
}

export interface RelaySrtLatencyResult {
  ingestMs: number;
  obsMs: number;
  ingestUs: number;
  obsUs: number;
}
