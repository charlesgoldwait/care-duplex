// server.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');   // ✅ only declare once

const app = express();

// 1) Healthcheck
app.get('/', (_req, res) => res.send('OK'));

// 2) TwiML: tells Twilio to open a bidirectional media stream to our WS endpoint
app.post('/twiml', (_req, res) => {
  const twiml =
    `<Response>
       <Connect>
         <Stream url="wss://${process.env.PUBLIC_HOST}/media"/>
       </Connect>
     </Response>`;
  res.type('text/xml').send(twiml);
});

// HTTP server + WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws) => {
  console.log('🔗 WS connected');

  let streamSid = null;

  ws.on('message', (msg) => {
    const json = JSON.parse(msg.toString());

    if (json.event === 'start') {
      streamSid = json.start.streamSid;
      console.log('▶️ stream started', streamSid);
    }

    if (json.event === 'media') {
      // Caller audio arriving here
    }

    if (json.event === 'stop') {
      console.log('⏹️ stream stopped', streamSid);
    }
  });

  ws.on('close', () => console.log('🔌 WS closed'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`HTTP/WS listening on :${PORT}`));
