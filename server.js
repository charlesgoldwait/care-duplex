// server.js — continuous convo, barge‑in, clear logging, ElevenLabs TTS (fallback to Deepgram)
// Dependencies: npm i express ws node-fetch dotenv

require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fetch = require('node-fetch');
const { createTts } = require('./tts');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DG_SAMPLE_RATE = 8000;              // Twilio Media Streams = 8kHz μ-law
const DG_KEEPALIVE_MS = 5000;             // Keep Deepgram alive between turns
const FRAME_BYTES = 160;                  // 20ms @ 8kHz μ-law

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Health
app.get('/', (_, res) => res.send('OK'));

// Utils
const shortId = () => Math.random().toString(36).slice(2, 8);
const log = (id, msg) => console.log(`[${id}] ${msg}`);
const nowIso = () => new Date().toISOString();

// Send a single frame to Twilio
function sendFrameToTwilio(ws, streamSid, frameBuf) {
  if (!frameBuf || frameBuf.length !== FRAME_BYTES) return;
  const payload = frameBuf.toString('base64');
  ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
}

// Stream frames at ~20ms cadence with abort + throttled logs
async function streamAudioFrames(ws, streamSid, frames, callId, ctrl) {
  let i = 0;
  for (const frame of frames) {
    if (ctrl?.aborted) {
      log(callId, '🛑 TTS stream aborted');
      break;
    }
    sendFrameToTwilio(ws, streamSid, frame);
    if (i % 50 === 0) log(callId, `📤 sent frames=${i}`);
    i++;
    await new Promise(r => setTimeout(r, 20));
  }
  log(callId, `📤 sent frames total=${i}`);
}

// Persona
function systemPrompt() {
  return 'You are a kind, patient phone companion. Keep replies short (1–2 sentences), friendly, and spoken-language natural. Prefer reflective listening and gentle encouragement.';
}

// LLM call
async function llmReply(userText, callId) {
  if (!OPENAI_API_KEY) {
    log(callId, '⚠️ No OPENAI_API_KEY set — using fallback reply.');
    return 'I hear you. How can I help?';
  }
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userText || '' },
    ],
    temperature: 0.6,
    max_tokens: 120,
  };
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || 'Okay.').trim();
}

// Open Deepgram in raw μ-law mode
function openDeepgram(callId) {
  if (!DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY required');
  const url = `wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=${DG_SAMPLE_RATE}&channels=1&punctuate=true&smart_format=true`;
  const headers = { Authorization: `Token ${DEEPGRAM_API_KEY}` };
  const dg = new (require('ws'))(url, { headers });
  return dg;
}

wss.on('connection', (ws) => {
  const callId = shortId();
  log(callId, '🔗 WS connected');

  let streamSid = null;
  let dg = null;
  let dgOpen = false;
  let keepaliveTimer = null;

  // TTS state for barge-in
  let speaking = { aborted: false };
  let isSpeaking = false;

  const tts = createTts();

  function sendMark(name) {
    if (!streamSid) return;
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: name || `m-${Date.now()}` } }));
  }

  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      try {
        if (dg && dgOpen) dg.send(JSON.stringify({ type: 'KeepAlive', timestamp: nowIso() }));
      } catch {}
      sendMark('ka');
    }, DG_KEEPALIVE_MS);
  }
  function stopKeepalive() {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  function stopSpeaking() {
    if (isSpeaking) {
      speaking.aborted = true;
      isSpeaking = false;
    }
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case 'start': {
        streamSid = msg.start?.streamSid;
        log(callId, `▶️ stream started ${streamSid}`);

        // open Deepgram
        dg = openDeepgram(callId);
        dg.on('open', () => {
          dgOpen = true;
          log(callId, '🔗 Deepgram (raw) open');
          startKeepalive();
        });
        dg.on('close', (code, reason) => {
          dgOpen = false;
          stopKeepalive();
          log(callId, `🔌 Deepgram (raw) closed ${code} ${reason || ''}`);
        });
        dg.on('error', (err) => log(callId, `❌ Deepgram error: ${err.message}`));

        dg.on('message', async (data) => {
          let j;
          try { j = JSON.parse(data.toString()); } catch { return; }
          const alt = j.channel?.alternatives?.[0];
          const transcript = alt?.transcript || '';
          if (j.is_final && transcript) {
            log(callId, `📝 FINAL: ${transcript}`);

            // Get LLM reply
            let reply = 'Okay.';
            try {
              reply = await llmReply(transcript, callId);
            } catch (e) {
              log(callId, `❌ LLM error: ${e.message}`);
              reply = "Sorry—I'm having trouble thinking right now.";
            }
            log(callId, `💬 LLM: ${reply}`);

            // Synthesize & stream
            try {
              speaking = { aborted: false };
              isSpeaking = true;
              const frames = await tts(reply);
              log(callId, `🔊 prepared ${frames.length} frames`);
              await streamAudioFrames(ws, streamSid, frames, callId, speaking);
            } catch (e) {
              log(callId, `❌ TTS error: ${e.message}`);
            } finally {
              isSpeaking = false;
            }
          }
        });
        break;
      }

      case 'media': {
        // If user speaks while TTS playing -> barge-in
        if (isSpeaking) {
          log(callId, '🛎️ media during TTS — barge-in');
          stopSpeaking();
        }
        const payload = msg.media?.payload;
        if (dg && dgOpen && payload) {
          try {
            const audio = Buffer.from(payload, 'base64'); // μ-law bytes
            dg.send(audio);
          } catch (e) {
            log(callId, `❌ send to DG failed: ${e.message}`);
          }
        }
        break;
      }

      case 'stop': {
        log(callId, `⏹️ stream stopped ${streamSid}`);
        stopSpeaking();
        stopKeepalive();
        try { if (dg) dg.close(1000); } catch {}
        break;
      }
    }
  });

  ws.on('close', () => {
    log(callId, '🔌 WS closed');
    stopSpeaking();
    stopKeepalive();
    try { if (dg) dg.close(1000); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`HTTP/WS listening on :${PORT}`);
});
