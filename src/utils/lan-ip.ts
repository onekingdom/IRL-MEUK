import os from 'os';

/** First non-internal IPv4 address (typical LAN IP for startup logs). */
export function detectLanIpv4(): string | null {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}
