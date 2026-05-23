import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { ServerResponse } from 'http';
import type { Settings } from '../types/settings';
import type {
  AudioLevels,
  PeakHold,
  ProcessExitInfo,
  RelayLogLevel,
  RelayStats,
  RelayStatsWithAudio,
} from '../types/relay';
import { dbToDisplayLevel, resolveMeterGainDb } from './audio-meter';
import { resolveFfmpegPath } from './ffmpeg-path';
import {
  isRelayHardStderrLine,
  relayLogsInfo,
  relayLogsVerbose,
  resolveRelayLogLevel,
  SRT_CONNECT_FAIL_RE,
} from './relay-log';
import { resolveRelaySrtLatency } from '../server/config';

const RELAY_BIND_DELAY_MS = 200;
const STOP_EXIT_TIMEOUT_MS = 2500;
const KILL_GRACE_MS = 1500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

interface ExecFileError extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

function execFileAsync(
  file: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options } as Parameters<typeof execFile>[2], (err, stdout, stderr) => {
      if (err) {
        (err as ExecFileError).stdout = String(stdout ?? '');
        (err as ExecFileError).stderr = String(stderr ?? '');
        reject(err);
      } else {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    });
  });
}

const FRAME_STALE_MS = 8000;
const AUDIO_STALE_MS = 2000;
const STATS_TICK_MS = 1000;
const MJPEG_BOUNDARY = 'okirlframe';
const BITRATE_LINE =
  /frame=\s*(\d+).*?fps=\s*([\d.]+).*?size=\s*([\d.]+)([kKmMgG]?i?B).*?time=.*?bitrate=\s*([\d.]+)\s*kbits\/s/i;
const ASTATS_META =
  /lavfi\.astats\.(Overall|(\d+))\.(Peak_level|RMS_level)(?:_dB)?\s*=\s*([-\d.eE+]+|inf|-inf|nan)/i;
const ASTATS_FILTER = 'astats=metadata=1:reset=0.1,ametadata=mode=print:direct=1';
const PEAK_HOLD_DECAY = 0.82;
const PEAK_HOLD_SILENT_FLOOR = 0.02;
const RELAY_FATAL_STDERR_RE =
  /Error opening (input|output)|Error opening input files|Error opening output files|Connection setup failure: unable to create|Error number -10048|Address already in use/i;
const RELAY_START_OK_STDERR_RE = /Press \[q\] to stop|Input #0,/;
const RELAY_ERROR_STDERR_RE =
  /error|failed|invalid|unable|cannot|Connection setup failure|Error number/i;
const RELAY_CONVERSION_FAILED_RE = /Conversion failed!/i;

interface RelayLegCtx {
  listenPort?: number;
  obsPort?: number;
}

export function detectRelayLeg(stderrRing: string[], ctx: RelayLegCtx = {}): string | null {
  const listenPort = Number(ctx.listenPort) > 0 ? Math.round(Number(ctx.listenPort)) : 8000;
  const obsPort = Number(ctx.obsPort) > 0 ? Math.round(Number(ctx.obsPort)) : 8001;
  const text = stderrRing.join('\n');
  const outputFailed = /Error opening output|Error opening output files/i.test(text);
  const inputFailed = /Error opening input|Error opening input files/i.test(text);

  if (outputFailed) {
    if (/Error parsing filterchain|Error parsing a filter description|No option name near/i.test(text)) {
      if (/astats|ametadata/i.test(text)) return 'audio meters (astats)';
      if (/mjpeg|mpjpeg|scale=854/i.test(text)) return 'preview (MJPEG)';
    }
    if (new RegExp(`srt://127\\.0\\.0\\.1:${obsPort}|Could not write header.*mpegts|mux.*mpegts`, 'i').test(text)) {
      return 'OBS relay (SRT copy)';
    }
    if (/mjpeg|mpjpeg|scale=854|pipe:1|Error while opening encoder|Could not open encoder.*mjpeg/i.test(text)) {
      return 'preview (MJPEG)';
    }
    if (/astats|ametadata|Error applying.*af|No such filter.*astats/i.test(text)) {
      return 'audio meters (astats)';
    }
    return 'output (relay)';
  }

  if (inputFailed || new RegExp(`srt://0\\.0\\.0\\.0:${listenPort}`, 'i').test(text)) {
    return 'ingest (phone SRT)';
  }

  const checks = [
    {
      leg: 'OBS relay (SRT copy)',
      re: new RegExp(`srt://127\\.0\\.0\\.1:${obsPort}|Could not write header.*mpegts|mux.*mpegts`, 'i'),
    },
    {
      leg: 'preview (MJPEG)',
      re: /Conversion failed!|mjpeg|mpjpeg|scale=854|pipe:1|Error while opening encoder|Could not open encoder.*mjpeg/i,
    },
    {
      leg: 'audio meters (astats)',
      re: /astats|ametadata|Error applying.*af|No such filter.*astats|Error parsing filterchain/i,
    },
    {
      leg: 'ingest (phone SRT)',
      re: /Input #0,.*srt/i,
    },
  ];
  for (const { leg, re } of checks) {
    if (re.test(text)) return leg;
  }
  if (RELAY_CONVERSION_FAILED_RE.test(text)) return 'preview (MJPEG)';
  return null;
}

export function signedExitCode(code: number | null | undefined): number | null {
  if (code == null || code === 0) return code ?? null;
  let n = Number(code);
  if (!Number.isFinite(n)) return n;
  if (n > 0x7fffffff) n -= 0x100000000;
  return n;
}

export function describeFfmpegExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  ctx: RelayLegCtx = {},
): string {
  if (signal != null) return `ffmpeg stopped (${signal})`;
  const signed = signedExitCode(code);
  if (signed == null) return 'ffmpeg exited unexpectedly';
  const phonePort = Number(ctx.listenPort) > 0 ? Math.round(Number(ctx.listenPort)) : 8000;
  const obsPort = Number(ctx.obsPort) > 0 ? Math.round(Number(ctx.obsPort)) : 8001;
  const parts = [`ffmpeg exited (code ${signed})`];
  if (signed === -1) {
    parts.push(
      `— ffmpeg stopped unexpectedly (often killed or failed to stay running); check phone SRT caller to UDP port ${phonePort} and OBS SRT caller to 127.0.0.1:${obsPort}`,
    );
  } else if (signed === -5) {
    parts.push(
      '— I/O error: SRT stream dropped, phone disconnected, or OBS is not connected as caller to the relay OBS port',
    );
  } else if (signed === -22) {
    parts.push(
      '— invalid argument (EINVAL): often a broken ffmpeg filter option (e.g. ametadata file=pipe:2 on Windows) or an encoder/mux option on an output leg',
    );
  } else if (signed === -10048) {
    parts.push(
      '— port already in use (stop other ffmpeg/relay instances, or set OBS SRT to caller on 127.0.0.1:relay OBS port, not listener)',
    );
  } else if (signed === 1) {
    parts.push('— general ffmpeg error');
  }
  return parts.join(' ');
}

function pickStderrHint(ring: string[]): string | null {
  const conversion = ring.filter((l) => RELAY_CONVERSION_FAILED_RE.test(l));
  const prefer = ring.filter((l) => RELAY_ERROR_STDERR_RE.test(l));
  const line = (conversion.length ? conversion : prefer.length ? prefer : ring).at(-1);
  return line?.trim().slice(0, 240) ?? null;
}

function formatRelayError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrRing: string[],
  ctx: RelayLegCtx = {},
): string {
  const base = describeFfmpegExit(code, signal, ctx);
  const leg = detectRelayLeg(stderrRing, ctx);
  const hint = pickStderrHint(stderrRing);
  const parts = [base];
  if (leg) parts.push(`[${leg}]`);
  if (hint) parts.push(hint);
  return parts.join(' — ');
}

const PORT_IN_USE_RE = /-10048|WSAEADDRINUSE|address already in use|Error number -10048/i;

function isPortInUseMessage(text: string): boolean {
  return PORT_IN_USE_RE.test(text);
}

function portInUseRelayError(listenPort: number | null | undefined, obsPort: number | null | undefined): string {
  const phone = Number(listenPort) > 0 ? Math.round(Number(listenPort)) : 8000;
  const obs = Number(obsPort) > 0 ? Math.round(Number(obsPort)) : 8001;
  return `Port ${phone} or ${obs} is already in use. Stop stray ffmpeg, ensure OBS uses caller (not listener) on 127.0.0.1:${obs}, then Start SRT monitoring again.`;
}

interface BuildCommandResult {
  ffmpeg: string;
  listenPort: number;
  obsPort: number;
  args: string[];
  manualCommand: string;
}

interface ResolvePorts {
  listenPort: number;
  obsPort: number;
}

export class SrtRelay {
  proc: ChildProcess | null = null;
  private _lastSpawnPid: number | null = null;
  startedAt: number | null = null;
  private _lastFrame = 0;
  private _lastFrameAt = 0;
  private _lastPreviewAt = 0;
  private _bytesApprox = 0;
  private _mjpegBuffer: Buffer = Buffer.alloc(0);
  private _mjpegClients: Set<ServerResponse> = new Set();
  private _stderrRing: string[] = [];
  private _stderrLineBuf = '';
  private _lastAudioAt = 0;
  private _hasAudioTrack: boolean | null = null;
  private _sawAstatsEver = false;
  private _parseFailLogged = false;
  private _meterGainDb = 6;
  private _peakHold: PeakHold = { left: 0, right: 0, peak: 0 };
  private _logLevel: RelayLogLevel = 'quiet';
  private _listenPort: number | null = null;
  private _obsPort: number | null = null;
  private _statsTimer: ReturnType<typeof setInterval> | null = null;

  audioLevels: AudioLevels = { left: 0, right: 0, peak: 0, silent: true, audioTrack: 'unknown' };
  onStats: ((stats: RelayStatsWithAudio) => void) | null = null;
  onProcessExit: ((info: ProcessExitInfo) => void) | null = null;
  stats: RelayStats;

  constructor() {
    this.stats = this.emptyStats();
  }

  emptyStats(): RelayStats {
    return {
      relayActive: false,
      relayConnected: false,
      previewActive: false,
      relayBitrateKbps: null,
      relayUptimeMs: 0,
      relayBytesReceived: 0,
      relayFps: null,
      relayError: null,
    };
  }

  emptyAudioLevels(): AudioLevels {
    return { left: 0, right: 0, peak: 0, silent: true, audioTrack: 'unknown' };
  }

  relayMetersHealthy(): boolean {
    if (this._hasAudioTrack === false) return false;
    if (!this._sawAstatsEver) return false;
    if (this._lastAudioAt && Date.now() - this._lastAudioAt > AUDIO_STALE_MS) return false;
    return true;
  }

  isRunning(): boolean {
    return this.proc != null && this.proc.exitCode == null;
  }

  resolvePorts(settings?: Partial<Settings>): ResolvePorts {
    const relay = settings?.relay;
    const stream = settings?.streams?.[0];
    const listenPort =
      Number(relay?.listenPort) > 0 ? Math.round(Number(relay?.listenPort)) : stream?.srtPort ?? 8000;
    const obsPort = Number(relay?.obsPort) > 0 ? Math.round(Number(relay?.obsPort)) : 8001;
    return { listenPort, obsPort };
  }

  buildCommand(settings?: Partial<Settings>): BuildCommandResult {
    const stream = settings?.streams?.[0] ?? {};
    const { listenPort, obsPort } = this.resolvePorts(settings);
    const { ingestUs, obsUs } = resolveRelaySrtLatency(settings);
    const ingestTimeoutUs = Math.max(ingestUs * 2, 5_000_000);
    const obsTimeoutUs = Math.max(obsUs * 2, 2_000_000);
    const ffmpeg = resolveFfmpegPath(settings);

    const inputUrl = `srt://0.0.0.0:${listenPort}?mode=listener&latency=${ingestUs}&timeout=${ingestTimeoutUs}`;
    const outputUrl = `srt://127.0.0.1:${obsPort}?mode=listener&latency=${obsUs}&timeout=${obsTimeoutUs}`;

    const previewVf = 'scale=854:-2,format=yuv420p';
    const args = [
      '-hide_banner',
      '-loglevel',
      'info',
      '-err_detect',
      'ignore_err',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-i',
      inputUrl,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c',
      'copy',
      '-max_muxing_queue_size',
      '256',
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      '-f',
      'mpegts',
      '-flush_packets',
      '1',
      outputUrl,
      '-map',
      '0:v:0',
      '-an',
      '-r',
      '10',
      '-vf',
      previewVf,
      '-c:v',
      'mjpeg',
      '-q:v',
      '7',
      '-f',
      'mpjpeg',
      '-flush_packets',
      '1',
      'pipe:1',
      '-map',
      '0:a:0?',
      '-af',
      ASTATS_FILTER,
      '-f',
      'null',
      '-',
    ];

    const manual = [
      `${ffmpeg} -hide_banner -loglevel info -err_detect ignore_err -fflags nobuffer -flags low_delay`,
      `-i "${inputUrl}"`,
      `-map 0:v:0 -map 0:a:0? -c copy -max_muxing_queue_size 256 -muxdelay 0 -muxpreload 0 -f mpegts -flush_packets 1 "${outputUrl}"`,
      `-map 0:v:0 -an -r 10 -vf "${previewVf}" -c:v mjpeg -q:v 7 -f mpjpeg -flush_packets 1 pipe:1`,
      `-map 0:a:0? -af "${ASTATS_FILTER}" -f null -`,
    ].join(' ');

    return { ffmpeg, listenPort, obsPort, args, manualCommand: manual };
  }

  getManualCommand(settings?: Partial<Settings>): string {
    return this.buildCommand(settings).manualCommand;
  }

  private dbToLevel(db: number): number {
    return dbToDisplayLevel(db, this._meterGainDb);
  }

  noteInputAudioFromStderr(text: string): void {
    if (/Stream #0:\d+(?:\([^)]+\))?: Audio:/i.test(text)) {
      this._hasAudioTrack = true;
      return;
    }
    if (/Output #\d+.*does not contain any stream|matches no streams|Failed to set value '0:a:0/i.test(text)) {
      this._hasAudioTrack = false;
    }
  }

  parseAudioMetadata(text: string): void {
    const channels: Record<number, { peak?: number; rms?: number }> = {};
    let overallPeak: number | null = null;
    let overallRms: number | null = null;
    let sawAstats = false;

    const normalized = text.replace(/\r/g, '\n');
    for (const line of normalized.split('\n')) {
      this.noteInputAudioFromStderr(line);
      const m = line.match(ASTATS_META);
      if (!m) continue;
      sawAstats = true;
      const key = m[1];
      const kind = m[3];
      const raw = m[4];
      const db = raw === 'inf' || raw === '-inf' || raw === 'nan' ? -60 : Number(raw);
      if (!Number.isFinite(db)) continue;

      if (key === 'Overall') {
        if (kind === 'Peak_level') overallPeak = db;
        else overallRms = db;
      } else {
        const ch = Number(key);
        if (!channels[ch]) channels[ch] = {};
        if (kind === 'Peak_level') channels[ch].peak = db;
        else channels[ch].rms = db;
      }
    }

    if (!sawAstats) return;

    this._sawAstatsEver = true;

    const ch0 = channels[0];
    const ch1 = channels[1];
    const ch2 = channels[2];

    const chRmsDb = (ch: { peak?: number; rms?: number } | undefined): number | null => {
      if (!ch) return null;
      if (Number.isFinite(ch.rms)) return ch.rms!;
      return Number.isFinite(ch.peak) ? ch.peak! : null;
    };

    let left: number;
    let right: number;
    let peakDb: number;

    if (ch1 || ch2 || ch0) {
      const lDb = chRmsDb(ch1) ?? chRmsDb(ch0) ?? overallRms ?? overallPeak;
      const rDb = chRmsDb(ch2) ?? chRmsDb(ch1) ?? chRmsDb(ch0) ?? overallRms ?? overallPeak;
      left = this.dbToLevel(lDb!);
      right = this.dbToLevel(rDb!);
      peakDb = Math.max(
        ch0?.peak ?? -60,
        ch1?.peak ?? -60,
        ch2?.peak ?? -60,
        overallPeak ?? -60,
      );
    } else {
      const monoDb = overallRms ?? overallPeak;
      const mono = this.dbToLevel(monoDb!);
      left = mono;
      right = mono;
      peakDb = overallPeak ?? overallRms ?? -60;
    }

    const instLeft = left;
    const instRight = right;
    const instPeak = this.dbToLevel(peakDb);
    const silent = instPeak < 0.02 && instLeft < 0.02 && instRight < 0.02;
    this._peakHold.peak = Math.max(instPeak, this._peakHold.peak * PEAK_HOLD_DECAY);
    if (silent) {
      this._peakHold.peak *= 0.45;
      if (this._peakHold.peak < PEAK_HOLD_SILENT_FLOOR) this._peakHold.peak = 0;
    }
    const peak = this._peakHold.peak;
    const audioTrack = this._hasAudioTrack === false ? 'none' : silent ? 'silent' : 'active';

    this.audioLevels = {
      left: Math.round(instLeft * 1000) / 1000,
      right: Math.round(instRight * 1000) / 1000,
      peak: Math.round(peak * 1000) / 1000,
      silent,
      audioTrack: audioTrack as AudioLevels['audioTrack'],
    };
    this._lastAudioAt = Date.now();
    if (this._hasAudioTrack !== false) this._hasAudioTrack = true;
    this.emitStats();
  }

  parseAudioMetadataFromStderrRing(): void {
    if (!this._stderrRing.length) return;
    const tail = this._stderrRing.slice(-30).join('\n');
    this.parseAudioMetadata(tail);
  }

  ingestMjpegChunk(chunk: Buffer | string): void {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
    this._mjpegBuffer = Buffer.concat([this._mjpegBuffer, piece]);
    const SOI = Buffer.from([0xff, 0xd8]);
    const EOI = Buffer.from([0xff, 0xd9]);

    let start = this._mjpegBuffer.indexOf(SOI);
    while (start >= 0) {
      const end = this._mjpegBuffer.indexOf(EOI, start + 2);
      if (end < 0) break;
      const frame = this._mjpegBuffer.subarray(start, end + 2);
      this._mjpegBuffer = this._mjpegBuffer.subarray(end + 2);
      this._lastPreviewAt = Date.now();
      this.stats.previewActive = true;
      this.broadcastMjpegFrame(frame);
      start = this._mjpegBuffer.indexOf(SOI);
    }

    if (this._mjpegBuffer.length > 4_000_000) {
      this._mjpegBuffer = Buffer.alloc(0);
    }
  }

  broadcastMjpegFrame(frame: Buffer): void {
    if (!this._mjpegClients.size) return;
    const header = `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`;
    for (const res of this._mjpegClients) {
      try {
        if (!res.writableEnded) {
          res.write(header);
          res.write(frame);
          res.write('\r\n');
        }
      } catch {
        this._mjpegClients.delete(res);
      }
    }
  }

  attachMjpegClient(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'keep-alive',
    });
    this._mjpegClients.add(res);
    res.on('close', () => this._mjpegClients.delete(res));
  }

  detachMjpegClients(): void {
    for (const res of this._mjpegClients) {
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* ignore */
      }
    }
    this._mjpegClients.clear();
  }

  getAudioLevels(): AudioLevels {
    const now = Date.now();
    if (this._hasAudioTrack === false) {
      return { left: 0, right: 0, peak: 0, silent: true, audioTrack: 'none' };
    }
    if (this._lastAudioAt && now - this._lastAudioAt > AUDIO_STALE_MS) {
      const staleTrack = this._hasAudioTrack === true ? 'silent' : 'unknown';
      return { left: 0, right: 0, peak: 0, silent: true, audioTrack: staleTrack };
    }
    const uptime = this.startedAt ? now - this.startedAt : 0;
    if (
      !this._sawAstatsEver &&
      this._hasAudioTrack === true &&
      this.stats.relayConnected &&
      uptime > 5000
    ) {
      if (uptime > 30_000 && !this._parseFailLogged) {
        this._parseFailLogged = true;
        console.error(
          '[relay] camera audio meters: astats metadata not seen in relay stderr after 30s — use OBS meters when connected',
        );
      }
      return {
        left: 0,
        right: 0,
        peak: 0,
        silent: true,
        audioTrack: 'parse-fail',
        meterDebug: 'astats metadata not seen in relay stderr',
      };
    }
    if (!this._lastAudioAt && this.stats.relayConnected && uptime > 3000 && !this._sawAstatsEver) {
      return {
        ...this.audioLevels,
        audioTrack: this._hasAudioTrack === true ? 'parse-fail' : 'unknown',
        meterDebug:
          this._hasAudioTrack === true
            ? 'astats metadata not seen in relay stderr'
            : 'waiting for stream audio probe',
      };
    }
    return { ...this.audioLevels };
  }

  private relayErrorFromText(
    text: string,
    listenPort: number | null | undefined,
    obsPort: number | null | undefined,
  ): string | null {
    if (isPortInUseMessage(text)) return portInUseRelayError(listenPort, obsPort);
    return null;
  }

  private killChild(proc: ChildProcess | null = this.proc): void {
    if (!proc || proc.exitCode != null) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (proc.exitCode == null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        if (process.platform === 'win32' && proc.pid) {
          execFile('taskkill', ['/PID', String(proc.pid), '/F', '/T'], { windowsHide: true }, () => {});
        }
      }
    }, KILL_GRACE_MS);
  }

  async killPidIfAlive(pid: number, label = 'previous ffmpeg'): Promise<boolean> {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    if (relayLogsVerbose(this._logLevel)) {
      console.log(`[relay] stopping ${label} (pid ${pid})`);
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await delay(RELAY_BIND_DELAY_MS);
    try {
      process.kill(pid, 0);
      if (process.platform === 'win32') {
        try {
          await execFileAsync('taskkill', ['/PID', String(pid), '/F', '/T']);
        } catch {
          /* ignore */
        }
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* already exited */
    }
    await delay(RELAY_BIND_DELAY_MS);
    return true;
  }

  async win32UdpPortPids(ports: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (process.platform !== 'win32' || !ports.length) return map;
    const want = new Set(
      ports.map((p) => Math.round(Number(p))).filter((p) => Number.isFinite(p) && p > 0),
    );
    if (!want.size) return map;
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'udp']);
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*UDP\s+(\S+):(\d+)\s+\S+:\S+\s+(\d+)\s*$/i);
        if (!m) continue;
        const port = Number(m[2]);
        const pid = Number(m[3]);
        if (!want.has(port) || !Number.isFinite(pid) || pid <= 0) continue;
        map.set(port, pid);
      }
    } catch {
      /* ignore */
    }
    return map;
  }

  async win32UdpPortsInUse(ports: number[]): Promise<number[]> {
    const pidByPort = await this.win32UdpPortPids(ports);
    return [...pidByPort.keys()];
  }

  private protectedPids(): Set<number> {
    const pids = new Set<number>();
    if (this.proc?.pid) pids.add(this.proc.pid);
    if (this._lastSpawnPid) pids.add(this._lastSpawnPid);
    return pids;
  }

  async waitForPortsReleased(ports: number[], maxMs = 2500): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const held = await this.win32UdpPortsInUse(ports);
      if (!held.length) return true;
      await delay(100);
    }
    return !(await this.win32UdpPortsInUse(ports)).length;
  }

  async killStalePortHolders(ports: number[]): Promise<boolean> {
    if (process.platform !== 'win32' || !ports.length) return false;
    if (this.isRunning()) return false;
    const exclude = this.protectedPids();
    const pidByPort = await this.win32UdpPortPids(ports);
    const toKill = new Set<number>();
    for (const [, pid] of pidByPort) {
      if (!exclude.has(pid)) toKill.add(pid);
    }
    if (!toKill.size) return false;
    let any = false;
    for (const pid of toKill) {
      if (await this.killPidIfAlive(pid, 'stale UDP port holder')) any = true;
    }
    if (any && relayLogsInfo(this._logLevel)) {
      console.log(`[relay] cleared stale port holder(s): ${[...toKill].join(', ')}`);
    }
    return any;
  }

  async prepareForBind(settings?: Partial<Settings>): Promise<ResolvePorts> {
    const { listenPort, obsPort } = this.resolvePorts(settings);
    const ports = [listenPort, obsPort];

    if (this.isRunning()) {
      const pid = this.proc?.pid;
      if (pid && relayLogsVerbose(this._logLevel)) {
        console.log(`[relay] stopping previous ffmpeg (pid ${pid})`);
      }
      await this.stop();
    } else if (this._lastSpawnPid) {
      await this.killPidIfAlive(this._lastSpawnPid);
    }

    await delay(RELAY_BIND_DELAY_MS);

    if (process.platform === 'win32') {
      await this.waitForPortsReleased(ports);
      const held = await this.win32UdpPortsInUse(ports);
      if (held.length) {
        if (relayLogsInfo(this._logLevel)) {
          console.log(`[relay] ports ${held.join(', ')} still in use; stopping holder process(es)`);
        }
        await this.killStalePortHolders(ports);
        await delay(RELAY_BIND_DELAY_MS);
        await this.waitForPortsReleased(ports, 1500);
      }
    }

    return { listenPort, obsPort };
  }

  async start(settings?: Partial<Settings>): Promise<RelayStats> {
    await this.prepareForBind(settings);
    const { ffmpeg, args, listenPort, obsPort } = this.buildCommand(settings);
    this._listenPort = listenPort;
    this._obsPort = obsPort;
    this.stats = this.emptyStats();
    this.stats.relayActive = true;
    this.audioLevels = this.emptyAudioLevels();
    this._lastFrame = 0;
    this._lastFrameAt = 0;
    this._lastPreviewAt = 0;
    this._lastAudioAt = 0;
    this._hasAudioTrack = null;
    this._sawAstatsEver = false;
    this._parseFailLogged = false;
    this._meterGainDb = resolveMeterGainDb(settings);
    this._peakHold = { left: 0, right: 0, peak: 0 };
    this._logLevel = resolveRelayLogLevel(settings);
    this._bytesApprox = 0;
    this._mjpegBuffer = Buffer.alloc(0);
    this._stderrRing = [];
    this._stderrLineBuf = '';
    this.startedAt = Date.now();

    return new Promise<RelayStats>((resolve, reject) => {
      let settled = false;
      let fatalStartTimer: ReturnType<typeof setTimeout> | null = null;
      const proc = spawn(ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;
      this._lastSpawnPid = proc.pid ?? null;
      proc.stdout!.resume();

      const failStart = (msg: string) => {
        if (settled) return;
        settled = true;
        if (fatalStartTimer) {
          clearTimeout(fatalStartTimer);
          fatalStartTimer = null;
        }
        this.clearStatsTimer();
        this.stats.relayActive = false;
        this.stats.previewActive = false;
        const friendly = this.relayErrorFromText(msg, listenPort, obsPort);
        this.stats.relayError = friendly ?? msg;
        const child = this.proc;
        this.proc = null;
        this.killChild(child);
        this.detachMjpegClients();
        this.emitStats();
        reject(new Error(this.stats.relayError ?? msg));
      };

      proc.stdout!.on('data', (chunk: Buffer) => {
        this.ingestMjpegChunk(chunk);
        this.emitStats();
      });

      const trySettleStartOk = () => {
        if (settled) return;
        settled = true;
        if (fatalStartTimer) {
          clearTimeout(fatalStartTimer);
          fatalStartTimer = null;
        }
        clearTimeout(startTimeout);
        this.stats.relayError = null;
        this.emitStats();
        resolve(this.stats);
      };

      const scheduleFatalStartCheck = () => {
        if (settled || fatalStartTimer) return;
        fatalStartTimer = setTimeout(() => {
          fatalStartTimer = null;
          if (settled) return;
          const stderrText = this._stderrRing.join('\n');
          if (!RELAY_FATAL_STDERR_RE.test(stderrText)) return;
          const friendly = this.relayErrorFromText(stderrText, listenPort, obsPort);
          const msg = friendly ?? formatRelayError(1, null, this._stderrRing, { listenPort, obsPort });
          this.killChild(proc);
          failStart(msg);
        }, 120);
      };

      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = this.consumeStderrChunk(chunk.toString('utf8'));
        if (!text) return;
        this.pushStderr(text);
        this.logStderr(text);
        this.noteInputAudioFromStderr(text);
        this.parseStderr(text);
        this.parseAudioMetadata(text);
        if (settled) return;
        if (RELAY_FATAL_STDERR_RE.test(text)) {
          scheduleFatalStartCheck();
          return;
        }
        if (RELAY_START_OK_STDERR_RE.test(text)) trySettleStartOk();
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        failStart(
          err.message?.includes('ENOENT')
            ? `ffmpeg not found (${ffmpeg}). Install ffmpeg and add it to PATH, or set relay.ffmpegPath in settings.`
            : err.message,
        );
      });

      proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        this.clearStatsTimer();
        const wasRunning = this.stats.relayActive;
        this.proc = null;
        if (proc.pid === this._lastSpawnPid) this._lastSpawnPid = null;
        this.stats.relayActive = false;
        this.stats.relayConnected = false;
        this.stats.previewActive = false;
        this.detachMjpegClients();
        if (typeof this.onProcessExit === 'function') {
          try {
            this.onProcessExit({ code, signal, wasRunning });
          } catch (err) {
            console.error('[relay] onProcessExit handler error:', (err as Error)?.message ?? err);
          }
        }
        if (!settled && code !== 0 && code != null) {
          const stderrText = this._stderrRing.join('\n');
          const friendly = this.relayErrorFromText(stderrText, listenPort, obsPort);
          failStart(
            friendly ?? formatRelayError(code, signal, this._stderrRing, { listenPort, obsPort }),
          );
          return;
        }
        if (code !== 0 && code != null && wasRunning) {
          const stderrText = this._stderrRing.join('\n');
          const friendly = this.relayErrorFromText(stderrText, listenPort, obsPort);
          this.stats.relayError =
            friendly ?? formatRelayError(code, signal, this._stderrRing, { listenPort, obsPort });
          console.error('[relay]', this.stats.relayError);
        }
        this.emitStats();
      });

      const startTimeout = setTimeout(() => {
        if (!settled && proc.exitCode == null) trySettleStartOk();
      }, 400);

      this._statsTimer = setInterval(() => {
        const pending = this.flushStderrLineBuf();
        if (pending) {
          this.noteInputAudioFromStderr(pending);
          this.parseAudioMetadata(pending);
        }
        if (!this._sawAstatsEver) {
          this.parseAudioMetadataFromStderrRing();
        }
        this.parseStderr('');
      }, STATS_TICK_MS);
    });
  }

  clearStatsTimer(): void {
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.clearStatsTimer();
    this.detachMjpegClients();
    if (!this.proc) {
      this.stats = this.emptyStats();
      this.audioLevels = this.emptyAudioLevels();
      this.startedAt = null;
      this._mjpegBuffer = Buffer.alloc(0);
      this.emitStats();
      return;
    }
    const proc = this.proc;
    const pid = proc.pid;
    this.proc = null;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        this.startedAt = null;
        this.stats = this.emptyStats();
        this.audioLevels = this.emptyAudioLevels();
        this._stderrLineBuf = '';
        this._mjpegBuffer = Buffer.alloc(0);
        this._listenPort = null;
        if (pid === this._lastSpawnPid) this._lastSpawnPid = null;
        this.emitStats();
        resolve();
      };
      proc.once('exit', finish);
      const forceTimer = setTimeout(() => {
        if (proc.exitCode == null) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          if (process.platform === 'win32' && pid) {
            execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }, () =>
              finish(),
            );
            return;
          }
        }
        finish();
      }, STOP_EXIT_TIMEOUT_MS);
      this.killChild(proc);
    });
  }

  consumeStderrChunk(text: string): string {
    if (!text) return '';
    this._stderrLineBuf += text.replace(/\r/g, '\n');
    const lines = this._stderrLineBuf.split('\n');
    this._stderrLineBuf = lines.pop() ?? '';
    if (!lines.length) return '';
    return `${lines.join('\n')}\n`;
  }

  flushStderrLineBuf(): string {
    const pending = this._stderrLineBuf.trim();
    this._stderrLineBuf = '';
    return pending || '';
  }

  pushStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this._stderrRing.push(trimmed);
    }
    if (this._stderrRing.length > 40) {
      this._stderrRing.splice(0, this._stderrRing.length - 40);
    }
  }

  logStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !isRelayHardStderrLine(trimmed)) continue;
      console.error('[relay]', trimmed);
    }
  }

  getRecentStderr(): string[] {
    return [...this._stderrRing];
  }

  parseStderr(text: string): void {
    const normalized = text.replace(/\r/g, '\n');
    for (const line of normalized.split('\n')) {
      if (!line.trim()) continue;
      if (/error|failed|invalid|unable|cannot/i.test(line) && !BITRATE_LINE.test(line)) {
        const portErr = this.relayErrorFromText(line, this._listenPort, this._obsPort);
        if (portErr) {
          if (this.stats.relayError !== portErr) {
            console.error(`[relay] connection failed: ${portErr}`);
          }
          this.stats.relayError = portErr;
        } else if (/srt|bind|address|connection|i\/o|broken|reset|refused/i.test(line)) {
          const reason = line.trim().slice(0, 200);
          if (this.stats.relayError !== reason) {
            const isSrtFail = SRT_CONNECT_FAIL_RE.test(line);
            console.error(`[relay] ${isSrtFail ? 'connection failed' : 'error'}: ${reason}`);
          }
          this.stats.relayError = reason;
        }
      }
      const m = line.match(BITRATE_LINE);
      if (m) {
        const frame = Number(m[1]);
        const fps = Number(m[2]);
        const sizeNum = Number(m[3]);
        const sizeUnit = (m[4] || 'B').toUpperCase();
        const bitrate = Number(m[5]);

        if (frame > this._lastFrame) {
          this._lastFrame = frame;
          this._lastFrameAt = Date.now();
        }
        if (Number.isFinite(fps)) this.stats.relayFps = Math.round(fps * 10) / 10;
        if (Number.isFinite(bitrate)) this.stats.relayBitrateKbps = Math.round(bitrate);

        const mult =
          sizeUnit.startsWith('K')
            ? 1024
            : sizeUnit.startsWith('M')
              ? 1024 * 1024
              : sizeUnit.startsWith('G')
                ? 1024 * 1024 * 1024
                : 1;
        const bytes = Math.round(sizeNum * mult);
        if (bytes >= this._bytesApprox) {
          this._bytesApprox = bytes;
          this.stats.relayBytesReceived = bytes;
        }
        this.stats.relayError = null;
      }
    }

    const now = Date.now();
    const ingestFresh =
      !!(this._lastFrameAt && now - this._lastFrameAt <= FRAME_STALE_MS) ||
      !!(this._lastPreviewAt && now - this._lastPreviewAt <= FRAME_STALE_MS);
    this.stats.relayConnected = ingestFresh;
    if (this._lastPreviewAt && now - this._lastPreviewAt > FRAME_STALE_MS) {
      this.stats.previewActive = false;
    } else if (this._lastPreviewAt) {
      this.stats.previewActive = true;
    }
    if (this.startedAt) {
      this.stats.relayUptimeMs = now - this.startedAt;
    }
    this.stats.relayActive = this.isRunning();
    this.emitStats();
  }

  emitStats(): void {
    if (typeof this.onStats === 'function') {
      this.onStats({ ...this.stats, audioLevels: this.getAudioLevels() });
    }
  }

  getStats(): RelayStatsWithAudio {
    this.parseStderr('');
    if (!this._sawAstatsEver) {
      this.parseAudioMetadataFromStderrRing();
    }
    return { ...this.stats, audioLevels: this.getAudioLevels() };
  }
}
