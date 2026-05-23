import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { clampObsMul, mulToDisplayLevel } from '../relay/audio-meter';
import type { Settings } from '../types/settings';
import type {
  MediaStatus,
  ObsInputInfo,
  ObsStreamStatus,
  MediaFailResult,
  MediaFailOptions,
  ObsMeterEntry,
  EnsureMediaSourceResult,
} from '../types/obs';

const MEDIA_STATES: Record<string, string> = {
  OBS_MEDIA_STATE_NONE: 'none',
  OBS_MEDIA_STATE_PLAYING: 'playing',
  OBS_MEDIA_STATE_OPENING: 'opening',
  OBS_MEDIA_STATE_BUFFERING: 'buffering',
  OBS_MEDIA_STATE_PAUSED: 'paused',
  OBS_MEDIA_STATE_STOPPED: 'stopped',
  OBS_MEDIA_STATE_ENDED: 'ended',
  OBS_MEDIA_STATE_ERROR: 'error',
};

const FAIL_STATES = new Set(['stopped', 'ended', 'error', 'none']);

export class ObsClient {
  obs: OBSWebSocket;
  connected: boolean;
  config: Settings | null;
  private _meterByInput: Map<string, ObsMeterEntry>;
  private _meterListener: ((data: { inputs?: Array<{ inputName?: string; inputLevelsMul?: number[][] }> }) => void) | null;

  constructor() {
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.config = null;
    this._meterByInput = new Map();
    this._meterListener = null;
  }

  get wsUrl(): string {
    const { host, port } = this.config!.obs;
    return `ws://${host}:${port}`;
  }

  async connect(config: Settings): Promise<void> {
    this.config = config;
    if (this.connected) await this.disconnect();
    await this.obs.connect(this.wsUrl, config.obs.password || undefined, {
      rpcVersion: 1,
      eventSubscriptions: EventSubscription.InputVolumeMeters,
    });
    this.connected = true;
    this.attachMeterListener();
  }

  attachMeterListener(): void {
    if (this._meterListener) return;
    this._meterListener = (data) => {
      for (const input of data?.inputs ?? []) {
        const name = input?.inputName;
        if (!name) continue;
        const levels = input?.inputLevelsMul;
        if (!Array.isArray(levels) || !levels.length) continue;
        const parsed = this.parseObsInputLevels(levels, 0);
        this._meterByInput.set(name, {
          lMul: parsed.lMul,
          rMul: parsed.rMul,
          pMul: parsed.pMul,
          at: Date.now(),
        });
      }
    };
    this.obs.on('InputVolumeMeters', this._meterListener as Parameters<typeof this.obs.on>[1]);
  }

  parseObsInputLevels(levels: number[][], gainDb: number): { left: number; right: number; peak: number; lMul: number; rMul: number; pMul: number } {
    const row = (idx: number) => (Array.isArray(levels[idx]) ? levels[idx] : null);
    const magMul = (channelRow: number[] | null) => {
      if (!channelRow?.length) return 0;
      return clampObsMul(Number(channelRow[0]));
    };
    const peakMul = (channelRow: number[] | null) => {
      if (!channelRow?.length) return 0;
      const adj = clampObsMul(Number(channelRow[1] ?? channelRow[0]));
      const raw = clampObsMul(Number(channelRow[2] ?? channelRow[1] ?? channelRow[0]));
      return Math.max(adj, raw);
    };
    const lRow = row(0);
    const rRow = row(1) ?? lRow;
    const lMul = magMul(lRow);
    const rMul = magMul(rRow);
    const pMul = Math.max(peakMul(lRow), peakMul(rRow));
    const left = mulToDisplayLevel(lMul, gainDb);
    const right = mulToDisplayLevel(rMul, gainDb);
    const peak = mulToDisplayLevel(pMul, gainDb);
    return { left, right, peak, lMul, rMul, pMul };
  }

  getInputMeterLevels(
    inputName: string,
    maxAgeMs = 400,
    gainDb?: number,
  ): { left: number; right: number; peak: number; silent: boolean } | null {
    if (!inputName) return null;
    const m = this._meterByInput.get(inputName);
    if (!m || Date.now() - m.at > maxAgeMs) return null;
    const left = mulToDisplayLevel(m.lMul, gainDb);
    const right = mulToDisplayLevel(m.rMul, gainDb);
    const peak = mulToDisplayLevel(m.pMul, gainDb);
    return {
      left: Math.round(left * 1000) / 1000,
      right: Math.round(right * 1000) / 1000,
      peak: Math.round(peak * 1000) / 1000,
      silent: peak < 0.02 && left < 0.02 && right < 0.02,
    };
  }

  async disconnect(): Promise<void> {
    if (this._meterListener) {
      try {
        this.obs.off('InputVolumeMeters', this._meterListener as Parameters<typeof this.obs.off>[1]);
      } catch { /* ignore */ }
      this._meterListener = null;
    }
    this._meterByInput.clear();
    try {
      if (this.connected) await this.obs.disconnect();
    } catch { /* ignore */ }
    this.connected = false;
  }

  async getCurrentScene(): Promise<string> {
    const { currentProgramSceneName } = await this.obs.call('GetCurrentProgramScene');
    return currentProgramSceneName;
  }

  async getSceneList(): Promise<string[]> {
    const data = await this.obs.call('GetSceneList');
    return data.scenes.map((s) => s.sceneName as string);
  }

  async getInputList(): Promise<ObsInputInfo[]> {
    const data = await this.obs.call('GetInputList');
    return (data.inputs ?? []).map((i) => ({
      name: i.inputName as string,
      kind: (i.inputKind ?? i.unversionedInputKind ?? '') as string,
    }));
  }

  async setScene(sceneName: string): Promise<boolean> {
    if (!sceneName) return false;
    const current = await this.getCurrentScene();
    if (current === sceneName) return false;
    await this.obs.call('SetCurrentProgramScene', { sceneName });
    return true;
  }

  async getSceneItemSourceNames(sceneName: string): Promise<string[]> {
    const data = await this.obs.call('GetSceneItemList', { sceneName });
    return (data.sceneItems ?? [])
      .map((item) => (item.sourceName ?? item.sourceUuid) as string)
      .filter(Boolean);
  }

  async getSceneItemId(sceneName: string, sourceName: string): Promise<number | null> {
    const data = await this.obs.call('GetSceneItemList', { sceneName });
    const item = (data.sceneItems ?? []).find(
      (i) => (i.sourceName ?? i.sourceUuid) === sourceName,
    );
    return (item?.sceneItemId as number) ?? null;
  }

  async callObs(method: string, request: Record<string, unknown>, context?: string): Promise<unknown> {
    try {
      return await this.obs.call(method as Parameters<typeof this.obs.call>[0], request as Parameters<typeof this.obs.call>[1]);
    } catch (err) {
      const detail = this.formatObsError(err);
      console.error(`[OBS] ${method} failed${context ? ` (${context})` : ''}:`, detail);
      throw new Error(detail);
    }
  }

  mediaSourceSettings(srtUrl: string, options: { relayEnabled?: boolean } = {}): Record<string, unknown> {
    const relayMode = !!options.relayEnabled;
    return {
      is_local_file: false,
      input: srtUrl,
      restart_on_activate: false,
      reconnect_delay_sec: relayMode ? 2 : 1,
      buffering_mb: relayMode ? 1 : 2,
    };
  }

  async ensureMediaSourceInScene({
    sceneName,
    inputName,
    srtUrl,
  }: {
    sceneName: string;
    inputName: string;
    srtUrl: string;
  }): Promise<EnsureMediaSourceResult> {
    if (!sceneName?.trim()) throw new Error('Live / OK scene name is required');
    if (!inputName?.trim()) throw new Error('Media source name is required');
    if (!srtUrl?.trim()) throw new Error('SRT URL is required');

    const scenes = await this.getSceneList();
    if (!scenes.includes(sceneName)) {
      throw new Error(`Scene not found in OBS: "${sceneName}"`);
    }

    const inputs = await this.getInputList();
    const existing = inputs.find((i) => i.name === inputName);
    const settings = this.mediaSourceSettings(srtUrl.trim(), {
      relayEnabled: !!this.config?.relay?.enabled,
    });

    let created = false;
    let addedToScene = false;

    if (!existing) {
      await this.obs.call('CreateInput', {
        sceneName,
        inputName,
        inputKind: 'ffmpeg_source',
        inputSettings: settings as never,
        sceneItemEnabled: true,
      });
      created = true;
      addedToScene = true;
    } else {
      await this.obs.call('SetInputSettings', { inputName, inputSettings: settings as never, overlay: true });
      const inScene = (await this.getSceneItemSourceNames(sceneName)).includes(inputName);
      if (!inScene) {
        await this.obs.call('CreateSceneItem', { sceneName, sourceName: inputName, sceneItemEnabled: true });
        addedToScene = true;
      }
    }

    return { created, addedToScene, updated: !created, sceneName, inputName };
  }

  async renameMediaSource(
    oldName: string,
    newName: string,
  ): Promise<{ renamed: boolean; unchanged?: boolean; missing?: boolean; inputName: string; oldName: string }> {
    this.assertReady();
    const oldInputName = String(oldName ?? '').trim();
    const newInputName = String(newName ?? '').trim();
    if (!oldInputName || !newInputName) throw new Error('Old and new media source names are required');
    if (oldInputName === newInputName) {
      return { renamed: false, unchanged: true, inputName: newInputName, oldName: oldInputName };
    }
    const inputs = await this.getInputList();
    if (!inputs.some((i) => i.name === oldInputName)) {
      return { renamed: false, missing: true, inputName: newInputName, oldName: oldInputName };
    }
    if (inputs.some((i) => i.name === newInputName)) {
      throw new Error(`OBS input already exists: "${newInputName}"`);
    }
    await this.obs.call('SetInputName', { inputName: oldInputName, newInputName });
    return { renamed: true, inputName: newInputName, oldName: oldInputName };
  }

  async updateMediaSourceUrlIfExists(
    inputName: string,
    srtUrl: string,
  ): Promise<{ updated: boolean; missing?: boolean; inputName: string; srtUrl?: string }> {
    if (!inputName?.trim()) throw new Error('Media source name is required');
    if (!srtUrl?.trim()) throw new Error('SRT URL is required');
    const inputs = await this.getInputList();
    const existing = inputs.find((i) => i.name === inputName);
    if (!existing) return { updated: false, missing: true, inputName };
    const updateSettings = this.mediaSourceSettings(srtUrl.trim(), {
      relayEnabled: !!this.config?.relay?.enabled,
    });
    await this.obs.call('SetInputSettings', {
      inputName,
      inputSettings: updateSettings as never,
      overlay: true,
    });
    return { updated: true, missing: false, inputName, srtUrl: srtUrl.trim() };
  }

  static async withTemporaryConnection<T>(
    config: Settings,
    fn: (client: ObsClient) => Promise<T>,
  ): Promise<T> {
    const client = new ObsClient();
    await client.connect(config);
    try {
      return await fn(client);
    } finally {
      await client.disconnect();
    }
  }

  normalizeMediaState(state: string): string {
    if (typeof state === 'string' && state.startsWith('OBS_MEDIA_STATE_')) {
      return MEDIA_STATES[state] ?? state.replace('OBS_MEDIA_STATE_', '').toLowerCase();
    }
    return String(state ?? 'unknown').toLowerCase();
  }

  async getMediaStatus(sourceName: string): Promise<MediaStatus> {
    const data = await this.obs.call('GetMediaInputStatus', { inputName: sourceName });
    return {
      mediaState: this.normalizeMediaState(data.mediaState as string),
      mediaCursor: (data.mediaCursor as number) ?? 0,
      mediaDuration: (data.mediaDuration as number) ?? 0,
    };
  }

  async getStreamStatus(): Promise<ObsStreamStatus> {
    const data = await this.obs.call('GetStreamStatus');
    return {
      outputActive: data?.outputActive === true,
      outputReconnecting: data?.outputReconnecting === true,
    };
  }

  assertReady(): void {
    if (!this.connected || !this.obs.identified) {
      throw new Error('OBS WebSocket not connected — use Connect OBS in settings');
    }
  }

  formatObsError(err: unknown): string {
    const e = err as { code?: unknown; message?: string };
    const code = e?.code;
    const msg = e?.message ?? String(err);
    if (code != null && code !== '') return `OBS error (${code}): ${msg}`;
    return msg || 'OBS request failed';
  }

  async resolveStreamOutputName(): Promise<string | null> {
    const data = await this.obs.call('GetOutputList');
    const outputs = (data?.outputs ?? []) as Array<{ outputKind?: string; outputName?: string }>;
    const streamOutputs = outputs.filter((o) => {
      const kind = String(o.outputKind ?? '').toLowerCase();
      const name = String(o.outputName ?? '').toLowerCase();
      return kind.includes('stream') || name === 'adv_stream';
    });
    const pick =
      streamOutputs.find((o) => String(o.outputName).toLowerCase() === 'adv_stream') ??
      streamOutputs[0];
    return pick?.outputName ?? null;
  }

  async waitForStreamActive({ timeoutMs = 8000, intervalMs = 200 } = {}): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getStreamStatus();
      if (status.outputActive) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  async startStream(): Promise<void> {
    this.assertReady();
    try {
      await this.obs.call('StartStream');
      return;
    } catch (err) {
      const outputName = await this.resolveStreamOutputName().catch(() => null);
      if (outputName) {
        try {
          await this.obs.call('StartOutput', { outputName });
          return;
        } catch (fallbackErr) {
          throw new Error(this.formatObsError(fallbackErr));
        }
      }
      throw new Error(this.formatObsError(err));
    }
  }

  async stopStream(): Promise<void> {
    this.assertReady();
    try {
      await this.obs.call('StopStream');
    } catch (err) {
      throw new Error(this.formatObsError(err));
    }
  }

  async getInputMute(sourceName: string): Promise<boolean> {
    this.assertReady();
    const inputName = String(sourceName ?? '').trim();
    if (!inputName) throw new Error('Media source name is required');
    const data = await this.obs.call('GetInputMute', { inputName });
    return data?.inputMuted === true;
  }

  async toggleInputMute(sourceName: string): Promise<{ inputMuted: boolean }> {
    this.assertReady();
    const inputName = String(sourceName ?? '').trim();
    if (!inputName) throw new Error('Media source name is required');
    try {
      const data = await this.obs.call('ToggleInputMute', { inputName });
      return { inputMuted: data?.inputMuted === true };
    } catch (err) {
      throw new Error(this.formatObsError(err));
    }
  }

  isMediaFailed(
    status: MediaStatus,
    stream: { frozenDetectSeconds: number; ristFailMode?: boolean },
    frozenMs: number,
    options: MediaFailOptions = {},
  ): MediaFailResult {
    const state = options.debouncedState ?? status.mediaState;
    const relayIngestOk = !!options.relayConnected;
    const inWarmup = !!options.inRelayWarmup;

    if (inWarmup && ['ended', 'opening', 'buffering', 'none'].includes(state)) {
      return { failed: false, reason: null };
    }
    if (options.relayEnabled && relayIngestOk && ['ended', 'stopped', 'none'].includes(state)) {
      return { failed: false, reason: null };
    }
    if (FAIL_STATES.has(state)) return { failed: true, reason: `media-${state}` };
    if (state === 'playing' && frozenMs >= stream.frozenDetectSeconds * 1000) {
      if (options.relayEnabled && relayIngestOk) return { failed: false, reason: null };
      return { failed: true, reason: 'media-frozen' };
    }
    if (stream.ristFailMode && state === 'buffering') {
      return { failed: true, reason: 'media-buffering-rist' };
    }
    return { failed: false, reason: null };
  }

  isMediaLowBitrate(bitrateKbps: number, settings: Settings): boolean {
    if (!settings.relay?.enabled || bitrateKbps == null) return false;
    const threshold =
      settings.scenes?.lbrBitrateThresholdKbps ??
      settings.srtLiveServer?.bitrateLowKbps ??
      800;
    return bitrateKbps > 0 && bitrateKbps < threshold;
  }

  isBitrateFailed(bitrateKbps: number, settings: Settings): boolean {
    const thresholds = settings.srtLiveServer;
    if (!settings.relay?.enabled || bitrateKbps == null || !thresholds) return false;
    return bitrateKbps < thresholds.bitrateFailKbps;
  }
}

export { FAIL_STATES };
