# ChatSession Durable Object

A Cloudflare Workers application with Durable Objects for managing real-time chat sessions.

## 🚀 Quick Start

### Prerequisites
- Node.js installed
- Wrangler CLI installed (`npm install -g wrangler`)

### Installation
```bash
npm install
```

### Local Development
```bash
wrangler dev
```
Server will be available at: `http://127.0.0.1:8787`

## 🧪 Testing

### Option 1: Browser-based Testing (Recommended)
1. Start the local server: `wrangler dev`
2. Open `test-chat.html` in your browser
3. Click "Connect WebSocket" to establish connection
4. Test various features using the quick test buttons

### Option 2: Node.js Automated Testing
```bash
node test-chat-session.js
```

This will run comprehensive tests for:
- ✅ HTTP endpoints (`/api/sessions`, `/api/chat`, `/api/actions`)
- ✅ WebSocket connection and messaging
- ✅ User preferences, personality, and context management
- ✅ Message streaming and interruption

## 📡 API Endpoints

### HTTP Endpoints
- `GET /api/sessions?userId=...&workspaceId=...` - List chat sessions
- `GET /api/chat?userId=...&workspaceId=...&sessionId=...` - Get chat history
- `GET /api/actions?userId=...&workspaceId=...` - List user actions

### WebSocket Endpoint
```
ws://127.0.0.1:8787/?userId=...&workspaceId=...
```

### WebSocket Message Types

#### Send Messages
```javascript
// Regular chat message
{
  "type": "message",
  "content": "Hello!",
  "sessionId": "session-123",
  "messageId": "msg-1"
}

// Set user preferences
{
  "type": "set_preference",
  "data": {
    "communicationStyle": "casual",
    "responseLength": "brief"
  },
  "sessionId": "session-123"
}

// Set AI personality
{
  "type": "set_personality",
  "data": {
    "personality": {
      "name": "Friendly Assistant",
      "systemPrompt": "You are helpful..."
    }
  },
  "sessionId": "session-123"
}

// Set user context
{
  "type": "set_user_context",
  "data": {
    "userGoals": ["Help with coding"],
    "emotionalTone": "curious"
  },
  "sessionId": "session-123"
}

// Get session context
{
  "type": "get_context",
  "sessionId": "session-123"
}

// Send interrupt signal
{
  "type": "interrupt"
}
```

#### Receive Messages
```javascript
// AI response (streaming)
{
  "type": "content",
  "content": "AI response text",
  "messageId": "ai-msg-123"
}

// Status updates
{
  "type": "status",
  "content": "Message received, processing...",
  "messageId": "msg-1"
}

// Context data
{
  "type": "context_data",
  "data": { /* full context object */ },
  "messageId": "context-1"
}
```

## 🏗️ Project Structure

```
├── src/
│   └── index.ts              # Main entry point
├── durable-objects/
│   ├── ChatSession.ts        # Durable Object implementation
│   ├── services/             # Service classes
│   └── types/               # TypeScript type definitions
├── types/
│   └── index.ts             # Shared type definitions
├── test-chat.html           # Browser-based testing
├── test-chat-session.js     # Node.js automated testing
├── wrangler.toml           # Cloudflare Workers config
└── package.json            # Dependencies
```

## 🚀 Production Deployment

```bash
# Deploy to production
wrangler deploy

# Or deploy to specific environment
wrangler deploy --env production

# Check deployment logs
wrangler tail
```

## 🔧 Configuration

Environment variables are configured in `wrangler.toml`:

- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `OPENAI_API_KEY` - OpenAI API key
- `MCP_SERVER_URL` - MCP server URL

## 🎯 Features

- ✅ **Real-time WebSocket communication**
- ✅ **Persistent chat sessions** via Durable Objects
- ✅ **User preference management**
- ✅ **AI personality customization**
- ✅ **Conversation context tracking**
- ✅ **Message streaming support**
- ✅ **Session state persistence**
- ✅ **HTTP API endpoints**
- ✅ **Comprehensive testing suite**

## 🔄 Next Steps

1. **Replace simulated AI** in `ChatSession.ts` with actual OpenAI integration
2. **Add authentication** middleware
3. **Implement rate limiting**
4. **Add message history pagination**
5. **Configure custom domain** in Cloudflare

## 📝 Development Notes

- Durable Objects provide persistent state across WebSocket connections
- All session data is automatically persisted to Cloudflare's storage
- WebSocket connections are automatically cleaned up on disconnect
- The system supports multiple concurrent sessions per user/workspace

---

**Happy coding! 🎉**