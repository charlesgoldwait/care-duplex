// tts.js — Deepgram Speak (μ-law 8k) for Twilio, with frame streamer
// Node 18+ (built-in fetch)

const { EventEmitter } = require('events');

const BYTES_PER_FRAME = 160;   // 20 ms * 8000 samples/sec * 1 byte/sample
const MS_PER_FRAME = 20;
const ULawSilence = 0xFF;      // μ-law silence byte for padding, if needed

function createTts({ dgApiKey, voice = "aura-asteria-en" } = {}) {
  if (!dgApiKey) throw new Error("Missing DEEPGRAM_API_KEY for TTS");

  // Fetch μ-law 8k audio for the given text
  async function synthToUlaw8k(text) {
    const url = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(
      voice
    )}&encoding=mulaw&sample_rate=8000`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${dgApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: String(text || "") }),
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      throw new Error(`Deepgram Speak ${res.status}: ${errTxt}`);
    }

    const ab = await res.arrayBuffer();
    return Buffer.from(ab); // μ-law 8k bytes
  }

  /**
   * Stream TTS frames to the caller.
   * @param {string} text - what to speak
   * @param {(frame: Buffer) => void} onFrame - called every 20ms with a 160-byte μ-law frame
   * @returns {{ stop: () => void, on: (evt: 'done', cb: () => void) => void }}
   */
  async function startTTS(text, onFrame) {
    // 1) Synthesize full clip
    const ulaw = await synthToUlaw8k(text);

    // 2) Pre-slice into 160B frames (pad last one to full frame length)
    const frames = [];
    for (let i = 0; i < ulaw.length; i += BYTES_PER_FRAME) {
      const end = Math.min(i + BYTES_PER_FRAME, ulaw.length);
      if (end - i === BYTES_PER_FRAME) {
        frames.push(ulaw.subarray(i, end));
      } else {
        // pad with μ-law silence to exactly 160 bytes
        const chunk = Buffer.alloc(BYTES_PER_FRAME, ULawSilence);
        ulaw.copy(chunk, 0, i, end);
        frames.push(chunk);
      }
    }

    // 3) Create a simple speaker controller
    const emitter = new EventEmitter();
    let idx = 0;
    let timer = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      if (idx >= frames.length) {
        clearInterval(timer);
        timer = null;
        emitter.emit('done');
        return;
      }
      try {
        onFrame(frames[idx++]); // your server sends this to Twilio as base64 payload
      } catch (e) {
        // If sending fails, stop gracefully so sockets aren't affected
        clearInterval(timer);
        timer = null;
        emitter.emit('done');
      }
    };

    // Start sending at 20ms cadence
    timer = setInterval(tick, MS_PER_FRAME);

    // Controller API expected by your server.js
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
        emitter.emit('done'); // signal completion to server; DO NOT close sockets here
      },
      on: (evt, cb) => {
        if (evt === 'done') emitter.on('done', cb);
      }
    };
  }

  return { synthToUlaw8k, startTTS };
}

module.exports = { createTts };
