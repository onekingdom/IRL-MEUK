import type { Settings } from '../types/settings';
import type { RelayLogLevel } from '../types/relay';

export function resolveRelayLogLevel(settings?: Partial<Settings>): RelayLogLevel {
  const env = String(process.env.RELAY_QUIET ?? '').trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return 'quiet';
  if (env === '0' || env === 'false' || env === 'no') return 'info';
  const raw = settings?.relay?.logLevel;
  const level = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (level === 'verbose' || level === 'info') return level as RelayLogLevel;
  return 'quiet';
}

export function relayLogsInfo(level: RelayLogLevel): boolean {
  return level === 'info' || level === 'verbose';
}

export function relayLogsVerbose(level: RelayLogLevel): boolean {
  return level === 'verbose';
}

/** ffmpeg stderr lines that are decode noise, not actionable relay failures. */
export const RELAY_STDERR_NOISE_RE =
  /Error constructing frame RPS|Skipping invalid undecodable NALU/i;

/** Lines worth printing to the server console. */
export const RELAY_STDERR_CONSOLE_RE =
  /Error opening (input|output)|Error opening input files|Error opening output files|Connection setup failure|unable to create|Error number -10048|Address already in use|Conversion failed!|Error parsing filterchain|Error parsing a filter description|No option name near|Error applying|No such filter|I\/O error|Input\/output error/i;

/** SRT-specific connection attempt failures from ffmpeg stderr. */
export const SRT_CONNECT_FAIL_RE =
  /Connection timeout|Connection was rejected|Connection reset|srt.*error|ECONNREFUSED|ETIMEDOUT|peer.*closed|broken pipe/i;

export function isRelayHardStderrLine(line: string): boolean {
  const t = String(line ?? '').trim();
  if (!t || RELAY_STDERR_NOISE_RE.test(t)) return false;
  return RELAY_STDERR_CONSOLE_RE.test(t);
}
