// server.js — natural duplex conversation with barge‑in grace period
// Run: node server.js  (expects PORT, OPENAI_API_KEY, DEEPGRAM_API_KEY; optional ELEVENLABS_* via tts.js)

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');

// TTS factory (returns async function(text)->frames[])
const { createTts } = require('./tts');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const DG_SAMPLE_RATE = 8000;               // Twilio Media Streams are 8kHz µ-law
const DG_KEEPALIVE_MS = 5000;              // ping Deepgram so it doesn't time out
const FRAME_MS = 20;                        // 20ms per audio frame
const CALL_LOG_PREFIX = () => new Date().toISOString().slice(11, 19);

// ---------- small utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rid = () => Math.random().toString(36).slice(2, 8);
const log = (id, msg) => console.log(`${CALL_LOG_PREFIX()}  ${id}  ${msg}`);

// ---------- HTTP (health) ----------
const app = express();
app.get('/', (_req, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------- WS server for Twilio Media Streams ----------
const wss = new WebSocketServer({ server, path: '/media' });

// -- Deepgram raw WS helper
const openDeepgram = (callId, onTranscript) => {
  const url = `wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=${DG_SAMPLE_RATE}&channels=1&punctuate=true&vad_events=true`;
  const ws = new (require('ws'))(url, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });

  let open = false;
  ws.on('open', () => { open = true; });
  ws.on('error', (e) => log(callId, `❌ Deepgram error: ${e.message}`));
  ws.on('close', () => { open = false; });

  // Receive transcripts
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const ch = data.channel || data;
      const alt = ch.alternatives?.[0];
      const text = alt?.transcript || '';
      const isFinal = !!alt?.transcript && (data.is_final || alt?.confidence !== undefined && data.type !== 'UtteranceEnd');
      // Deepgram "is_final" for interim/final varies by stream type; we guard by non-empty transcript
      if (text && (data.type === 'Results' || data.type === 'result' || data.is_final || isFinal)) {
        onTranscript(text, !!data.is_final || !!data.speech_final || !!data.utterance_end || !!alt?.words || true);
      }
    } catch { /* ignore parse noise */ }
  });

  return { ws, send: (buf) => open && ws.readyState === ws.OPEN && ws.send(buf), close: () => { try { ws.close(1000); } catch {} }, isOpen: () => open };
};

// -- OpenAI chat helper (text-only)
async function llmReply(text, callId) {
  const prompt = [
    { role: 'system', content: "You are a kind, patient phone companion. Keep replies short (1–2 sentences), friendly, and spoken-language natural. Prefer reflective listening and gentle encouragement Use simple language." },
    { role: 'user', content: text }
  ];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: prompt,
      temperature: 0.6,
      max_tokens: 120
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() || "I'm here.";
  return reply;
}

// -- Twilio outbound audio: send one frame
function sendFrameToTwilio(ws, streamSid, payloadB64) {
  ws.send(JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: payloadB64 }
  }));
}

// -- Stream frames to Twilio with optional abort flag
async function streamAudioFrames(ws, streamSid, framesB64, callId, speakingRef) {
  for (const b64 of framesB64) {
    if (speakingRef.aborted) {
      log(callId, '🛑 TTS stream aborted');
      return;
    }
    sendFrameToTwilio(ws, streamSid, b64);
    await sleep(FRAME_MS);
  }
  // mark end (harmless if ignored)
  ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'tts_end' } }));
}

wss.on('connection', (ws) => {
  const callId = `[${rid()}]`;
  log(callId, '🔗 WS connected');

  // Per-call state
  let streamSid = null;
  let speaking = { aborted: false, ttsStartedAt: 0 };
  let isSpeaking = false;

  let dg = null;
  let dgOpen = false;
  let kaTimer = null;

  const startKeepalive = () => {
    clearInterval(kaTimer);
    kaTimer = setInterval(() => {
      try {
        if (dg && dgOpen) dg.ws.ping?.();
      } catch {}
    }, DG_KEEPALIVE_MS);
  };
  const stopKeepalive = () => { clearInterval(kaTimer); kaTimer = null; };

  const stopSpeaking = () => { speaking.aborted = true; };

  // Deepgram transcript handler -> LLM -> TTS -> stream
  const onTranscript = async (text, isFinal) => {
    // We only react on finalish chunks to avoid chattiness
    if (!isFinal) return;

    log(callId, `📝 FINAL: ${text}`);

    // Get reply
    let reply = "Okay.";
    try {
      reply = await llmReply(text, callId);
    } catch (e) {
      log(callId, `❌ LLM error: ${e.message}`);
      reply = "I'm here and listening.";
    }
    log(callId, `💬 LLM: ${reply}`);

    // Synthesize + play
    try {
      speaking = { aborted: false, ttsStartedAt: Date.now() };
      isSpeaking = true;
      const tts = createTts();                   // factory returns function(text)->frames array(Base64)
      const frames = await tts(reply);
      log(callId, `🔊 prepared ${frames.length} frames`);
      await streamAudioFrames(ws, streamSid, frames, callId, speaking);
      log(callId, `📤 sent frames total=${speaking.aborted ? 0 : frames.length}`);
    } catch (e) {
      log(callId, `❌ TTS error: ${e.message}`);
    } finally {
      isSpeaking = false;
    }
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case 'start': {
        streamSid = msg.start?.streamSid || streamSid;
        log(callId, `▶️ stream started ${streamSid}`);

        if (!DEEPGRAM_API_KEY) {
          log(callId, '❌ DEEPGRAM_API_KEY required');
          return;
        }
        const dgConn = openDeepgram(callId, onTranscript);
        dg = dgConn;
        dgOpen = true;
        log(callId, '🔗 Deepgram (raw) open');
        startKeepalive();
        break;
      }

      case 'media': {
        // Potential barge‑in: ignore early noise for first 600ms of a reply
        if (isSpeaking) {
          const graceMs = 600;
          if (Date.now() - (speaking.ttsStartedAt || 0) >= graceMs) {
            log(callId, '🛎️ media during TTS — barge-in');
            stopSpeaking();
          }
          // else: within grace period; do nothing so user hears first syllable
        }

        const payload = msg.media?.payload;
        if (payload && dg && dgOpen) {
          try {
            const audio = Buffer.from(payload, 'base64'); // µ-law
            dg.send(audio);
          } catch (e) {
            log(callId, `❌ send to DG failed: ${e.message}`);
          }
        }
        break;
      }

      case 'mark': {
        // Twilio playback marker (optional)
        // log(callId, `📍 mark ${msg.mark?.name || ''}`);
        break;
      }

      case 'stop': {
        log(callId, `⏹️ stream stopped ${streamSid}`);
        stopSpeaking();
        stopKeepalive();
        try { dg?.close(); } catch {}
        dgOpen = false;
        break;
      }

      default: {
        // ignore unknown events
        break;
      }
    }
  });

  ws.on('close', () => {
    log(callId, '🔌 WS closed');
    stopSpeaking();
    stopKeepalive();
    try { dg?.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`HTTP/WS listening on :${PORT}`);
});
