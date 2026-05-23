import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import type { Settings } from '../types/settings';
import type { FfmpegCandidate, FfmpegProbeResult } from '../types/relay';

let cachedResolved: string | null = null;

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function tryFromPath(bin: string): string | null {
  if (!bin) return null;
  if (bin.includes(path.sep) || bin.includes('/')) {
    return fileExists(bin) ? bin : null;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, [bin], { encoding: 'utf8', windowsHide: true });
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && fileExists(l));
    return first ?? null;
  } catch {
    return null;
  }
}

function scanForFfmpegExe(dir: string, out: string[], depth: number): void {
  if (depth <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /^ffmpeg\.exe?$/i.test(entry.name)) {
      out.push(full);
    } else if (entry.isDirectory()) {
      scanForFfmpegExe(full, out, depth - 1);
    }
  }
}

/** Common install locations (winget Gyan.FFmpeg, scoop, chocolatey). */
export function discoverFfmpegCandidates(): FfmpegCandidate[] {
  const found: FfmpegCandidate[] = [];
  const seen = new Set<string>();
  const add = (p: string, source: string) => {
    const norm = path.normalize(p);
    if (!fileExists(norm) || seen.has(norm.toLowerCase())) return;
    seen.add(norm.toLowerCase());
    found.push({ path: norm, source });
  };

  const fromPath = tryFromPath('ffmpeg');
  if (fromPath) add(fromPath, 'PATH');

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const wingetPackages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
      try {
        for (const entry of fs.readdirSync(wingetPackages, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/ffmpeg/i.test(entry.name)) continue;
          const pkgDir = path.join(wingetPackages, entry.name);
          const hits: string[] = [];
          scanForFfmpegExe(pkgDir, hits, 5);
          for (const hit of hits) add(hit, 'winget');
        }
        for (const entry of fs.readdirSync(wingetPackages, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/^Gyan\.FFmpeg_/i.test(entry.name)) continue;
          const pkgDir = path.join(wingetPackages, entry.name);
          let subdirs: fs.Dirent[];
          try {
            subdirs = fs.readdirSync(pkgDir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const sub of subdirs) {
            if (!sub.isDirectory() || !/^ffmpeg-/i.test(sub.name)) continue;
            const binExe = path.join(pkgDir, sub.name, 'bin', 'ffmpeg.exe');
            add(binExe, 'winget-gyan');
          }
        }
      } catch {
        /* ignore */
      }
    }

    const fixed = [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env.USERPROFILE ?? '', 'scoop', 'apps', 'ffmpeg', 'current', 'bin', 'ffmpeg.exe'),
      path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
    ];
    for (const p of fixed) add(p, 'common');
  }

  return found;
}

/**
 * Resolve ffmpeg executable for relay spawn.
 * Priority: settings.relay.ffmpegPath → ffmpeg-static bundled binary → system PATH → platform scan.
 */
export function resolveFfmpegPath(
  settings?: Partial<Settings>,
  { refresh = false }: { refresh?: boolean } = {},
): string {
  const configured = String(settings?.relay?.ffmpegPath ?? '').trim();
  if (configured) {
    const resolved = tryFromPath(configured) ?? (fileExists(configured) ? configured : null);
    if (resolved) return resolved;
    // configured path not found — fall through to ffmpeg-static
  }

  // ffmpeg-static bundled binary (no system install needed)
  if (ffmpegStatic) return ffmpegStatic;

  if (!refresh && cachedResolved && fileExists(cachedResolved)) {
    return cachedResolved;
  }

  const fromPath = tryFromPath('ffmpeg');
  if (fromPath) {
    cachedResolved = fromPath;
    return fromPath;
  }

  const discovered = discoverFfmpegCandidates();
  if (discovered.length) {
    cachedResolved = discovered[0].path;
    return discovered[0].path;
  }

  return 'ffmpeg';
}

export function probeFfmpeg(ffmpegPath: string): FfmpegProbeResult {
  try {
    const out = execFileSync(ffmpegPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    const versionLine = out.split(/\r?\n/).find((l) => l.trim()) ?? '';
    return { ok: true, versionLine, error: null };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    const msg =
      e.code === 'ENOENT'
        ? `ffmpeg not found (${ffmpegPath}). Install via ffmpeg-static or set relay.ffmpegPath in settings.`
        : e.message ?? String(err);
    return { ok: false, versionLine: null, error: msg };
  }
}
