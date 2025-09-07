// tts.js — Deepgram Speak (μ-law 8k) for Twilio
// Node 18+ (built-in fetch). Uses your existing DEEPGRAM_API_KEY.

function createTts({ dgApiKey, voice = "aura-asteria-en" } = {}) {
  if (!dgApiKey) throw new Error("Missing DEEPGRAM_API_KEY for TTS");

  // Fetch μ-law 8k audio for a short phrase
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

  return { synthToUlaw8k };
}

module.exports = { createTts };
