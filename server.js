// server.js — Phase 8 (fixed): ASR (raw DG) + LLM + TTS back to caller (μ-law 8k)
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws'); // raw WS for Deepgram
const { createLlm } = require('./llm');
const { createTts } = require('./tts');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ---- Env sanity / toggles
const DG_API_KEY = process.env.DEEPGRAM_API_KEY || '';
console.log('DG key present?', !!DG_API_KEY);

const LOG_RMS = /^1|true$/i.test(process.env.LOG_RMS || '');
const RMS_INTERVAL = parseInt(process.env.RMS_INTERVAL || '200', 10);

// ---- LLM (OpenAI)
let llm = null;
try {
  llm = createLlm({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  });
  console.log('LLM ready?', true);
} catch (e) {
  console.warn('LLM disabled:', e.message);
}

// ---- TTS (Deepgram Speak)
let tts = null;
try {
  tts = createTts({
    dgApiKey: DG_API_KEY,
    voice: process.env.DG_VOICE || 'aura-asteria-en',
  });
  console.log('TTS ready?', true);
} catch (e) {
  console.warn('TTS disabled:', e.message);
}

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
function makeToneBase64({ durationMs = 300, freqHz = 440 }) {
  const sampleRate = 8000;
  const total = Math.floor(sampleRate * (durationMs / 1000));
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    bytes[i] = linearToMuLaw(pcmSample(t, freqHz, 0.6));
  }
  return Buffer.from(bytes).toString('base64');
}

/* ---- μ-law (8k) → PCM16 + optional RMS ---- */
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

/* ---- Deepgram raw WS (ASR) — now takes onFinal callback ---- */
function openDeepgramRaw(onFinal) {
  const params = new URLSearchParams({
    model: 'general',
    encoding: 'linear16',
    sample_rate: '8000',
  });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const headers = { Authorization: `Token ${DG_API_KEY}` };

  const dg = new WebSocket(url, { headers });
  dg.binaryType = 'arraybuffer';

  dg.on('open', () => console.log('🔗 Deepgram (raw) open'));
  dg.on('error', (e) => console.error('Deepgram (raw) error:', e?.message || e));
  dg.on('close', (code, reason) => {
    console.log('🔌 Deepgram (raw) closed', code || '', reason?.toString?.() || '');
  });

  dg.on('message', (data) => {
    try {
      const txt = Buffer.isBuffer(data) ? data.toString('utf8')
                : typeof data === 'string' ? data
                : Buffer.from(data).toString('utf8');
      const msg = JSON.parse(txt);
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        const transcript = (alt?.transcript || '').trim();
        const isFinal = !!msg.is_final;
        if (transcript && isFinal) {
          console.log(`📝 FINAL: ${transcript}`);
          if (typeof onFinal === 'function') onFinal(transcript);
        }
      }
    } catch { /* ignore non-JSON */ }
  });

  return dg;
}

/* ---- TTS playback queue (μ-law 8k back to Twilio) ---- */
function ulawBufferToBase64Frames160B(ulawBuf) {
  const pad = ulawBuf.length % 160 === 0 ? 0 : (160 - (ulawBuf.length % 160));
  const padded = pad ? Buffer.concat([ulawBuf, Buffer.alloc(pad, 0xFF)]) : ulawBuf;
  const frames = [];
  for (let i = 0; i < padded.length; i += 160) {
    frames.push(padded.subarray(i, i + 160).toString('base64'));
  }
  return frames;
}
function createSpeaker(ws, streamSid) {
  let speaking = false;
  const q = [];

  function playNext() {
    if (speaking) return;
    const next = q.shift();
    if (!next) return;

    speaking = true;
    const frames = ulawBufferToBase64Frames160B(next);
    let idx = 0;

    const sendFrame = () => {
      if (!ws || ws.readyState !== ws.OPEN) { speaking = false; return; }
      if (idx >= frames.length) {
        ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'tts_done' } }));
        speaking = false;
        if (q.length) playNext();
        return;
      }
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: frames[idx++] } }));
      setTimeout(sendFrame, 20);
    };
    sendFrame();
  }

  return {
    async sayUlaw(ulawBuf) {
      q.push(ulawBuf);
      playNext();
    },
    isSpeaking: () => speaking,
    queueSize: () => q.length,
  };
}

/* ---- Tiny LLM queue (no overlaps) ---- */
const llmQueue = [];
let llmBusy = false;

async function processLlmQueue() {
  if (llmBusy) return;
  const item = llmQueue.shift();
  if (!item) return;

  llmBusy = true;
  try {
    if (!llm) throw new Error('LLM not initialized (missing OPENAI_API_KEY?)');
    const answer = await llm.reply(item.text);
    const short = (answer || '').replace(/\s+/g, ' ').trim();
    console.log('💬 LLM:', short || '(empty)');

    // TTS: generate μ-law 8k and send back to caller
    if (!item.speaker) {
      console.warn('TTS skipped: no speaker available for this call.');
    } else if (tts && short) {
      const ulaw = await tts.synthToUlaw8k(short);
      await item.speaker.sayUlaw(ulaw);
    }
  } catch (e) {
    console.error('LLM/TTS error:', e.message);
  } finally {
    llmBusy = false;
    if (llmQueue.length) processLlmQueue();
  }
}
function enqueueLlm(text, speaker) {
  llmQueue.push({ text, speaker });
  processLlmQueue();
}

/* ----------------------- WS session ----------------------- */
wss.on('connection', (ws) => {
  console.log('🔗 WS connected');

  let streamSid = null;
  let frames = 0;

  // Deepgram state
  let dg = null;
  let dgReady = false;

  // Speaker for this call
  let speaker = null;

  ws.on('error', (err) => console.error('❌ WS error:', err?.message || err));

  ws.on('message', async (rawMsg) => {
    let json;
    try { json = JSON.parse(rawMsg.toString()); }
    catch { console.error('Bad WS message (not JSON)'); return; }

    if (json.event === 'start') {
      streamSid = json.start.streamSid;
      console.log('▶️ stream started', streamSid);

      // Create a speaker bound to this WebSocket stream
      speaker = createSpeaker(ws, streamSid);

      // Open raw DG socket; pass a callback that can see speaker
      try {
        dg = openDeepgramRaw((finalText) => enqueueLlm(finalText, speaker));
        dg.on('open', () => { dgReady = true; });
      } catch (e) {
        console.error('Failed to open Deepgram raw socket:', e.message);
      }

      // Short beep to prove path
      const b64 = makeToneBase64({ durationMs: 300, freqHz: 440 });
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

          if (LOG_RMS && frames % Math.max(1, RMS_INTERVAL) === 0) {
            const r = Math.round(rmsInt16LE(pcm16));
            console.log(`🎧 received ${frames} frames | 📤 DG bytes: ${pcm16.length} | 🔊 RMS: ${r}`);
          }

          dg.send(pcm16);
        } catch (e) {
          console.error('Deepgram (raw) send error:', e.message);
        }
      }
    }

    if (json.event === 'stop') {
      console.log('⏹️ stream stopped', streamSid);
      try { dg && dg.close && dg.close(); } catch {}
      dg = null; dgReady = false;
    }
  });

  ws.on('close', async () => {
    console.log('🔌 WS closed');
    try { dg && dg.close && dg.close(); } catch {}
  });
});

/* ----------------------- START SERVER ----------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`HTTP/WS listening on :${PORT}`));
