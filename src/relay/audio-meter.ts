import type { Settings } from '../types/settings';

/** OBS IEC broadcast meter deflection (matches libobs obs-audio-controls.c). */

export const METER_DISPLAY_GAIN_DB = 6;

/** @deprecated use METER_DISPLAY_GAIN_DB */
export const METER_CALIBRATION_DB = METER_DISPLAY_GAIN_DB;

export function resolveMeterGainDb(settings?: Partial<Settings>): number {
  const raw = settings?.monitor?.cameraMeterGainDb;
  return Number.isFinite(raw) ? (raw as number) : METER_DISPLAY_GAIN_DB;
}

export function iecDbToDef(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db >= 0) return 1;
  if (db <= -114) return 0;
  if (db >= -9) return ((db + 9) / 9) * 0.25 + 0.75;
  if (db >= -20) return ((db + 20) / 11) * 0.25 + 0.5;
  if (db >= -30) return ((db + 30) / 10) * 0.2 + 0.3;
  if (db >= -40) return ((db + 40) / 10) * 0.15 + 0.15;
  if (db >= -50) return ((db + 50) / 10) * 0.075 + 0.075;
  if (db >= -60) return ((db + 60) / 10) * 0.05 + 0.025;
  return ((db + 150) / 90) * 0.025;
}

/** Clamp OBS websocket linear meter samples before dB conversion (gain can push > 1). */
export function clampObsMul(mul: number): number {
  if (!Number.isFinite(mul) || mul <= 0) return 0;
  return Math.min(1, mul);
}

/** Linear OBS meter sample → dBFS. */
export function mulToDb(mul: number): number {
  const m = clampObsMul(mul);
  if (m <= 0) return -114;
  return 20 * Math.log10(Math.max(m, 1e-9));
}

/** dBFS (astats / OBS meter) → 0–1 bar level. */
export function dbToDisplayLevel(db: number, calibrationDb = METER_DISPLAY_GAIN_DB): number {
  if (!Number.isFinite(db)) return 0;
  const adjusted = db + (Number.isFinite(calibrationDb) ? calibrationDb : 0);
  return Math.max(0, Math.min(1, iecDbToDef(adjusted)));
}

/** OBS InputVolumeMeters linear mul (0–1, magnitude) → display level. */
export function mulToDisplayLevel(mul: number, calibrationDb = METER_DISPLAY_GAIN_DB): number {
  return dbToDisplayLevel(mulToDb(mul), calibrationDb);
}

/** UI color tier for a 0–1 display level. */
export function displayLevelColorClass(level: number): string {
  if (level >= 0.92) return 'level-high';
  if (level >= 0.78) return 'level-mid';
  return 'level-low';
}

export function formatMeterDebug({
  source,
  db,
  mul,
  display,
}: {
  source: string;
  db?: number;
  mul?: number;
  display?: number;
}): string {
  const pct = Math.round((display ?? 0) * 100);
  const color = displayLevelColorClass(display ?? 0);
  const parts = [`src=${source}`, `disp=${pct}%`, color];
  if (Number.isFinite(db)) parts.push(`db=${(db as number).toFixed(1)}`);
  if (Number.isFinite(mul)) parts.push(`mul=${(mul as number).toFixed(4)}`);
  return parts.join(' ');
}
