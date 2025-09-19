# 🧪 Test Your MCP Accumulation System

## 🚀 Quick Start

### Step 1: Start the Server
```bash
wrangler dev
```
Wait for: `Ready on http://127.0.0.1:8787`

### Step 2: Open Browser Test
1. Open `test-chat.html` in your browser
2. Click **"Connect WebSocket"**
3. You should see: `✅ WebSocket connected successfully!`

## 🧪 Test MCP Accumulation

### Your Test Data:
- **User ID**: `330c7620-2914-4a5c-8d5f-e4bac4737d08`
- **Workspace ID**: `14f49f8a-1e2f-4159-abf9-bbff0078bfa9`
- **Session ID**: `f279177d-2e8e-48ad-baa4-607f440f7950`

### Test Scenarios:

#### 1. 📇 Test Contact Search Accumulation
- Click **"📇 Test Contact Search"**
- This simulates finding contacts via MCP
- Response gets accumulated in session metadata

#### 2. 📧 Test Email Draft Accumulation
- Click **"📧 Test Email Draft"**
- This simulates drafting an email via MCP
- Email data gets accumulated for future context

#### 3. 📅 Test Meeting Draft Accumulation
- Click **"📅 Test Meeting Draft"**
- This simulates scheduling a meeting via MCP
- Meeting data gets accumulated

#### 4. 📊 Check Session Summary
- Click **"📊 Get Session Summary"**
- Shows all accumulated MCP data
- Displays statistics and context

## 🔍 What Happens:

### 1. **Complete Message Flow:**
```
User sends: "Hi there"
    ↓
✅ Save to chat_messages (is_own_message: true)
    ↓
AI responds: "Hi user how are you"
    ↓
✅ Save to chat_messages (is_own_message: false)
    ↓
MCP accumulates context for future responses
```

### 2. **Database Records Created:**
```sql
-- User message saved
INSERT INTO chat_messages (session_id, user_id, workspace_id, text, is_own_message)
VALUES ('f279177d-2e8e-48ad-baa4-607f440f7950', '330c7620-2914-4a5c-8d5f-e4bac4737d08', '14f49f8a-1e2f-4159-abf9-bbff0078bfa9', 'Hi there', true);

-- AI response saved
INSERT INTO chat_messages (session_id, user_id, workspace_id, text, is_own_message)
VALUES ('f279177d-2e8e-48ad-baa4-607f440f7950', '330c7620-2914-4a5c-8d5f-e4bac4737d08', '14f49f8a-1e2f-4159-abf9-bbff0078bfa9', 'Hi user how are you', false);
```

### 3. MCP Response Accumulation
```javascript
// When you click "Test Contact Search":
{
  "type": "accumulate_mcp_response",
  "data": {
    "action": "contacts_search",
    "result": [{ "name": "John Doe", "email": "john@example.com" }],
    "success": true
  },
  "sessionId": "f279177d-2e8e-48ad-baa4-607f440f7950"
}
```

### 2. Database Storage
- Session metadata saved to Supabase `chat_sessions` table
- MCP responses accumulated in `metadata.mcpResponses[]`
- Context extracted and stored in `metadata.contextAccumulated`

### 3. Context Building
- Contacts → `contextAccumulated.contacts[]`
- Emails → `contextAccumulated.emails[]`
- Meetings → `contextAccumulated.meetings[]`
- Tasks → `contextAccumulated.tasks[]`

## 📊 Expected Results:

### Browser Console (WebSocket messages):
```
📨 Received: status - MCP response accumulated successfully
📨 Received: session_summary - { sessionId: "f279...", metadata: {...} }
```

### Database (Supabase):
```sql
SELECT * FROM chat_sessions
WHERE id = 'f279177d-2e8e-48ad-baa4-607f440f7950';
```

Should show:
```json
{
  "metadata": {
    "mcpResponses": [
      {
        "action": "contacts_search",
        "result": [{ "name": "John Doe" }],
        "success": true,
        "timestamp": "2024-01-01T..."
      }
    ],
    "contextAccumulated": {
      "contacts": [{ "name": "John Doe" }],
      "recentActions": [{ "action": "contacts_search" }]
    },
    "totalMCPActions": 1
  }
}
```

## 🎯 Alternative: Node.js Test

If you prefer command line:
```bash
node test-with-your-data.js
```

This will:
- ✅ Connect with your real IDs
- ✅ Test MCP accumulation
- ✅ Show results in console

## 🔧 Troubleshooting:

### If WebSocket won't connect:
1. Make sure `wrangler dev` is running
2. Check browser console for errors
3. Verify the server is on `http://127.0.0.1:8787`

### If no data in database:
1. Check Supabase connection
2. Verify `SUPABASE_SERVICE_ROLE_KEY` in `wrangler.toml`
3. Check Supabase logs for errors

### If accumulation fails:
1. Check browser console for WebSocket errors
2. Verify session ID is correct
3. Check server logs in terminal

## 🎉 Success Indicators:

- ✅ WebSocket connects successfully
- ✅ "MCP response accumulated successfully" message
- ✅ Session summary shows accumulated data
- ✅ Database contains session metadata
- ✅ Context accumulated for future AI use

**🚀 Your MCP accumulation system is ready to test!**