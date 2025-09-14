# from your project root (same folder as server.js)
mv tts.js tts.js.bak 2>/dev/null || true

cat > tts.js <<'EOF'
// tts.js — OpenAI TTS -> μ-law 8k frames for Twilio (CommonJS)
// Exports: ttsUlaw8kFrames(text) -> Promise<string[] of base64 frames>
// Uses global fetch (Node 18+). No external deps.

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'; // or 'tts-1'
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';

const SAMPLE_RATE_OUT = 8000;  // μ-law 8k mono for Twilio
const FRAME_MS = 20;           // 20ms => 160 samples/bytes per frame (μ-law)

// ---------- μ-law (G.711) ----------
function linearToUlaw(sample) {
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
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  if (ulawByte === 0) ulawByte = 0x02; // avoid absolute zero
  return ulawByte;
}

// ---------- WAV parser (PCM16 or float32) ----------
function parseWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const text = (o, n) => String.fromCharCode(...buf.subarray(o, o + n));
  if (text(0,4) !== 'RIFF' || text(8,4) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');

  let o = 12, fmt = null, dataOffset = 0, dataSize = 0;
  while (o + 8 <= buf.length) {
    const id = text(o,4);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;

    if (id === 'fmt ') {
      const audioFormat   = dv.getUint16(body + 0,  true);
      const numChannels   = dv.getUint16(body + 2,  true);
      const sampleRate    = dv.getUint32(body + 4,  true);
      const bitsPerSample = dv.getUint16(body + 14, true);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !dataOffset) throw new Error('Malformed WAV');

  let samples;
  if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
    // PCM16
    const frames = dataSize / (fmt.numChannels * 2);
    const mono = new Float32Array(frames);
    if (fmt.numChannels === 1) {
      for (let i = 0; i < frames; i++) {
        mono[i] = dv.getInt16(dataOffset + i*2, true) / 32768;
      }
    } else {
      for (let i = 0; i < frames; i++) {
        const L = dv.getInt16(dataOffset + (i*fmt.numChannels    )*2, true) / 32768;
        const R = dv.getInt16(dataOffset + (i*fmt.numChannels + 1)*2, true) / 32768;
        mono[i] = (L + R) * 0.5;
      }
    }
    samples = mono;
  } else if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
    // float32
    const frames = dataSize / (fmt.numChannels * 4);
    const mono = new Float32Array(frames);
    if (fmt.numChannels === 1) {
      for (let i = 0; i < frames; i++) mono[i] = dv.getFloat32(dataOffset + i*4, true);
    } else {
      for (let i = 0; i < frames; i++) {
        const L = dv.getFloat32(dataOffset + (i*fmt.numChannels    )*4, true);
        const R = dv.getFloat32(dataOffset + (i*fmt.numChannels + 1)*4, true);
        mono[i] = (L + R) * 0.5;
      }
    }
    samples = mono;
  } else {
    throw new Error(`Unsupported WAV: fmt=${fmt.audioFormat} bits=${fmt.bitsPerSample}`);
  }

  return { sampleRate: fmt.sampleRate, samples };
}

// ---------- linear resampler ----------
function resampleFloat32(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLen = Math.round(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i / ratio;
    const x0 = Math.floor(x);
    const x1 = Math.min(x0 + 1, samples.length - 1);
    const t = x - x0;
    const s = samples[x0] * (1 - t) + samples[x1] * t;
    out[i] = Math.max(-1, Math.min(1, s));
  }
  return out;
}

// ---------- float -> μ-law frames (20ms @ 8k => 160 bytes) ----------
function floatToUlawFrames(f32) {
  const SAMPLES_PER_FRAME = Math.round(SAMPLE_RATE_OUT * FRAME_MS / 1000); // 160
  const ulaw = Buffer.alloc(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const i16 = Math.max(-32768, Math.min(32767, Math.round((f32[i]) * 32767)));
    ulaw[i] = linearToUlaw(i16);
  }
  const frames = [];
  for (let i = 0; i < ulaw.length; i += SAMPLES_PER_FRAME) {
    const chunk = ulaw.subarray(i, i + SAMPLES_PER_FRAME);
    if (chunk.length) frames.push(chunk.toString('base64'));
  }
  return frames;
}

// ---------- OpenAI TTS -> WAV ----------
async function openaiTtsWav(text) {
  if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: OPENAI_TTS_VOICE,
      input: text,
      format: 'wav'
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${body.slice(0,300)}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// ---------- public API ----------
async function ttsUlaw8kFrames(text) {
  try {
    const wav = await openaiTtsWav(text);
    const { sampleRate, samples } = parseWav(wav);
    const resampled = resampleFloat32(samples, sampleRate, SAMPLE_RATE_OUT);
    const frames = floatToUlawFrames(resampled);
    return frames.length ? frames : silenceFrames(15);
  } catch (e) {
    console.error('[tts] OpenAI TTS failed, using loud test tone:', e.message);
    return toneFrames(2000, 600); // audible fallback
  }
}

// ---------- fallback tone & helpers ----------
function splitIntoFramesUlaw(buf) {
  const BYTES_PER_FRAME = Math.round((SAMPLE_RATE_OUT * FRAME_MS) / 1000); // 160
  const frames = [];
  for (let i = 0; i < buf.length; i += BYTES_PER_FRAME) {
    const chunk = buf.subarray(i, i + BYTES_PER_FRAME);
    if (chunk.length) frames.push(chunk.toString('base64'));
  }
  return frames;
}

function toneFrames(durationMs = 2000, freq = 600) {
  const total = Math.round((SAMPLE_RATE_OUT * durationMs) / 1000);
  const pcm = new Int16Array(total);
  const amp = 0.75, fadeMs = 40, fade = Math.round(SAMPLE_RATE_OUT*fadeMs/1000);
  for (let n = 0; n < total; n++) {
    const t = n / SAMPLE_RATE_OUT;
    let s = Math.sin(2*Math.PI*freq*t) * amp;
    if (n < fade) s *= n / fade;
    const fromEnd = total - 1 - n;
    if (fromEnd < fade) s *= fromEnd / fade;
    pcm[n] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  const ulaw = Buffer.alloc(total);
  for (let i = 0; i < total; i++) ulaw[i] = linearToUlaw(pcm[i]);
  return splitIntoFramesUlaw(ulaw);
}

function silenceFrames(n = 10) {
  return Array.from({ length: n }, () => Buffer.alloc(160).toString('base64'));
}

module.exports = { ttsUlaw8kFrames };
EOF
