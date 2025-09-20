# Quick Deployment Guide

## 🚀 Super Simple Deployment

### 1. Install Wrangler
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare
```bash
wrangler login
```

### 3. Copy Configuration
```bash
cp wrangler.toml.example wrangler.toml
```

### 4. Edit wrangler.toml
Replace the placeholder values with your actual:
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY  
- OPENAI_API_KEY
- MCP_SERVER_URL

### 5. Deploy
```bash
npm install
wrangler deploy
```

That's it! Your worker is now deployed. 🎉

## 🧪 Test Your Deployment

```bash
# Test basic endpoint
curl "https://your-worker.your-subdomain.workers.dev/test?userId=test&workspaceId=test"

# View logs
wrangler tail
```

## 📝 What You Need

Before deploying, make sure you have:
- Cloudflare account
- Supabase project (for database)
- OpenAI API key
- MCP server URL

## 🔧 Environment Variables

You can set them in wrangler.toml (easy) or use secrets (more secure):

```bash
# For production secrets
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put MCP_SERVER_URL
```

## 📊 Database Setup

Create these tables in your Supabase database:

```sql
-- Chat sessions table
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode TEXT DEFAULT 'text',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Chat messages table
CREATE TABLE chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  text TEXT NOT NULL,
  mode TEXT DEFAULT 'text',
  is_own_message BOOLEAN DEFAULT false,
  sender_name TEXT,
  actions JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);
```

## 🎯 Done!

Your ChatSession Durable Objects application is now running on Cloudflare Workers. Use the test-chat.html file to test WebSocket functionality.

---

Need more details? See README-WRANGLER-DEPLOYMENT.md for comprehensive instructions.