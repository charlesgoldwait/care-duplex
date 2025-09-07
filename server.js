// server.js — Phase 6 (minimal DG config) + dual handlers + RMS + safe WS
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('@deepgram/sdk'); // v3

const app = express();
app.use(express.urlencoded({ extended: false }));

console.log('DG key present?', !!process.env.DEEPGRAM_API_KEY);
const deepgram = createClient(process.env.DEEPGRAM_API_KEY || '');

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

/* ---- Tone helpers ---- */
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
  const out = Buffer.allocUnsafe(muBuf.length * 2);
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

wss.on('connection', (ws) => {
  console.log('🔗 WS connected');

  let streamSid = null;
  let frames = 0;

  let dgSocket = null;
  let dgReady = false;

  ws.on('error', (err) => console.error('❌ WS error:', err?.message || err));

  ws.on('message', async (rawMsg) => {
    let json;
    try { json = JSON.parse(rawMsg.toString()); }
    catch { console.error('Bad WS message (not JSON)'); return; }

    if (json.event === 'start') {
      streamSid = json.start.streamSid;
      console.log('▶️ stream started', streamSid);

      try {
        // 🔽 MINIMAL Deepgram config
        dgSocket = deepgram.listen.live({
          model: 'general',       // always available
          encoding: 'linear16',   // we send PCM16
          sample_rate: 8000,      // 8kHz telephony
        });

        dgSocket.on('open', () => { dgReady = true; console.log('🔗 connected to Deepgram'); });

        dgSocket.on('transcriptReceived', (data) => {
          try {
            if (data?.type !== 'Results') return;
            const alt = data.channel?.alternatives?.[0];
            const transcript = alt?.transcript || '';
            const isFinal = !!data?.is_final;
            if (!transcript) return;
            console.log(isFinal ? `📝 FINAL: ${transcript}` : `✏️ partial: ${transcript}`);
          } catch (e) { console.error('DG transcript handler error:', e.message); }
        });

        // Generic path (some SDK variants emit via 'message')
        dgSocket.on('message', (raw) => {
          try {
            const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
            const data = JSON.parse(s);
            if (data?.type === 'Results') {
              const alt = data.channel?.alternatives?.[0];
              const transcript = alt?.transcript || '';
              const isFinal = !!data.is_final;
              if (transcript) {
                console.log(isFinal ? `📝 FINAL (msg): ${transcript}` : `✏️ partial (msg): ${transcript}`);
              }
            } else if (data?.type) {
              console.log('💬 DG message type:', data.type);
            }
          } catch { /* ignore non-JSON control frames */ }
        });

        dgSocket.on('error', (e) => console.error('Deepgram error:', e?.message || e));
        dgSocket.on('close', (code, reason) => {
          dgReady = false;
          console.log('🔌 Deepgram closed', code || '', reason?.toString?.() || '');
        });
      } catch (e) {
        console.error('Failed to open Deepgram live socket:', e.message);
      }

      // Outbound beep
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

      if (dgSocket && dgReady && json.media?.payload) {
        try {
          const mu = Buffer.from(json.media.payload, 'base64');   // 160 B / 20ms
          const pcm16 = muLawBufferToPCM16Buffer(mu);             // 320 B / 20ms

          if (frames % 50 === 0) {
            const r = Math.round(rmsInt16LE(pcm16));
            console.log(`🎧 received ${frames} audio frames | 📤 to DG bytes: ${pcm16.length} | 🔊 RMS: ${r}`);
          }

          dgSocket.send(pcm16);
        } catch (e) {
          console.error('Deepgram send error:', e.message);
        }
      }
    }

    if (json.event === 'mark') {
      console.log('✅ mark acknowledged by Twilio:', json?.mark?.name);
    }

    if (json.event === 'stop') {
      console.log('⏹️ stream stopped', streamSid);
      try {
        if (dgSocket && typeof dgSocket.finish === 'function') {
          await dgSocket.finish(); // flush finals if any
        }
      } catch (e) {
        console.error('Deepgram finish error:', e.message);
      } finally {
        try { dgSocket && dgSocket.close && dgSocket.close(); } catch {}
        dgSocket = null;
        dgReady = false;
      }
    }
  });

  ws.on('close', async () => {
    console.log('🔌 WS closed');
    try {
      if (dgSocket && typeof dgSocket.finish === 'function') {
        await dgSocket.finish();
      }
    } catch (e) {
      console.error('Deepgram finish-on-close error:', e.message);
    } finally {
      try { dgSocket && dgSocket.close && dgSocket.close(); } catch {}
      dgSocket = null;
      dgReady = false;
    }
  });
});

/* ----------------------- START SERVER ----------------------- */

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`HTTP/WS listening on :${PORT}`));
