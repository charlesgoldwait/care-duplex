// server.js (Deepgram v3 robust handler - Phase 6)
// Minimal, surgical edits: proper DG v3 event usage, finish() on stop, clean logs.

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('@deepgram/sdk'); // v3

const app = express();

// Twilio may call /twiml with GET or POST; support both.
app.use(express.urlencoded({ extended: false }));

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

/* ---- Helpers to generate 8kHz μ-law audio (Twilio format) ---- */
function pcmSample(t, freq = 440, amp = 0.6) {
  const v = Math.sin(2 * Math.PI * freq * t) * amp;
  const clamped = Math.max(-1, Math.min(1, v));
  return Math.trunc(clamped * 32767); // 16-bit PCM
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

wss.on('connection', (ws) => {
  console.log('🔗 WS connected');

  let streamSid = null;
  let frames = 0;

  // Deepgram state
  let dgSocket = null;
  let dgReady = false;

  ws.on('message', async (msg) => {
    const json = JSON.parse(msg.toString());

    if (json.event === 'start') {
      streamSid = json.start.streamSid;
      console.log('▶️ stream started', streamSid);

      // ---- Open Deepgram live transcription (v3) ----
      try {
        dgSocket = deepgram.listen.live({
          model: 'nova-2-phonecall',
          encoding: 'mulaw',
          sample_rate: 8000,
          channels: 1,
          interim_results: true,
          smart_format: true,
          punctuate: true,
          language: 'en-US',
          vad_events: true, // useful later for barge-in
        });

        dgSocket.on('open', () => {
          dgReady = true;
          console.log('🔗 connected to Deepgram');
        });

        // ✅ Correct v3 event: already a parsed object (no JSON.parse needed)
        dgSocket.on('transcriptReceived', (data) => {
          try {
            if (data?.type !== 'Results') return;
            const alt = data.channel?.alternatives?.[0];
            const transcript = alt?.transcript || '';
            const isFinal = !!data?.is_final;
            if (!transcript) return;

            if (isFinal) {
              console.log(`📝 FINAL: ${transcript}`);
            } else {
              console.log(`✏️ partial: ${transcript}`);
            }
          } catch (e) {
            console.error('Deepgram transcript handling error:', e.message);
          }
        });

        dgSocket.on('error', (e) => console.error('Deepgram error:', e?.message || e));
        dgSocket.on('close', () => { dgReady = false; console.log('🔌 Deepgram closed'); });
      } catch (e) {
        console.error('Failed to open Deepgram live socket:', e.message);
      }

      // ---- Send a short tone back to the caller (prove outbound audio) ----
      const b64 = makeToneBase64({ durationMs: 800, freqHz: 440 });
      const BYTES_PER_20MS = 160;                               // 8kHz * 0.02s
      const CHUNK_B64_LEN = Math.ceil(BYTES_PER_20MS * 4 / 3);  // base64 expansion

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
      if (frames % 50 === 0) console.log(`🎧 received ${frames} audio frames`);

      // Forward caller μ-law audio to Deepgram once socket is open
      if (dgSocket && dgReady && json.media?.payload) {
        try {
          dgSocket.send(Buffer.from(json.media.payload, 'base64'));
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
        // ✅ Properly finish the DG stream (flush finals)
        if (dgSocket && typeof dgSocket.finish === 'function') {
          await dgSocket.finish();
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
