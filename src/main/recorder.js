const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateFolder(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

function safeFilePart(s) {
  const base = String(s || '').trim();
  if (!base) return 'account';
  return base
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .slice(0, 60);
}

function recorderHelperExeCandidates() {
  return [
    path.join(__dirname, 'recorder-helper', 'RecorderHelper.exe'),
    path.join(__dirname, 'recorder-helper', 'bin', 'Release', 'net6.0', 'RecorderHelper.exe'),
    path.join(__dirname, 'recorder-helper', 'bin', 'Release', 'net6.0', 'win-x64', 'publish', 'RecorderHelper.exe'),
    path.join(__dirname, 'recorder-helper', 'bin', 'Release', 'net8.0', 'RecorderHelper.exe'),
    path.join(__dirname, 'recorder-helper', 'bin', 'Release', 'net8.0', 'win-x64', 'publish', 'RecorderHelper.exe'),
  ];
}

function findRecorderHelperExe() {
  for (const p of recorderHelperExeCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }

  return null;
}

class Recorder {
  constructor({ userDataPath }) {
    this.userDataPath = userDataPath;
    this.byAccount = new Map();
    this.tabByAccount = new Map();

    this._supportsWasapi = null;

    this.fallbackRoot = path.join(this.userDataPath, 'recordings');
    try {
      fs.mkdirSync(this.fallbackRoot, { recursive: true });
      for (const name of fs.readdirSync(this.fallbackRoot)) {
        if (name.endsWith('.partial')) {
          try {
            fs.unlinkSync(path.join(this.fallbackRoot, name));
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  startTabRecording(accountId, cfg, { mimeType } = {}) {
    if (!accountId) return;
    if (this.tabByAccount.has(accountId)) return;

    const now = new Date();
    const dayFolder = formatDateFolder(now);
    const stamp = formatTimestamp(now);

    const accountName = safeFilePart(cfg.accountName);
    const fileBase = `${stamp}__${safeFilePart(accountId)}__${accountName}__call.mp3`;

    let outDir = path.join(cfg.recordingsPath, dayFolder);
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (e) {
      outDir = this.fallbackRoot;
      try {
        fs.mkdirSync(outDir, { recursive: true });
      } catch (e2) {
        return;
      }
    }


    // Удаляем брошенные .tab.webm.partial файлы в outDir
    try {
      for (const name of fs.readdirSync(outDir)) {
        if (name.endsWith('.tab.webm.partial')) {
          try { fs.unlinkSync(path.join(outDir, name)); } catch (e) {}
        }
      }
    } catch (e) {}
    const finalPath = path.join(outDir, fileBase);
    const webmPath = `${finalPath}.tab.webm.partial`;
    const mp3Quality = Number.isFinite(cfg.mp3Quality) ? String(cfg.mp3Quality) : '4';

    let stream;
    try {
      stream = fs.createWriteStream(webmPath, { flags: 'w' });
    } catch (e) {
      return;
    }

    this.tabByAccount.set(accountId, {
      accountId,
      startedAt: Date.now(),
      webmPath,
      finalPath,
      stream,
      mimeType: String(mimeType || ''),
      mp3Quality,
      stopping: false,
    });
  }

  appendTabChunk(accountId, data) {
    const cur = this.tabByAccount.get(accountId);
    if (!cur || !cur.stream || cur.stopping) return;
    try {
      let buf;
      if (Buffer.isBuffer(data)) {
        buf = data;
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(new Uint8Array(data));
      } else if (data && data.buffer instanceof ArrayBuffer) {
        buf = Buffer.from(new Uint8Array(data.buffer));
      } else {
        return;
      }
      cur.stream.write(buf);
    } catch (e) {}
  }

  stopTabRecording(accountId) {
    const cur = this.tabByAccount.get(accountId);
    if (!cur) return;
    if (cur.stopping) return;
    cur.stopping = true;

    const transcode = () => {
      try {
        if (!fs.existsSync(cur.webmPath)) {
          this.tabByAccount.delete(accountId);
          return;
        }

        const proc = spawn(
          ffmpegPath,
          [
            '-hide_banner',
            '-y',
            '-f',
            'webm',
            '-i',
            cur.webmPath,
            '-c:a',
            'libmp3lame',
            '-q:a',
            String(cur.mp3Quality || '4'),
            '-ar',
            '44100',
            '-ac',
            '2',
            '-f',
            'mp3',
            '-id3v2_version',
            '3',
            cur.finalPath,
          ],
          { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
        );

        let ffErr = '';
        proc.stderr.on('data', (d) => { ffErr += d.toString('utf8'); });

        proc.on('exit', (code) => {
          try {
            if (fs.existsSync(cur.finalPath) && fs.statSync(cur.finalPath).size > 1024) {
              fs.unlinkSync(cur.webmPath);
            } else {
              console.log('[tab-recorder] transcode failed, code=' + code + ', err=' + ffErr.slice(0, 300));
            }
          } catch (e) {}
          this.tabByAccount.delete(accountId);
        });
      } catch (e) {
        this.tabByAccount.delete(accountId);
      }
    };

    try {
      cur.stream.once('close', () => transcode());
      cur.stream.end();
    } catch (e) {
      transcode();
    }
  }

  _listDshowAudioDevicesSync() {
    try {
      const r = spawnSync(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;
      return this.parseDshowAudioDevices(out);
    } catch (e) {
      return [];
    }
  }

  async testRecording(cfg) {
    const durationSec = Math.max(1, Math.min(60, Number(cfg && cfg.durationSec) || 10));
    const mp3Quality = Number.isFinite(cfg && cfg.mp3Quality) ? String(cfg.mp3Quality) : '4';

    const micDevice = String((cfg && cfg.micDevice) || 'default').trim() || 'default';
    const speakerDevice = String((cfg && cfg.speakerDevice) || 'default').trim() || 'default';

    let outDir = String((cfg && cfg.recordingsPath) || '').trim();
    if (!outDir) {
      outDir = this.fallbackRoot;
    }

    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (e) {
      outDir = this.fallbackRoot;
      try {
        fs.mkdirSync(outDir, { recursive: true });
      } catch (e2) {
        return { ok: false, error: 'Failed to create recordings directory.' };
      }
    }

    const outPath = path.join(outDir, `test_${Date.now()}.mp3`);

    const helperExe = findRecorderHelperExe();
    if (helperExe) {
      const proc = spawn(
        helperExe,
        [
          '--out',
          outPath,
          '--seconds',
          String(durationSec),
          '--mic',
          String(cfg && cfg.micDevice ? cfg.micDevice : ''),
          '--quality',
          mp3Quality,
        ],
        {
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );

      let err = '';
      proc.stderr.on('data', (d) => (err += d.toString('utf8')));

      const code = await new Promise((resolve) => {
        proc.on('close', (c) => resolve(typeof c === 'number' ? c : 0));
        proc.on('error', () => resolve(1));
      });

      try {
        const exists = fs.existsSync(outPath);
        if (code !== 0 && !exists) {
          return { ok: false, error: (err || 'RecorderHelper failed.').trim() };
        }
        if (!exists) {
          return { ok: false, error: (err || 'RecorderHelper produced no output file.').trim() };
        }

        const st = fs.statSync(outPath);
        if (!st || !Number.isFinite(st.size) || st.size < 2048) {
          return { ok: false, savedPath: outPath, error: (err || 'Recording file is too small / invalid.').trim() };
        }

        let fileUrl;
        try {
          fileUrl = pathToFileURL(outPath).toString();
        } catch (e) {}

        return { ok: true, savedPath: outPath, fileUrl };
      } catch (e) {
        return { ok: false, savedPath: fs.existsSync(outPath) ? outPath : undefined, error: (e && e.message) || String(e) };
      }
    }

    const useWasapi = this.supportsWasapi();
    const backend = useWasapi ? 'wasapi' : 'dshow';
    const dshowInput = (name) => {
      const n = String(name || '').trim();
      if (!n || n === 'default') return null;
      return `audio=${n}`;
    };

    let args;
    const wavTmpPath = outPath.replace(/\.mp3$/i, '.wav');
    if (useWasapi) {
      const mic = micDevice && micDevice.trim() ? micDevice.trim() : 'default';
      const out = speakerDevice && speakerDevice.trim() ? speakerDevice.trim() : 'default';

      args = [
        '-hide_banner',
        '-y',
        '-t',
        String(durationSec),
        '-f',
        'wasapi',
        '-i',
        mic,
        '-f',
        'wasapi',
        '-loopback',
        '1',
        '-i',
        out,
        '-filter_complex',
        '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2',
        '-c:a',
        'pcm_s16le',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-f',
        'wav',
        wavTmpPath,
      ];
    } else {
      let micName = micDevice;
      if (!micName || micName === 'default') {
        const names = this._listDshowAudioDevicesSync();
        micName = names[0] || 'default';
      }

      let speakerName = speakerDevice;
      if (!speakerName || speakerName === 'default') {
        speakerName = '';
      }

      if (speakerName && micName && speakerName.trim().toLowerCase() === micName.trim().toLowerCase()) {
        speakerName = '';
      }

      const mic = dshowInput(micName);
      const spk = dshowInput(speakerName);

      if (!mic) {
        return { ok: false, error: 'No DirectShow microphone device found.' };
      }

      if (spk) {
        args = [
          '-hide_banner',
          '-y',
          '-t',
          String(durationSec),
          '-f',
          'dshow',
          '-i',
          mic,
          '-f',
          'dshow',
          '-i',
          spk,
          '-filter_complex',
          '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2',
          '-c:a',
          'pcm_s16le',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-f',
          'wav',
          wavTmpPath,
        ];
      } else {
        args = [
          '-hide_banner',
          '-y',
          '-t',
          String(durationSec),
          '-f',
          'dshow',
          '-i',
          mic,
          '-c:a',
          'pcm_s16le',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-f',
          'wav',
          wavTmpPath,
        ];
      }
    }

    const proc = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString('utf8')));

    const killAfterMs = (durationSec + 7) * 1000;
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (e) {}
    }, killAfterMs);

    const code = await new Promise((resolve) => {
      proc.on('close', (c) => resolve(typeof c === 'number' ? c : 0));
      proc.on('error', () => resolve(1));
    });

    clearTimeout(killTimer);

    try {
      const wavExists = fs.existsSync(wavTmpPath);
      if (code !== 0 && !wavExists) {
        return { ok: false, backend, error: (err || 'ffmpeg failed.').trim() };
      }
      if (!wavExists) {
        return { ok: false, backend, error: (err || 'ffmpeg produced no output file.').trim() };
      }

      const enc = spawnSync(
        ffmpegPath,
        [
          '-hide_banner',
          '-y',
          '-i',
          wavTmpPath,
          '-c:a',
          'libmp3lame',
          '-q:a',
          mp3Quality,
          '-ar',
          '44100',
          '-ac',
          '2',
          '-f',
          'mp3',
          '-id3v2_version',
          '3',
          outPath,
        ],
        { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

      const encOut = `${enc.stdout || ''}\n${enc.stderr || ''}`;
      const mp3Exists = fs.existsSync(outPath);
      if (!mp3Exists) {
        return { ok: false, backend, savedPath: wavTmpPath, error: (encOut || 'MP3 encode failed.').trim() };
      }

      try {
        fs.unlinkSync(wavTmpPath);
      } catch (e) {}

      const st = fs.statSync(outPath);
      if (!st || !Number.isFinite(st.size) || st.size < 2048) {
        return { ok: false, backend, savedPath: outPath, error: (encOut || 'MP3 is too small / invalid.').trim() };
      }

      const buf = fs.readFileSync(outPath);
      const b64 = buf.toString('base64');
      let fileUrl;
      try {
        fileUrl = pathToFileURL(outPath).toString();
      } catch (e) {}
      return { ok: true, backend, savedPath: outPath, fileUrl, dataUrl: `data:audio/mpeg;base64,${b64}` };
    } catch (e) {
      return {
        ok: false,
        backend,
        savedPath: fs.existsSync(outPath) ? outPath : undefined,
        error: (e && e.message) || String(e),
      };
    }
  }

  supportsWasapi() {
    if (this._supportsWasapi !== null) return this._supportsWasapi;
    try {
      const r = spawnSync(ffmpegPath, ['-hide_banner', '-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy'], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 6000,
      });
      const out = `${r.stdout || ''}\n${r.stderr || ''}`;

      if (/unknown input format\s*:\s*'wasapi'/i.test(out) || /unknown input format\s+wasapi/i.test(out)) {
        this._supportsWasapi = false;
        return false;
      }

      const names = [];
      const seen = new Set();
      for (const line of out.split(/\r?\n/)) {
        const l = String(line || '').trim();
        if (!l) continue;
        if (/alternative name/i.test(l)) continue;
        const m = l.match(/\"([^\"]+)\"/);
        if (!m) continue;
        const v = String(m[1] || '').trim();
        if (!v) continue;
        if (v.toLowerCase() === 'dummy') continue;
        if (!seen.has(v)) {
          seen.add(v);
          names.push(v);
        }
      }

      this._supportsWasapi = names.length > 0;
      return this._supportsWasapi;
    } catch (e) {
      this._supportsWasapi = false;
      return false;
    }
  }

  parseDshowAudioDevices(out) {
    const names = [];
    const seen = new Set();
    let inAudio = false;

    for (const line of String(out || '').split(/\r?\n/)) {
      const l = String(line || '').trim();
      if (!l) continue;

      if (/DirectShow audio devices/i.test(l)) {
        inAudio = true;
        continue;
      }
      if (/DirectShow video devices/i.test(l)) {
        inAudio = false;
        continue;
      }
      if (!inAudio) continue;
      if (/Alternative name/i.test(l)) continue;

      const m = l.match(/\"([^\"]+)\"/);
      if (!m) continue;
      const v = String(m[1] || '').trim();
      if (!v) continue;
      if (!seen.has(v)) {
        seen.add(v);
        names.push(v);
      }
    }

    return names;
  }

  async listWasapiDevices() {
    return new Promise((resolve) => {
      const useWasapi = this.supportsWasapi();
      const args = useWasapi
        ? ['-hide_banner', '-list_devices', 'true', '-f', 'wasapi', '-i', 'dummy']
        : ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];

      const proc = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      proc.stdout.on('data', (d) => (out += d.toString('utf8')));
      proc.stderr.on('data', (d) => (out += d.toString('utf8')));

      proc.on('close', () => {
        if (!useWasapi) {
          resolve(this.parseDshowAudioDevices(out));
          return;
        }

        const names = [];
        const seen = new Set();

        for (const line of out.split(/\r?\n/)) {
          const l = String(line || '').trim();
          if (!l) continue;
          if (/alternative name/i.test(l)) continue;

          const m = l.match(/\"([^\"]+)\"/);
          if (!m) continue;

          const v = String(m[1] || '').trim();
          if (!v) continue;
          if (v.toLowerCase() === 'dummy') continue;

          if (!seen.has(v)) {
            seen.add(v);
            names.push(v);
          }
        }

        resolve(names);
      });

      proc.on('error', () => resolve([]));
    });
  }

  startCandidateRecording(accountId, cfg) {
    const current = this.byAccount.get(accountId);
    if (current && current.state === 'recording') return;

    const now = new Date();
    const dayFolder = formatDateFolder(now);
    const stamp = formatTimestamp(now);

    const accountName = safeFilePart(cfg.accountName);
    const fileBase = `${stamp}__${safeFilePart(accountId)}__${accountName}__call.mp3`;

    let outDir = path.join(cfg.recordingsPath, dayFolder);
    let usingFallback = false;
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (e) {
      usingFallback = true;
      outDir = this.fallbackRoot;
      try {
        fs.mkdirSync(outDir, { recursive: true });
      } catch (e2) {
        return;
      }
    }

    const finalPath = path.join(outDir, fileBase);
    let partialPath = `${finalPath}.partial`;

    const mp3Quality = Number.isFinite(cfg.mp3Quality) ? String(cfg.mp3Quality) : '4';

    const helperExe = findRecorderHelperExe();
    if (helperExe) {
      const proc = spawn(
        helperExe,
        [
          '--out',
          partialPath,
          '--mic',
          String(cfg.micDevice || ''),
          '--quality',
          mp3Quality,
        ],
        {
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );

      const startedAt = Date.now();

      const state = {
        state: 'recording',
        accountId,
        startedAt,
        confirmedCall: false,
        proc,
        finalPath,
        partialPath,
        usingFallback: false,
        minDurationSec: Number.isFinite(cfg.minDurationSec) ? cfg.minDurationSec : 10,
        stopRequested: false,
      };

      proc.stderr.on('data', () => {});

      proc.on('exit', () => {
        const cur = this.byAccount.get(accountId);
        if (cur && cur.proc === proc) {
          if (!cur.stopRequested) {
            try {
              if (fs.existsSync(cur.partialPath)) fs.unlinkSync(cur.partialPath);
            } catch (e) {}
          }
          this.byAccount.delete(accountId);
        }
      });

      this.byAccount.set(accountId, state);
      return;
    }

    const micDevice = (cfg.micDevice || 'default').trim();
    const speakerDevice = (cfg.speakerDevice || 'default').trim();

    const useWasapi = this.supportsWasapi();

    const spoolFormat = 'wav';
    partialPath = `${finalPath.replace(/\.mp3$/i, '.wav')}.partial`;

    const dshowInput = (name) => {
      const n = String(name || '').trim();
      if (!n || n === 'default') return null;
      return `audio=${n}`;
    };

    let args;
    if (useWasapi) {
      const mic = micDevice && micDevice.trim() ? micDevice.trim() : 'default';
      const out = speakerDevice && speakerDevice.trim() ? speakerDevice.trim() : 'default';

      args = [
        '-hide_banner',
        '-y',
        '-f',
        'wasapi',
        '-i',
        mic,
        '-f',
        'wasapi',
        '-loopback',
        '1',
        '-i',
        out,
        '-filter_complex',
        '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2',
        '-c:a',
        'pcm_s16le',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-f',
        'wav',
        partialPath,
      ];
    } else {
      let micName = micDevice;
      if (!micName || micName === 'default') {
        const names = this._listDshowAudioDevicesSync();
        micName = names[0] || 'default';
      }

      let speakerName = speakerDevice;
      if (!speakerName || speakerName === 'default') {
        speakerName = '';
      }

      if (speakerName && micName && speakerName.trim().toLowerCase() === micName.trim().toLowerCase()) {
        speakerName = '';
      }

      const mic = dshowInput(micName);
      const spk = dshowInput(speakerName);

      if (!mic) {
        return;
      }

      if (spk) {
        args = [
          '-hide_banner',
          '-y',
          '-f',
          'dshow',
          '-i',
          mic,
          '-f',
          'dshow',
          '-i',
          spk,
          '-filter_complex',
          '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2',
          '-c:a',
          'pcm_s16le',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-f',
          'wav',
          partialPath,
        ];
      } else {
        args = [
          '-hide_banner',
          '-y',
          '-f',
          'dshow',
          '-i',
          mic,
          '-c:a',
          'pcm_s16le',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-f',
          'wav',
          partialPath,
        ];
      }
    }

    const proc = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    const startedAt = Date.now();

    const state = {
      state: 'recording',
      accountId,
      startedAt,
      confirmedCall: false,
      proc,
      finalPath,
      partialPath,
      spoolFormat,
      mp3Quality,
      usingFallback,
      minDurationSec: Number.isFinite(cfg.minDurationSec) ? cfg.minDurationSec : 10,
      stopRequested: false,
    };

    proc.stderr.on('data', () => {});

    proc.on('exit', () => {
      const cur = this.byAccount.get(accountId);
      if (cur && cur.proc === proc) {
        this.byAccount.delete(accountId);
      }
    });

    this.byAccount.set(accountId, state);
  }

  confirmCall(accountId) {
    const cur = this.byAccount.get(accountId);
    if (!cur) return;
    cur.confirmedCall = true;
  }

  stopIfRecording(accountId, { deleteIfUnconfirmed, forceDelete } = {}) {
    const cur = this.byAccount.get(accountId);
    if (!cur || cur.state !== 'recording') return;
    if (cur.stopRequested) return;

    cur.stopRequested = true;

    const proc = cur.proc;

    try {
      if (proc.stdin) {
        proc.stdin.write('q\n');
        proc.stdin.end();
      }
    } catch (e) {}

    const startedAt = cur.startedAt;

    const finalize = () => {
      const durationSec = Math.max(0, (Date.now() - startedAt) / 1000);

      const tooShort = durationSec < (Number.isFinite(cur.minDurationSec) ? cur.minDurationSec : 10);

      const shouldDeleteUnconfirmed = Boolean(deleteIfUnconfirmed) && !cur.confirmedCall && tooShort;

      const shouldDelete = Boolean(forceDelete) || shouldDeleteUnconfirmed;

      try {
        if (shouldDelete) {
          if (fs.existsSync(cur.partialPath)) fs.unlinkSync(cur.partialPath);
        } else {
          if (cur.spoolFormat === 'wav') {
            if (fs.existsSync(cur.partialPath)) {
              const enc = spawnSync(
                ffmpegPath,
                [
                  '-hide_banner',
                  '-y',
                  '-f',
                  'wav',
                  '-i',
                  cur.partialPath,
                  '-c:a',
                  'libmp3lame',
                  '-q:a',
                  String(cur.mp3Quality || '4'),
                  '-ar',
                  '44100',
                  '-ac',
                  '2',
                  '-f',
                  'mp3',
                  '-id3v2_version',
                  '3',
                  cur.finalPath,
                ],
                { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
              );
              const encOut = `${enc.stdout || ''}\n${enc.stderr || ''}`;
              if (fs.existsSync(cur.finalPath)) {
                try {
                  fs.unlinkSync(cur.partialPath);
                } catch (e) {}
              } else {
                // keep wav for debugging
                void encOut;
              }
            }
          } else {
            if (fs.existsSync(cur.partialPath)) {
              fs.renameSync(cur.partialPath, cur.finalPath);
            }
          }
        }
      } catch (e) {
        // ignore
      }

      this.byAccount.delete(accountId);
    };

    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (e) {}
      finalize();
    }, 5000);

    proc.once('close', () => {
      clearTimeout(timeout);
      finalize();
    });
  }
}

module.exports = {
  Recorder,
};
