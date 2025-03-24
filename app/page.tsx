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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  
  // Connect to our WebSocket proxy instead of directly to Azure
  useEffect(() => {
    const connectWebSocketProxy = () => {
      try {
        setStatus("Connecting to WebSocket proxy...");
        
        // Connect to our local WebSocket proxy
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/ws-proxy`;
        console.log("Connecting to WebSocket proxy:", wsUrl);
        
        // Close any existing connection
        if (wsRef.current) {
          try {
            wsRef.current.close();
          } catch (e) {
            console.error("Error closing existing WebSocket:", e);
          }
        }
        
        const ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
          console.log("WebSocket connection to proxy opened");
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
            } else if (data.type === "response" || data.type === "response.partial") {
              // Handle response from real-time API
              if (data.data && data.data.content && data.data.content.length > 0) {
                const content = data.data.content[0];
                if (content.text) {
                  setMessages(prev => [...prev, { 
                    role: "assistant", 
                    content: content.text
                  }]);
                }
              }
            } else if (data.type === "speech.partial" || data.type === "speech") {
              // Handle speech response
              console.log("Received speech/audio response from Azure");
              
              if (data.data && data.data.audio) {
                try {
                  // Create audio element if it doesn't exist
                  if (!audioRef.current) {
                    audioRef.current = new Audio();
                  }
                  
                  // Convert base64 audio to a blob
                  const audioBlob = base64ToBlob(data.data.audio, 'audio/mp3');
                  const audioUrl = URL.createObjectURL(audioBlob);
                  
                  // Play the audio
                  audioRef.current.src = audioUrl;
                  audioRef.current.play().catch(err => {
                    console.error("Error playing audio:", err);
                  });
                  
                  // Clean up the blob URL when done
                  audioRef.current.onended = () => {
                    URL.revokeObjectURL(audioUrl);
                  };
                } catch (error) {
                  console.error("Error processing audio response:", error);
                }
              }
            } else if (data.type === "error") {
              const errorMessage = data.message || data.error?.message || "An unknown error occurred";
              setStatus(`Error: ${errorMessage}`);
              console.error("Azure OpenAI Error:", data);
              
              // Display a more user-friendly error in the messages area
              if (errorMessage.includes("content policy")) {
                setMessages(prev => [...prev, { 
                  role: "system", 
                  content: "Sorry, that request couldn't be processed due to content policy restrictions."
                }]);
              } else {
                setMessages(prev => [...prev, { 
                  role: "system", 
                  content: "Sorry, there was an issue processing your request. Please try again."
                }]);
              }
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
          
          // Attempt to reconnect after a delay, with exponential backoff
          if (event.code !== 1000) {
            const reconnectDelay = Math.min(5000 + Math.random() * 1000, 30000);
            console.log(`Attempting to reconnect in ${reconnectDelay/1000} seconds...`);
            setTimeout(connectWebSocketProxy, reconnectDelay);
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
        
        // Attempt to reconnect after error
        setTimeout(connectWebSocketProxy, 5000);
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

  // Helper function to convert base64 to Blob
  const base64ToBlob = (base64: string, mimeType: string) => {
    const byteCharacters = atob(base64);
    const byteArrays = [];

    for (let i = 0; i < byteCharacters.length; i += 512) {
      const slice = byteCharacters.slice(i, i + 512);
      const byteNumbers = new Array(slice.length);
      
      for (let j = 0; j < slice.length; j++) {
        byteNumbers[j] = slice.charCodeAt(j);
      }
      
      const byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }

    return new Blob(byteArrays, { type: mimeType });
  };

  return (
    <div className="grid grid-rows-[auto_1fr_auto] items-center min-h-screen p-8 pb-20 gap-8 font-sans">
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
        Powered by Azure OpenAI Real-time API with Voice
      </footer>
    </div>
  );
}
