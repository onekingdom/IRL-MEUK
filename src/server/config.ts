import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Settings, RelaySrtLatencyResult } from '../types/settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, '../..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS: Settings = {
  relay: {
    listenPort: 8000,
    obsPort: 8001,
    ffmpegPath: '',
    logLevel: 'info',
  },
  streams: [{ srtLatencyMs: 2500 }],
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

export function resolveRelaySrtLatency(settings?: Partial<Settings>): RelaySrtLatencyResult {
  const stream = settings?.streams?.[0];
  const relay = settings?.relay;
  const ingestMsRaw = Number(stream?.srtLatencyMs);
  const ingestMs =
    Number.isFinite(ingestMsRaw) && ingestMsRaw > 0 ? Math.round(ingestMsRaw) : 2500;
  const obsMsRaw = Number(relay?.obsLatencyMs);
  const obsMs =
    Number.isFinite(obsMsRaw) && obsMsRaw > 0
      ? Math.round(obsMsRaw)
      : Math.min(500, Math.max(120, Math.round(ingestMs * 0.25)));
  const ingestUs = Math.round(Math.max(1, ingestMs) * 1000);
  const obsUs = Math.round(Math.max(120, obsMs) * 1000);
  return { ingestMs, obsMs, ingestUs, obsUs };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(raw) as Partial<Settings>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
      return structuredClone(DEFAULT_SETTINGS);
    }
    throw err;
  }
}
