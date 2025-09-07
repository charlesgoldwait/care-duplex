// server.js
require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();

/* ----------------------- HTTP ROUTES ----------------------- */

// Healthcheck
app.get('/', (_req, res) => res.send('OK'));

// TwiML: instruct Twilio to open a bidirectional media stream to our WS endpoint
app.post('/twiml', (_req, res) => {
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

// --- Helpers to generate 8kHz μ-law audio frames (Twilio requires this) ---
function pcmSample(t, freq = 440, amp = 0.6) {
  // t in seconds -> 16-bit PCM sample
  const v = Math.sin(2 * Math.PI * freq * t) * amp;
  const clamped = Math.max(-1, Math.min(1, v));
  return Math.trunc(clamped * 32767);
}

function linearToMuLaw(sample) {
  // Convert 16-bit PCM (-32768..32767) to 8-bit G.711 μ-law
  const BIAS = 0x84; // 132
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample = sample + BIAS;

  // Find exponent
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  // Mantissa depends on exponent
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;

  // Pack sign, exponent, mantissa, then invert
  const mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mu;
}

function makeToneBase64({ durationMs = 800, freqHz = 440 }) {
  const sampleRate = 8000; // Twilio WS uses 8kHz μ-law
  const totalSamples = Math.floor(sampleRate * (durationMs / 1000));
  const bytes = new Uint8Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const pcm = pcmSample(t, freqHz, 0.6);
    bytes[i] = linearToMuLaw(pcm);
  }
  // Convert raw μ-law bytes to base64
  return Buffer.from(bytes).toString('base64');
}

wss.on('connection', (ws) => {
  console.log('🔗 WS connected');
  let streamSid = null;
  let frames = 0; // count inbound audio frames

  ws.on('message', (msg) => {
    const json = JSON.parse(msg.toString());

    // Twilio events: start, media, mark, stop
    if (json.event === 'start') {
      streamSid = json.start.streamSid;
      console.log('▶️ stream started', streamSid);

      // --- Send an 800ms tone back to the caller to prove outbound audio ---
      const b64 = makeToneBase64({ durationMs: 800, freqHz: 440 });
      const BYTES_PER_20MS = 160;                              // 8kHz * 0.02s = 160 samples/bytes (μ-law)
      const CHUNK_B64_LEN = Math.ceil(BYTES_PER_20MS * 4 / 3); // base64 expansion ≈ 4/3

      let offset = 0;
      const sendFrame = () => {
        if (offset >= b64.length) {
          // Tell Twilio we’re done with this clip
          ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'hello_done' } }));
          return;
        }
        const payload = b64.slice(offset, offset + CHUNK_B64_LEN);
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
        offset += CHUNK_B64_LEN;
        setTimeout(sendFrame, 20); // pace ~real-time
      };
      sendFrame();
    }

    if (json.event === 'media') {
      frames++;
      if (frames % 50 === 0) console.log(`🎧 received ${frames} audio frames`);
      // json.media.payload is base64 μ-law from the caller (20ms frames)
      // We'll forward this to STT (Deepgram) in the next phase.
    }

    if (json.event === 'mark') {
      console.log('✅ mark acknowledged by Twilio:', json.mark?.name);
    }

    if (json.event === 'stop') {
      console.log('⏹️ stream stopped', streamSid);
    }
  });

  ws.on('close', () => console.log('🔌 WS closed'));
});

/* ----------------------- START SERVER ----------------------- */

const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 so it works on Render
server.listen(PORT, '0.0.0.0', () => console.log(`HTTP/WS listening on :${PORT}`));
