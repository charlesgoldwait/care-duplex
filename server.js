// server.js — Phase 8 (multi-turn safe): ASR (raw DG) + LLM + streaming TTS (μ-law 8k)
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ---- Env / toggles
const DG_API_KEY = process.env.DEEPGRAM_API_KEY || '';
console.log('DG key present?', !!DG_API_KEY);

const LOG_RMS = /^1|true$/i.test(process.env.LOG_RMS || '');
const RMS_INTERVAL = parseInt(process.env.RMS_INTERVAL || '200', 10);

// ---- LLM (OpenAI)
const { createLlm } = require('./llm');
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

// ---- TTS (Deepgram Speak) — must expose startTTS(text, onFrame)
const { createTts } = require('./tts');
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
  res.type('text/xml').send(
`<Response>
  <Connect>
    <Stream url="wss://${host}/media"/>
  </Connect>
</Response>`
  );
});

/* ----------------------- WEBSOCKET SERVER ----------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

/* ---- μ-law tone (optional hello beep) ---- */
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
function makeToneUlawBuffer({ durationMs = 300, freqHz = 440 }) {
  const sampleRate = 8000;
  const total = Math.floor(sampleRate * (durationMs / 1000));
  const bytes = Buffer.allocUnsafe(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    bytes[i] = linearToMuLaw(pcmSample(t, freqHz, 0.6));
  }
  return bytes; // raw μ-law bytes
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

/* ---- Deepgram raw WS (ASR) — one socket per call ---- */
function openDeepgramRaw({ onFinal, onOpen, onError, onClose }) {
  const params = new URLSearchParams({
    model: 'general',
    encoding: 'linear16',
    sample_rate: '8000',
    vad_events: 'true',
    interim_results: 'false',
    endpointing: '200',
  });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const headers = { Authorization: `Token ${DG_API_KEY}` };

  const dg = new WebSocket(url, { headers });
  dg.binaryType = 'arraybuffer';

  dg.on('open', () => onOpen?.());
  dg.on('error', (e) => onError?.(e));
  dg.on('close', (code, reason) => onClose?.(code, reason));

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
        if (transcript && isFinal) onFinal?.(transcript);
      }
    } catch { /* ignore non-JSON */ }
  });

  return dg;
}

/* ---- Keepalive marks to Twilio (optional but stabilizing) ---- */
function startKeepalive(twilioWs, streamSid) {
  let timer = null;
  const send = () => {
    if (!twilioWs || twilioWs.readyState !== 1 || !streamSid) return;
    twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'ka' } }));
  };
  return {
    start() { if (!timer) timer = setInterval(send, 2000); },
    stop()  { if (timer) clearInterval(timer); timer = null; }
  };
}

/* ---- LLM queue (no overlaps) ---- */
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

    if (!item.state) {
      console.warn('TTS skipped: no call state.');
    } else if (tts && short) {
      // STREAM TTS: send 160B μ-law frames every 20ms
      item.state.isSpeaking = true;

      let outCount = 0; // counter for debug visibility

      const speaker = await tts.startTTS(short, (frame) => {
        // IMPORTANT: include streamSid
        safeSendMedia(item.state.twilioWs, item.state.streamSid, frame);
        if (++outCount % 50 === 0) {
          log(item.state.callId, `🔊 sent ${outCount} TTS frames`);
        }
      });

      item.state.stopSpeaking = speaker.stop;

      speaker.on('done', () => {
        item.state.isSpeaking = false; // sockets stay open
        log(
          item.state.callId,
          `TTS finished. twilioOpen=${item.state.twilioWs?.readyState===1} dgOpen=${item.state.dgWs?.readyState===1}`
        );
      });
    }
  } catch (e) {
    console.error('LLM/TTS error:', e.message);
  } finally {
    llmBusy = false;
    if (llmQueue.length) processLlmQueue();
  }
}

function enqueueLlm(text, state) {
  llmQueue.push({ text, state });
  processLlmQueue();
}

/* ----------------------- WS session (one DG per call) ----------------------- */
wss.on('connection', (twilioWs) => {
  const callId = Math.random().toString(36).slice(2, 8);
  log(callId, '🔗 WS connected');

  // Per-call state
  const state = {
    callId,
    twilioWs,
    dgWs: null,
    streamSid: null,
    isSpeaking: false,
    stopSpeaking: null,
    keepalive: null,
  };

  let frames = 0;

  twilioWs.on('error', (err) => console.error(`[${callId}] ❌ WS error:`, err?.message || err));

  twilioWs.on('message', async (rawMsg) => {
    let json;
    try { json = JSON.parse(rawMsg.toString()); }
    catch { log(callId, 'Bad WS message (not JSON)'); return; }

    if (json.event === 'start') {
      const streamSid = json.start?.streamSid;
      state.streamSid = streamSid;
      log(callId, `▶️ stream started ${streamSid}`);

      // Open ONE Deepgram socket for the whole call
      state.dgWs = openDeepgramRaw({
        onOpen: () => log(callId, '🔗 Deepgram (raw) open'),
        onError: (e) => log(callId, `Deepgram (raw) error: ${e?.message || e}`),
        onClose: (code, reason) => log(callId, `🔌 Deepgram (raw) closed ${code || ''} ${reason || ''}`),
        onFinal: (finalText) => {
          log(callId, `📝 FINAL: ${finalText}`);
          enqueueLlm(finalText, state);
        }
      });

      // Start lightweight keepalive marks (helps some routes stay open)
      state.keepalive = startKeepalive(twilioWs, streamSid);
      state.keepalive.start();

      // ✅ Optional hello beep (frame-correct: 160B μ-law frames, 20ms cadence)
      const tone = makeToneUlawBuffer({ durationMs: 300, freqHz: 440 });
      for (let i = 0; i < tone.length; i += 160) {
        const end = Math.min(i + 160, tone.length);
        let frame = tone.subarray(i, end);
        if (frame.length < 160) {
          const pad = Buffer.alloc(160, 0xFF);
          frame.copy(pad, 0);
          frame = pad;
        }
        safeSendMedia(twilioWs, streamSid, frame);
        await new Promise((r) => setTimeout(r, 20));
      }
      safeSendMark(twilioWs, streamSid, 'hello_done');
      return;
    }

    if (json.event === 'media') {
      frames++;

      // Debug: prove we keep getting inbound audio from Twilio
      if (frames % 50 === 0) log(callId, `📥 inbound frames=${frames}`);

      // Forward caller audio to Deepgram
      if (state.dgWs && state.dgWs.readyState === 1 && json.media?.payload) {
        try {
          const mu = Buffer.from(json.media.payload, 'base64');  // 160B / 20ms
          const pcm16 = muLawBufferToPCM16Buffer(mu);            // 320B / 20ms
          if (LOG_RMS && frames % Math.max(1, RMS_INTERVAL) === 0) {
            const r = Math.round(rmsInt16LE(pcm16));
            log(callId, `🎧 received ${frames} frames | 🔊 RMS: ${r}`);
          }
          state.dgWs.send(pcm16);
        } catch (e) {
          log(callId, `Deepgram (raw) send error: ${e.message}`);
        }
      }
      return;
    }

    if (json.event === 'stop') {
      log(callId, `⏹️ stream stopped ${state.streamSid}`);
      cleanup(state);
      return;
    }
  });

  twilioWs.on('close', () => {
    log(callId, '🔌 WS closed');
    cleanup(state);
  });
});

/* ----------------------- Helpers ----------------------- */
function cleanup(state) {
  try { state.stopSpeaking?.(); } catch {}
  try { state.keepalive?.stop(); } catch {}
  try { if (state.dgWs && state.dgWs.readyState === 1) state.dgWs.close(1000); } catch {}
  state.dgWs = null;
}

function safeSendMedia(twilioWs, streamSid, mulaw160ByteFrame) {
  if (!twilioWs || twilioWs.readyState !== 1 || !streamSid) return;
  const payloadB64 = mulaw160ByteFrame.toString('base64');
  const msg = {
    event: 'media',
    streamSid: streamSid,
    media: { payload: payloadB64 }
  };
  twilioWs.send(JSON.stringify(msg));
  console.log(`[debug] sent 1 frame to Twilio (160 bytes) sid=${streamSid}`);
}

function safeSendMark(twilioWs, streamSid, name) {
  if (!twilioWs || twilioWs.readyState !== 1 || !streamSid) return;
  twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name } }));
}

function log(callId, line) { console.log(`[${callId}] ${line}`); }

/* ----------------------- START SERVER ----------------------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`HTTP/WS listening on :${PORT}`));
