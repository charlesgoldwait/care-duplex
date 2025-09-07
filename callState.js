// callState.js
const calls = new Map(); // callSid -> state

function initCall(callSid) {
  const state = {
    callSid,
    twilioWs: null,     // WebSocket from Twilio <Stream>
    dgWs: null,         // WebSocket to Deepgram listen
    isSpeaking: false,  // TTS currently streaming?
    stopSpeaking: null, // function to interrupt TTS (barge-in ready)
    createdAt: Date.now(),
  };
  calls.set(callSid, state);
  return state;
}

function getCall(callSid) { return calls.get(callSid); }

function endCall(callSid) {
  const s = calls.get(callSid);
  if (!s) return;
  try { if (s.dgWs && s.dgWs.readyState === 1) s.dgWs.close(1000); } catch {}
  try { if (s.twilioWs && s.twilioWs.readyState === 1) s.twilioWs.close(1000); } catch {}
  calls.delete(callSid);
}

module.exports = { initCall, getCall, endCall };
