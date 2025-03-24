const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config({ path: '.env.local' });

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const PORT = process.env.PORT || 3000;

// Azure OpenAI endpoint details
const azureEndpoint = process.env.NEXT_PUBLIC_AZURE_OPENAI_ENDPOINT;
const azureApiVersion = process.env.NEXT_PUBLIC_AZURE_OPENAI_API_VERSION;
const azureDeployment = process.env.NEXT_PUBLIC_AZURE_OPENAI_DEPLOYMENT;
const azureApiKey = process.env.AZURE_OPENAI_API_KEY;

if (!azureEndpoint || !azureApiVersion || !azureDeployment || !azureApiKey) {
  console.error('Missing Azure OpenAI configuration');
  process.exit(1);
}

// Start the Next.js app
app.prepare().then(() => {
  // Create HTTP server
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // Create WebSocket server
  const wss = new WebSocket.Server({ server, path: '/api/ws-proxy' });
  
  // Track client connections
  const clients = new Map();

  wss.on('connection', (ws) => {
    const clientId = uuidv4();
    console.log(`Client connected: ${clientId}`);
    
    // Set up Azure OpenAI WebSocket connection
    const azureWsUrl = `${azureEndpoint}?api-version=${azureApiVersion}&deployment=${azureDeployment}`;
    console.log(`Connecting to Azure OpenAI: ${azureWsUrl}`);
    
    // Establish connection to Azure OpenAI
    const azureWs = new WebSocket(azureWsUrl);
    
    // Store connection pair
    clients.set(clientId, { clientWs: ws, azureWs });
    
    // Handle Azure WebSocket events
    azureWs.on('open', () => {
      console.log(`Azure connection opened for client ${clientId}`);
      
      // Send authentication message to Azure
      azureWs.send(JSON.stringify({
        type: "authentication",
        apiKey: azureApiKey
      }));
      
      // Notify client that connection is established
      ws.send(JSON.stringify({
        type: 'status',
        status: 'connected'
      }));
    });
    
    azureWs.on('message', (data) => {
      console.log(`Received message from Azure`);
      // Forward message from Azure to client
      ws.send(data.toString());
    });
    
    azureWs.on('error', (error) => {
      console.error(`Azure WebSocket error for client ${clientId}:`, error.message);
      // Notify client of error
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Azure connection error'
      }));
    });
    
    azureWs.on('close', (code, reason) => {
      console.log(`Azure connection closed for client ${clientId}: ${code} - ${reason}`);
      // Notify client
      ws.send(JSON.stringify({
        type: 'status',
        status: 'disconnected',
        code,
        reason
      }));
    });
    
    // Handle client WebSocket events
    ws.on('message', (data) => {
      // Forward client message to Azure
      if (azureWs.readyState === WebSocket.OPEN) {
        console.log(`Forwarding message to Azure`);
        azureWs.send(data.toString());
      } else {
        console.error(`Azure WebSocket not ready for client ${clientId}`);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Azure connection not ready'
        }));
      }
    });
    
    ws.on('close', () => {
      console.log(`Client disconnected: ${clientId}`);
      // Close Azure connection when client disconnects
      if (azureWs.readyState === WebSocket.OPEN) {
        azureWs.close();
      }
      clients.delete(clientId);
    });
  });

  // Start the server
  server.listen(PORT, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://localhost:${PORT}`);
  });
});
