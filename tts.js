{\rtf1\ansi\ansicpg1252\cocoartf2865
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww28600\viewh28540\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 // tts.js \'97 OpenAI TTS -> \uc0\u956 -law 8k frames for Twilio\
// Exports: ttsUlaw8kFrames(text) -> Promise<string[] of base64 frames>\
\
const fetch = require('node-fetch');\
\
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;\
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts'; // alt: 'tts-1'\
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';          // alloy, verse, echo, onyx, etc.\
\
const SAMPLE_RATE_OUT = 8000;  // \uc0\u956 -law 8k mono for Twilio\
const FRAME_MS = 20;           // 20ms => 160 samples/bytes per frame for ulaw\
\
// ---------- \uc0\u956 -law (G.711) ----------\
function linearToUlaw(sample) \{\
  // sample int16 [-32768, 32767]\
  const BIAS = 0x84; // 132\
  const CLIP = 32635;\
  let sign = (sample >> 8) & 0x80;\
  if (sample < 0) sample = -sample;\
  if (sample > CLIP) sample = CLIP;\
  sample = sample + BIAS;\
\
  let exponent = 7;\
  for (let expMask = 0x4000; ((sample & expMask) === 0) && exponent > 0; expMask >>= 1) \{\
    exponent--;\
  \}\
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;\
  let ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;\
  if (ulawByte === 0) ulawByte = 0x02; // avoid absolute zero\
  return ulawByte;\
\}\
\
// ---------- WAV parser (PCM16 or float32) ----------\
function parseWav(buffer) \{\
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);\
  const text = (o, n) => String.fromCharCode(...buffer.subarray(o, o + n));\
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');\
\
  let offset = 12;\
  let fmt = null;\
  let dataOffset = 0;\
  let dataSize = 0;\
\
  while (offset + 8 <= buffer.length) \{\
    const id = text(offset, 4);\
    const size = dv.getUint32(offset + 4, true);\
    const body = offset + 8;\
\
    if (id === 'fmt ') \{\
      const audioFormat   = dv.getUint16(body + 0,  true);\
      const numChannels   = dv.getUint16(body + 2,  true);\
      const sampleRate    = dv.getUint32(body + 4,  true);\
      const bitsPerSample = dv.getUint16(body + 14, true);\
      fmt = \{ audioFormat, numChannels, sampleRate, bitsPerSample \};\
    \} else if (id === 'data') \{\
      dataOffset = body;\
      dataSize = size;\
    \}\
\
    offset = body + size + (size & 1); // chunks are word-aligned\
  \}\
\
  if (!fmt || !dataOffset) throw new Error('Malformed WAV (missing fmt or data)');\
\
  let samples;\
  if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) \{\
    // PCM16\
    const frameCount = dataSize / (fmt.numChannels * 2);\
    const pcm = new Int16Array(frameCount * fmt.numChannels);\
    for (let i = 0; i < pcm.length; i++) \{\
      pcm[i] = dv.getInt16(dataOffset + i * 2, true);\
    \}\
    // mix to mono\
    const mono = new Float32Array(frameCount);\
    if (fmt.numChannels === 1) \{\
      for (let i = 0; i < frameCount; i++) mono[i] = pcm[i] / 32768;\
    \} else \{\
      for (let i = 0; i < frameCount; i++) \{\
        const L = pcm[i * fmt.numChannels] / 32768;\
        const R = pcm[i * fmt.numChannels + 1] / 32768;\
        mono[i] = (L + R) * 0.5;\
      \}\
    \}\
    samples = mono;\
  \} else if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) \{\
    // IEEE float32\
    const frameCount = dataSize / (fmt.numChannels * 4);\
    const fl = new Float32Array(frameCount * fmt.numChannels);\
    for (let i = 0; i < fl.length; i++) \{\
      fl[i] = dv.getFloat32(dataOffset + i * 4, true);\
    \}\
    const mono = new Float32Array(frameCount);\
    if (fmt.numChannels === 1) \{\
      mono.set(fl);\
    \} else \{\
      for (let i = 0; i < frameCount; i++) \{\
        const L = fl[i * fmt.numChannels];\
        const R = fl[i * fmt.numChannels + 1];\
        mono[i] = (L + R) * 0.5;\
      \}\
    \}\
    samples = mono;\
  \} else \{\
    throw new Error(`Unsupported WAV format: fmt=$\{fmt.audioFormat\}, bits=$\{fmt.bitsPerSample\}`);\
  \}\
\
  return \{ sampleRate: fmt.sampleRate, samples \};\
\}\
\
// ---------- simple linear resampler ----------\
function resampleFloat32(samples, fromRate, toRate) \{\
  if (fromRate === toRate) return samples;\
  const ratio = toRate / fromRate;\
  const outLen = Math.round(samples.length * ratio);\
  const out = new Float32Array(outLen);\
  for (let i = 0; i < outLen; i++) \{\
    const x = i / ratio;\
    const x0 = Math.floor(x);\
    const x1 = Math.min(x0 + 1, samples.length - 1);\
    const t = x - x0;\
    const s = samples[x0] * (1 - t) + samples[x1] * t;\
    // clamp to [-1,1] to avoid surprises\
    out[i] = Math.max(-1, Math.min(1, s));\
  \}\
  return out;\
\}\
\
// ---------- frames: 20ms @ 8k => 160 samples/bytes ----------\
function floatToUlawFrames(f32) \{\
  const samples = f32.length;\
  const frames = [];\
  const SAMPLES_PER_FRAME = Math.round(SAMPLE_RATE_OUT * FRAME_MS / 1000); // 160\
  const ulawBuf = Buffer.alloc(samples);\
\
  // float -> int16 -> \uc0\u956 -law\
  for (let i = 0; i < samples; i++) \{\
    let s = Math.max(-1, Math.min(1, f32[i]));\
    const i16 = Math.round(s * 32767);\
    ulawBuf[i] = linearToUlaw(i16);\
  \}\
\
  for (let i = 0; i < samples; i += SAMPLES_PER_FRAME) \{\
    const chunk = ulawBuf.subarray(i, i + SAMPLES_PER_FRAME);\
    if (chunk.length > 0) frames.push(chunk.toString('base64'));\
  \}\
  return frames;\
\}\
\
// ---------- OpenAI TTS -> WAV ----------\
async function openaiTtsWav(text) \{\
  const resp = await fetch('https://api.openai.com/v1/audio/speech', \{\
    method: 'POST',\
    headers: \{\
      'Authorization': `Bearer $\{OPENAI_API_KEY\}`,\
      'Content-Type': 'application/json'\
    \},\
    body: JSON.stringify(\{\
      model: OPENAI_TTS_MODEL,   // e.g., 'gpt-4o-mini-tts' or 'tts-1'\
      voice: OPENAI_TTS_VOICE,   // e.g., 'alloy'\
      input: text,\
      format: 'wav'              // we\'92ll parse & resample locally\
    \})\
  \});\
\
  if (!resp.ok) \{\
    const body = await resp.text();\
    throw new Error(`OpenAI TTS $\{resp.status\}: $\{body.slice(0, 300)\}`);\
  \}\
  const arr = await resp.arrayBuffer();\
  return Buffer.from(arr);\
\}\
\
// ---------- public API ----------\
async function ttsUlaw8kFrames(text) \{\
  try \{\
    if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');\
    const wav = await openaiTtsWav(text);\
    const \{ sampleRate, samples \} = parseWav(wav);\
    const resampled = resampleFloat32(samples, sampleRate, SAMPLE_RATE_OUT);\
    const frames = floatToUlawFrames(resampled);\
    return frames.length ? frames : silenceFrames(15); // ~300ms silence if empty\
  \} catch (e) \{\
    console.error('[tts] OpenAI TTS failed, using loud test tone:', e.message);\
    // Fallback: 2s loud 600Hz tone so you can clearly hear something\
    return toneFrames(2000, 600);\
  \}\
\}\
\
// ---------- fallback tone & helpers ----------\
function splitIntoFramesUlaw(baseUlawBuffer) \{\
  const BYTES_PER_FRAME = Math.round((SAMPLE_RATE_OUT * FRAME_MS) / 1000); // 160\
  const frames = [];\
  for (let i = 0; i < baseUlawBuffer.length; i += BYTES_PER_FRAME) \{\
    const chunk = baseUlawBuffer.subarray(i, i + BYTES_PER_FRAME);\
    if (chunk.length > 0) frames.push(chunk.toString('base64'));\
  \}\
  return frames;\
\}\
\
function toneFrames(durationMs = 2000, freq = 600) \{\
  const totalSamples = Math.round((SAMPLE_RATE_OUT * durationMs) / 1000);\
  const pcm = new Int16Array(totalSamples);\
\
  const amp = 0.75;      // loud\
  const fadeMs = 40;     // avoid clicks\
  const fadeSamples = Math.round(SAMPLE_RATE_OUT * fadeMs / 1000);\
\
  for (let n = 0; n < totalSamples; n++) \{\
    const t = n / SAMPLE_RATE_OUT;\
    let s = Math.sin(2 * Math.PI * freq * t) * amp;\
    if (n < fadeSamples) s *= (n / fadeSamples);\
    const fromEnd = totalSamples - 1 - n;\
    if (fromEnd < fadeSamples) s *= (fromEnd / fadeSamples);\
    pcm[n] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));\
  \}\
  const ulaw = Buffer.alloc(totalSamples);\
  for (let i = 0; i < totalSamples; i++) ulaw[i] = linearToUlaw(pcm[i]);\
  return splitIntoFramesUlaw(ulaw);\
\}\
\
function silenceFrames(n = 10) \{\
  return Array.from(\{ length: n \}, () => Buffer.alloc(160).toString('base64'));\
\}\
\
module.exports = \{ ttsUlaw8kFrames \};\
}