// tts.js
// Returns an array of base64 μ-law 8kHz frames (~20ms each)
// Primary: ElevenLabs (ulaw_8000). Fallback: 1s 440 Hz tone (no API needed).

const fetch = require('node-fetch');

const ELEVEN_KEY   = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || ''; // e.g. "Rachel"
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2';
const FRAME_MS = 20;
const SAMPLE_RATE = 8000; // Twilio birectional streams expect ulaw 8k, mono

// ---- μ-law encoder (G.711) ----
function linearToUlaw(sample) {
  // sample is 16-bit PCM signed, range [-32768, 32767]
  const BIAS = 0x84; // 132
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; ((sample & expMask) === 0) && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  let mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;

  // CCITT recommendation: set zero to 0xFF
  if (ulawByte === 0) ulawByte = 0x02; // small tweak to avoid absolute zero
  return ulawByte;
}

function splitIntoFramesUlaw(baseUlawBuffer) {
  // 20ms @ 8kHz μ-law => 160 bytes per frame (1 byte per sample)
  const BYTES_PER_FRAME = Math.round((SAMPLE_RATE * FRAME_MS) / 1000); // 160
  const frames = [];
  for (let i = 0; i < baseUlawBuffer.length; i += BYTES_PER_FRAME) {
    const chunk = baseUlawBuffer.subarray(i, i + BYTES_PER_FRAME);
    if (chunk.length > 0) frames.push(chunk.toString('base64'));
  }
  return frames;
}

// ---- Fallback: 1s 440 Hz tone (to verify audio path) ----
function toneFrames(durationMs = 1000, freq = 440) {
  const totalSamples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const pcm = new Int16Array(totalSamples);
  for (let n = 0; n < totalSamples; n++) {
    const t = n / SAMPLE_RATE;
    const amp = 0.3; // 30% to avoid clipping
    const val = Math.max(-1, Math.min(1, amp * Math.sin(2 * Math.PI * freq * t)));
    pcm[n] = Math.round(val * 32767);
  }
  // Convert to μ-law
  const ulaw = Buffer.alloc(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    ulaw[i] = linearToUlaw(pcm[i]);
  }
  return splitIntoFramesUlaw(ulaw);
}

// ---- ElevenLabs helper (ulaw_8000) ----
async function elevenLabsUlawFrames(text) {
  if (!ELEVEN_KEY || !ELEVEN_VOICE) {
    // No config => fallback tone so you can hear *something*
    return toneFrames(1000, 440);
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: ELEVEN_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.7 },
      // This is the key bit: telephony-ready μ-law at 8kHz
      output_format: 'ulaw_8000'
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ElevenLabs ${resp.status}: ${body.slice(0, 200)}`);
  }

  // ElevenLabs returns raw audio bytes; for ulaw_8000 it's 8k μ-law mono
  const audioBuf = Buffer.from(await resp.arrayBuffer());
  // Chunk into 20ms frames (160 bytes) and base64 encode
  return splitIntoFramesUlaw(audioBuf);
}

// ---- Public API ----
async function ttsUlaw8kFrames(text) {
  // Try ElevenLabs; if anything fails, use tone fallback so the call never goes silent
  try {
    return await elevenLabsUlawFrames(text);
  } catch (e) {
    console.error('[tts] ElevenLabs failed, using test tone:', e.message);
    // Short “beep” + small silence tail so it feels natural
    const beep = toneFrames(500, 880);
    const silence = new Array(6).fill(Buffer.alloc(160).toString('base64')); // ~120ms silence
    return [...beep, ...silence];
  }
}

module.exports = { ttsUlaw8kFrames };
