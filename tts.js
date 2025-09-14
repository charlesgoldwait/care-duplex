// tts.js — ElevenLabs TTS with Deepgram Speak fallback, outputs 8k μ-law frames for Twilio
// Requirements: npm i node-fetch
const fetch = require('node-fetch');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DG_VOICE = process.env.DG_VOICE || 'aura-asteria-en'; // any Deepgram Speak voice
const SAMPLE_RATE = 8000; // μ-law 8k required by Twilio
const FRAME_SIZE = 160;   // 20ms frames for Twilio Media Streams

function splitToFrames(ulawBuffer) {
  // Ensure 160-byte chunks; drop trailing partial frame if present
  const frames = [];
  for (let i = 0; i + FRAME_SIZE <= ulawBuffer.length; i += FRAME_SIZE) {
    frames.push(ulawBuffer.slice(i, i + FRAME_SIZE));
  }
  return frames;
}

async function elevenLabsTTS(text) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
  if (!ELEVENLABS_VOICE_ID) throw new Error('ELEVENLABS_VOICE_ID not set');

  // Request μ-law 8k audio. Many setups accept this via Accept header or output_format.
  // We try Accept first; if your account uses output_format, set ELEVENLABS_OUTPUT=ulaw_8000 and switch logic.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`;
  const body = { text, model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2' };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Accept': 'audio/ulaw;rate=8000',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs ${resp.status}: ${t}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return splitToFrames(buf);
}

async function deepgramSpeakTTS(text) {
  if (!DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY not set (for Deepgram fallback)');
  const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(DG_VOICE)}&encoding=mulaw&sample_rate=${SAMPLE_RATE}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Deepgram Speak ${resp.status}: ${t}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return splitToFrames(buf);
}

function createTts() {
  return async function tts(text) {
    // Prefer ElevenLabs if configured; else Deepgram
    if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
      try {
        return await elevenLabsTTS(text);
      } catch (e) {
        // fall back to Deepgram if ElevenLabs fails
        if (!DEEPGRAM_API_KEY) throw e;
        return await deepgramSpeakTTS(text);
      }
    }
    // Else require Deepgram
    return await deepgramSpeakTTS(text);
  };
}

module.exports = { createTts };
