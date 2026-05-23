import http from 'http';
import { loadSettings, warnIfLargeRootLiveTs, resolveServerPort } from './server/config';
import { detectLanIpv4 } from './utils/lan-ip';
import { StreamMonitor } from './monitor';
import { createServer } from './server/server';

function collectListenUrls(host: string, port: number): string[] {
  const urls = new Set<string>();
  const bindAll = host === '0.0.0.0' || host === '::' || !host;
  if (bindAll) {
    urls.add(`http://127.0.0.1:${port}/`);
    const lan = detectLanIpv4();
    if (lan) urls.add(`http://${lan}:${port}/`);
  } else {
    urls.add(`http://${host}:${port}/`);
  }
  return [...urls];
}

await warnIfLargeRootLiveTs();

const monitor = new StreamMonitor();
const settings = await loadSettings();
const app = createServer(monitor);

const { host } = settings.server;
const port = resolveServerPort(settings);

monitor.settings = settings;
monitor.syncMediaSourceInState();
monitor.syncSettingsFlags();

const httpServer = http.createServer(app);

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`HTTP listen failed: port ${port} is already in use.`);
    console.error('Stop the other process, then run: bun src/index.ts');
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(
      `HTTP listen failed: cannot bind to ${host}:${port} (address not available on this PC).`,
    );
    console.error('Set server.host to "0.0.0.0" in data/settings.json.');
  } else {
    console.error(`HTTP listen failed: ${err.message}`);
  }
  process.exit(1);
});

httpServer.listen(port, host, () => {
  console.log(`OK IRL Monitoring — http://${host}:${port}`);
  for (const url of collectListenUrls(host, port)) {
    console.log(`  ${url}`);
  }
  console.log(`Forward TCP ${port} on your router for control UI over WAN.`);

  monitor.startMonitoring(settings).catch((err: Error) => {
    console.error('[monitor] auto-start failed:', err.message);
  });
});

process.on('SIGINT', async () => {
  await monitor.stop();
  httpServer.close();
  process.exit(0);
});
