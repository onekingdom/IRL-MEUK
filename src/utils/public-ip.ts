const CACHE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 10_000;
const USER_AGENT = 'OK-IRL-Monitoring/1.0';

interface Provider {
  name: string;
  url: string;
  parse: (res: Response) => Promise<string>;
  accept: string;
}

interface IpResult {
  ip: string | null;
  error: string | null;
}

interface IpCache extends IpResult {
  fetchedAt: number;
}

let cache: IpCache = { ip: null, error: null, fetchedAt: 0 };
let inFlight: Promise<IpResult> | null = null;

const PROVIDERS: Provider[] = [
  {
    name: 'ipify',
    url: 'https://api.ipify.org?format=json',
    parse: async (res) => {
      const body = await res.json() as { ip?: string };
      return String(body?.ip ?? '').trim();
    },
    accept: 'application/json',
  },
  {
    name: 'ifconfig.me',
    url: 'https://ifconfig.me/ip',
    parse: async (res) => String(await res.text()).trim(),
    accept: 'text/plain',
  },
  {
    name: 'icanhazip',
    url: 'https://icanhazip.com',
    parse: async (res) => String(await res.text()).trim(),
    accept: 'text/plain',
  },
];

function isValidIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const v4 =
    /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/.test(ip);
  if (v4) return true;
  return /^[0-9a-f:]+$/i.test(ip);
}

async function fetchFromProvider(provider: Provider): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(provider.url, {
      signal: controller.signal,
      headers: { Accept: provider.accept, 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ip = await provider.parse(res);
    if (!isValidIp(ip)) throw new Error('Invalid response');
    return ip;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupPublicIp(): Promise<IpResult> {
  const failures: string[] = [];
  for (const provider of PROVIDERS) {
    try {
      const ip = await fetchFromProvider(provider);
      return { ip, error: null };
    } catch (err: unknown) {
      const e = err as Error & { name?: string };
      const detail = e?.name === 'AbortError' ? 'timed out' : e?.message ?? 'failed';
      failures.push(`${provider.name}: ${detail}`);
      console.error(`[public-ip] ${provider.name} lookup failed:`, err);
    }
  }
  const message = 'Could not detect public IP — set WAN IP on Web server tab or check internet';
  console.error('[public-ip] All providers failed:', failures.join('; '));
  return { ip: null, error: message };
}

export async function getPublicIp({ force = false } = {}): Promise<IpResult> {
  const now = Date.now();
  if (!force && cache.fetchedAt && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { ip: cache.ip, error: cache.error };
  }
  if (!force && inFlight) return inFlight;

  const run = (async () => {
    const result = await lookupPublicIp();
    cache = { ...result, fetchedAt: Date.now() };
    return result;
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}
