import { NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';

// Azure OpenAI configuration
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || '';
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://cto-m8hozr3j-eastus2.openai.azure.com';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-realtime-preview';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-01-preview';

export async function POST(req: NextRequest) {
  try {
    const { audio, format } = await req.json();
    
    if (!audio) {
      return NextResponse.json({ error: 'No audio data provided' }, { status: 400 });
    }
    
    // Convert base64 back to binary
    const binaryData = Buffer.from(audio, 'base64');
    
    // Step 1: Transcribe the audio using Azure Speech Services or OpenAI Whisper API
    const transcription = await transcribeAudio(binaryData, format);
    
    // Step 2: Get response from Azure OpenAI real-time API via WebSocket
    const apiResponse = await getRealtimeResponseFromAzureOpenAI(transcription);
    
    return NextResponse.json({
      transcription,
      response: apiResponse
    });
  } catch (error) {
    console.error('API route error:', error);
    return NextResponse.json({ 
      error: 'Failed to process audio',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

// Function to transcribe audio
async function transcribeAudio(audioData: Buffer, format: string): Promise<string> {
  // This is a placeholder - you would need to implement actual transcription
  // using Azure Speech Services, OpenAI Whisper API, or similar
  
  console.log(`Transcribing audio of format: ${format}, size: ${audioData.length} bytes`);
  
  // For demo purposes, return placeholder text
  return "This is a placeholder transcription. Implement actual transcription service.";
}

// Function to get real-time response from Azure OpenAI using WebSocket
async function getRealtimeResponseFromAzureOpenAI(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const wsUrl = `wss://${AZURE_OPENAI_ENDPOINT.replace('https://', '')}/openai/realtime?api-version=${AZURE_OPENAI_API_VERSION}&deployment=${AZURE_OPENAI_DEPLOYMENT}`;
      
      console.log(`Connecting to Azure OpenAI real-time API at: ${wsUrl}`);
      
      const ws = new WebSocket(wsUrl, {
        headers: {
          'api-key': AZURE_OPENAI_KEY
        }
      });
      
      let responseText = '';
      
      ws.on('open', () => {
        console.log('WebSocket connection established');
        
        // Send the initial message with the prompt
        const message = {
          type: 'message',
          role: 'user',
          content: prompt
        };
        
        ws.send(JSON.stringify(message));
      });
      
      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          console.log('Received response:', response);
          
          if (response.type === 'message' && response.role === 'assistant') {
            responseText += response.content || '';
          } else if (response.type === 'error') {
            reject(new Error(`Azure OpenAI Error: ${response.message}`));
            ws.close();
          } else if (response.type === 'done') {
            resolve(responseText);
            ws.close();
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });
      
      ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} ${reason}`);
        if (responseText && !ws.isAlive) {
          resolve(responseText);
        }
      });
      
      // Set a timeout in case the WebSocket doesn't close properly
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log('Closing WebSocket due to timeout');
          ws.close();
          if (responseText) {
            resolve(responseText);
          } else {
            reject(new Error('WebSocket timeout'));
          }
        }
      }, 30000); // 30 seconds timeout
    } catch (error) {
      console.error('Error in WebSocket setup:', error);
      reject(error);
    }
  });
}
