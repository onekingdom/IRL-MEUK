export interface MediaStatus {
  mediaState: string;
  mediaCursor: number;
  mediaDuration: number;
}

export interface ObsInputInfo {
  name: string;
  kind: string;
}

export interface ObsStreamStatus {
  outputActive: boolean;
  outputReconnecting: boolean;
}

export interface MediaFailResult {
  failed: boolean;
  reason: string | null;
}

export interface MediaFailOptions {
  debouncedState?: string;
  relayEnabled?: boolean;
  relayConnected?: boolean;
  inRelayWarmup?: boolean;
}

export interface ObsMeterEntry {
  lMul: number;
  rMul: number;
  pMul: number;
  at: number;
}

export interface MediaSourceOptions {
  relayEnabled?: boolean;
}

export interface EnsureMediaSourceResult {
  created: boolean;
  addedToScene: boolean;
  updated: boolean;
  sceneName: string;
  inputName: string;
}
