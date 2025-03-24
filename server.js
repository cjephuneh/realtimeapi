const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const WebSocket = require('ws');
require('dotenv').config({ path: '.env.local' });

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = process.env.PORT || 3000;

// Log environment variables without exposing full keys
console.log('Environment check:');
console.log('- AZURE_OPENAI_ENDPOINT:', process.env.AZURE_OPENAI_ENDPOINT ? '✓' : '✗');
console.log('- AZURE_OPENAI_API_VERSION:', process.env.AZURE_OPENAI_API_VERSION ? '✓' : '✗');
console.log('- AZURE_OPENAI_DEPLOYMENT:', process.env.AZURE_OPENAI_DEPLOYMENT ? '✓' : '✗');
console.log('- AZURE_OPENAI_KEY:', process.env.AZURE_OPENAI_KEY ? '✓' : '✗');

// Azure OpenAI endpoint details
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
const azureApiKey = process.env.AZURE_OPENAI_KEY;

if (!azureEndpoint || !azureApiVersion || !azureDeployment || !azureApiKey) {
  console.error('Missing Azure OpenAI configuration');
  process.exit(1);
}

// Start the Next.js app
app.prepare().then(() => {
  console.log('Next.js app prepared');
  
  // Create HTTP server
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    
    // Special handling for WebSocket upgrade requests
    if (req.url.startsWith('/api/ws-proxy')) {
      console.log('Received request to WebSocket endpoint');
    }
    
    handle(req, res, parsedUrl);
  });

  // Create WebSocket server - SIMPLER CONFIGURATION
  const wss = new WebSocket.Server({ 
    server,
    path: '/api/ws-proxy'
  });
  
  // Handle WebSocket server errors
  wss.on('error', (error) => {
    console.error('WebSocket Server Error:', error.message);
  });
  
  console.log('WebSocket server created on path: /api/ws-proxy');
  
  wss.on('connection', (ws, req) => {
    console.log('Client connected to proxy');
    
    // Create WebSocket URL for Azure OpenAI
    const cleanEndpoint = azureEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const azureWsUrl = `wss://${cleanEndpoint}/openai/realtime?api-version=${azureApiVersion}&deployment=${azureDeployment}`;
    console.log(`Connecting to Azure OpenAI: ${azureWsUrl}`);
    
    // Connect to Azure OpenAI with proper headers
    const azureWs = new WebSocket(azureWsUrl, {
      headers: {
        'api-key': azureApiKey
      }
    });
    
    // Handle Azure WebSocket events
    azureWs.on('open', () => {
      console.log('Connected to Azure OpenAI');
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'status',
            status: 'connected'
          }));
          console.log('Sent connected status to client');
        } catch (error) {
          console.error('Error sending connected status:', error);
        }
      }
    });
    
    azureWs.on('message', (data) => {
      // Forward message from Azure to client
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data.toString());
        } catch (error) {
          console.error('Error forwarding message from Azure:', error);
        }
      }
    });
    
    azureWs.on('error', (error) => {
      console.error('Azure WebSocket error:', error.message);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Azure connection error: ' + error.message
          }));
        } catch (err) {
          console.error('Error sending error message to client:', err);
        }
      }
    });
    
    azureWs.on('close', (code, reason) => {
      console.log(`Azure connection closed: ${code} - ${reason}`);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'status',
            status: 'disconnected',
            code,
            reason: reason.toString()
          }));
          // Close client connection when Azure disconnects
          ws.close(code, reason.toString());
        } catch (error) {
          console.error('Error closing client connection:', error);
        }
      }
    });
    
    // Handle client WebSocket events
    ws.on('message', (data) => {
      // Forward message from client to Azure
      if (azureWs.readyState === WebSocket.OPEN) {
        try {
          azureWs.send(data.toString());
        } catch (error) {
          console.error('Error forwarding message to Azure:', error);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Failed to send message to Azure'
            }));
          }
        }
      } else {
        console.warn('Azure WebSocket not ready');
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Azure connection not ready'
          }));
        }
      }
    });
    
    ws.on('error', (error) => {
      console.error('Client WebSocket error:', error.message);
    });
    
    ws.on('close', (code, reason) => {
      console.log(`Client disconnected: ${code} - ${reason || 'No reason'}`);
      // Close Azure connection when client disconnects
      if (azureWs.readyState === WebSocket.OPEN) {
        azureWs.close(1000, 'Client disconnected');
      }
    });
  });

  // Start the server
  server.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`> Server ready on http://localhost:${PORT}`);
    console.log(`> WebSocket proxy available at ws://localhost:${PORT}/api/ws-proxy`);
  });
});
