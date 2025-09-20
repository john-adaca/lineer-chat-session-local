# ChatSession Durable Objects - Wrangler Deployment Guide

This guide provides comprehensive instructions for deploying the ChatSession Durable Objects application to Cloudflare Workers using Wrangler.

## 📋 Prerequisites

Before deploying, ensure you have:

- **Node.js** (v16 or higher) installed
- **Wrangler CLI** installed: `npm install -g wrangler`
- **Cloudflare account** with Workers subscription
- **Supabase project** for database storage
- **OpenAI API key** for AI responses
- **MCP server URL** for external service integration

## 🔧 Configuration Setup

### 1. Create wrangler.toml Configuration

Create a `wrangler.toml` file in your project root:

```toml
name = "lineer-chat-workers"
main = "src/index.ts"
compatibility_date = "2024-07-31"

# Durable Objects configuration
[[durable_objects.bindings]]
name = "CHAT_SESSION"
class_name = "ChatSession"

# Environment variables - Development
[env.development.vars]
SUPABASE_URL = "your-supabase-project-url"
SUPABASE_SERVICE_ROLE_KEY = "your-supabase-service-role-key"
OPENAI_API_KEY = "your-openai-api-key"
MCP_SERVER_URL = "your-mcp-server-url"

# Environment variables - Production
[env.production.vars]
SUPABASE_URL = "your-production-supabase-url"
SUPABASE_SERVICE_ROLE_KEY = "your-production-supabase-key"
OPENAI_API_KEY = "your-production-openai-key"
MCP_SERVER_URL = "your-production-mcp-url"

# Development settings
[env.development]
durable_objects.persist = true

# Production settings
[env.production]
durable_objects.persist = true
```

### 2. Set Up Environment Variables

You can set environment variables in multiple ways:

#### Option A: Using wrangler.toml (recommended for development)
Add your variables directly to the `wrangler.toml` file as shown above.

#### Option B: Using Wrangler CLI (recommended for production)
```bash
# Set production environment variables
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put MCP_SERVER_URL
```

#### Option C: Using .dev.vars for local development
Create a `.dev.vars` file in your project root:
```
SUPABASE_URL=your-supabase-project-url
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
OPENAI_API_KEY=your-openai-api-key
MCP_SERVER_URL=your-mcp-server-url
```

## 🚀 Deployment Process

### 1. Install Dependencies

```bash
npm install
```

### 2. Build the Project

The project uses TypeScript, which will be automatically compiled by Wrangler during deployment. You can test the build:

```bash
npm run build
```

### 3. Local Development

Start the development server:

```bash
npm run dev
# or
wrangler dev
```

The server will be available at `http://127.0.0.1:8787`

### 4. Deploy to Production

Deploy the application:

```bash
npm run deploy
# or
wrangler deploy
```

To deploy to a specific environment:

```bash
wrangler deploy --env production
```

### 5. Verify Deployment

Check if your deployment was successful:

```bash
wrangler deployments list
```

View real-time logs:

```bash
wrangler tail
```

## 🗄️ Database Setup

### Supabase Configuration

1. **Create a Supabase project** at [supabase.com](https://supabase.com)
2. **Get your project URL and service role key** from the project settings
3. **Create the required tables** using the SQL scripts in the `docs/` directory:

```sql
-- Run these in your Supabase SQL editor
-- docs/chatSessions.sql
-- docs/chatMessages.sql
```

### Required Tables

The application expects these tables in your Supabase database:

#### chat_sessions table
- `id` (text, primary key)
- `user_id` (text)
- `workspace_id` (text)
- `mode` (text, default: 'text')
- `metadata` (jsonb)
- `created_at` (timestamp)
- `updated_at` (timestamp)

#### chat_messages table
- `id` (uuid, primary key)
- `session_id` (text, foreign key)
- `user_id` (text)
- `workspace_id` (text)
- `text` (text)
- `mode` (text)
- `is_own_message` (boolean)
- `sender_name` (text)
- `actions` (jsonb)
- `created_at` (timestamp)

## 🔌 Durable Objects Configuration

### Understanding Durable Objects in this Project

This application uses Durable Objects to:
- Maintain persistent chat sessions across WebSocket connections
- Store user preferences and conversation context
- Cache MCP (Model Context Protocol) responses
- Handle real-time message streaming

### Durable Objects Limits and Considerations

- **Memory limit**: 128MB per Durable Object
- **Storage limit**: 128MB per Durable Object
- **Execution limit**: 30 seconds CPU time per request
- **Concurrency limit**: 1000 concurrent connections per object

## 🧪 Testing Deployment

### 1. Test HTTP Endpoints

```bash
# Test the main endpoint
curl "https://your-worker.your-subdomain.workers.dev/test?userId=test-user&workspaceId=test-workspace"

# Test sessions endpoint
curl "https://your-worker.your-subdomain.workers.dev/api/sessions?userId=test-user&workspaceId=test-workspace"

# Test chat endpoint
curl "https://your-worker.your-subdomain.workers.dev/api/chat?userId=test-user&workspaceId=test-workspace&sessionId=test-session"
```

### 2. Test WebSocket Connection

Use the provided `test-chat.html` file to test WebSocket functionality:

1. Deploy your worker
2. Update the WebSocket URL in `test-chat.html` to point to your deployment
3. Open the HTML file in a browser
4. Test WebSocket connectivity and messaging

### 3. Run Automated Tests

```bash
# Update the test file with your worker URL
# Then run:
node test-chat-session.js
```

## 📊 Monitoring and Logging

### 1. Cloudflare Dashboard

Monitor your worker through the Cloudflare dashboard:
- Go to Workers & Pages
- Select your worker
- View metrics, logs, and analytics

### 2. Wrangler Tail

View real-time logs:

```bash
wrangler tail --format=pretty
```

Filter logs by level:

```bash
wrangler tail --level=error
wrangler tail --level=warn
```

### 3. Custom Metrics

The application includes built-in logging for:
- WebSocket connections and disconnections
- MCP function calls and responses
- Database operations
- Error tracking

## 🔄 Environment Management

### Development Environment

```bash
# Start development server
wrangler dev --env development

# Deploy to development environment
wrangler deploy --env development
```

### Production Environment

```bash
# Deploy to production
wrangler deploy --env production

# View production logs
wrangler tail --env production
```

### Custom Domains

To set up a custom domain:

```bash
# Add a custom domain
wrangler domains add your-domain.com

# Check domain status
wrangler domains list
```

## 🛠️ Troubleshooting

### Common Issues

#### 1. Durable Object Binding Errors
**Error**: `CHAT_SESSION binding not found`

**Solution**: Ensure your `wrangler.toml` has the correct Durable Objects configuration:
```toml
[[durable_objects.bindings]]
name = "CHAT_SESSION"
class_name = "ChatSession"
```

#### 2. Environment Variable Issues
**Error**: Missing environment variables

**Solution**: 
- Check that all required variables are set in `wrangler.toml` or via `wrangler secret put`
- Verify variable names match exactly (case-sensitive)
- For production, use `wrangler secret put` instead of `wrangler.toml`

#### 3. TypeScript Compilation Errors
**Error**: TypeScript compilation fails

**Solution**:
```bash
# Install TypeScript if not already installed
npm install -D typescript

# Check TypeScript version compatibility
npm list typescript

# Clean and reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

#### 4. Database Connection Issues
**Error**: Supabase connection failures

**Solution**:
- Verify Supabase URL and API key
- Check Supabase project settings and IP restrictions
- Ensure required tables exist in your database
- Test database connectivity separately

#### 5. WebSocket Connection Issues
**Error**: WebSocket connections failing

**Solution**:
- Check Cloudflare Workers logs for connection errors
- Verify userId and workspaceId parameters are provided
- Test with the provided HTML test file
- Check for CORS issues if connecting from a web page

### Performance Optimization

#### 1. Durable Object Optimization
- Keep object state minimal
- Use efficient data structures
- Implement proper cleanup routines
- Monitor memory usage

#### 2. Database Optimization
- Use appropriate indexes in Supabase
- Implement connection pooling if needed
- Monitor query performance
- Clean up old data periodically

#### 3. Network Optimization
- Use appropriate caching strategies
- Minimize external API calls
- Implement retry logic for external services
- Monitor response times

## 🔒 Security Considerations

### 1. Environment Variables
- Never commit sensitive data to version control
- Use `wrangler secret put` for production secrets
- Regularly rotate API keys and tokens
- Use environment-specific configurations

### 2. Input Validation
- The application includes basic input validation
- Consider adding additional validation for production
- Implement rate limiting if needed
- Monitor for suspicious activity

### 3. Database Security
- Use Supabase Row Level Security (RLS)
- Implement proper authentication
- Regularly backup your data
- Monitor database access patterns

## 📈 Scaling and Performance

### 1. Horizontal Scaling
Durable Objects automatically scale based on demand. Each object handles a specific user/workspace combination.

### 2. Vertical Scaling
Monitor resource usage and consider:
- Upgrading to a higher Workers tier
- Optimizing database queries
- Implementing caching strategies
- Reducing payload sizes

### 3. Monitoring Metrics
Track these metrics:
- Request count and duration
- Error rates
- Database query performance
- WebSocket connection count
- Memory usage per Durable Object

## 🚀 Advanced Configuration

### 1. Custom Domains and Routes

```toml
# wrangler.toml
[env.production]
routes = [
  { pattern = "your-domain.com/api/*", zone_name = "your-domain.com" },
  { pattern = "your-domain.com/*", zone_name = "your-domain.com" }
]
```

### 2. KV Storage for Caching

```toml
# wrangler.toml
[[kv_namespaces]]
binding = "CACHE_NAMESPACE"
id = "your-kv-namespace-id"

[env.production.kv_namespaces]
binding = "CACHE_NAMESPACE"
id = "your-production-kv-namespace-id"
```

### 3. Cron Triggers for Maintenance

```toml
# wrangler.toml
[triggers]
crons = ["0 2 * * *"] # Run daily at 2 AM
```

## 📝 Best Practices

### 1. Development
- Use local development with `wrangler dev`
- Test all endpoints before deployment
- Implement comprehensive logging
- Use environment-specific configurations

### 2. Deployment
- Deploy to staging environment first
- Use automated deployment pipelines
- Implement rollback procedures
- Monitor deployments closely

### 3. Monitoring
- Set up comprehensive logging
- Implement alerting for critical errors
- Regular performance reviews
- Capacity planning

### 4. Maintenance
- Regular dependency updates
- Database maintenance and optimization
- Security audits
- Performance tuning

## 🆘 Support and Resources

### Official Documentation
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Durable Objects Documentation](https://developers.cloudflare.com/workers/learning/using-durable-objects/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)

### Community Resources
- [Cloudflare Workers Discord](https://discord.cloudflare.com/)
- [Stack Overflow](https://stackoverflow.com/questions/tagged/cloudflare-workers)
- [GitHub Issues](https://github.com/cloudflare/workers-sdk/issues)

### Troubleshooting Commands
```bash
# Check Wrangler version
wrangler --version

# Check authentication status
wrangler whoami

# List all deployments
wrangler deployments list

# Delete a deployment
wrangler deployments delete <deployment-id>

# Get detailed worker information
wrangler tail --format=json
```

---

This deployment guide should help you successfully deploy and manage your ChatSession Durable Objects application on Cloudflare Workers. For additional support, refer to the official Cloudflare documentation or community resources.