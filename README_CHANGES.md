
# Care Duplex — Optimized Build (2025-09-14)

This build implements:
- **Barge‑in** (interrupt TTS when caller speaks) for natural turn‑taking.
- **Direct μ-law → Deepgram** (no PCM conversion) to cut bandwidth/CPU ~50%.
- **Keep‑alive** pings to Deepgram + Twilio marks to avoid idle timeouts.
- **Throttled logging** (no per‑frame spam), clear `[callId] 📝 / 💬 / 📤` lines.
- **Per‑call isolation** (no global LLM queue), ready for multi‑call scale.
- **ElevenLabs TTS** (preferred) with **Deepgram Speak** fallback, 8k μ‑law.

## Files changed
- `server.js` — barge‑in; mulaw pipeline; keepalive; throttled logs; no global queue.
- `tts.js` — ElevenLabs primary; Deepgram Speak fallback; outputs 160‑byte 20ms frames.

## Environment (.env)
```
PORT=10000
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

DEEPGRAM_API_KEY=dg_...

# ElevenLabs (primary TTS)
ELEVENLABS_API_KEY=eleven_...
ELEVENLABS_VOICE_ID=YOUR_VOICE_ID
# Optional:
# ELEVENLABS_MODEL=eleven_multilingual_v2
# DG_VOICE=aura-asteria-en
```

## Notes
- Ensure Twilio <Stream> connects to `wss://<your-host>/media` served by this app.
- Keep replies short for minimal latency; you can tune style via `systemPrompt()`.
- For global callers, deploy near Twilio/Deepgram regions to reduce RTT.
