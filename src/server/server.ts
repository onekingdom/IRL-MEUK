import express from 'express';
import type { Express } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ROOT_DIR,
  loadSettings,
  saveSettings,
  buildObsSrtUrl,
  getSrtPreview,
  MEDIA_SOURCE_NAME,
} from './config';
import { discoverFfmpegCandidates, probeFfmpeg, resolveFfmpegPath } from '../relay/ffmpeg-path';
import { getPublicIp } from '../utils/public-ip';
import { ObsClient } from '../obs/obs-client';
import type { StreamMonitor } from '../monitor';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export function createServer(monitor: StreamMonitor): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    monitor.state.monitoringActive = monitor.running;
    res.json({
      monitoringActive: monitor.running,
      obsSessionActive: monitor.obsSession,
      state: monitor.state,
    });
  });

  app.get('/api/settings', async (_req, res) => {
    const settings = await loadSettings();
    const { ip, error } = await getPublicIp();
    const urlPreview = getSrtPreview(settings, {
      detectedPublicIp: ip ?? undefined,
      publicIpError: error,
    });
    res.json({ ...settings, urlPreview });
  });

  app.get('/api/network/public-ip', async (req, res) => {
    const force = req.query.force === 'true' || req.query.force === '1';
    const { ip, error } = await getPublicIp({ force });
    res.json({ ip, error });
  });

  app.get('/api/srt/preview-url', async (req, res) => {
    const settings = await loadSettings();
    if (req.query.srtBindHost) {
      settings.streams = settings.streams ?? [];
      settings.streams[0] = {
        ...settings.streams[0],
        srtBindHost: String(req.query.srtBindHost),
      };
    }
    if (req.query.srtPort != null) {
      settings.streams = settings.streams ?? [];
      settings.streams[0] = {
        ...settings.streams[0],
        srtPort: Number(req.query.srtPort),
      };
    }
    if (req.query.srtLatencyMs != null) {
      settings.streams = settings.streams ?? [];
      settings.streams[0] = {
        ...settings.streams[0],
        srtLatencyMs: Number(req.query.srtLatencyMs),
      };
    }
    if (req.query.serverHost) {
      settings.server = { ...settings.server, host: String(req.query.serverHost) };
    }
    if (req.query.wanHost != null) {
      settings.server = { ...settings.server, wanHost: String(req.query.wanHost) };
    }
    if (req.query.relayEnabled != null) {
      settings.relay = {
        ...settings.relay,
        enabled: req.query.relayEnabled === 'true' || req.query.relayEnabled === '1',
      };
    }
    if (req.query.relayListenPort != null) {
      settings.relay = { ...settings.relay, listenPort: Number(req.query.relayListenPort) };
    }
    if (req.query.relayObsPort != null) {
      settings.relay = { ...settings.relay, obsPort: Number(req.query.relayObsPort) };
    }
    const forcePublicIp = req.query.forcePublicIp === 'true' || req.query.forcePublicIp === '1';
    const { ip, error } = await getPublicIp({ force: forcePublicIp });

    res.json(
      getSrtPreview(settings, {
        detectedPublicIp: ip,
        publicIpError: error,
      }),
    );
  });

  app.put('/api/settings', async (req, res) => {
    try {
      const settings = req.body;
      await saveSettings(settings);
      await monitor.updateSettings(settings);
      let obsCamSource = null;
      if (monitor.state.obsConnected) {
        try {
          obsCamSource = await monitor.updateCamSourceUrlIfExists(settings);
        } catch (err) {
          obsCamSource = { updated: false, error: (err as Error).message };
        }
      }
      res.json({
        ok: true,
        monitoringActive: monitor.running,
        obsCamSource,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  app.patch('/api/settings/media-source', async (req, res) => {
    try {
      const { mediaSourceName } = req.body as { mediaSourceName?: string };
      if (!mediaSourceName?.trim()) {
        return res.status(400).json({ ok: false, error: 'mediaSourceName is required' });
      }
      const settings = await loadSettings();
      if (!settings.streams?.[0]) {
        settings.streams = [
          {
            id: 'stream1',
            label: 'Main camera',
            enabled: true,
            type: 'obs-media',
            mediaSourceName: mediaSourceName.trim(),
            srtBindHost: '0.0.0.0',
            srtPort: 8000,
            srtLatencyMs: 3000,
            frozenDetectSeconds: 5,
          },
        ];
      } else {
        settings.streams[0].mediaSourceName = mediaSourceName.trim();
      }
      await saveSettings(settings);
      await monitor.updateSettings(settings);
      const formField = settings.streams[0].mediaSourceName;
      res.json({ ok: true, mediaSourceName: formField, monitoringActive: monitor.running });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/stream/start', async (req, res) => {
    try {
      if (!monitor.state.obsConnected) {
        return res.status(400).json({ ok: false, error: 'OBS not connected. Connect OBS first.' });
      }
      let settings = await loadSettings();
      if (req.body?.streams || req.body?.obs) {
        const saved = settings;
        settings = { ...saved, ...req.body, obs: { ...saved.obs, ...req.body.obs } };
        if (!String(req.body?.obs?.password ?? '').trim()) {
          settings.obs.password = saved.obs.password;
        }
        if (req.body.streams) settings.streams = req.body.streams;
        await saveSettings(settings);
        monitor.settings = settings;
      }
      const obsResult = await monitor.startObsOutput();
      if (!monitor.running) {
        await monitor.startMonitoring(settings);
      }
      await monitor.refreshObsOutputStatus();
      res.json({
        ok: true,
        monitoringActive: monitor.running,
        obsOutputActive: monitor.state.obsOutputActive,
        obsStream: obsResult,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/monitor/start', async (req, res) => {
    try {
      if (monitor.running) {
        return res.json({ ok: true, already: true });
      }
      let settings = await loadSettings();
      if (req.body?.streams || req.body?.obs) {
        settings = req.body;
        await saveSettings(settings);
        monitor.settings = settings;
      }
      await monitor.startMonitoring(settings);
      res.json({ ok: true, monitoringActive: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/monitor/stop', async (_req, res) => {
    try {
      await monitor.stopMonitoring();
      res.json({
        ok: true,
        monitoringActive: false,
        obsOutputActive: monitor.state.obsOutputActive,
      });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: (err as Error).message, monitoringActive: monitor.running });
    }
  });

  app.post('/api/obs/start-stream', async (req, res) => {
    try {
      if (!monitor.state.obsConnected) {
        return res.status(400).json({ ok: false, error: 'OBS not connected. Connect OBS first.' });
      }
      let settings = await loadSettings();
      if (req.body?.streams || req.body?.obs) {
        const saved = settings;
        settings = { ...saved, ...req.body, obs: { ...saved.obs, ...req.body.obs } };
        if (!String(req.body?.obs?.password ?? '').trim()) {
          settings.obs.password = saved.obs.password;
        }
        if (req.body.streams) settings.streams = req.body.streams;
        await saveSettings(settings);
        monitor.settings = settings;
      }
      const obsResult = await monitor.startObsOutput();
      await monitor.refreshObsOutputStatus();
      res.json({
        ok: true,
        monitoringActive: monitor.running,
        obsOutputActive: monitor.state.obsOutputActive,
        obsStream: obsResult,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/obs/stop-stream', async (_req, res) => {
    try {
      if (!monitor.state.obsConnected) {
        return res.status(400).json({ ok: false, error: 'OBS not connected' });
      }
      if (!monitor.state.obsOutputActive) {
        return res.status(400).json({ ok: false, error: 'OBS is not streaming' });
      }
      monitor.cancelScheduledStreamEnd();
      await monitor.stopObsOutput();
      res.json({
        ok: true,
        obsOutputActive: monitor.state.obsOutputActive,
        monitoringActive: monitor.running,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/stream/end-scheduled', async (req, res) => {
    try {
      const settings = await loadSettings();
      const sceneName = req.body?.sceneName ?? settings.streamEnd?.sceneName ?? '';
      const delayMinutes = req.body?.delayMinutes ?? settings.streamEnd?.delayMinutes ?? 0;
      const result = await monitor.scheduleStreamEnd(sceneName, delayMinutes);
      res.json({
        ok: true,
        ...result,
        obsOutputActive: monitor.state.obsOutputActive,
        streamEndPending: monitor.state.streamEndPending,
        streamEndAt: monitor.state.streamEndAt,
        streamEndSceneName: monitor.state.streamEndSceneName,
        monitoringActive: monitor.running,
      });
    } catch (err) {
      const status = /not connected|not streaming/i.test((err as Error).message) ? 400 : 500;
      res.status(status).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/obs/connect', async (req, res) => {
    try {
      let settings = await loadSettings();
      if (req.body?.obs) {
        settings = { ...settings, ...req.body };
        await saveSettings(settings);
      }
      await monitor.connectObs(settings);
      res.json({
        ok: true,
        obsSessionActive: true,
        obsConnected: monitor.state.obsConnected,
        currentScene: monitor.state.currentScene,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/obs/disconnect', async (_req, res) => {
    try {
      await monitor.disconnectObs();
      res.json({ ok: true, obsSessionActive: false, obsConnected: false });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/api/obs/inputs', async (_req, res) => {
    try {
      if (monitor.state.obsConnected) {
        const inputs = await monitor.obs.getInputList();
        return res.json({ inputs });
      }
      const settings = await loadSettings();
      const inputs = await ObsClient.withTemporaryConnection(settings, (c) => c.getInputList());
      res.json({ inputs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/obs/rename-media-source', async (req, res) => {
    try {
      const newName = String(req.body?.newName ?? '').trim();
      if (!newName) {
        return res.status(400).json({ ok: false, error: 'newName is required' });
      }

      const settings = await loadSettings();
      const oldName = (settings.streams?.[0]?.mediaSourceName || MEDIA_SOURCE_NAME).trim();

      let obsResult = null;
      if (monitor.state.obsConnected && oldName !== newName) {
        try {
          obsResult = await monitor.renameMediaSourceInObs(oldName, newName);
        } catch (err) {
          obsResult = { renamed: false, error: (err as Error).message };
        }
      }

      if (!settings.streams?.[0]) {
        settings.streams = [
          {
            id: 'stream1',
            label: 'Main camera',
            enabled: true,
            type: 'obs-media',
            mediaSourceName: newName,
            srtBindHost: '0.0.0.0',
            srtPort: 8000,
            srtLatencyMs: 3000,
            frozenDetectSeconds: 5,
          },
        ];
      } else {
        settings.streams[0].mediaSourceName = newName;
      }
      await saveSettings(settings);
      await monitor.updateSettings(settings);

      res.json({
        ok: true,
        mediaSourceName: newName,
        oldName,
        unchanged: oldName === newName,
        obsConnected: monitor.state.obsConnected,
        renamedInObs: (obsResult as { renamed?: boolean } | null)?.renamed === true,
        sourceMissingInObs: (obsResult as { missing?: boolean } | null)?.missing === true,
        obsRenameError: (obsResult as { error?: string } | null)?.error ?? null,
        monitoringActive: monitor.running,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/obs/create-cam-source', async (req, res) => {
    try {
      let settings = await loadSettings();
      if (req.body?.streams || req.body?.scenes) {
        settings = { ...settings, ...req.body };
        if (req.body.streams) settings.streams = req.body.streams;
        if (req.body.scenes) settings.scenes = { ...settings.scenes, ...req.body.scenes };
        await saveSettings(settings);
        monitor.settings = settings;
        monitor.syncMediaSourceInState();
      }
      const result = await monitor.createCamSource(settings);
      res.json({
        ok: true,
        ...result,
        srtUrl: buildObsSrtUrl(settings),
        relayEnabled: !!settings.relay?.enabled,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/api/relay/manual-command', async (_req, res) => {
    const settings = await loadSettings();
    const { SrtRelay } = await import('../relay/srt-relay');
    const relay = new SrtRelay();
    const ffmpegPath = resolveFfmpegPath(settings);
    res.json({
      relayEnabled: !!settings.relay?.enabled,
      ffmpegPath,
      command: relay.getManualCommand(settings),
      ports: relay.resolvePorts(settings),
    });
  });

  app.get('/api/relay/discover', async (_req, res) => {
    const settings = await loadSettings();
    const candidates = discoverFfmpegCandidates();
    const resolved = resolveFfmpegPath(settings, { refresh: true });
    res.json({
      resolved,
      configured: String(settings.relay?.ffmpegPath ?? '').trim() || null,
      candidates,
      onPath: candidates.some((c) => c.source === 'PATH'),
    });
  });

  app.post('/api/relay/test', async (_req, res) => {
    const settings = await loadSettings();
    const ffmpegPath = resolveFfmpegPath(settings, { refresh: true });
    const probe = probeFfmpeg(ffmpegPath);
    const relayRunning = monitor.relay.isRunning();
    res.json({
      ok: probe.ok,
      ffmpegPath,
      versionLine: probe.versionLine,
      error: probe.error,
      relayEnabled: !!settings.relay?.enabled,
      relayActive: relayRunning,
      relayError: monitor.relay.getStats().relayError ?? monitor.state.relayError ?? null,
      recentStderr: monitor.relay.getRecentStderr(),
      ports: monitor.relay.resolvePorts(settings),
      manualCommandUrl: '/api/relay/manual-command',
    });
  });

  app.get('/api/camera/feed.mjpeg', (req, res) => {
    if (!monitor.relay.isRunning()) {
      const msg = monitor.state.relayError
        ? `Camera relay is not running: ${monitor.state.relayError}`
        : 'Camera relay is not running. Start SRT monitoring with Route through monitor enabled.';
      res.status(503).setHeader('Content-Type', 'text/plain').send(msg);
      return;
    }
    monitor.relay.attachMjpegClient(res);
  });

  app.get('/api/camera/audio-levels', (_req, res) => {
    const stats = monitor.relay.getStats();
    res.json({
      relayActive: monitor.relay.isRunning(),
      relayConnected: stats.relayConnected,
      previewActive: stats.previewActive,
      relayEnabled: monitor.state.relayEnabled,
      relayError: stats.relayError ?? monitor.state.relayError ?? null,
      obsConnected: monitor.state.obsConnected,
      ffmpegPath: resolveFfmpegPath(monitor.settings ?? {}),
      recentStderr: monitor.relay.getRecentStderr().slice(-8),
      ...monitor.getCameraAudioLevels(),
    });
  });

  app.post('/api/obs/scene', async (req, res) => {
    try {
      const { sceneName } = req.body as { sceneName: string };
      await monitor.forceScene(sceneName);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/obs/toggle-mute-mic', async (_req, res) => {
    try {
      if (!monitor.state.obsConnected) {
        return res.status(400).json({ ok: false, error: 'OBS not connected' });
      }
      const settings = monitor.settings ?? (await loadSettings());
      const inputName = (
        settings.streams?.[0]?.mediaSourceName || MEDIA_SOURCE_NAME
      ).trim();
      const { inputMuted } = await monitor.obs.toggleInputMute(inputName);
      monitor.state.mediaInputMuted = inputMuted;
      monitor.emit();
      res.json({ ok: true, inputName, inputMuted });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  app.get('/api/obs/scenes', async (_req, res) => {
    try {
      if (!monitor.state.obsConnected || !monitor.obsSession) {
        const settings = await loadSettings();
        const scenes = await ObsClient.withTemporaryConnection(settings, (c) => c.getSceneList());
        return res.json({ scenes });
      }
      const scenes = await monitor.obs.getSceneList();
      res.json({ scenes });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send(monitor.state);
    const off = monitor.onUpdate(send);

    req.on('close', () => {
      off();
      res.end();
    });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({
      ok: false,
      error: 'API route not found — restart the monitor app',
      method: req.method,
      path: req.path,
    });
  });

  app.use(express.static(PUBLIC_DIR));

  return app;
}
