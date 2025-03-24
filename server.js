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
    // Forward regular HTTP requests to Next.js
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // Create WebSocket server with noServer mode
  const wss = new WebSocket.Server({ noServer: true });
  
  // Handle upgrade requests
  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = parse(req.url, true);
    const { pathname } = parsedUrl;
    
    // Only handle our specific WebSocket endpoint
    if (pathname === '/api/ws-proxy') {
      wss.handleUpgrade(req, socket, head, ws => {
        console.log('WebSocket connection upgraded for /api/ws-proxy');
        wss.emit('connection', ws, req);
      });
    } else {
      // Let Next.js handle other WebSocket connections (like HMR)
      console.log(`Not handling upgrade for: ${pathname}`);
      socket.destroy();
    }
  });
  
  console.log('WebSocket server created with upgrade handler for /api/ws-proxy');
  
  wss.on('connection', (ws, req) => {
    console.log('Client connected to proxy');
    
    // Connection state tracking
    let azureWs = null;
    let azureIsReady = false; // Track if Azure is fully ready for messages
    let connectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 15; // Increased for more persistence
    let clientClosed = false;
    let messageQueue = []; // Queue for messages when Azure isn't ready
    let keepAliveInterval;
    let reconnectTimeout;
    let lastMessageTime = Date.now();
    let connectionInitTime = 0;
    
    // Safe way to send messages to the client
    const sendToClient = (message) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const messageString = typeof message === 'string' 
            ? message 
            : JSON.stringify(message);
          ws.send(messageString);
          return true;
        } catch (error) {
          console.error('Error sending message to client:', error);
          return false;
        }
      }
      return false;
    };
    
    // Safe way to send messages to Azure
    const sendToAzure = (message) => {
      lastMessageTime = Date.now();
      
      // Check if Azure is truly ready
      if (!azureWs || azureWs.readyState !== WebSocket.OPEN || !azureIsReady) {
        console.log('Azure not ready for sending, queueing message');
        if (typeof message === 'string') {
          try {
            messageQueue.push(JSON.parse(message));
          } catch (e) {
            messageQueue.push(message);
          }
        } else {
          messageQueue.push(message);
        }
        
        // Try reconnecting if needed
        if (!azureWs || azureWs.readyState === WebSocket.CLOSED) {
          console.log('Azure connection lost, attempting to reconnect');
          connectToAzure();
        }
        
        return false;
      }
      
      try {
        const messageString = typeof message === 'string' 
          ? message 
          : JSON.stringify(message);
        azureWs.send(messageString);
        console.log(`Message sent to Azure: ${messageString.substring(0, 50)}...`);
        return true;
      } catch (error) {
        console.error('Error sending message to Azure:', error);
        
        // Notify client of the error
        sendToClient({
          type: 'error',
          message: 'Failed to send message to Azure: ' + (error.message || 'Unknown error')
        });
        
        messageQueue.push(message);
        return false;
      }
    };
    
    // Process any queued messages
    const processQueue = () => {
      if (messageQueue.length > 0 && azureWs && azureWs.readyState === WebSocket.OPEN && azureIsReady) {
        console.log(`Processing ${messageQueue.length} queued messages`);
        
        // Take a copy of the queue and clear it
        const currentQueue = [...messageQueue];
        messageQueue = [];
        
        // Process each message
        for (const message of currentQueue) {
          sendToAzure(message);
        }
      }
    };
    
    // Function to connect to Azure OpenAI
    const connectToAzure = () => {
      // Clear any existing reconnect timeout
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      
      // Don't reconnect if we already have an active connection or are in the process of connecting
      if (azureWs && (azureWs.readyState === WebSocket.CONNECTING || azureWs.readyState === WebSocket.OPEN)) {
        console.log('Azure connection already in progress or established - skipping reconnect');
        return;
      }
      
      // Check connection attempts
      if (connectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`Reached maximum reconnection attempts (${MAX_RECONNECT_ATTEMPTS})`);
        sendToClient({
          type: 'error',
          message: 'Failed to maintain connection to Azure OpenAI after multiple attempts'
        });
        return;
      }
      
      // Reset state
      azureIsReady = false;
      connectAttempts++;
      connectionInitTime = Date.now();
      
      // Create WebSocket URL for Azure OpenAI
      const cleanEndpoint = azureEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const azureWsUrl = `wss://${cleanEndpoint}/openai/realtime?api-version=${azureApiVersion}&deployment=${azureDeployment}`;
      console.log(`Connecting to Azure OpenAI (attempt ${connectAttempts}): ${azureWsUrl}`);
      
      try {
        // Clean up any existing connection
        if (azureWs) {
          try {
            azureWs.terminate();
          } catch (e) {
            console.log('Error terminating existing Azure connection:', e);
          }
        }
        
        // Connect to Azure OpenAI with proper headers
        azureWs = new WebSocket(azureWsUrl, {
          headers: {
            'api-key': azureApiKey
          }
        });
        
        // Clear any existing interval
        if (keepAliveInterval) {
          clearInterval(keepAliveInterval);
        }
        
        // Azure connection events
        azureWs.on('open', () => {
          console.log('Connected to Azure OpenAI - open event triggered');
          connectAttempts = 0; // Reset counter on successful connection
          
          // Set up a keep-alive ping to prevent connection timeouts
          keepAliveInterval = setInterval(() => {
            if (azureWs && azureWs.readyState === WebSocket.OPEN) {
              try {
                const timeNow = Date.now();
                // Only send a ping if we haven't sent a message in the last 15 seconds
                if (timeNow - lastMessageTime > 15000) {
                  console.log('Sending ping to keep connection alive');
                  azureWs.ping();
                  lastMessageTime = timeNow;
                }
              } catch (error) {
                console.error('Error sending ping:', error);
              }
            } else {
              clearInterval(keepAliveInterval);
            }
          }, 15000); // Every 15 seconds - more frequent to keep connection alive
          
          // Notify client of connection and send system message
          setTimeout(() => {
            // Mark Azure as ready to receive messages
            azureIsReady = true;
            console.log('Azure connection fully established and ready for messages');
            
            sendToClient({
              type: 'status',
              status: 'connected'
            });
            
            // Send session update with voice options
            sendToAzure({
              type: "session.update",
              data: {
                speech: {
                  input: { encoding: "webm", speaking_rate: 1.0 },
                  output: { voice: "alloy", format: "mp3" }
                }
              }
            });
            
            // Add a system message using conversation.item.create
            sendToAzure({
              type: "conversation.item.create",
              data: {
                role: "system",
                content: "You are a helpful voice assistant. Be conversational and natural in your responses."
              }
            });
            
            // Process any queued messages right away
            processQueue();
          }, 1000); // Give it a full second to stabilize
        });
        
        azureWs.on('message', (data) => {
          lastMessageTime = Date.now();
          
          try {
            // Parse the message to see if it's an audio response
            const messageData = JSON.parse(data.toString());
            
            if (messageData.type === 'audio_response') {
              console.log('Received audio response from Azure');
              // Audio responses should be forwarded as-is
            } else if (messageData.type === 'error') {
              // Enhance the error message if it's undefined
              console.error('Received error message from Azure:', messageData);
              if (!messageData.message || messageData.message === 'undefined') {
                messageData.message = 'An error occurred, but no details were provided';
              }
            } else {
              console.log('Received text message from Azure to forward to client');
            }
            
            // Forward all messages to client regardless of type
            sendToClient(data.toString());
            
          } catch (error) {
            console.log('Error parsing Azure message, forwarding as-is');
            sendToClient(data.toString());
          }
        });
        
        azureWs.on('error', (error) => {
          console.error('Azure WebSocket error:', error.message);
          azureIsReady = false;
          
          // Send a more specific error message to the client
          sendToClient({
            type: 'error',
            message: 'Azure connection error: ' + (error.message || 'Unknown error'),
            code: error.code || 'NO_CODE',
            timestamp: new Date().toISOString()
          });
          
          // Reconnect on error after a short delay
          if (!clientClosed) {
            console.log('Scheduling reconnect after error');
            reconnectTimeout = setTimeout(connectToAzure, 2000);
          }
        });
        
        azureWs.on('close', (code, reason) => {
          console.log(`Azure connection closed: ${code} - ${reason || 'No reason provided'}`);
          azureIsReady = false;
          
          // Clear the keep-alive interval
          if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
          }
          
          // Notify client only if it wasn't a normal closure or if it was too soon
          const connectionDuration = Date.now() - connectionInitTime;
          
          if (code !== 1000 || connectionDuration < 60000) {
            // If connection closed too quickly (less than 60 seconds) or abnormally
            sendToClient({
              type: 'status',
              status: 'reconnecting',
              message: 'Azure connection closed, attempting to reconnect...'
            });
            
            // Reconnect to Azure if client is still connected
            if (!clientClosed) {
              console.log('Scheduling reconnect after close');
              reconnectTimeout = setTimeout(connectToAzure, 1000);
            }
          } else {
            // Normal closure after a reasonable time
            sendToClient({
              type: 'status',
              status: 'disconnected',
              code,
              reason: reason ? reason.toString() : 'No reason provided'
            });
          }
        });
        
        // Handle pong response to our ping
        azureWs.on('pong', () => {
          console.log('Received pong from Azure - connection still alive');
          lastMessageTime = Date.now();
        });
        
      } catch (error) {
        console.error('Failed to create Azure WebSocket:', error);
        azureIsReady = false;
        
        sendToClient({
          type: 'error',
          message: 'Failed to connect to Azure: ' + error.message
        });
        
        // Try reconnecting after a delay
        if (!clientClosed) {
          console.log('Scheduling reconnect after connection failure');
          reconnectTimeout = setTimeout(connectToAzure, 3000);
        }
      }
    };
    
    // Start the Azure connection
    connectToAzure();
    
    // Client connection events
    ws.on('message', (data) => {
      // Forward message from client to Azure
      try {
        const jsonData = JSON.parse(data.toString());
        console.log(`Received message from client of type: ${jsonData.type}`);
        
        if (jsonData.type === "audio") {
          // For audio data, use the input_audio_buffer.append
          sendToAzure({
            type: "input_audio_buffer.append",
            data: {
              audio: jsonData.data,
              encoding: jsonData.format || "webm"
            }
          });
        } else if (jsonData.type === "end_of_audio") {
          // For end of audio, use input_audio_buffer.commit
          sendToAzure({
            type: "input_audio_buffer.commit",
            data: {}
          });
          
          // Then create a response
          sendToAzure({
            type: "response.create",
            data: {}
          });
        } else {
          // For other message types, translate to appropriate Azure format
          console.log(`Unsupported message type: ${jsonData.type}`);
        }
      } catch (error) {
        console.error('Error handling client message:', error);
      }
    });
    
    ws.on('error', (error) => {
      console.error('Client WebSocket error:', error.message);
    });
    
    ws.on('close', (code, reason) => {
      console.log(`Client disconnected: ${code} - ${reason || 'No reason'}`);
      clientClosed = true;
      
      // Clear any intervals and timeouts
      if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
      }
      
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      
      // Close Azure connection when client disconnects
      if (azureWs) {
        try {
          if (azureWs.readyState === WebSocket.OPEN) {
            azureWs.close(1000, 'Client disconnected');
          } else {
            azureWs.terminate();
          }
        } catch (error) {
          console.error('Error closing Azure connection:', error);
        }
        azureWs = null;
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
