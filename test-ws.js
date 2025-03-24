// A simple WebSocket server test
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', function connection(ws) {
  console.log('Client connected');
  
  ws.on('message', function incoming(message) {
    console.log('received: %s', message);
    ws.send(JSON.stringify({ 
      type: 'message',
      content: 'Echo: ' + message
    }));
  });
  
  ws.send(JSON.stringify({ 
    type: 'status',
    status: 'connected'
  }));
});

console.log('WebSocket server running on ws://localhost:8080');
