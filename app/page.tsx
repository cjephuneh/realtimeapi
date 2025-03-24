"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState<Array<{role: string, content: string}>>([]);
  const [status, setStatus] = useState("Ready");
  
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  
  // Connect to our WebSocket proxy instead of directly to Azure
  useEffect(() => {
    const connectWebSocketProxy = () => {
      try {
        setStatus("Connecting to WebSocket proxy...");
        
        // Connect to our local WebSocket proxy
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/ws-proxy`;
        console.log("Connecting to WebSocket proxy:", wsUrl);
        
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          console.log("WebSocket connection to proxy opened");
          // Don't set connected here - wait for the status message from the proxy
          setStatus("Connected to proxy, waiting for Azure...");
        };
        
        ws.onmessage = (event) => {
          try {
            console.log("Received message:", event.data);
            const data = JSON.parse(event.data);
            
            if (data.type === "status") {
              if (data.status === "connected") {
                setIsConnected(true);
                setStatus("Connected to Azure OpenAI");
              } else if (data.status === "disconnected") {
                setIsConnected(false);
                setStatus(`Disconnected (${data.code}: ${data.reason || 'Unknown reason'})`);
              }
            } else if (data.type === "message") {
              setMessages(prev => [...prev, { 
                role: "assistant", 
                content: data.content || "Sorry, I couldn't process that."
              }]);
            } else if (data.type === "error") {
              setStatus(`Error: ${data.message}`);
              console.error("Azure OpenAI Error:", data.message);
            } else if (data.type === "content_block_notification") {
              setStatus("Content blocked: Violated content policy");
              console.warn("Content blocked:", data);
            } else if (data.type === "audio_response") {
              console.log("Received audio response:", data);
            } else {
              console.log("Other message type:", data.type);
            }
          } catch (error) {
            console.error("Error parsing WebSocket message:", error);
          }
        };
        
        ws.onclose = (event) => {
          console.log("WebSocket closed with code:", event.code, "reason:", event.reason);
          setIsConnected(false);
          setStatus(`Disconnected (${event.code}: ${event.reason || 'Unknown reason'})`);
          
          // Attempt to reconnect unless it was closed intentionally
          if (event.code !== 1000) {
            console.log("Attempting to reconnect in 5 seconds...");
            setTimeout(connectWebSocketProxy, 5000);
          }
        };
        
        ws.onerror = (error) => {
          console.error("WebSocket error occurred");
          setStatus("Connection error - check console");
        };
        
        wsRef.current = ws;
      } catch (error) {
        console.error("Error in connectWebSocketProxy:", error);
        setStatus("Failed to establish connection");
      }
    };
    
    connectWebSocketProxy();
    
    return () => {
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, "Component unmounted");
        } catch (error) {
          console.error("Error closing WebSocket:", error);
        }
      }
    };
  }, []);
  
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Azure OpenAI supports webm opus format for audio
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
          
          // Send audio chunk directly to Azure OpenAI in real-time
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            const reader = new FileReader();
            reader.readAsDataURL(event.data);
            reader.onloadend = () => {
              const base64data = reader.result as string;
              // Remove the content type prefix (e.g., "data:audio/webm;base64,")
              const audioData = base64data.split(',')[1];
              
              wsRef.current?.send(JSON.stringify({
                type: "audio",
                data: audioData,
                format: mediaRecorder.mimeType.includes('opus') 
                  ? 'webm;codecs=opus' 
                  : 'webm'
              }));
            };
          }
        }
      };
      
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release the microphone
        stream.getTracks().forEach(track => track.stop());
        console.log("Recording stopped");
      };
      
      // Request data in smaller chunks for real-time processing
      mediaRecorder.start(100); // Send audio chunks every 100ms
      setIsRecording(true);
      setStatus("Recording");
      
      // Add user message to show recording started
      setMessages(prev => [...prev, { role: "user", content: "🎤 Recording started..." }]);
      
    } catch (error) {
      console.error("Error starting recording:", error);
      setStatus("Error accessing microphone");
    }
  };
  
  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setStatus("Processing audio");
      
      // Update the user message
      setMessages(prev => {
        const newMessages = [...prev];
        // Find and update the last user message if it was about recording
        const lastUserMsgIndex = newMessages.findIndex(
          msg => msg.role === "user" && msg.content === "🎤 Recording started..."
        );
        
        if (lastUserMsgIndex !== -1) {
          newMessages[lastUserMsgIndex].content = "🎤 Voice message sent";
        } else {
          newMessages.push({ role: "user", content: "🎤 Voice message sent" });
        }
        
        return newMessages;
      });
      
      // Send end-of-audio signal to Azure OpenAI
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: "end_of_audio"
        }));
      }
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
