// deepgram.js
const WebSocket = require('ws');

function openDeepgram({ apiKey, sampleRate = 8000, onFinal, onError, onOpen, onClose }) {
  const url = 'wss://api.deepgram.com/v1/listen';
  const headers = { Authorization: `Token ${apiKey}` };
  // Endpointing tighter -> faster finals
  const params = { model: 'general', encoding: 'linear16', sample_rate: sampleRate, vad_events: true, interim_results: false, endpointing: 200 };

  const ws = new WebSocket(url + '?' + new URLSearchParams(params), { headers });

  ws.on('open', () => onOpen?.());
  ws.on('error', (e) => onError?.(e));
  ws.on('close', (code, reason) => onClose?.(code, reason));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Deepgram sends channel.alternatives with is_final; adapt if your format differs
      const isFinal = msg?.is_final || msg?.channel?.alternatives?.[0]?.transcript && msg?.type === 'Results' && msg?.speech_final;
      const text = msg?.channel?.alternatives?.[0]?.transcript || msg?.transcript || '';
      if (isFinal && text) onFinal?.(text);
    } catch {}
  });

  return ws;
}

module.exports = { openDeepgram };
