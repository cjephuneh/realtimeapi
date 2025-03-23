import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'token') {
      // For security in production, you should implement proper token generation
      // with JWT or another secure method. This is just for demonstration.
      
      // Verify that we have the API key in the environment
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      if (!apiKey) {
        console.error("API key is missing from environment variables");
        return NextResponse.json(
          { error: 'Server configuration error' }, 
          { status: 500 }
        );
      }
      
      return NextResponse.json({
        token: apiKey,
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('API route error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
