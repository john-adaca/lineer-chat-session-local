// @ts-ignore - Cloudflare Workers types
import { DurableObject, DurableObjectStorage, DurableObjectState } from 'cloudflare:workers';
import type {
	WebSocketMessage,
	ChatMessage,
	ChatSession as IChatSession,
	AIStreamChunk,
} from '../types';
import { SessionMetadataManager } from './services/SessionMetadataManager';

// MCP Context Management Types
interface MCPEntityContext {
	contacts: Array<{ id: string; name: string; email: string; metadata?: any }>;
	emails: Array<{ id: string; subject: string; status: string; metadata?: any }>;
	meetings: Array<{ id: string; title: string; status: string; metadata?: any }>;
	lastUpdated: number;
}

// Enhanced User Context Types
interface UserPreferences {
	communicationStyle: 'formal' | 'casual' | 'friendly' | 'professional';
	responseLength: 'brief' | 'detailed' | 'comprehensive';
	defaultTimezone: string;
	workingHours: { start: string; end: string };
	preferredMeetingDuration: number;
	emailSignature: string;
	notificationPreferences: string[];
}

interface ConversationContext {
	userGoals: string[];
	currentTasks: string[];
	mentionedPreferences: Record<string, any>;
	emotionalTone: 'neutral' | 'positive' | 'frustrated' | 'excited' | 'urgent';
	conversationFlow: string[];
	lastUserIntent: string;
	pendingActions: string[];
}

interface MCPCacheEntry {
	data: any;
	expiry: number;
	actionType: string;
}

interface MCPStatusUpdate {
	status: 'thinking' | 'analyzing' | 'calling_tool' | 'processing_results' | 'completing';
	action?: string;
	details?: string;
}

interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	OPENAI_API_KEY: string;
	MCP_SERVER_URL: string;
}

export class ChatSession extends DurableObject {
	private state: DurableObjectState;
	private sessions: Map<string, IChatSession> = new Map();
	private activeConnections: Map<string, WebSocket> = new Map();
	private aiStreamController: ReadableStreamDefaultController | null = null;
	private isStreaming = false;
	private currentStreamAbortController: AbortController | null = null;
	private workspaceId: string | null = null;
	private currentUserId: string | null = null;
	private supabaseEnabled: boolean = false;
	private env: Env;
	private metadataManager: SessionMetadataManager;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.state = state;
		this.env = env;
		this.metadataManager = new SessionMetadataManager(env);

		// Initialize storage immediately
		console.log('🏗️ ChatSession constructor called');
		console.log('🏗️ Storage available:', !!state.storage);
		console.log('🏗️ State available:', !!state);

		// Initialize storage and other components
		this.initializeStorage().catch((error) => {
			console.error('❌ Failed to initialize storage in constructor:', error);
		});
	}

	// Performance optimizations - Global MCP cache shared across all sessions
	private static globalMCPCapabilitiesCache: any = null;
	private static globalMCPCacheExpiry: number = 0;
	private readonly MCP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours - MCP capabilities rarely change
	private readonly MCP_MEMORY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes for memory-only mode
	private messageBuffer: Map<string, any[]> = new Map();
	private batchSaveTimeout: Map<string, number> = new Map();
	private readonly BATCH_SAVE_DELAY = 2000; // 2 seconds

	// MCP Context Management
	private sessionEntities = new Map<string, MCPEntityContext>();
	private mcpResponseCache = new Map<string, MCPCacheEntry>();

	// Enhanced Context Management
	private userPreferences = new Map<string, UserPreferences>();
	private conversationContexts = new Map<string, ConversationContext>();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		console.log('📨 ChatSession fetch called:', url.pathname);

		// Extract user ID and workspace ID from URL parameters - REQUIRED
		const userId = url.searchParams.get('userId');
		const workspaceId = url.searchParams.get('workspaceId');

		// Validate required parameters
		if (!userId) {
			console.error('❌ User ID is required but not provided');
			return new Response('User ID is required', { status: 400 });
		}

		if (!workspaceId) {
			console.error('❌ Workspace ID is required but not provided');
			return new Response('Workspace ID is required', { status: 400 });
		}

		// Store the required IDs
		this.currentUserId = userId;
		this.workspaceId = workspaceId;
		console.log('✅ Required parameters validated:', { userId, workspaceId });

		// Check if this is a WebSocket upgrade request
		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader === 'websocket') {
			return this.handleWebSocket(request);
		}

		if (url.pathname === '/api/chat') {
			return this.handleChatRequest(request);
		}

		if (url.pathname === '/api/sessions') {
			return this.handleSessionsRequest();
		}

		if (url.pathname === '/api/actions') {
			return this.handleActionsRequest();
		}

		return new Response('Not found', { status: 404 });
	}

	// ==================== WEBSOCKET HANDLING ====================

	private async handleWebSocket(request: Request): Promise<Response> {
		console.log('🔌 Setting up WebSocket connection');
		// @ts-ignore - Cloudflare Workers WebSocketPair
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket];

		(server as any).accept();
		console.log('🔌 WebSocket server accepted');

		// Store connection with user/workspace context
		const connectionId = `${this.currentUserId}-${this.workspaceId}-${Date.now()}`;
		this.activeConnections.set(connectionId, server);
		console.log('✅ WebSocket connection stored:', {
			connectionId,
			userId: this.currentUserId,
			workspaceId: this.workspaceId,
		});

		this.setupWebSocketHandlers(server, connectionId);

		return new Response(null, {
			status: 101,
			webSocket: client,
		} as any);
	}

	private setupWebSocketHandlers(webSocket: WebSocket, connectionId: string): void {
		console.log('🔌 Setting up WebSocket event handlers for connection:', connectionId);

		webSocket.addEventListener('message', async (event) => {
			try {
				console.log('📨 WebSocket message received on server:', event.data);
				const message: WebSocketMessage = JSON.parse(event.data);
				await this.handleWebSocketMessage(webSocket, message);
			} catch (error) {
				console.error('Error handling WebSocket message:', error);
				this.sendError(webSocket, 'Invalid message format');
			}
		});

		webSocket.addEventListener('close', (event) => {
			console.log('🔌 WebSocket closed on server:', event.code, event.reason);
			this.cleanupConnection(webSocket, connectionId);
		});

		webSocket.addEventListener('error', (error) => {
			console.log('❌ WebSocket error on server:', error);
			this.cleanupConnection(webSocket, connectionId);
		});
	}

	private async handleWebSocketMessage(
		webSocket: WebSocket,
		message: WebSocketMessage,
	): Promise<void> {
		const { type, content, data, messageId, sessionId, supabaseSessionId } = message;

		// Type assertion for enhanced message types
		const messageType = type as WebSocketMessage['type'];

		switch (messageType) {
			case 'message':
				if (content && sessionId) {
					await this.handleUserMessage(webSocket, content, sessionId, messageId, supabaseSessionId);
				}
				break;

			case 'interrupt':
				this.handleInterrupt();
				break;

			case 'status':
				this.sendStatus(webSocket, 'Connected to chat session');
				break;

			case 'set_preference':
				if (data && sessionId) {
					await this.handleSetUserPreference(sessionId, data);
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'Preference updated successfully',
						messageId: messageId || '',
					});
				}
				break;

			case 'set_personality':
				if (data && sessionId) {
					await this.handleSetSessionPersonality(sessionId, data.personality);
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'AI personality updated for this session',
						messageId: messageId || '',
					});
				}
				break;

			case 'set_user_context':
				if (data && sessionId) {
					await this.handleSetUserContext(sessionId, data);
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'User context updated successfully',
						messageId: messageId || '',
					});
				}
				break;

			case 'get_context':
				if (sessionId) {
					const contextData = this.getSessionContextData(sessionId);
					this.sendMessage(webSocket, {
						type: 'context_data',
						content: JSON.stringify(contextData),
						data: contextData,
						messageId: messageId || '',
					});
				}
				break;

			case 'test_mcp_cache':
				await this.testMCPCache(webSocket, messageId);
				break;

			case 'accumulate_mcp_response':
				if (data && sessionId) {
					await this.accumulateMCPResponse(
						sessionId,
						data.action,
						data.parameters,
						data.result,
						data.success,
						data.error
					);
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'MCP response accumulated successfully',
						messageId: messageId || '',
					});
				}
				break;

			case 'get_session_summary':
				if (sessionId) {
					const summary = this.getSessionSummary(sessionId);
					this.sendMessage(webSocket, {
						type: 'session_summary',
						content: JSON.stringify(summary),
						data: summary,
						messageId: messageId || '',
					});
				}
				break;
		}
	}

	// ==================== WEBSOCKET UTILITY METHODS ====================

	private sendMessage(webSocket: WebSocket, message: WebSocketMessage): void {
		if (webSocket.readyState === WebSocket.OPEN) {
			webSocket.send(JSON.stringify(message));
		}
	}

	private sendError(webSocket: WebSocket, error: string): void {
		this.sendMessage(webSocket, {
			type: 'error',
			content: error,
		});
	}

	private sendStatus(webSocket: WebSocket, status: string): void {
		this.sendMessage(webSocket, {
			type: 'status',
			content: status,
		});
	}

	private broadcast(message: WebSocketMessage): void {
		this.activeConnections.forEach((webSocket) => {
			this.sendMessage(webSocket, message);
		});
	}

	private cleanupConnection(webSocket: WebSocket, connectionId?: string): void {
		// Remove from active connections
		if (connectionId) {
			this.activeConnections.delete(connectionId);
			console.log('🧹 Cleaned up connection:', connectionId);
		} else {
			// Fallback: find by WebSocket reference
			for (const [id, ws] of this.activeConnections.entries()) {
				if (ws === webSocket) {
					this.activeConnections.delete(id);
					console.log('🧹 Cleaned up connection by reference:', id);
					break;
				}
			}
		}
	}

	private getSessionIdFromWebSocket(webSocket: WebSocket): string | null {
		// Find the session ID associated with this WebSocket connection
		console.log(
			'🔍 Looking for WebSocket in connections. Total connections:',
			this.activeConnections.size,
		);
		for (const [id, ws] of this.activeConnections.entries()) {
			console.log('🔍 Checking connection:', id, ws === webSocket ? '✅ MATCH' : '❌ no match');
			if (ws === webSocket) {
				return id;
			}
		}
		return null;
	}

	// ==================== PLACEHOLDER METHODS ====================
	// These methods will be implemented in subsequent migrations

	private async initializeStorage(): Promise<void> {
		try {
			console.log('📦 Initializing storage...');

			// Load existing sessions from storage
			const storedSessions = await this.state.storage.get('sessions');
			if (storedSessions) {
				this.sessions = new Map(Object.entries(storedSessions));
				console.log(`📦 Loaded ${this.sessions.size} sessions from storage`);
			}

			// Load user preferences
			const storedPreferences = await this.state.storage.get('userPreferences');
			if (storedPreferences) {
				this.userPreferences = new Map(Object.entries(storedPreferences));
			}

			// Load conversation contexts
			const storedContexts = await this.state.storage.get('conversationContexts');
			if (storedContexts) {
				this.conversationContexts = new Map(Object.entries(storedContexts));
			}

			// Load global MCP cache from storage
			const storedMCPCache = await this.state.storage.get('globalMCPCache');
			if (storedMCPCache && storedMCPCache.capabilities && storedMCPCache.expiry) {
				const now = Date.now();
				if (now < storedMCPCache.expiry) {
					ChatSession.globalMCPCapabilitiesCache = storedMCPCache.capabilities;
					ChatSession.globalMCPCacheExpiry = storedMCPCache.expiry;
					console.log('📦 Loaded MCP cache from storage');
				} else {
					console.log('🗑️ MCP cache expired, will fetch fresh data');
				}
			}

			console.log('✅ Storage initialization completed');
		} catch (error) {
			console.error('❌ Failed to initialize storage:', error);
		}
	}

	private async handleChatRequest(request: Request): Promise<Response> {
		try {
			const method = request.method;
			const url = new URL(request.url);

			switch (method) {
				case 'GET':
					// Return chat history for a session
					const sessionId = url.searchParams.get('sessionId');
					if (!sessionId) {
						return new Response('Session ID required', { status: 400 });
					}

					const session = this.sessions.get(sessionId);
					if (!session) {
						return new Response('Session not found', { status: 404 });
					}

					return new Response(JSON.stringify({
						sessionId: session.id,
						messages: session.messages,
						isActive: session.isActive,
						lastActivity: session.lastActivity,
					}), {
						headers: { 'Content-Type': 'application/json' },
					});

				case 'POST':
					// Handle new chat message via HTTP
					const body = await request.json();
					const { content, sessionId: postSessionId } = body;

					if (!content || !postSessionId) {
						return new Response('Content and sessionId required', { status: 400 });
					}

					// This would need WebSocket context, so return not supported for now
					return new Response('Use WebSocket for chat messages', { status: 400 });

				default:
					return new Response('Method not allowed', { status: 405 });
			}
		} catch (error) {
			console.error('Error handling chat request:', error);
			return new Response('Internal server error', { status: 500 });
		}
	}

	private async handleSessionsRequest(): Promise<Response> {
		try {
			const sessions = Array.from(this.sessions.values()).map(session => ({
				id: session.id,
				supabaseSessionId: session.supabaseSessionId,
				userId: session.userId,
				workspaceId: session.workspaceId,
				messageCount: session.messages.length,
				actionCount: session.actions.length,
				isActive: session.isActive,
				createdAt: session.createdAt,
				lastActivity: session.lastActivity,
			}));

			return new Response(JSON.stringify({
				totalSessions: sessions.length,
				activeSessions: sessions.filter(s => s.isActive).length,
				sessions: sessions,
			}), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			console.error('Error handling sessions request:', error);
			return new Response('Internal server error', { status: 500 });
		}
	}

	private async handleActionsRequest(): Promise<Response> {
		try {
			const allActions: any[] = [];

			// Collect actions from all sessions
			for (const session of this.sessions.values()) {
				allActions.push(...session.actions.map(action => ({
					...action,
					sessionId: session.id,
				})));
			}

			// Sort by timestamp (most recent first)
			allActions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

			return new Response(JSON.stringify({
				totalActions: allActions.length,
				actions: allActions.slice(0, 100), // Limit to last 100 actions
			}), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			console.error('Error handling actions request:', error);
			return new Response('Internal server error', { status: 500 });
		}
	}

	private async handleUserMessage(
		webSocket: WebSocket,
		content: string,
		sessionId: string,
		messageId?: string,
		supabaseSessionId?: string,
	): Promise<void> {
		console.log('📝 Handling user message:', { content, sessionId, messageId });

		try {
			// Create user message
			const userMessage: ChatMessage = {
				id: messageId || `user-${Date.now()}`,
				role: 'user',
				content: content,
				timestamp: new Date(),
			};

			// Get or create session with proper duplicate prevention
			let session = this.sessions.get(sessionId);
			if (!session) {
				// First, check if we already have a session with this supabaseSessionId to prevent duplicates
				if (supabaseSessionId) {
					for (const [existingSessionId, existingSession] of this.sessions.entries()) {
						if (existingSession.supabaseSessionId === supabaseSessionId) {
							console.log('🔍 Found existing session with same supabaseSessionId:', {
								existingSessionId,
								requestedSessionId: sessionId,
								supabaseSessionId,
							});
							// Update the session map to use the new sessionId
							this.sessions.delete(existingSessionId);
							this.sessions.set(sessionId, existingSession);
							session = existingSession;
							session.id = sessionId; // Update the session ID
							break;
						}
					}
				}

				// Only create a new session if we didn't find an existing one
				if (!session) {
					// Create base session
					const baseSession = {
						id: sessionId,
						supabaseSessionId: supabaseSessionId || sessionId, // Use sessionId if no supabaseSessionId provided
						userId: this.currentUserId!, // Now guaranteed to be set
						workspaceId: this.workspaceId!, // Now guaranteed to be set
						messages: [],
						actions: [],
						isActive: true,
						createdAt: new Date(),
						lastActivity: new Date()
					};

					// Initialize with database data (metadata + existing messages)
					session = await this.metadataManager.initializeSession(sessionId, baseSession);
					this.sessions.set(sessionId, session);

					// If this is a completely new session (no existing data), save it
					if (supabaseSessionId && !session.metadata?.mcpResponses?.length) {
						await this.metadataManager.saveSession(session);
					}

					console.log('✅ Created/loaded session:', {
						sessionId,
						userId: this.currentUserId,
						workspaceId: this.workspaceId,
						supabaseSessionId,
						hasExistingMessages: session.messages.length > 0,
						hasExistingMetadata: !!session.metadata?.mcpResponses?.length
					});
				} else {
					console.log('♻️ Reusing existing session:', {
						sessionId,
						supabaseSessionId,
						existingMessages: session.messages.length
					});
				}
			}

			// Add user message to session
			session.messages.push(userMessage);
			session.lastActivity = new Date();

			// Save message to database if we have a supabase session
			if (session.supabaseSessionId) {
				await this.metadataManager.saveChatMessage(session.id, userMessage, session.userId, session.workspaceId);
			}

			// Send confirmation
			this.sendMessage(webSocket, {
				type: 'status',
				content: 'Message received, processing...',
				messageId: userMessage.id,
			});

			// Start streaming response
			await this.streamResponse(webSocket, session, userMessage);
		} catch (error) {
			console.error('Error handling user message:', error);
			this.sendError(webSocket, 'Failed to process message');
		}
	}

	private async handleSetUserPreference(sessionId: string, data: any): Promise<void> {
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				console.warn('Session not found for preference update:', sessionId);
				return;
			}

			// Store user preferences
			this.userPreferences.set(session.userId, {
				communicationStyle: data.communicationStyle || 'professional',
				responseLength: data.responseLength || 'detailed',
				defaultTimezone: data.defaultTimezone || 'UTC',
				workingHours: data.workingHours || { start: '09:00', end: '17:00' },
				preferredMeetingDuration: data.preferredMeetingDuration || 60,
				emailSignature: data.emailSignature || '',
				notificationPreferences: data.notificationPreferences || [],
			});

			// Update session with preference data
			session.context = session.context || {};
			session.context.preferences = data;

			console.log('✅ User preferences updated for session:', sessionId);
		} catch (error) {
			console.error('Error setting user preferences:', error);
		}
	}

	private async handleSetSessionPersonality(sessionId: string, personality: any): Promise<void> {
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				console.warn('Session not found for personality update:', sessionId);
				return;
			}

			// Update session personality
			session.personality = {
				id: personality.id || 'default',
				name: personality.name || 'Default Assistant',
				description: personality.description || 'A helpful AI assistant',
				systemPrompt: personality.systemPrompt || 'You are a helpful AI assistant.',
				createdAt: new Date(),
			};

			console.log('✅ Session personality updated for session:', sessionId);
		} catch (error) {
			console.error('Error setting session personality:', error);
		}
	}

	private async handleSetUserContext(sessionId: string, data: any): Promise<void> {
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				console.warn('Session not found for context update:', sessionId);
				return;
			}

			// Store conversation context
			this.conversationContexts.set(sessionId, {
				userGoals: data.userGoals || [],
				currentTasks: data.currentTasks || [],
				mentionedPreferences: data.mentionedPreferences || {},
				emotionalTone: data.emotionalTone || 'neutral',
				conversationFlow: data.conversationFlow || [],
				lastUserIntent: data.lastUserIntent || '',
				pendingActions: data.pendingActions || [],
			});

			// Update session context
			session.context = session.context || {};
			session.context.conversation = data;

			console.log('✅ User context updated for session:', sessionId);
		} catch (error) {
			console.error('Error setting user context:', error);
		}
	}

	private getSessionContextData(sessionId: string): any {
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				console.warn('Session not found for context retrieval:', sessionId);
				return {};
			}

			const preferences = this.userPreferences.get(session.userId);
			const conversationContext = this.conversationContexts.get(sessionId);

			return {
				sessionId: session.id,
				userId: session.userId,
				workspaceId: session.workspaceId,
				preferences: preferences || null,
				conversationContext: conversationContext || null,
				personality: session.personality || null,
				messageCount: session.messages.length,
				lastActivity: session.lastActivity,
				isActive: session.isActive,
			};
		} catch (error) {
			console.error('Error retrieving session context data:', error);
			return {};
		}
	}

	// ==================== STREAMING FUNCTIONALITY ====================

	private async streamResponse(
		webSocket: WebSocket,
		session: IChatSession,
		userMessage: ChatMessage,
	): Promise<void> {
		console.log('🌊 Starting streaming response for message:', userMessage.id);

		// Create AI message placeholder
		const aiMessage: ChatMessage = {
			id: `ai-${Date.now()}`,
			role: 'assistant',
			content: '',
			timestamp: new Date(),
		};

		// Add AI message to session
		session.messages.push(aiMessage);

		// Send initial thinking status
		this.sendStreamingChunk(webSocket, {
			type: 'thinking',
			messageId: aiMessage.id,
		});

		// Simulate streaming response (replace with actual AI later)
		await this.simulateStreamingResponse(webSocket, aiMessage, userMessage.content);

		// Mark streaming as complete
		this.sendStreamingChunk(webSocket, {
			type: 'done',
			messageId: aiMessage.id,
		});

		// Save AI message to database AFTER content is fully built
		if (session.supabaseSessionId) {
			console.log('💾 Saving complete AI response to database:', {
				messageId: aiMessage.id,
				contentLength: aiMessage.content.length,
				contentPreview: aiMessage.content.substring(0, 100) + '...'
			});
			await this.metadataManager.saveChatMessage(session.id, aiMessage, session.userId, session.workspaceId);
		}

		console.log('✅ Streaming response completed for message:', aiMessage.id);
	}

	private async simulateStreamingResponse(
		webSocket: WebSocket,
		aiMessage: ChatMessage,
		userContent: string,
	): Promise<void> {
		// Simple response simulation - replace with actual AI later
		const responses = [
			'I understand you said: "',
			userContent,
			'"\n\n',
			'This is a simulated streaming response. ',
			'In the future, this will be replaced with actual AI responses. ',
			'The streaming functionality is working correctly! ',
			'Each chunk is being sent individually to create a smooth typing effect. ',
			'Thank you for testing the chat system!',
		];

		for (let i = 0; i < responses.length; i++) {
			// Add delay between chunks for realistic streaming effect
			await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));

			const chunk = responses[i];
			aiMessage.content += chunk;

			// Send content chunk
			this.sendStreamingChunk(webSocket, {
				type: 'content',
				content: chunk || '',
				messageId: aiMessage.id,
			});
		}
	}

	private sendStreamingChunk(webSocket: WebSocket, chunk: AIStreamChunk): void {
		if (webSocket.readyState === WebSocket.OPEN) {
			webSocket.send(JSON.stringify(chunk));
			console.log(
				'📤 Sent streaming chunk:',
				chunk.type,
				chunk.content ? `"${chunk.content.substring(0, 50)}..."` : '',
			);
		}
	}

	private handleInterrupt(): void {
		console.log('⏹️ Interrupt received - stopping current stream');
		this.isStreaming = false;

		if (this.currentStreamAbortController) {
			this.currentStreamAbortController.abort();
			this.currentStreamAbortController = null;
		}
	}

	/**
	 * Accumulate MCP response in session metadata
	 */
	async accumulateMCPResponse(sessionId: string, action: string, parameters: any, result: any, success: boolean, error?: string): Promise<void> {
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				console.warn('Session not found for MCP response accumulation:', sessionId);
				return;
			}

			await this.metadataManager.addMCPResponse(session, action, parameters, result, success, error);

			console.log('✅ MCP response accumulated for session:', sessionId);
		} catch (error) {
			console.error('❌ Failed to accumulate MCP response:', error);
		}
	}

	/**
	 * Get accumulated context for AI prompt
	 */
	getAccumulatedContext(sessionId: string): string {
		const session = this.sessions.get(sessionId);
		if (!session) return '';

		return this.metadataManager.getAccumulatedContext(session);
	}

	/**
	 * Get session summary with metadata
	 */
	getSessionSummary(sessionId: string): any {
		const session = this.sessions.get(sessionId);
		if (!session) return null;

		return this.metadataManager.getSessionSummary(session);
	}

	private async testMCPCache(webSocket: WebSocket, messageId?: string): Promise<void> {
		try {
			console.log('🧪 Testing MCP global cache...');

			const now = Date.now();

			// Check if we have cached capabilities
			if (ChatSession.globalMCPCapabilitiesCache && now < ChatSession.globalMCPCacheExpiry) {
				console.log('✅ Using cached MCP capabilities');
				this.sendMessage(webSocket, {
					type: 'status',
					content: `Using cached MCP capabilities (expires in ${Math.round((ChatSession.globalMCPCacheExpiry - now) / 1000)}s)`,
					data: {
						cacheHit: true,
						capabilities: ChatSession.globalMCPCapabilitiesCache,
						expiry: ChatSession.globalMCPCacheExpiry,
						ttl: this.MCP_CACHE_TTL
					},
					messageId: messageId || '',
				});
				return;
			}

			// Simulate fetching MCP capabilities (replace with real API call)
			console.log('🔄 Fetching fresh MCP capabilities...');
			const mockCapabilities = {
				resources: [
					{
						name: 'calendar',
						description: 'Comprehensive calendar and meeting management system for scheduling, organizing, and managing all types of events and meetings.',
						capabilities: [
							{
								name: 'meetings',
								description: 'Complete meeting and calendar event lifecycle management - create, update, send invites, list, cancel, and manage all calendar events and meetings.',
								actions: [
									'meeting_draft_meeting',
									'meeting_update_draft',
									'meeting_send_invite',
									'meeting_list_meetings',
									'meeting_cancel_meeting',
									'meeting_invite_to_existing'
								]
							}
						]
					},
					{
						name: 'email',
						description: 'Workspace email system with drafting, sending, reading, and archiving.',
						capabilities: [
							{
								name: 'compose',
								description: 'Draft and send emails.',
								actions: [
									'email_draft_email',
									'email_send_email'
								]
							},
							{
								name: 'manage',
								description: 'Read, archive, and delete emails.',
								actions: [
									'email_read_email',
									'email_archive_email',
									'email_delete_email'
								]
							}
						]
					},
					{
						name: 'contacts',
						description: 'Workspace contact management system.',
						capabilities: [
							{
								name: 'search',
								description: 'Search and retrieve contacts.',
								actions: [
									'contacts_search',
									'contacts_get_recent',
									'contacts_get_by_company',
									'contacts_get_all'
								]
							}
						]
					},
					{
						name: 'tasks',
						description: 'Workspace task management system.',
						capabilities: [
							{
								name: 'manage',
								description: 'Create, update, and delete tasks.',
								actions: [
									'tasks_get_tasks',
									'tasks_get_overdue',
									'tasks_get_today',
									'tasks_create',
									'tasks_update',
									'tasks_delete',
									'tasks_get_summary'
								]
							}
						]
					},
					{
						name: 'activities',
						description: 'Workspace activity tracking and analytics.',
						capabilities: [
							{
								name: 'track',
								description: 'Track and analyze workspace activities.',
								actions: [
									'activities_get_feed',
									'activities_get_analytics'
								]
							}
						]
					},
					{
						name: 'queue',
						description: 'Background job queue system.',
						capabilities: [
							{
								name: 'manage',
								description: 'Queue and manage background jobs.',
								actions: [
									'queue_add_job',
									'queue_get_status',
									'queue_cancel_job'
								]
							}
						]
					}
				],
				actions: [
					// Calendar actions
					{ name: 'calendar_draft_event', description: 'Draft a calendar event/meeting' },
					{ name: 'calendar_update_draft', description: 'Update a drafted calendar event' },
					{ name: 'calendar_send_event', description: 'Send a drafted calendar event' },
					{ name: 'calendar_list_events', description: 'List calendar events/meetings' },
					{ name: 'calendar_cancel_event', description: 'Cancel a calendar event' },
					{ name: 'calendar_add_attendees', description: 'Add attendees to existing event' },

					// Email actions
					{ name: 'email_draft_email', description: 'Draft a new email message' },
					{ name: 'email_update_draft', description: 'Update an existing email draft' },
					{ name: 'email_send_email', description: 'Send a drafted email message' },
					{ name: 'email_read_email', description: 'Read email messages from inbox' },
					{ name: 'email_archive_email', description: 'Archive email messages' },
					{ name: 'email_delete_email', description: 'Delete email messages permanently' },

					// Contacts actions
					{ name: 'contacts_search', description: 'Search for contacts in workspace' },
					{ name: 'contacts_get_recent', description: 'Get recently added/updated contacts' },
					{ name: 'contacts_get_by_company', description: 'Get contacts filtered by company' },
					{ name: 'contacts_get_all', description: 'Get all contacts in workspace' },

					// Tasks actions
					{ name: 'tasks_get_tasks', description: 'Get workspace tasks' },
					{ name: 'tasks_get_overdue', description: 'Get overdue tasks' },
					{ name: 'tasks_get_today', description: 'Get today\'s tasks' },
					{ name: 'tasks_create', description: 'Create a new task' },
					{ name: 'tasks_update', description: 'Update an existing task' },
					{ name: 'tasks_delete', description: 'Delete a task' },
					{ name: 'tasks_get_summary', description: 'Get task summary' },

					// Activities actions
					{ name: 'activities_get_feed', description: 'Get activity feed' },
					{ name: 'activities_get_analytics', description: 'Get activity analytics' },

					// Queue actions
					{ name: 'queue_add_job', description: 'Add background job to queue' },
					{ name: 'queue_get_status', description: 'Get job status' },
					{ name: 'queue_cancel_job', description: 'Cancel background job' }
				],
				prompts: [
					{ name: 'email_draft', description: 'Help draft emails' },
					{ name: 'meeting_summary', description: 'Summarize meetings' },
					{ name: 'contact_search', description: 'Help search contacts' },
					{ name: 'task_management', description: 'Help manage tasks' },
					{ name: 'calendar_scheduling', description: 'Help schedule meetings' }
				],
				fetchedAt: new Date().toISOString(),
				cacheKey: `mcp-${Date.now()}`,
				version: '1.0.0',
				totalResources: 6,
				totalActions: 23,
				totalPrompts: 5
			};

			// Cache globally
			ChatSession.globalMCPCapabilitiesCache = mockCapabilities;
			const cacheTTL = this.state ? this.MCP_CACHE_TTL : this.MCP_MEMORY_CACHE_TTL;
			ChatSession.globalMCPCacheExpiry = now + cacheTTL;

			// Persist to storage if available
			if (this.state) {
				await this.saveGlobalMCPCacheToStorage(mockCapabilities, ChatSession.globalMCPCacheExpiry);
			}

			console.log('✅ Fresh MCP capabilities fetched and cached');
			this.sendMessage(webSocket, {
				type: 'status',
				content: `Fresh MCP capabilities fetched and cached for ${Math.round(cacheTTL / 1000)}s`,
				data: {
					cacheHit: false,
					capabilities: mockCapabilities,
					expiry: ChatSession.globalMCPCacheExpiry,
					ttl: cacheTTL,
					persisted: !!this.state
				},
				messageId: messageId || '',
			});

		} catch (error) {
			console.error('❌ Error testing MCP cache:', error);
			this.sendError(webSocket, 'Failed to test MCP cache');
		}
	}

	private async saveGlobalMCPCacheToStorage(capabilities: any, expiry: number): Promise<void> {
		if (!this.state) return;

		try {
			await this.state.storage.put('globalMCPCache', {
				capabilities,
				expiry,
				savedAt: new Date().toISOString()
			});
			console.log('💾 Global MCP cache saved to storage');
		} catch (error) {
			console.error('❌ Failed to save MCP cache to storage:', error);
		}
	}
}
