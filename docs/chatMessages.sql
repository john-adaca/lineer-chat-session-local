-- Create chat_messages table for persistent chat history
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  text TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'text' CHECK (mode IN ('text', 'text_with_voice', 'voice')),
  is_own_message BOOLEAN DEFAULT TRUE,
  sender_name TEXT,
  audio_url TEXT,
  transcription TEXT,
  actions JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);