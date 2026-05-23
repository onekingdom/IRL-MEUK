import { resolveMeterGainDb } from './relay/audio-meter';
import { ObsClient } from './obs/obs-client';
import { SrtRelay } from './relay/srt-relay';
import { appendLog, buildObsSrtUrl, MEDIA_SOURCE_NAME } from './server/config';
import { resolveFfmpegPath } from './relay/ffmpeg-path';
import { relayLogsInfo, resolveRelayLogLevel } from './relay/relay-log';
import type { Settings, StreamSettings } from './types/settings';
import type { AudioLevels, RelayStatsWithAudio } from './types/relay';
import type { MonitorState, StreamResult, SceneMode } from './types/monitor';
import type { EnsureMediaSourceResult } from './types/obs';

const RELAY_OBS_GLITCH_STATES = new Set(['ended', 'stopped', 'none']);

interface MediaDebounceTrack {
  stable: string;
  candidate: string;
  candidateSince: number;
}

interface CursorHistoryEntry {
  cursor: number;
  since: number;
}

export class StreamMonitor {
  obs: ObsClient;
  relay: SrtRelay;
  settings: Settings | null = null;
  running = false;
  obsSession = false;
  monitoringOwnedObs = false;
  timer: ReturnType<typeof setInterval> | null = null;
  obsSceneTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<(state: MonitorState) => void> = new Set();

  state: MonitorState;

  private _streamEndTimer: ReturnType<typeof setTimeout> | null = null;
  private _failSince: number | null = null;
  private _okSince: number | null = null;
  private _cursorHistory: Map<string, CursorHistoryEntry> = new Map();
  private _mediaDebounce: Map<string, MediaDebounceTrack> = new Map();
  private _monitoringStartedAt: number | null = null;
  private _relayWarmupUntil = 0;
  private _relayRestartAt = 0;
  private _relayRestartInFlight = false;
  private _relayRestartBackoffMs = 2000;
  private _lastDataAccumAt: number | null = null;
  private _lastIngestKbps: number | null = null;

  constructor() {
    this.obs = new ObsClient();
    this.relay = new SrtRelay();
    this.relay.onStats = (stats: RelayStatsWithAudio) => this.applyRelayStats(stats);

    this.state = {
      monitoringActive: false,
      obsSessionActive: false,
      obsConnected: false,
      obsOutputActive: false,
      obsOutputReconnecting: false,
      obsError: null,
      mediaSourceName: '',
      currentScene: null,
      targetScene: null,
      mode: 'stopped',
      bypassActive: false,
      relayEnabled: false,
      relayActive: false,
      relayConnected: false,
      relayBitrateKbps: null,
      relayUptimeMs: 0,
      relayBytesReceived: 0,
      totalBytesIngested: 0,
      relayFps: null,
      relayError: null,
      previewActive: false,
      cameraAudioLevels: { left: 0, right: 0, peak: 0, silent: true, audioTrack: 'unknown' },
      streams: {},
      streamSummary: null,
      lastChangeAt: null,
      lastSceneChange: null,
      startedAt: null,
      stats: {
        brbSwitchCount: 0,
        okSwitchCount: 0,
        lbrSwitchCount: 0,
        introSwitchCount: 0,
        totalAutoSwitches: 0,
        totalFailEvents: 0,
      },
      streamEndPending: false,
      streamEndAt: null,
      streamEndSceneName: null,
      mediaInputMuted: null,
    };

    this.relay.onProcessExit = () => {
      if (this.running && this.settings?.relay?.enabled) {
        this.scheduleRelayRestart(0);
      }
    };
  }

  onUpdate(fn: (state: MonitorState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    this.state.monitoringActive = this.running;
    const snapshot = structuredClone(this.state);
    for (const fn of this.listeners) fn(snapshot);
  }

  primaryMediaSourceName(): string {
    const stream = this.settings?.streams?.find((s) => s.enabled) ?? this.settings?.streams?.[0];
    return stream?.mediaSourceName ?? '';
  }

  syncMediaSourceInState(): void {
    this.state.mediaSourceName = this.primaryMediaSourceName();
  }

  syncSettingsFlags(): void {
    this.state.relayEnabled = !!this.settings?.relay?.enabled;
  }

  meterGainDb(): number {
    return resolveMeterGainDb(this.settings ?? undefined);
  }

  isCameraSourcePlaying(): boolean {
    const name = (this.primaryMediaSourceName() || MEDIA_SOURCE_NAME).trim();
    if (!name) return false;
    for (const stream of this.settings?.streams ?? []) {
      if (!stream.enabled || stream.type !== 'obs-media') continue;
      const src = (stream.mediaSourceName || MEDIA_SOURCE_NAME).trim();
      if (src !== name) continue;
      const ev = this.state.streams?.[stream.id];
      if (ev?.mediaState === 'playing') return true;
    }
    return false;
  }

  resolveCameraAudioLevels(relayLevels: AudioLevels | null = null): AudioLevels {
    const relay = relayLevels ?? this.relay.getAudioLevels();
    const relayConnected = this.state.relayConnected ?? this.relay.getStats().relayConnected;
    const relayHealthy = relayConnected && this.relay.relayMetersHealthy();
    const gainDb = this.meterGainDb();

    const inputName = (this.primaryMediaSourceName() || MEDIA_SOURCE_NAME).trim();
    const obsLevels =
      this.state.obsConnected && inputName
        ? this.obs.getInputMeterLevels(inputName, 600, gainDb)
        : null;
    const camPlaying = this.isCameraSourcePlaying();

    const obsOut = (hint?: string): AudioLevels => ({
      left: obsLevels!.left,
      right: obsLevels!.right,
      peak: obsLevels!.peak,
      silent: obsLevels!.silent,
      audioTrack: obsLevels!.silent ? 'silent' : 'active',
      meterSource: 'obs',
      ...(hint ? { meterHint: hint } : {}),
    });

    if (obsLevels && this.state.obsConnected && camPlaying) {
      const relayBroken = relay.audioTrack === 'parse-fail' || !relayHealthy;
      let hint: string | undefined;
      if (relayBroken && relay.meterDebug) {
        hint = `Source: OBS (${relay.meterDebug})`;
      } else if (relay.audioTrack === 'none') {
        hint = 'Source: OBS — no audio track on phone relay';
      } else {
        hint = 'Source: OBS';
      }
      return obsOut(hint);
    }

    if (relayHealthy && relay.audioTrack !== 'parse-fail') {
      return { ...relay, meterSource: 'relay', meterHint: 'Source: Relay' };
    }

    if (obsLevels) {
      const relayNoTrack = relay.audioTrack === 'none';
      const relayBroken = relay.audioTrack === 'parse-fail' || !relayHealthy;
      let hint: string | undefined;
      if ((relayNoTrack || relayBroken) && !obsLevels.silent) {
        hint = 'Source: OBS — audio on OBS; enable audio on phone for relay meters';
      } else if (relayBroken && relay.meterDebug) {
        hint = `Source: OBS (${relay.meterDebug})`;
      } else {
        hint = 'Source: OBS';
      }
      return obsOut(hint);
    }

    if (relayConnected) {
      return {
        ...relay,
        meterSource: 'relay',
        meterHint: relay.audioTrack === 'parse-fail' ? relay.meterDebug : 'Source: Relay',
      };
    }

    return { ...relay, meterSource: 'none' };
  }

  getCameraAudioLevels(): AudioLevels {
    return this.resolveCameraAudioLevels();
  }

  applyRelayStats(stats: RelayStatsWithAudio): void {
    const wasConnected = this.state.relayConnected;
    this.state.relayActive = stats.relayActive;
    this.state.relayConnected = stats.relayConnected;
    this.state.relayBitrateKbps = stats.relayBitrateKbps;
    this.state.relayUptimeMs = stats.relayUptimeMs ?? 0;
    this.state.relayBytesReceived = stats.relayBytesReceived ?? 0;
    this.state.relayFps = stats.relayFps;
    this.state.relayError = stats.relayError;
    this.state.previewActive = stats.previewActive;
    this.state.cameraAudioLevels = this.resolveCameraAudioLevels(stats.audioLevels);
    if (!wasConnected && stats.relayConnected) {
      const kbps = stats.relayBitrateKbps != null ? ` (${stats.relayBitrateKbps} kbps)` : '';
      console.log(`[relay] phone connected${kbps}`);
      this.onRelayIngestRecovered();
    } else if (wasConnected && !stats.relayConnected && stats.relayActive) {
      console.log('[relay] phone disconnected');
    }
    this.emit();
  }

  private onRelayIngestRecovered(): void {
    this._failSince = null;
    this._cursorHistory.clear();
  }

  scheduleRelayRestart(delayMs = 0): void {
    this._relayRestartAt = Math.min(this._relayRestartAt, Date.now() + delayMs);
    this.ensureRelayRunning().catch((err: Error) => {
      console.error('[relay] auto-restart failed:', err?.message ?? err);
    });
  }

  private markRelayWarmup(): void {
    const warmupMs = Math.max(0, (this.settings?.monitor?.relayWarmupSeconds ?? 10) * 1000);
    this._relayWarmupUntil = warmupMs ? Date.now() + warmupMs : 0;
  }

  async ensureRelayRunning(): Promise<void> {
    if (!this.running || !this.settings?.relay?.enabled) return;
    if (this.relay.isRunning() || this._relayRestartInFlight) return;
    const now = Date.now();
    if (now < this._relayRestartAt) return;

    this._relayRestartInFlight = true;
    const ffmpegPath = resolveFfmpegPath(this.settings);
    if (relayLogsInfo(resolveRelayLogLevel(this.settings))) {
      console.log('[relay] auto-restarting ffmpeg:', ffmpegPath);
    }
    try {
      await this.relay.start(this.settings);
      this.applyRelayStats(this.relay.getStats());
      this._relayRestartBackoffMs = 2000;
      this._relayRestartAt = now + 1500;
      this.markRelayWarmup();
      const { listenPort, obsPort } = this.relay.resolvePorts(this.settings);
      console.log(`[relay] ffmpeg running — phone → UDP ${listenPort} | OBS caller → 127.0.0.1:${obsPort} | binary: ${ffmpegPath}`);
      if (this.state.relayError) {
        console.error('[relay] restart error:', this.state.relayError);
      }
    } catch (err) {
      this.state.relayError = (err as Error).message;
      const backoff = Math.min(30000, this._relayRestartBackoffMs);
      this._relayRestartBackoffMs = Math.min(30000, Math.round(backoff * 1.5));
      this._relayRestartAt = now + backoff;
      console.error('[relay] auto-restart failed:', (err as Error).message);
      const tail = this.relay.getRecentStderr();
      if (tail.length) console.error('[relay] stderr:', tail.join(' | '));
      this.emit();
    } finally {
      this._relayRestartInFlight = false;
    }
  }

  ingestBitrateKbps(): number | null {
    return this.effectiveIngestKbps();
  }

  private effectiveIngestKbps(): number | null {
    if (this.settings?.relay?.enabled) {
      if (this.state.relayConnected && this.state.relayBitrateKbps != null) {
        this._lastIngestKbps = this.state.relayBitrateKbps;
        return this.state.relayBitrateKbps;
      }
      if (this._lastIngestKbps != null) return this._lastIngestKbps;
      return null;
    }
    const streams = this.state.streams ?? {};
    for (const ev of Object.values(streams)) {
      const kbps = (ev as { streamBitrateKbps?: number })?.streamBitrateKbps;
      if (Number.isFinite(kbps) && (kbps as number) > 0) return kbps as number;
    }
    return null;
  }

  private resetSrtDataUsage(): void {
    this.state.totalBytesIngested = 0;
    this._lastDataAccumAt = null;
    this._lastIngestKbps = null;
  }

  private accumulateSrtDataUsage(now = Date.now()): void {
    if (!this.running) return;
    if (!this._lastDataAccumAt) {
      this._lastDataAccumAt = now;
      return;
    }
    const elapsedSec = (now - this._lastDataAccumAt) / 1000;
    this._lastDataAccumAt = now;
    if (elapsedSec <= 0) return;

    const kbps = this.effectiveIngestKbps();
    if (kbps == null || kbps <= 0) return;

    this.state.totalBytesIngested += ((kbps * 1000) / 8) * elapsedSec;
  }

  private resetSessionStats(): void {
    this.state.stats = {
      brbSwitchCount: 0,
      okSwitchCount: 0,
      lbrSwitchCount: 0,
      introSwitchCount: 0,
      totalAutoSwitches: 0,
      totalFailEvents: 0,
    };
    this.state.lastSceneChange = null;
    this.state.lastChangeAt = null;
    this.resetSrtDataUsage();
  }

  private recordAutoSceneSwitch(mode: SceneMode, sceneName: string): void {
    const at = new Date().toISOString();
    this.state.lastChangeAt = at;
    this.state.lastSceneChange = { at, scene: sceneName, mode };
    const stats = this.state.stats;
    stats.totalAutoSwitches += 1;
    if (mode === 'fail') {
      stats.brbSwitchCount += 1;
      stats.totalFailEvents += 1;
    } else if (mode === 'ok') {
      stats.okSwitchCount += 1;
    } else if (mode === 'low-bitrate') {
      stats.okSwitchCount += 1;
      stats.lbrSwitchCount += 1;
    } else if (mode === 'intro') {
      stats.introSwitchCount += 1;
    }
  }

  private updateStreamSummary(
    streamResults: Record<string, StreamResult>,
    enabledStreams: StreamSettings[],
  ): void {
    const primary = enabledStreams[0];
    if (!primary) {
      this.state.streamSummary = null;
      return;
    }
    const evalResult = streamResults[primary.id];
    this.state.streamSummary = {
      label: evalResult?.label ?? primary.label,
      mediaState: evalResult?.mediaState ?? null,
      mediaStateRaw: evalResult?.mediaStateRaw ?? null,
      frozenMs: evalResult?.frozenMs ?? 0,
      healthy: !!evalResult?.healthy,
      failed: !!evalResult?.failed,
      reason: evalResult?.reason ?? null,
      srtLatencyMs: primary.srtLatencyMs ?? null,
      relayIngest: this.settings?.relay?.enabled
        ? this.state.relayConnected
          ? 'connected'
          : this.state.relayActive
            ? 'waiting'
            : 'off'
        : null,
    };
  }

  async connectObs(settings: Settings): Promise<void> {
    this.settings = settings ?? this.settings;
    if (!this.settings) throw new Error('Settings not loaded');
    this.syncSettingsFlags();
    this.obsSession = true;
    this.state.obsSessionActive = true;
    await this.reconnectObs();
    this.scheduleObsScenePoll();
    this.emit();
  }

  cancelScheduledStreamEnd(): void {
    if (this._streamEndTimer) {
      clearTimeout(this._streamEndTimer);
      this._streamEndTimer = null;
    }
    const hadPending = this.state.streamEndPending;
    this.state.streamEndPending = false;
    this.state.streamEndAt = null;
    this.state.streamEndSceneName = null;
    if (hadPending) this.emit();
  }

  async scheduleStreamEnd(
    sceneName: string,
    delayMinutes: number,
  ): Promise<Record<string, unknown>> {
    if (!this.state.obsConnected) {
      throw new Error('OBS not connected');
    }
    await this.refreshObsOutputStatus();
    if (!this.state.obsOutputActive) {
      throw new Error('OBS is not streaming');
    }

    const delayMs = Math.max(0, Number(delayMinutes) || 0) * 60 * 1000;
    const trimmedScene = String(sceneName ?? '').trim();

    this.cancelScheduledStreamEnd();

    if (trimmedScene) {
      await this.forceScene(trimmedScene);
    }

    if (delayMs <= 0) {
      await this.stopObsOutput();
      return { immediate: true, sceneName: trimmedScene || null };
    }

    const streamEndAt = new Date(Date.now() + delayMs).toISOString();
    this.state.streamEndPending = true;
    this.state.streamEndAt = streamEndAt;
    this.state.streamEndSceneName = trimmedScene || null;
    this._streamEndTimer = setTimeout(() => {
      this._streamEndTimer = null;
      this.executeScheduledStreamEnd().catch((e: Error) => this.handleObsError(e));
    }, delayMs);
    this.emit();
    return {
      scheduled: true,
      streamEndAt,
      sceneName: trimmedScene || null,
      delayMinutes: delayMs / 60_000,
    };
  }

  private async executeScheduledStreamEnd(): Promise<Record<string, unknown>> {
    this.state.streamEndPending = false;
    this.state.streamEndAt = null;
    this.state.streamEndSceneName = null;

    if (!this.state.obsConnected) {
      this.emit();
      return { cancelled: true, reason: 'obs-disconnected' };
    }

    await this.refreshObsOutputStatus();
    if (!this.state.obsOutputActive) {
      this.emit();
      return { cancelled: true, reason: 'not-streaming' };
    }

    await this.stopObsOutput();
    return { stopped: true };
  }

  async disconnectObs(): Promise<void> {
    this.cancelScheduledStreamEnd();
    if (this.running) await this.stopMonitoring();
    this.obsSession = false;
    this.state.obsSessionActive = false;
    if (this.obsSceneTimer) {
      clearInterval(this.obsSceneTimer);
      this.obsSceneTimer = null;
    }
    await this.obs.disconnect();
    this.state.obsConnected = false;
    this.state.obsOutputActive = false;
    this.state.obsOutputReconnecting = false;
    this.state.obsError = null;
    this.state.currentScene = null;
    this.state.mediaInputMuted = null;
    this.emit();
  }

  private async refreshMediaInputMute(): Promise<void> {
    if (!this.state.obsConnected) {
      this.state.mediaInputMuted = null;
      return;
    }
    const inputName = (this.primaryMediaSourceName() || MEDIA_SOURCE_NAME).trim();
    if (!inputName) {
      this.state.mediaInputMuted = null;
      return;
    }
    try {
      this.state.mediaInputMuted = await this.obs.getInputMute(inputName);
    } catch {
      this.state.mediaInputMuted = null;
    }
  }

  async startMonitoring(settings: Settings): Promise<void> {
    this.settings = settings ?? this.settings;
    if (!this.settings) throw new Error('Settings not loaded');
    this.running = true;
    this.state.monitoringActive = true;
    this.state.startedAt = new Date().toISOString();
    this.syncMediaSourceInState();
    this.syncSettingsFlags();
    this.resetSessionStats();
    this._failSince = null;
    this._okSince = null;
    this._cursorHistory.clear();
    this._mediaDebounce.clear();
    this._monitoringStartedAt = Date.now();
    this._relayRestartAt = 0;
    this._relayRestartBackoffMs = 2000;
    this._relayRestartInFlight = false;
    if (!this.state.obsConnected) {
      try {
        await this.reconnectObs();
        this.monitoringOwnedObs = true;
      } catch {
        /* reconnectObs schedules retry while running */
      }
    } else {
      this.monitoringOwnedObs = false;
    }
    if (this.obsSceneTimer) {
      clearInterval(this.obsSceneTimer);
      this.obsSceneTimer = null;
    }
    this.schedulePoll();
    if (this.settings.relay?.enabled && this.settings.relay?.startWithMonitoring !== false) {
      const ffmpegPath = resolveFfmpegPath(this.settings);
      if (relayLogsInfo(resolveRelayLogLevel(this.settings))) {
        console.log('[relay] starting ffmpeg:', ffmpegPath);
      }
      try {
        await this.relay.start(this.settings);
        this.applyRelayStats(this.relay.getStats());
        this.markRelayWarmup();
        const { listenPort, obsPort } = this.relay.resolvePorts(this.settings);
        console.log(`[relay] ffmpeg running — phone → UDP ${listenPort} | OBS caller → 127.0.0.1:${obsPort} | binary: ${ffmpegPath}`);
        if (this.state.relayError) {
          console.error('[relay] start error:', this.state.relayError);
        }
      } catch (err) {
        this.state.relayError = (err as Error).message;
        console.error('[relay] failed to start:', (err as Error).message);
        const tail = this.relay.getRecentStderr();
        if (tail.length) console.error('[relay] stderr:', tail.join(' | '));
        this.emit();
      }
    }
    this.emit();
  }

  async stopMonitoring(): Promise<void> {
    this.running = false;
    await this.relay.stop();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.state.monitoringActive = false;
    this.state.mode = this.state.obsConnected ? 'idle' : 'stopped';
    this.state.targetScene = null;
    this.state.streams = {};
    this.state.streamSummary = null;
    this._failSince = null;
    this._okSince = null;
    this._mediaDebounce.clear();
    this._monitoringStartedAt = null;
    this._relayWarmupUntil = 0;
    this._relayRestartAt = 0;
    this._relayRestartInFlight = false;
    this.resetSrtDataUsage();
    if (this.monitoringOwnedObs && !this.obsSession) {
      this.monitoringOwnedObs = false;
      if (this.obsSceneTimer) {
        clearInterval(this.obsSceneTimer);
        this.obsSceneTimer = null;
      }
      await this.obs.disconnect();
      this.state.obsConnected = false;
      this.state.obsError = null;
      this.state.currentScene = null;
    } else if (this.obsSession) {
      this.scheduleObsScenePoll();
    }
    this.emit();
  }

  async stop(): Promise<void> {
    await this.stopMonitoring();
    await this.disconnectObs();
  }

  async updateSettings(settings: Settings): Promise<void> {
    const wasRunning = this.running;
    const hadObs = this.obsSession;
    if (wasRunning) await this.stopMonitoring();
    if (hadObs) await this.disconnectObs();
    this.settings = settings;
    this.syncMediaSourceInState();
    this.syncSettingsFlags();
    if (hadObs) {
      await this.connectObs(settings);
    }
    if (wasRunning) await this.startMonitoring(settings);
    else this.emit();
  }

  private schedulePoll(): void {
    if (this.timer) clearInterval(this.timer);
    const ms = this.settings!.monitor.pollIntervalMs || 1000;
    this.timer = setInterval(() => this.tick().catch((e: Error) => this.handleObsError(e)), ms);
    this.tick().catch((e: Error) => this.handleObsError(e));
  }

  private async reconnectObs(): Promise<void> {
    try {
      await this.obs.connect(this.settings!);
      this.state.obsConnected = true;
      this.state.cameraAudioLevels = this.resolveCameraAudioLevels();
      this.state.obsError = null;
      this.state.obsOutputActive = false;
      this.state.obsOutputReconnecting = false;
      this.state.currentScene = await this.obs.getCurrentScene();
      await this.refreshObsOutputStatus();
      await this.refreshMediaInputMute();
      if (this.obsSession && !this.running) this.scheduleObsScenePoll();
    } catch (err) {
      this.handleObsError(err as Error);
      throw err;
    }
  }

  handleObsError(err: Error): void {
    this.cancelScheduledStreamEnd();
    this.state.obsConnected = false;
    this.state.obsOutputActive = false;
    this.state.obsOutputReconnecting = false;
    this.state.mediaInputMuted = null;
    this.state.obsError = err?.message ?? String(err);
    this.obs.connected = false;
    if (this.obsSession || this.running) {
      setTimeout(() => this.reconnectObs().catch(() => {}), 2000);
    }
    this.emit();
  }

  private scheduleObsScenePoll(): void {
    if (this.obsSceneTimer) clearInterval(this.obsSceneTimer);
    if (!this.obsSession || this.running || !this.state.obsConnected) {
      this.obsSceneTimer = null;
      return;
    }
    this.obsSceneTimer = setInterval(() => {
      this.refreshObsScene().catch((e: Error) => this.handleObsError(e));
    }, 2000);
    this.refreshObsScene().catch((e: Error) => this.handleObsError(e));
  }

  private async refreshObsScene(): Promise<void> {
    if (!this.state.obsConnected) return;
    this.state.currentScene = await this.obs.getCurrentScene();
    await this.refreshObsOutputStatus();
    await this.refreshMediaInputMute();
    this.state.cameraAudioLevels = this.resolveCameraAudioLevels();
    this.emit();
  }

  async refreshObsOutputStatus(): Promise<void> {
    if (!this.state.obsConnected) {
      this.state.obsOutputActive = false;
      this.state.obsOutputReconnecting = false;
      return;
    }
    try {
      const status = await this.obs.getStreamStatus();
      this.state.obsOutputActive = status.outputActive;
      this.state.obsOutputReconnecting = status.outputReconnecting;
    } catch {
      this.state.obsOutputActive = false;
      this.state.obsOutputReconnecting = false;
    }
  }

  async startObsOutput(): Promise<Record<string, unknown>> {
    this.cancelScheduledStreamEnd();
    if (!this.state.obsConnected) {
      throw new Error('OBS not connected — connect OBS first');
    }
    if (!this.obs.connected || !(this.obs.obs as { identified?: boolean }).identified) {
      throw new Error('OBS WebSocket session lost — disconnect and connect OBS again');
    }
    await this.refreshObsOutputStatus();
    if (this.state.obsOutputActive) {
      return { already: true, outputActive: true };
    }
    await this.obs.startStream();
    const active = await this.obs.waitForStreamActive({ timeoutMs: 8000 });
    await this.refreshObsOutputStatus();
    this.emit();
    if (!active && !this.state.obsOutputActive) {
      throw new Error(
        'OBS did not start streaming — check stream service settings and WebSocket permissions in OBS',
      );
    }
    return { started: true, outputActive: this.state.obsOutputActive };
  }

  async stopObsOutput(): Promise<boolean> {
    if (!this.state.obsConnected || !this.state.obsOutputActive) return false;
    await this.obs.stopStream();
    await this.refreshObsOutputStatus();
    this.emit();
    return true;
  }

  private getBypassScenes(): string[] {
    const bypass = this.settings!.scenes.bypass ?? ['none'];
    return bypass
      .map((s) => String(s).trim())
      .filter((s) => s && s.toLowerCase() !== 'none');
  }

  private isBypass(sceneName: string | null): boolean {
    if (!sceneName) return false;
    return this.getBypassScenes().includes(sceneName);
  }

  private lbrSceneName(baseScene: string): string {
    const configured = this.settings!.scenes.lowBitrateSuffix ?? ' LBR';
    if (typeof configured === 'string' && configured.startsWith(' ')) {
      return `${baseScene}${configured}`;
    }
    return configured || `${baseScene} LBR`;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.accumulateSrtDataUsage();
    if (!this.state.obsConnected) return;
    if (this.settings?.relay?.enabled) {
      await this.ensureRelayRunning();
    }
    await this.refreshObsOutputStatus();
    await this.refreshMediaInputMute();

    const { settings } = this;
    const enabledStreams = settings!.streams.filter((s) => s.enabled);
    const streamResults: Record<string, StreamResult> = {};

    for (const stream of enabledStreams) {
      streamResults[stream.id] = await this.evaluateStream(stream);
    }

    this.state.streams = streamResults;
    this.updateStreamSummary(streamResults, enabledStreams);
    this.state.currentScene = await this.obs.getCurrentScene();
    this.state.bypassActive = this.isBypass(this.state.currentScene);

    if (this.state.bypassActive) {
      this.state.mode = 'bypass';
      this.state.targetScene = this.state.currentScene;
      this._failSince = null;
      this._okSince = null;
      this.emit();
      return;
    }

    const anyEnabled = enabledStreams.length > 0;
    const allHealthy = anyEnabled && enabledStreams.every((s) => streamResults[s.id]?.healthy);
    const anyFailed = enabledStreams.some((s) => streamResults[s.id]?.failed);
    const anyLow =
      settings!.scenes.lowBitrateEnabled &&
      enabledStreams.some((s) => streamResults[s.id]?.lowBitrate);

    const ingestKbps = this.ingestBitrateKbps();
    const bitrateThresholds = settings!.srtLiveServer;
    const relayBitrateFail =
      ingestKbps != null &&
      settings!.relay?.enabled &&
      ingestKbps < bitrateThresholds.bitrateFailKbps;

    const now = Date.now();
    const failDelay = (settings!.monitor.streamFailDelaySeconds ?? 8) * 1000;
    const recoveryDelay = (settings!.monitor.recoveryDelaySeconds ?? 2) * 1000;

    const unhealthy = anyFailed || relayBitrateFail || !anyEnabled;
    const healthy = allHealthy && !relayBitrateFail && anyEnabled;

    if (unhealthy) {
      this._okSince = null;
      if (!this._failSince) this._failSince = now;
    } else if (healthy) {
      this._failSince = null;
      if (!this._okSince) this._okSince = now;
    }

    let desiredScene: string;
    let mode: SceneMode;

    if (!anyEnabled) {
      desiredScene = settings!.scenes.intro;
      mode = 'intro';
    } else if (unhealthy && this._failSince && now - this._failSince >= failDelay) {
      desiredScene = settings!.scenes.fail;
      mode = 'fail';
    } else if (healthy && this._okSince && now - this._okSince >= recoveryDelay) {
      if (anyLow) {
        desiredScene = this.lbrSceneName(settings!.scenes.ok);
        mode = 'low-bitrate';
      } else {
        desiredScene = settings!.scenes.ok;
        mode = 'ok';
      }
    } else if (!healthy && !unhealthy) {
      desiredScene = settings!.scenes.intro;
      mode = 'waiting';
    } else {
      desiredScene = this.state.currentScene ?? settings!.scenes.intro;
      mode = this.state.mode;
    }

    this.state.targetScene = desiredScene;
    this.state.mode = mode;
    this.state.cameraAudioLevels = this.resolveCameraAudioLevels();

    if (
      desiredScene &&
      desiredScene !== this.state.currentScene &&
      (['ok', 'fail', 'low-bitrate', 'intro'] as SceneMode[]).includes(mode)
    ) {
      const changed = await this.obs.setScene(desiredScene);
      if (changed) {
        this.recordAutoSceneSwitch(mode, desiredScene);
        this.state.currentScene = desiredScene;
        if (settings!.monitor.connectionsLog) {
          const { stats } = this.state;
          await appendLog(
            `Scene -> ${desiredScene} (${mode}) · BRB ${stats.brbSwitchCount} · OK ${stats.okSwitchCount}`,
          );
        }
      }
    }

    this.emit();
  }

  private debounceMediaState(streamId: string, rawState: string, now: number): string {
    const ms = Math.max(500, this.settings?.monitor?.mediaStateDebounceMs ?? 2500);
    let track = this._mediaDebounce.get(streamId);
    if (!track) {
      track = { stable: rawState, candidate: rawState, candidateSince: now };
      this._mediaDebounce.set(streamId, track);
      return rawState;
    }
    if (rawState === track.stable) {
      track.candidate = rawState;
      track.candidateSince = now;
      return track.stable;
    }
    if (rawState !== track.candidate) {
      track.candidate = rawState;
      track.candidateSince = now;
    }
    if (now - track.candidateSince >= ms) {
      track.stable = track.candidate;
    }
    return track.stable;
  }

  private inRelayWarmup(now: number): boolean {
    if (!this.settings?.relay?.enabled) return false;
    if (this._relayWarmupUntil && now < this._relayWarmupUntil) return true;
    const warmupMs = Math.max(0, (this.settings.monitor.relayWarmupSeconds ?? 10) * 1000);
    if (!warmupMs || !this._monitoringStartedAt) return false;
    return now - this._monitoringStartedAt < warmupMs;
  }

  private async evaluateStream(stream: StreamSettings): Promise<StreamResult> {
    const result: StreamResult = {
      label: stream.label,
      healthy: false,
      failed: false,
      lowBitrate: false,
      reason: null,
      mediaState: null,
      mediaStateRaw: null,
      mediaCursor: null,
      frozenMs: 0,
    };

    if (stream.type !== 'obs-media') {
      result.reason = 'unsupported-type';
      return result;
    }

    try {
      const status = await this.obs.getMediaStatus(stream.mediaSourceName);
      const now = Date.now();
      result.mediaStateRaw = status.mediaState;
      const stableState = this.debounceMediaState(stream.id, status.mediaState, now);
      result.mediaState = stableState;
      result.mediaCursor = status.mediaCursor;

      const key = stream.id;
      const prev = this._cursorHistory.get(key);
      let frozenMs = 0;

      if (stableState === 'playing') {
        if (prev && prev.cursor === status.mediaCursor) {
          frozenMs = now - prev.since;
        } else {
          this._cursorHistory.set(key, { cursor: status.mediaCursor, since: now });
          frozenMs = 0;
        }
      } else {
        this._cursorHistory.delete(key);
      }

      result.frozenMs = frozenMs;

      const relayEnabled = !!this.settings?.relay?.enabled;
      const failCheck = this.obs.isMediaFailed(status, stream, frozenMs, {
        debouncedState: stableState,
        relayEnabled,
        relayConnected: relayEnabled && this.state.relayConnected,
        inRelayWarmup: this.inRelayWarmup(now),
      });
      result.failed = failCheck.failed;
      result.reason = failCheck.reason;
      if (result.mediaStateRaw !== result.mediaState) {
        (result as StreamResult & { mediaStateDebounced?: boolean }).mediaStateDebounced = true;
      }

      const ingestKbps = this.ingestBitrateKbps();
      if (ingestKbps != null && this.settings?.relay?.enabled) {
        if (this.obs.isBitrateFailed(ingestKbps, this.settings)) {
          result.failed = true;
          result.reason = 'relay-bitrate-fail';
        }
        result.lowBitrate = this.obs.isMediaLowBitrate(ingestKbps, this.settings);
      }

      const relayIngestOk = relayEnabled && this.state.relayConnected;
      if (relayIngestOk && RELAY_OBS_GLITCH_STATES.has(result.mediaStateRaw ?? '')) {
        result.mediaState = 'playing';
        (result as StreamResult & { mediaStateDebounced?: boolean }).mediaStateDebounced = true;
      }
      result.healthy = !result.failed && (result.mediaState === 'playing' || relayIngestOk);
    } catch (err) {
      result.failed = true;
      result.reason = (err as Error).message;
    }

    return result;
  }

  async createCamSource(settings: Settings): Promise<EnsureMediaSourceResult> {
    if (!this.state.obsConnected) {
      throw new Error('Connect OBS first');
    }
    const sceneName = settings?.scenes?.ok;
    const inputName = (settings?.streams?.[0]?.mediaSourceName || MEDIA_SOURCE_NAME).trim();
    const srtUrl = buildObsSrtUrl(settings ?? this.settings ?? undefined);
    return this.obs.ensureMediaSourceInScene({ sceneName, inputName, srtUrl });
  }

  async renameMediaSourceInObs(
    oldName: string,
    newName: string,
  ): Promise<{ renamed: boolean; skipped?: boolean; reason?: string; unchanged?: boolean; missing?: boolean; inputName?: string; oldName?: string }> {
    if (!this.state.obsConnected) {
      return { renamed: false, skipped: true, reason: 'obs-not-connected' };
    }
    return this.obs.renameMediaSource(oldName, newName);
  }

  async updateCamSourceUrlIfExists(
    settings: Settings,
  ): Promise<{ updated: boolean; skipped?: boolean; reason?: string; missing?: boolean; inputName?: string; srtUrl?: string }> {
    if (!this.state.obsConnected) {
      return { updated: false, skipped: true, reason: 'obs-not-connected' };
    }
    const inputName = (settings?.streams?.[0]?.mediaSourceName || MEDIA_SOURCE_NAME).trim();
    const srtUrl = buildObsSrtUrl(settings ?? this.settings ?? undefined);
    return this.obs.updateMediaSourceUrlIfExists(inputName, srtUrl);
  }

  async forceScene(sceneName: string): Promise<void> {
    if (!this.state.obsConnected) throw new Error('OBS not connected');
    await this.obs.setScene(sceneName);
    this.state.currentScene = sceneName;
    this.emit();
  }
}
