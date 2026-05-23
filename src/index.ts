import { SrtRelay } from './relay/srt-relay';
import { loadSettings } from './server/config';
import { resolveFfmpegPath } from './relay/ffmpeg-path';

const settings = await loadSettings();
const relay = new SrtRelay();

let wasConnected = false;
let restartBackoffMs = 2000;

relay.onStats = (stats) => {
  if (!wasConnected && stats.relayConnected) {
    const kbps = stats.relayBitrateKbps != null ? ` (${stats.relayBitrateKbps} kbps)` : '';
    console.log(`[relay] phone connected${kbps}`);
    wasConnected = true;
    restartBackoffMs = 2000;
  } else if (wasConnected && !stats.relayConnected && stats.relayActive) {
    console.log('[relay] phone disconnected');
    wasConnected = false;
  }
};

relay.onProcessExit = ({ code, signal }) => {
  wasConnected = false;
  const reason = signal ? `signal ${signal}` : `exit code ${code}`;
  console.log(`[relay] ffmpeg stopped (${reason}) — restarting in ${restartBackoffMs / 1000}s`);
  setTimeout(() => startRelay(), restartBackoffMs);
  restartBackoffMs = Math.min(30_000, Math.round(restartBackoffMs * 1.5));
};

async function startRelay(): Promise<void> {
  const ffmpegPath = resolveFfmpegPath(settings);
  const { listenPort, obsPort } = relay.resolvePorts(settings);
  try {
    await relay.start(settings);
    console.log(
      `[relay] ffmpeg running — phone → UDP ${listenPort} | output → 127.0.0.1:${obsPort} | binary: ${ffmpegPath}`,
    );
  } catch (err) {
    console.error('[relay] failed to start:', (err as Error).message);
    setTimeout(() => startRelay(), restartBackoffMs);
    restartBackoffMs = Math.min(30_000, Math.round(restartBackoffMs * 1.5));
  }
}

await startRelay();

process.on('SIGINT', async () => {
  console.log('[relay] shutting down...');
  await relay.stop();
  process.exit(0);
});
