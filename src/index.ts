import { ChatSession } from '../durable-objects/ChatSession';

// @ts-ignore - Cloudflare Workers types
export interface Env {
	CHAT_SESSION: any; // DurableObjectNamespace
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	OPENAI_API_KEY: string;
	MCP_SERVER_URL: string;
}

export default {
	// @ts-ignore - Cloudflare Workers types
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		console.log('🚀 Main fetch called:', url.pathname, url.searchParams.toString());

		// For now, return a simple response to test if our handler is being called
		if (url.pathname === '/test') {
			return new Response(JSON.stringify({
				message: 'Main handler is working',
				userId: url.searchParams.get('userId'),
				workspaceId: url.searchParams.get('workspaceId'),
				timestamp: new Date().toISOString()
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		// Extract userId and workspaceId from URL for Durable Object ID
		const userId = url.searchParams.get('userId');
		const workspaceId = url.searchParams.get('workspaceId');

		console.log('🔍 Extracted params:', { userId, workspaceId });

		if (!userId || !workspaceId) {
			console.log('❌ Missing required parameters');
			return new Response(JSON.stringify({
				error: 'Missing userId or workspaceId',
				received: Object.fromEntries(url.searchParams.entries())
			}), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		try {
			// Check if CHAT_SESSION binding exists
			if (!env.CHAT_SESSION) {
				console.error('❌ CHAT_SESSION binding not found');
				return new Response(JSON.stringify({
					error: 'CHAT_SESSION binding not configured',
					availableBindings: Object.keys(env)
				}), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				});
			}

			console.log('✅ CHAT_SESSION binding found');

			// Create a unique Durable Object ID based on user and workspace
			const id = env.CHAT_SESSION.idFromName(`${userId}-${workspaceId}`);
			console.log('🆔 Created Durable Object ID');

			// Get the Durable Object stub
			const stub = env.CHAT_SESSION.get(id);
			console.log('🎯 Got Durable Object stub');

			// Forward the request to the Durable Object
			console.log('📨 Forwarding to Durable Object');
			const response = await stub.fetch(request);
			console.log('✅ Durable Object responded');
			return response;
		} catch (error) {
			console.error('💥 Error in main fetch:', error);
			return new Response(JSON.stringify({
				error: 'Internal server error',
				message: error.message,
				stack: error.stack
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	},
};

// Export the Durable Object class
export { ChatSession };