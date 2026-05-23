import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectLanIpv4 } from '../utils/lan-ip';
import type { Settings, ServerSettings, StreamSettings, RelaySrtLatencyResult } from '../types/settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, '../..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const LOG_PATH = path.join(DATA_DIR, 'connections.log');

export const MEDIA_SOURCE_NAME = 'OK IRL CAM SOURCE';

const DEFAULT_SETTINGS: Settings = {
  server: {
    host: '0.0.0.0',
    port: 9000,
  },
  obs: { host: '127.0.0.1', port: 4455, password: '' },
  scenes: {
    ok: 'Main',
    fail: 'BRB',
    intro: 'Intro',
    bypass: ['none'],
    lowBitrateSuffix: ' LBR',
    lowBitrateEnabled: false,
    lbrBitrateThresholdKbps: 800,
  },
  streams: [
    {
      id: 'stream1',
      label: 'Main camera',
      enabled: true,
      type: 'obs-media',
      mediaSourceName: MEDIA_SOURCE_NAME,
      srtBindHost: '0.0.0.0',
      srtPort: 8000,
      srtLatencyMs: 3000,
      frozenDetectSeconds: 5,
    },
  ],
  monitor: {
    pollIntervalMs: 1000,
    streamFailDelaySeconds: 8,
    recoveryDelaySeconds: 2,
    frozenThresholdMs: 3000,
    mediaStateDebounceMs: 2500,
    relayWarmupSeconds: 10,
    connectionsLog: false,
    cameraMeterGainDb: 6,
  },
  srtLiveServer: {
    enabled: false,
    host: '127.0.0.1',
    port: 8181,
    statsPath: 'stats',
    publisherPath: 'publish/live/stream1',
    bitrateLowKbps: 800,
    bitrateFailKbps: 400,
    pollIntervalSeconds: 5,
  },
  relay: {
    enabled: false,
    listenPort: 8000,
    obsPort: 8001,
    ffmpegPath: '',
    startWithMonitoring: true,
    logLevel: 'quiet',
  },
  streamEnd: {
    sceneName: '',
    delayMinutes: 2,
  },
};

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const out = { ...target } as T;
  for (const key of Object.keys(source) as (keyof T)[]) {
    const val = source[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = deepMerge(target[key] as object ?? {}, val as object) as T[typeof key];
    } else if (val !== undefined) {
      out[key] = val as T[typeof key];
    }
  }
  return out;
}

const DEFAULT_SRT_PORT = 8000;

export function resolveServerPort(settings?: Partial<Settings>): number {
  const raw = settings?.server?.port;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? Math.round(n) : 9000;
}

export function parseSrtHostPort(
  host: string,
  defaultPort = DEFAULT_SRT_PORT,
): { host: string; port: number } {
  const raw = String(host ?? '0.0.0.0').trim() || '0.0.0.0';
  if (raw.includes(':')) {
    const idx = raw.lastIndexOf(':');
    const h = raw.slice(0, idx) || '0.0.0.0';
    const p = Number(raw.slice(idx + 1));
    return { host: h, port: Number.isFinite(p) && p > 0 ? p : defaultPort };
  }
  return { host: raw, port: defaultPort };
}

function clampSrtPort(port: number | string | undefined): number {
  const p = Number(port);
  return Number.isFinite(p) && p >= 1 && p <= 65535 ? Math.round(p) : DEFAULT_SRT_PORT;
}

export function resolveRelaySrtLatency(settings?: Partial<Settings>): RelaySrtLatencyResult {
  const stream = settings?.streams?.[0];
  const relay = settings?.relay;
  const ingestMsRaw = Number(stream?.srtLatencyMs);
  const ingestMs =
    Number.isFinite(ingestMsRaw) && ingestMsRaw > 0 ? Math.round(ingestMsRaw) : 3000;
  const obsMsRaw = Number(relay?.obsLatencyMs);
  const obsMs =
    Number.isFinite(obsMsRaw) && obsMsRaw > 0
      ? Math.round(obsMsRaw)
      : Math.min(500, Math.max(120, Math.round(ingestMs * 0.25)));
  const ingestUs = Math.round(Math.max(1, ingestMs) * 1000);
  const obsUs = Math.round(Math.max(120, obsMs) * 1000);
  return { ingestMs, obsMs, ingestUs, obsUs };
}

export function buildObsSrtUrl(settings?: Partial<Settings>): string {
  const relay = settings?.relay;
  const stream = settings?.streams?.[0];
  if (relay?.enabled) {
    const obsPort = Number(relay.obsPort) > 0 ? Math.round(Number(relay.obsPort)) : 8001;
    const { obsUs } = resolveRelaySrtLatency(settings);
    const timeoutUs = Math.max(obsUs * 2, 2_000_000);
    return `srt://127.0.0.1:${obsPort}?mode=caller&latency=${obsUs}&timeout=${timeoutUs}`;
  }
  return buildSrtUrl(stream?.srtBindHost, stream?.srtPort, stream?.srtLatencyMs);
}

export function buildSrtUrl(
  bindHost: string | undefined,
  port: number | undefined,
  latencyMs: number | undefined,
): string {
  const host = String(bindHost ?? '0.0.0.0').trim() || '0.0.0.0';
  const hostPort = `${host}:${clampSrtPort(port)}`;
  const ms = Number(latencyMs);
  const latencyUs = Number.isFinite(ms) && ms > 0 ? Math.round(ms * 1000) : 3_000_000;
  const timeoutUs = Math.max(latencyUs * 2, 5_000_000);
  return `srt://${hostPort}?mode=listener&latency=${latencyUs}&timeout=${timeoutUs}`;
}

function buildSrtCallerUrl(host: string | null, port: number, latencyUs: number): string | null {
  const h = String(host ?? '').trim();
  if (!h) return null;
  return `srt://${h}:${port}?mode=caller&latency=${latencyUs}`;
}

function isPrivateLanIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host ?? '').trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export interface ResolveWanHostOptions {
  detectedPublicIp?: string;
}

export function resolveWanHost(
  settings?: Partial<Settings>,
  options: ResolveWanHostOptions = {},
): string {
  const explicit = String(settings?.server?.wanHost ?? '').trim();
  if (explicit && !isPrivateLanIpv4(explicit)) return explicit;
  const detected = String(options.detectedPublicIp ?? '').trim();
  if (detected && !isPrivateLanIpv4(detected)) return detected;
  return '';
}

export function resolveLanHost(settings?: Partial<Settings>): string | null {
  const explicit = String(settings?.server?.lanHost ?? '').trim();
  if (explicit) return explicit;
  const serverHost = String(settings?.server?.host ?? '').trim();
  if (
    serverHost &&
    serverHost !== '0.0.0.0' &&
    serverHost !== '127.0.0.1' &&
    serverHost !== '::'
  ) {
    return serverHost;
  }
  return detectLanIpv4();
}

function buildWebUiUrl(host: string | null, settings?: Partial<Settings>): string | null {
  const h = String(host ?? '').trim();
  if (!h) return null;
  const port = resolveServerPort(settings);
  return `http://${h}:${port}`;
}

function relayPhonePort(settings?: Partial<Settings>): number {
  const relay = settings?.relay;
  const stream = settings?.streams?.[0];
  if (relay?.enabled) {
    const p = Number(relay.listenPort);
    return Number.isFinite(p) && p >= 1 ? Math.round(p) : clampSrtPort(stream?.srtPort);
  }
  return clampSrtPort(stream?.srtPort);
}

export interface SrtPreviewOptions {
  detectedPublicIp?: string | null;
  publicIpError?: string | null;
}

export interface SrtPreviewResult {
  bindHost: string;
  port: number;
  obsPort: number | null;
  relayEnabled: boolean;
  latencyMs: number;
  listenerUrl: string;
  listenerUrlLabel: string;
  callerUrlLan: string;
  callerUrlWan: string | null;
  phoneCallerUrl: string;
  lanIp: string | null;
  wanIp: string | null;
  wanHost: string | null;
  detectedPublicIp: string | null;
  publicIpError: string | null;
  webUiUrl: string | null;
  bindWarning: string | null;
}

export function getSrtPreview(
  settings?: Partial<Settings>,
  options: SrtPreviewOptions = {},
): SrtPreviewResult {
  const stream = settings?.streams?.[0];
  const relayEnabled = !!settings?.relay?.enabled;
  const bindHost = String(stream?.srtBindHost ?? '0.0.0.0').trim() || '0.0.0.0';
  const port = relayPhonePort(settings);
  const obsPort =
    relayEnabled && Number(settings?.relay?.obsPort) > 0
      ? Math.round(Number(settings?.relay?.obsPort))
      : null;
  const latencyMs = stream?.srtLatencyMs ?? 3000;
  const latencyUs = Math.round(Math.max(1, latencyMs) * 1000);
  const listenerUrl = relayEnabled
    ? buildObsSrtUrl(settings)
    : buildSrtUrl(bindHost, port, latencyMs);

  const lanIp = resolveLanHost(settings);
  const callerUrlLan =
    buildSrtCallerUrl(lanIp, port, latencyUs) ??
    `srt://YOUR_PC_LAN_IP:${port}?mode=caller&latency=${latencyUs}`;

  const wanIp = resolveWanHost(settings, {
    detectedPublicIp: options.detectedPublicIp ?? undefined,
  });
  const detectedPublicIp = String(options.detectedPublicIp ?? '').trim();
  const callerUrlWan = buildSrtCallerUrl(wanIp || null, port, latencyUs);

  let bindWarning: string | null =
    !relayEnabled && bindHost !== '0.0.0.0' && bindHost !== '::'
      ? `OBS listener bind is "${bindHost}:${port}". Use 0.0.0.0:${port} so the PC accepts phone connections (including port-forwarded UDP).`
      : null;

  if (relayEnabled) {
    bindWarning = `Relay mode: phone → UDP ${port}, OBS caller → 127.0.0.1:${obsPort ?? 8001}. Start SRT monitoring to run the ffmpeg relay.`;
  }

  return {
    bindHost,
    port,
    obsPort,
    relayEnabled,
    latencyMs,
    listenerUrl,
    listenerUrlLabel: relayEnabled
      ? 'OBS Media Source (caller → relay)'
      : 'OBS Media Source (listener)',
    callerUrlLan,
    callerUrlWan,
    phoneCallerUrl: callerUrlLan,
    lanIp,
    wanIp: wanIp || null,
    wanHost: String(settings?.server?.wanHost ?? '').trim() || null,
    detectedPublicIp: detectedPublicIp || null,
    publicIpError: options.publicIpError ?? null,
    webUiUrl: buildWebUiUrl(lanIp, settings),
    bindWarning,
  };
}

export function parseSrtUrl(url: string | undefined): {
  bindHost: string;
  port: number;
  latencyMs: number;
} {
  if (!url?.trim()) {
    return { bindHost: '0.0.0.0', port: DEFAULT_SRT_PORT, latencyMs: 3000 };
  }
  try {
    const u = new URL(url);
    const latency = u.searchParams.get('latency');
    const latencyMs = latency ? Math.max(1, Math.round(Number(latency) / 1000)) : 3000;
    const { host: bindHost, port } = parseSrtHostPort(u.host || '0.0.0.0');
    return { bindHost, port, latencyMs };
  } catch {
    return { bindHost: '0.0.0.0', port: DEFAULT_SRT_PORT, latencyMs: 3000 };
  }
}

export function normalizeStreamSrt(stream: StreamSettings): StreamSettings {
  if (!stream) return stream;
  const s = stream as StreamSettings & { srtUrl?: string; srtHost?: string };
  const { srtBindHost, srtPort, srtLatencyMs, srtUrl, srtHost, ...rest } = s;

  let bindHost = srtBindHost;
  let port = srtPort;
  let latencyMs = srtLatencyMs;

  if (bindHost == null && srtHost != null) {
    const parsed = parseSrtHostPort(srtHost);
    bindHost = parsed.host;
    port = parsed.port;
  }
  if (srtUrl) {
    const parsed = parseSrtUrl(srtUrl);
    bindHost = bindHost ?? parsed.bindHost;
    port = port ?? parsed.port;
    latencyMs = latencyMs ?? parsed.latencyMs;
  }

  return {
    ...rest,
    srtBindHost: String(bindHost ?? '0.0.0.0').trim() || '0.0.0.0',
    srtPort: clampSrtPort(port),
    srtLatencyMs: latencyMs ?? 3000,
  };
}

function normalizeServerSettings(settings: Settings): Settings {
  const server = settings.server ?? ({} as ServerSettings);
  server.port = resolveServerPort(settings);
  let host = String(server.host ?? '0.0.0.0').trim() || '0.0.0.0';
  const lanHost = String(server.lanHost ?? '').trim();
  const wanHost = String(server.wanHost ?? '').trim();
  if (isPrivateLanIpv4(host)) {
    server.lanHost = lanHost || host;
    host = '0.0.0.0';
  } else if (lanHost) {
    server.lanHost = lanHost;
  } else {
    delete server.lanHost;
  }
  if (wanHost) {
    if (isPrivateLanIpv4(wanHost)) {
      delete server.wanHost;
    } else {
      server.wanHost = wanHost;
    }
  } else {
    delete server.wanHost;
  }
  server.host = host;
  settings.server = server;
  return settings;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const settings = normalizeServerSettings(
      deepMerge(DEFAULT_SETTINGS, JSON.parse(raw) as Partial<Settings>),
    );
    if (settings.streams?.[0]) {
      settings.streams[0] = normalizeStreamSrt(settings.streams[0]);
      if (!String(settings.streams[0].mediaSourceName ?? '').trim()) {
        settings.streams[0].mediaSourceName = MEDIA_SOURCE_NAME;
      }
    }
    return settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await saveSettings(DEFAULT_SETTINGS);
      return structuredClone(DEFAULT_SETTINGS);
    }
    throw err;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const normalized = normalizeServerSettings(settings);
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

export async function appendLog(line: string): Promise<void> {
  const stamp = new Date().toISOString();
  await fs.appendFile(LOG_PATH, `[${stamp}] ${line}\n`, 'utf8');
}

const LIVE_TS_WARN_BYTES = 100 * 1024 * 1024;

export async function warnIfLargeRootLiveTs(): Promise<void> {
  const liveTsDump = path.join(ROOT_DIR, 'live.ts');
  try {
    const st = await fs.stat(liveTsDump);
    if (st.size > LIVE_TS_WARN_BYTES) {
      const mb = Math.round(st.size / (1024 * 1024));
      console.warn(
        `WARNING: project-root live.ts is ${mb} MB (${liveTsDump}). ` +
          'Delete it; do not run ffmpeg with -f mpegts writing to live.ts in this folder.',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
