// server.js — Phase 6 (raw Deepgram WS) : PCM16 → DG, explicit headers, clear Results logs
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws'); // raw WS for Deepgram

const app = express();
app.use(express.urlencoded({ extended: false }));

// ---- sanity (do not print the key) ----
const DG_KEY_PRESENT = !!process.env.DEEPGRAM_API_KEY;
console.log('DG key present?', DG_KEY_PRESENT);
const DG_API_KEY = process.env.DEEPGRAM_API_KEY || '';

/* ----------------------- HTTP ROUTES ----------------------- */

app.get('/', (_req, res) => res.send('OK'));

app.all('/twiml', (_req, res) => {
  const host = process.env.PUBLIC_HOST || 'localhost:3000';
  const twiml =
    `<Response>
       <Connect>
         <Stream url="wss://${host}/media"/>
       </Connect>
     </Response>`;
  res.type('text/xml').send(twiml);
});

/* ----------------------- WEBSOCKET SERVER ----------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

/* ---- 8k μ-law tone helpers ---- */
function pcmSample(t, freq = 440, amp = 0.6) {
  const v = Math.sin(2 * Math.PI * freq * t) * amp;
  const clamped = Math.max(-1, Math.min(1, v));
  return Math.trunc(clamped * 32767);
}
function linearToMuLaw(sample) {
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function makeToneBase64({ durationMs = 800, freqHz = 440 }) {
  const sampleRate = 8000;
  const total = Math.floor(sampleRate * (durationMs / 1000));
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    bytes[i] = linearToMuLaw(pcmSample(t, freqHz, 0.6));
  }
  return Buffer.from(bytes).toString('base64');
}

/* ---- μ-law (8k) → PCM16 + RMS ---- */
const MU_LAW_DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    let sign = mu & 0x80;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0f;
    let magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
    magnitude -= 0x84;
    table[i] = sign ? -magnitude : magnitude;
  }
  return table;
})();
function muLawBufferToPCM16Buffer(muBuf) {
  const out = Buffer.allocUnsafe(muBuf.length * 2); // 2 bytes/sample
  for (let i = 0; i < muBuf.length; i++) {
    const s = MU_LAW_DECODE_TABLE[muBuf[i]];
    out.writeInt16LE(s, i * 2);
  }
  return out;
}
function rmsInt16LE(buf) {
  let sumSq = 0;
  const samples = buf.length / 2;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / Math.max(1, samples));
}

/* ---- Deepgram raw WS helper ---- */
function openDeepgramRaw() {
  // Minimal, safe URL — tested across accounts
  const params = new URLSearchParams({
    model: 'general',       // safest always-on model
    encoding: 'linear16',   // we send PCM16 LE
    sample_rate: '8000',
  });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const headers = { Authorization: `Token ${DG_API_KEY}` };

  const dg = new WebSocket(url, { headers });
  dg.binaryType = 'arraybuffer';

  dg.on('open', () => console.log('🔗 Deepgram (raw) open'));
  dg.on('error', (e) => console.error('Deepgram (raw) error:', e?.message || e));
  dg.on('close', (code, reason) =>
    console.log('🔌 Deepgram (raw) closed', code || '', reason?.toString?.() || '')
  );

  // Results from Deepgram arrive as JSON text frames.
  dg.on('message', (data) => {
    try {
      const txt = Buffer.isBuffer(data) ? data.toString('utf8') :
                  typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      const msg = JSON.parse(txt);
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        const transcript = alt?.transcript || '';
        const isFinal = !!msg.is_final;
        if (transcript) {
          console.log(isFinal ? `📝 FINAL: ${transcript}` : `✏️ partial: ${transcript}`);
        }
      } else if (msg.type) {
        console.log('💬 DG message type:', msg.type);
      }
    } catch {
      // Ignore non-JSON control frames.
    }
  });

  return dg;
}

wss.on('connection', (ws) => {
  console.log('🔗 WS connected');

  let streamSid = null;
  let frames = 0;

  // Deepgram state
  let dg = null;
  let dgReady = false;

  ws.on('error', (err) => console.error('❌ WS error:', err?.message || err));

  ws.on('message', async (rawMsg) => {
    let json;
    try { json = JSON.parse(rawMsg.toString()); }
    catch { console.error('Bad WS message (not JSON)'); return; }

    if (json.event === 'start') {
      streamSid = json.start.streamSid;
      console.log('▶️ stream started', streamSid);

      // Open raw DG socket
      try {
        dg = openDeepgramRaw();
        dg.on('open', () => { dgReady = true; });
      } catch (e) {
        console.error('Failed to open Deepgram raw socket:', e.message);
      }

      // Outbound beep to prove duplex
      const b64 = makeToneBase64({ durationMs: 800, freqHz: 440 });
      const BYTES_PER_20MS = 160;
      const CHUNK_B64_LEN = Math.ceil(BYTES_PER_20MS * 4 / 3);
      let offset = 0;
      const sendFrame = () => {
        if (offset >= b64.length) {
          ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'hello_done' } }));
          return;
        }
        const payload = b64.slice(offset, offset + CHUNK_B64_LEN);
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
        offset += CHUNK_B64_LEN;
        setTimeout(sendFrame, 20);
      };
      sendFrame();
    }

    if (json.event === 'media') {
      frames++;

      if (dg && dgReady && json.media?.payload) {
        try {
          const mu = Buffer.from(json.media.payload, 'base64');  // 160 B / 20ms
          const pcm16 = muLawBufferToPCM16Buffer(mu);            // 320 B / 20ms

          if (frames % 50 === 0) {
            const r = Math.round(rmsInt16LE(pcm16));
            console.log(`🎧 received ${frames} audio frames | 📤 to DG bytes: ${pcm16.length} | 🔊 RMS: ${r}`);
          }

          // Send binary PCM16 directly
          dg.send(pcm16);
        } catch (e) {
          console.error('Deepgram (raw) send error:', e.message);
        }
      }
    }

    if (json.event === 'mark') {
      console.log('✅ mark acknowledged by Twilio:', json?.mark?.name);
    }

    if (json.event === 'stop') {
      console.log('⏹️ stream stopped', streamSid);
      try { dg && dg.close && dg.close(); } catch {}
      dg = null;
      dgReady = false;
    }
  });

  ws.on('close', async () => {
    console.log('🔌 WS closed');
    try { dg && dg.close && dg.close(); } catch {}
    dg = null;
    dgReady = false;
  });
});

/* ----------------------- START SERVER ----------------------- */

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`HTTP/WS listening on :${PORT}`));
