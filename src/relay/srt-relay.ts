import { execFile, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { Settings } from '../types/settings';
import type { ProcessExitInfo, RelayLogLevel, RelayStats } from '../types/relay';
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
const FRAME_STALE_MS = 8000;
const STATS_TICK_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExecFileError extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
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

const BITRATE_LINE =
  /frame=\s*(\d+).*?fps=\s*([\d.]+).*?size=\s*([\d.]+)([kKmMgG]?i?B).*?time=.*?bitrate=\s*([\d.]+)\s*kbits\/s/i;
const RELAY_FATAL_STDERR_RE =
  /Error opening (input|output)|Error opening input files|Error opening output files|Connection setup failure: unable to create|Error number -10048|Address already in use/i;
const RELAY_START_OK_STDERR_RE = /Press \[q\] to stop|Input #0,/;
const RELAY_ERROR_STDERR_RE = /error|failed|invalid|unable|cannot|Connection setup failure|Error number/i;
const RELAY_CONVERSION_FAILED_RE = /Conversion failed!/i;
const PORT_IN_USE_RE = /-10048|WSAEADDRINUSE|address already in use|Error number -10048/i;

interface RelayLegCtx {
  listenPort?: number;
  obsPort?: number;
}

interface ResolvePorts {
  listenPort: number;
  obsPort: number;
}

interface BuildCommandResult {
  ffmpeg: string;
  listenPort: number;
  obsPort: number;
  args: string[];
  manualCommand: string;
}

function detectRelayLeg(stderrRing: string[], ctx: RelayLegCtx = {}): string | null {
  const listenPort = Number(ctx.listenPort) > 0 ? Math.round(Number(ctx.listenPort)) : 8000;
  const obsPort = Number(ctx.obsPort) > 0 ? Math.round(Number(ctx.obsPort)) : 8001;
  const text = stderrRing.join('\n');
  const outputFailed = /Error opening output|Error opening output files/i.test(text);
  const inputFailed = /Error opening input|Error opening input files/i.test(text);
  if (outputFailed) {
    if (new RegExp(`srt://127\\.0\\.0\\.1:${obsPort}|Could not write header.*mpegts|mux.*mpegts`, 'i').test(text)) {
      return 'output SRT (destination)';
    }
    return 'output';
  }
  if (inputFailed || new RegExp(`srt://0\\.0\\.0\\.0:${listenPort}`, 'i').test(text)) {
    return 'input SRT (phone)';
  }
  if (RELAY_CONVERSION_FAILED_RE.test(text)) return 'output';
  return null;
}

function signedExitCode(code: number | null): number | null {
  if (code == null || code === 0) return code;
  let n = Number(code);
  if (!Number.isFinite(n)) return n;
  if (n > 0x7fffffff) n -= 0x100000000;
  return n;
}

function describeFfmpegExit(
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
    parts.push(`— check phone SRT caller to UDP ${phonePort} and destination caller to 127.0.0.1:${obsPort}`);
  } else if (signed === -5) {
    parts.push('— I/O error: stream dropped or destination disconnected');
  } else if (signed === -10048) {
    parts.push('— port already in use');
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

function portInUseRelayError(
  listenPort: number | null | undefined,
  obsPort: number | null | undefined,
): string {
  const phone = Number(listenPort) > 0 ? Math.round(Number(listenPort)) : 8000;
  const obs = Number(obsPort) > 0 ? Math.round(Number(obsPort)) : 8001;
  return `Port ${phone} or ${obs} is already in use. Stop any stray ffmpeg processes and try again.`;
}

export class SrtRelay {
  proc: ChildProcess | null = null;
  private _lastSpawnPid: number | null = null;
  startedAt: number | null = null;
  private _lastFrame = 0;
  private _lastFrameAt = 0;
  private _bytesApprox = 0;
  private _stderrRing: string[] = [];
  private _stderrLineBuf = '';
  private _logLevel: RelayLogLevel = 'quiet';
  private _listenPort: number | null = null;
  private _obsPort: number | null = null;
  private _statsTimer: ReturnType<typeof setInterval> | null = null;

  onStats: ((stats: RelayStats) => void) | null = null;
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

  isRunning(): boolean {
    return this.proc != null && this.proc.exitCode == null;
  }

  resolvePorts(settings?: Partial<Settings>): ResolvePorts {
    const relay = settings?.relay;
    const listenPort =
      Number(relay?.listenPort) > 0 ? Math.round(Number(relay?.listenPort)) : 8000;
    const obsPort = Number(relay?.obsPort) > 0 ? Math.round(Number(relay?.obsPort)) : 8001;
    return { listenPort, obsPort };
  }

  buildCommand(settings?: Partial<Settings>): BuildCommandResult {
    const { listenPort, obsPort } = this.resolvePorts(settings);
    const { ingestUs, obsUs } = resolveRelaySrtLatency(settings);
    const ingestTimeoutUs = Math.max(ingestUs * 2, 5_000_000);
    const obsTimeoutUs = Math.max(obsUs * 2, 2_000_000);
    const ffmpeg = resolveFfmpegPath(settings);

    const inputUrl = `srt://0.0.0.0:${listenPort}?mode=listener&latency=${ingestUs}&timeout=${ingestTimeoutUs}`;
    const outputUrl = `srt://127.0.0.1:${obsPort}?mode=listener&latency=${obsUs}&timeout=${obsTimeoutUs}`;

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
    ];

    const manual =
      `${ffmpeg} -hide_banner -loglevel info -err_detect ignore_err -fflags nobuffer -flags low_delay` +
      ` -i "${inputUrl}"` +
      ` -map 0:v:0 -map 0:a:0? -c copy -max_muxing_queue_size 256 -muxdelay 0 -muxpreload 0 -f mpegts -flush_packets 1 "${outputUrl}"`;

    return { ffmpeg, listenPort, obsPort, args, manualCommand: manual };
  }

  getManualCommand(settings?: Partial<Settings>): string {
    return this.buildCommand(settings).manualCommand;
  }

  private relayErrorFromText(
    text: string,
    listenPort: number | null | undefined,
    obsPort: number | null | undefined,
  ): string | null {
    if (PORT_IN_USE_RE.test(text)) return portInUseRelayError(listenPort, obsPort);
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
    try { process.kill(pid, 0); } catch { return false; }
    if (relayLogsVerbose(this._logLevel)) console.log(`[relay] stopping ${label} (pid ${pid})`);
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    await delay(RELAY_BIND_DELAY_MS);
    try {
      process.kill(pid, 0);
      if (process.platform === 'win32') {
        try { await execFileAsync('taskkill', ['/PID', String(pid), '/F', '/T']); } catch { /* ignore */ }
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch { /* already exited */ }
    await delay(RELAY_BIND_DELAY_MS);
    return true;
  }

  async win32UdpPortPids(ports: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (process.platform !== 'win32' || !ports.length) return map;
    const want = new Set(ports.map((p) => Math.round(Number(p))).filter((p) => p > 0));
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'udp']);
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*UDP\s+(\S+):(\d+)\s+\S+:\S+\s+(\d+)\s*$/i);
        if (!m) continue;
        const port = Number(m[2]);
        const pid = Number(m[3]);
        if (!want.has(port) || pid <= 0) continue;
        map.set(port, pid);
      }
    } catch { /* ignore */ }
    return map;
  }

  async win32UdpPortsInUse(ports: number[]): Promise<number[]> {
    return [...(await this.win32UdpPortPids(ports)).keys()];
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
      if (!(await this.win32UdpPortsInUse(ports)).length) return true;
      await delay(100);
    }
    return !(await this.win32UdpPortsInUse(ports)).length;
  }

  async killStalePortHolders(ports: number[]): Promise<boolean> {
    if (process.platform !== 'win32' || !ports.length || this.isRunning()) return false;
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
      if (relayLogsVerbose(this._logLevel)) console.log(`[relay] stopping previous ffmpeg (pid ${this.proc?.pid})`);
      await this.stop();
    } else if (this._lastSpawnPid) {
      await this.killPidIfAlive(this._lastSpawnPid);
    }

    await delay(RELAY_BIND_DELAY_MS);

    if (process.platform === 'win32') {
      await this.waitForPortsReleased(ports);
      const held = await this.win32UdpPortsInUse(ports);
      if (held.length) {
        if (relayLogsInfo(this._logLevel)) console.log(`[relay] ports ${held.join(', ')} still in use; stopping holder process(es)`);
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
    this._lastFrame = 0;
    this._lastFrameAt = 0;
    this._logLevel = resolveRelayLogLevel(settings);
    this._bytesApprox = 0;
    this._stderrRing = [];
    this._stderrLineBuf = '';
    this.startedAt = Date.now();

    return new Promise<RelayStats>((resolve, reject) => {
      let settled = false;
      let fatalStartTimer: ReturnType<typeof setTimeout> | null = null;

      const proc = spawn(ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      this.proc = proc;
      this._lastSpawnPid = proc.pid ?? null;

      const failStart = (msg: string) => {
        if (settled) return;
        settled = true;
        if (fatalStartTimer) { clearTimeout(fatalStartTimer); fatalStartTimer = null; }
        this.clearStatsTimer();
        this.stats.relayActive = false;
        const friendly = this.relayErrorFromText(msg, listenPort, obsPort);
        this.stats.relayError = friendly ?? msg;
        const child = this.proc;
        this.proc = null;
        this.killChild(child);
        this.emitStats();
        reject(new Error(this.stats.relayError ?? msg));
      };

      const trySettleStartOk = () => {
        if (settled) return;
        settled = true;
        if (fatalStartTimer) { clearTimeout(fatalStartTimer); fatalStartTimer = null; }
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
        this.parseStderr(text);
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
            ? `ffmpeg not found (${ffmpeg}). Set relay.ffmpegPath in data/settings.json.`
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
        if (typeof this.onProcessExit === 'function') {
          try { this.onProcessExit({ code, signal, wasRunning }); }
          catch (err) { console.error('[relay] onProcessExit error:', (err as Error)?.message ?? err); }
        }
        if (!settled && code !== 0 && code != null) {
          const stderrText = this._stderrRing.join('\n');
          const friendly = this.relayErrorFromText(stderrText, listenPort, obsPort);
          failStart(friendly ?? formatRelayError(code, signal, this._stderrRing, { listenPort, obsPort }));
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
        if (pending) this.parseStderr(pending);
        this.parseStderr('');
      }, STATS_TICK_MS);
    });
  }

  clearStatsTimer(): void {
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
  }

  async stop(): Promise<void> {
    this.clearStatsTimer();
    if (!this.proc) {
      this.stats = this.emptyStats();
      this.startedAt = null;
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
        this._stderrLineBuf = '';
        this._listenPort = null;
        if (pid === this._lastSpawnPid) this._lastSpawnPid = null;
        this.emitStats();
        resolve();
      };
      proc.once('exit', finish);
      const forceTimer = setTimeout(() => {
        if (proc.exitCode == null) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          if (process.platform === 'win32' && pid) {
            execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }, () => finish());
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
          if (this.stats.relayError !== portErr) console.error(`[relay] connection failed: ${portErr}`);
          this.stats.relayError = portErr;
        } else if (/srt|bind|address|connection|i\/o|broken|reset|refused/i.test(line)) {
          const reason = line.trim().slice(0, 200);
          if (this.stats.relayError !== reason) {
            console.error(`[relay] ${SRT_CONNECT_FAIL_RE.test(line) ? 'connection failed' : 'error'}: ${reason}`);
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

        if (frame > this._lastFrame) { this._lastFrame = frame; this._lastFrameAt = Date.now(); }
        if (Number.isFinite(fps)) this.stats.relayFps = Math.round(fps * 10) / 10;
        if (Number.isFinite(bitrate)) this.stats.relayBitrateKbps = Math.round(bitrate);

        const mult =
          sizeUnit.startsWith('K') ? 1024
          : sizeUnit.startsWith('M') ? 1024 * 1024
          : sizeUnit.startsWith('G') ? 1024 * 1024 * 1024
          : 1;
        const bytes = Math.round(sizeNum * mult);
        if (bytes >= this._bytesApprox) { this._bytesApprox = bytes; this.stats.relayBytesReceived = bytes; }
        this.stats.relayError = null;
      }
    }

    const now = Date.now();
    this.stats.relayConnected = !!(this._lastFrameAt && now - this._lastFrameAt <= FRAME_STALE_MS);
    if (this.startedAt) this.stats.relayUptimeMs = now - this.startedAt;
    this.stats.relayActive = this.isRunning();
    this.emitStats();
  }

  emitStats(): void {
    if (typeof this.onStats === 'function') this.onStats({ ...this.stats });
  }

  getStats(): RelayStats {
    this.parseStderr('');
    return { ...this.stats };
  }
}
