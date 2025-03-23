"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState<Array<{role: string, content: string}>>([]);
  const [status, setStatus] = useState("Ready");
  const [authToken, setAuthToken] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  
  // First fetch the auth token from our secure API
  useEffect(() => {
    const fetchAuthToken = async () => {
      try {
        setStatus("Fetching authentication...");
        const response = await fetch('/api/azure-openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'token' })
        });
        
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }
        
        const data = await response.json();
        setAuthToken(data.token);
      } catch (error) {
        console.error("Error fetching auth token:", error);
        setStatus("Authentication failed");
      }
    };
    
    fetchAuthToken();
  }, []);
  
  // Then connect to Azure OpenAI when we have the token
  useEffect(() => {
    if (!authToken) return;
    
    // Connect to Azure OpenAI real-time API
    const connectAzureOpenAI = () => {
      try {
        setStatus("Connecting to Azure OpenAI...");
        
        const endpoint = process.env.NEXT_PUBLIC_AZURE_OPENAI_ENDPOINT;
        const apiVersion = process.env.NEXT_PUBLIC_AZURE_OPENAI_API_VERSION;
        const deployment = process.env.NEXT_PUBLIC_AZURE_OPENAI_DEPLOYMENT;
        
        if (!endpoint || !apiVersion || !deployment) {
          setStatus("Missing configuration");
          return;
        }
        
        // Create WebSocket URL with the deployment name and API version
        const wsUrl = `${endpoint}?api-version=${apiVersion}&deployment=${deployment}`;
        console.log("Connecting to WebSocket:", wsUrl);
        
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          console.log("WebSocket connection opened");
          setIsConnected(true);
          setStatus("Connected to Azure OpenAI");
          
          // Send authentication message immediately after connection
          ws.send(JSON.stringify({
            type: "authentication",
            apiKey: authToken
          }));
        };
        
        ws.onmessage = (event) => {
          try {
            console.log("Received message:", event.data);
            const data = JSON.parse(event.data);
            
            if (data.type === "message") {
              setMessages(prev => [...prev, { 
                role: "assistant", 
                content: data.content || "Sorry, I couldn't process that."
              }]);
            } else if (data.type === "error") {
              setStatus(`Error: ${data.message}`);
              console.error("Azure OpenAI Error:", data.message);
            }
          } catch (error) {
            console.error("Error parsing WebSocket message:", error);
          }
        };
        
        ws.onclose = (event) => {
          console.log("WebSocket closed with code:", event.code);
          setIsConnected(false);
          setStatus(`Disconnected (${event.code}: ${event.reason || 'Unknown reason'})`);
          
          // Attempt to reconnect unless it was closed intentionally
          if (event.code !== 1000) {
            setTimeout(connectAzureOpenAI, 5000);
          }
        };
        
        ws.onerror = (error) => {
          // The error object doesn't have useful info in browsers due to security restrictions
          console.error("WebSocket error occurred");
          setStatus("Connection error - check console");
        };
        
        wsRef.current = ws;
      } catch (error) {
        console.error("Error in connectAzureOpenAI:", error);
        setStatus("Failed to establish connection");
      }
    };
    
    connectAzureOpenAI();
    
    return () => {
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, "Component unmounted");
        } catch (error) {
          console.error("Error closing WebSocket:", error);
        }
      }
    };
  }, [authToken]);
  
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Try to use audio/webm; codec=opus first, fall back to audio/webm
      let options;
      try {
        options = { mimeType: 'audio/webm; codecs=opus' };
        new MediaRecorder(stream, options);
      } catch (e) {
        console.log('audio/webm; codecs=opus not supported, using audio/webm');
        options = { mimeType: 'audio/webm' };
      }
      
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release the microphone
        stream.getTracks().forEach(track => track.stop());
        
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
        console.log(`Recorded audio (${audioBlob.size} bytes) with mime type: ${mediaRecorder.mimeType}`);
        
        // Send the audio to Azure OpenAI via WebSocket
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          setStatus("Processing audio");
          
          // Convert blob to base64
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = () => {
            const base64data = reader.result as string;
            // Remove the content type prefix (e.g., "data:audio/webm;base64,")
            const audioData = base64data.split(',')[1];
            
            const format = mediaRecorder.mimeType.includes('opus') 
              ? 'webm;codecs=opus' 
              : 'webm';
            
            // Send the audio data to Azure OpenAI
            wsRef.current?.send(JSON.stringify({
              type: "audio",
              data: audioData,
              format: format
            }));
            
            // Don't add user message here - we'll do it in stopRecording
          };
        }
      };
      
      // Request data every 250ms to get smaller chunks
      mediaRecorder.start(250);
      setIsRecording(true);
      setStatus("Recording");
    } catch (error) {
      console.error("Error starting recording:", error);
      setStatus("Error accessing microphone");
    }
  };
  
  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      
      // Add user message to the conversation
      setMessages(prev => [...prev, { role: "user", content: "🎤 Voice message sent" }]);
    }
  };
  
  const handleVoiceButtonClick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <div className="grid grid-rows-[auto_1fr_auto] items-center min-h-screen p-8 pb-20 gap-8 font-[family-name:var(--font-geist-sans)]">
      <header className="w-full text-center">
        <h1 className="text-3xl font-bold mb-2">Azure OpenAI Voice Chat</h1>
        <p className="text-gray-600 dark:text-gray-300">
          Powered by gpt-4o-realtime-preview
        </p>
        <div className="mt-2 text-sm">
          Status: <span className={`font-medium ${isConnected ? 'text-green-500' : 'text-red-500'}`}>
            {status}
          </span>
        </div>
      </header>
      
      <main className="w-full max-w-4xl mx-auto flex flex-col gap-6 overflow-y-auto">
        <div className="flex-1 bg-gray-50 dark:bg-gray-900 rounded-lg p-6 overflow-y-auto h-[50vh]">
          {messages.length === 0 ? (
            <div className="text-center text-gray-400 dark:text-gray-500 h-full flex items-center justify-center">
              <p>Your conversation will appear here. Click the microphone button to start talking.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, index) => (
                <div key={index} className={`p-3 rounded-lg ${
                  msg.role === 'user' 
                    ? 'bg-blue-100 dark:bg-blue-900 ml-auto max-w-[80%]' 
                    : 'bg-gray-100 dark:bg-gray-800 mr-auto max-w-[80%]'
                }`}>
                  <p>{msg.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        
        <div className="flex justify-center">
          <button
            onClick={handleVoiceButtonClick}
            disabled={!isConnected}
            className={`rounded-full w-16 h-16 flex items-center justify-center transition-colors ${
              isRecording 
                ? 'bg-red-500 hover:bg-red-600' 
                : 'bg-blue-500 hover:bg-blue-600'
            } ${!isConnected ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Image
              src={isRecording ? "/stop.svg" : "/mic.svg"}
              alt={isRecording ? "Stop recording" : "Start recording"}
              width={24}
              height={24}
              className="text-white"
            />
          </button>
        </div>
      </main>
      
      <footer className="text-center text-sm text-gray-500 dark:text-gray-400">
        Powered by Azure OpenAI Real-time API
      </footer>
    </div>
  );
}
