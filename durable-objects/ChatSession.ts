// @ts-ignore - Cloudflare Workers types
import { DurableObject, DurableObjectStorage, DurableObjectState } from 'cloudflare:workers';
import type {
	WebSocketMessage,
	ChatMessage,
	ChatSession as IChatSession,
	AIStreamChunk,
	MCPResponse,
} from '../types';
import { SessionMetadataManager } from './services/SessionMetadataManager';
import { MCPClient } from './services/MCPClient';
import { MCPActionParser } from './services/MCPActionParser';

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
	private mcpClient: MCPClient;
	private mcpActionParser: MCPActionParser;
	private aiSummarizer: any;

	// Dynamic MCP function caching
	private static mcpFunctionsCache: any[] | null = null;
	private static mcpFunctionsCacheExpiry: number = 0;
	private readonly MCP_FUNCTIONS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.state = state;
		this.env = env;
		this.metadataManager = new SessionMetadataManager(env);

		// Initialize MCP services
		this.mcpClient = new MCPClient(env.MCP_SERVER_URL);
		this.mcpActionParser = new MCPActionParser(this.mcpClient);
		this.aiSummarizer = null; // Will be initialized when AI service is available

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
			allActions.sort((a, b) => {
				const aTime = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
				const bTime = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
				return bTime - aTime;
			});

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
		await this.simulateStreamingResponse(webSocket, aiMessage, userMessage.content, session);

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
		session?: IChatSession,
	): Promise<void> {
		try {
			// Get accumulated context to make AI smarter
			let accumulatedContext = '';
			if (session) {
				accumulatedContext = this.getAccumulatedContext(session.id);
				console.log('🧠 Context being sent to AI:', {
					hasContext: !!accumulatedContext,
					contextLength: accumulatedContext.length,
					contextPreview: accumulatedContext.substring(0, 200) + '...'
				});
			}

			// Build AI prompt with context
			const systemPrompt = this.buildAIPrompt(accumulatedContext, session);

			// Call OpenAI API with function calling (handles MCP actions internally)
			const aiResponse = await this.callOpenAI(systemPrompt, userContent, session);

			// Stream the response
			await this.streamOpenAIResponse(webSocket, aiMessage, aiResponse);

		} catch (error) {
			console.error('❌ Error in AI response:', error);
			// Fallback to basic response
			const fallbackResponse = `I understand you said: "${userContent}"\n\nI'm currently experiencing some technical difficulties, but I'm here to help! Could you please try again in a moment?`;
			aiMessage.content = fallbackResponse;

			this.sendStreamingChunk(webSocket, {
				type: 'content',
				content: fallbackResponse,
				messageId: aiMessage.id,
			});
		}
	}

	private buildAIPrompt(accumulatedContext: string, session?: IChatSession): string {
		let prompt = `You are a helpful AI assistant with access to workspace tools and context.

You can perform various actions using MCP (Model Context Protocol) tools. The available functions are provided to you as structured function definitions that you can call directly.

IMPORTANT: Use the provided context to give direct, specific answers. When users use pronouns like "him", "her", "it", or "that", refer to the most recent relevant item from the context.

🚨 STOP! READ THIS FIRST: Before calling ANY MCP function, check if you already have the data in the EXISTING CONTACTS/MEETINGS/EMAILS sections below. If you find a match, USE IT instead of searching!

🚨 CRITICAL DECISION RULES:
- BEFORE searching for contacts, check if you already have relevant contacts in the EXISTING CONTACTS section
- Use FUZZY MATCHING: "john" matches "John Lester", "jane" matches "Jane Smith", etc.
- Use PARTIAL MATCHING: "john lester" matches "John Lester", "jane smith" matches "Jane Smith"
- Use CASE-INSENSITIVE matching: "JOHN" matches "John Lester"
- ONLY search for NEW contacts if you cannot find a reasonable match in existing contacts
- If you find a match (even partial), USE THE EXISTING CONTACT instead of searching
- When user says "find john" and you have "John Lester", USE "John Lester"
- When user says "search john lester" and you have "John Lester", USE "John Lester"
- Only call search_contacts if you need to find someone completely new or different

FUNCTION CALLS:
When you need to perform an action, call the appropriate function with the correct parameters. The system will execute the function and return the results for you to analyze and respond to the user.

FUNCTION ERROR HANDLING:
If a function call fails, the system will return error details. Common error types:
- "resource_not_found": The requested item doesn't exist
- "permission_denied": User lacks required permissions
- "validation_error": Invalid parameters provided
- "conflict_error": Item already exists or is in use
- "rate_limit_error": Too many requests recently
- "server_error": Backend system issues
- "timeout_error": Request took too long
- "network_error": Connectivity problems

When functions fail, explain the issue clearly to the user and suggest appropriate alternatives based on the error type and available context data.

You have access to CONTEXT FROM PREVIOUS INTERACTIONS: -- this is where you can get the history of MCP responses

CRITICAL: When you see email IDs in the context (like "ID: 6a8e247b-aeb5-4c35-a1aa-2c500e0cbe90"), you MUST use these EXACT IDs when calling email functions. Never use placeholder values like "uuid" or "email_id".

FOR EMAIL OPERATIONS:
- To update an email: Use the email_id from the EXISTING EMAILS section above
- To send an email: Use the email_id from the EXISTING EMAILS section above  
- To delete/archive an email: Use the email_id from the EXISTING EMAILS section above
- The email_id must be a real UUID from the database, not a placeholder
`;

		if (accumulatedContext) {
			prompt += `\nCONTEXT FROM PREVIOUS INTERACTIONS:\n${accumulatedContext}\n`;
		}

		if (session?.metadata?.mcpResponses?.length) {
			prompt += `\nRECENT MCP ACTIONS:\n`;
			session.metadata.mcpResponses.slice(-3).forEach(response => {
				prompt += `- ${response.action}: ${response.success ? 'Success' : 'Failed'}\n`;
			});
		}

		prompt += `\nCRITICAL RESPONSE RULES:
1. ALWAYS use the most recent contact/person mentioned for pronouns like "him", "her", "his", "her"
2. If user just searched for someone, that person is the one they're referring to
3. Provide email addresses directly from context without asking for clarification
4. Use the context information to give specific, direct answers
5. Don't ask "which one" when there's a clear most recent reference

CONVERSATION FLOW EXAMPLES:

Example 1:
Context: "Recent contacts: John Doe (john@example.com), John Smith (john.smith@example.com)"
User just said: "search for john smith"
User now says: "whats his email?"
CORRECT Response: "John Smith's email is john.smith@example.com"

Example 2:
Context: "Recent email subjects: Project Update, Meeting Notes"
User: "what emails did I draft?"
CORRECT Response: "You recently drafted emails with subjects: 'Project Update' and 'Meeting Notes'"

Example 3:
Context: "Recent meetings: Project Review Meeting"
User: "what meetings do we have?"
CORRECT Response: "You recently scheduled a 'Project Review Meeting'"

WRONG Response: "I have information about multiple contacts. Which one do you mean?"

For pronouns and references:
- "him/her/his/her" = most recent person/contact mentioned
- "that email" = most recent email action
- "this meeting" = most recent meeting action
- "those contacts" = all recent contacts`;

		return prompt;
	}

	private async callOpenAI(systemPrompt: string, userMessage: string, session?: IChatSession): Promise<string> {
		const openaiApiKey = this.env.OPENAI_API_KEY;

		if (!openaiApiKey) {
			throw new Error('OpenAI API key not configured');
		}

		// Get MCP functions dynamically from server (with caching)
		const mcpFunctions = await this.getMCPFunctions();

		// Build conversation history (last 20 messages)
		const messages = [{ role: 'system', content: systemPrompt }];

		if (session?.messages) {
			// Get last 20 messages (excluding current user message)
			const recentMessages = session.messages.slice(-20);

			// Add conversation history
			let historyCount = 0;
			recentMessages.forEach((msg, index) => {
				if (msg.role === 'user' || msg.role === 'assistant') {
					messages.push({
						role: msg.role,
						content: msg.content
					});
					historyCount++;
				}
			});

			console.log('✅ Added conversation history:', {
				historyMessagesAdded: historyCount,
				totalMessagesInPayload: messages.length
			});
		}

		// Add current user message
		messages.push({
			role: 'user',
			content: userMessage
		});

		console.log('🤖 Sending to OpenAI with function calling:', {
			messageCount: messages.length,
			conversationHistory: messages.slice(1, -1).length,
			historyLimit: 20,
			functionsAvailable: mcpFunctions.length,
			systemPromptLength: systemPrompt.length,
			currentMessage: userMessage.substring(0, 50) + '...'
		});

		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${openaiApiKey}`,
			},
			body: JSON.stringify({
				model: 'gpt-3.5-turbo',
				messages: messages,
				tools: mcpFunctions.map(func => ({
					type: "function",
					function: func
				})),
				tool_choice: "auto", // Let OpenAI decide when to call functions
				max_tokens: 1000,
				temperature: 0.7
			})
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`OpenAI API error: ${response.status} - ${error}`);
		}

		const data = await response.json();
		const choice = data.choices[0];

		// Check if OpenAI wants to call a function (using the new tools format)
		if (choice.message.tool_calls) {
			const toolCall = choice.message.tool_calls[0];
			if (toolCall.type === 'function') {
				const functionCall = toolCall.function;
				console.log('🎯 OpenAI requested function call:', {
					function: functionCall.name,
					arguments: functionCall.arguments
				});

				// Execute the MCP function
				const functionResult = await this.executeMCPFunction(functionCall.name, JSON.parse(functionCall.arguments), session);

				// Format and store the MCP response for future AI context
				if (functionResult.success && functionResult.data && session) {
					await this.formatAndStoreMCPResponse(functionCall.name, functionResult.data, session);

					// Generate AI summary of what happened for better context
					await this.generateAndStoreAISummary(functionCall.name, functionResult.data, session);

					// Store the last successful action result for follow-up operations
					if (!session.metadata) {
						session.metadata = {
							mcpResponses: [],
							contextAccumulated: {},
							sessionType: 'mcp-integrated',
							createdFromUI: false,
							lastMCPInteraction: new Date(),
							totalMCPActions: 0
						};
					}

					if (!session.metadata.lastActionResult) {
						session.metadata.lastActionResult = {};
					}

					// Store only essential data - let AI handle context summarization
					session.metadata.lastActionResult[functionCall.name] = {
						result: {
							type: 'processed',
							action: functionCall.name,
							success: true,
							timestamp: new Date().toISOString()
						},
						timestamp: new Date(),
						parameters: functionCall.arguments
					};

					// Keep only last 3 action results to avoid bloat
					const actionKeys = Object.keys(session.metadata.lastActionResult);
					if (actionKeys.length > 3) {
						// Remove oldest actions
						const sortedKeys = actionKeys.sort((a, b) => {
							const lastActionResult = session.metadata?.lastActionResult;
							if (!lastActionResult) return 0;

							const aTime = lastActionResult[a]?.timestamp instanceof Date 
								? lastActionResult[a].timestamp.getTime() 
								: new Date(lastActionResult[a]?.timestamp || 0).getTime();
							const bTime = lastActionResult[b]?.timestamp instanceof Date 
								? lastActionResult[b].timestamp.getTime() 
								: new Date(lastActionResult[b]?.timestamp || 0).getTime();
							return bTime - aTime;
						});

						const keysToRemove = sortedKeys.slice(3);
						keysToRemove.forEach(key => {
							if (session.metadata?.lastActionResult) {
								delete session.metadata.lastActionResult[key];
							}
						});
					}
				}

				// Continue conversation with function result
				const functionMessage = {
					role: 'assistant',
					content: null,
					tool_calls: [toolCall]
				};

				const functionResultMessage = {
					role: 'tool',
					tool_call_id: toolCall.id,
					content: JSON.stringify(functionResult)
				};

				// Get final response from OpenAI with function result
				const finalResponse = await fetch('https://api.openai.com/v1/chat/completions', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${openaiApiKey}`,
					},
					body: JSON.stringify({
						model: 'gpt-3.5-turbo',
						messages: [...messages, functionMessage, functionResultMessage],
						max_tokens: 1000,
						temperature: 0.7
					})
				});

				if (!finalResponse.ok) {
					const error = await finalResponse.text();
					throw new Error(`OpenAI API error: ${finalResponse.status} - ${error}`);
				}

				const finalData = await finalResponse.json();
				return finalData.choices[0]?.message?.content || 'I executed the requested action successfully.';
			}
		}

		// No function call, return regular response
		return choice.message.content || 'I apologize, but I couldn\'t generate a response.';
	}

	/**
		* Generate AI summary of MCP action and store for future context
		*/
	private async generateAndStoreAISummary(functionName: string, rawData: any, session?: IChatSession): Promise<void> {
		try {
			if (!session) return;

			// Create a simple prompt for the AI to summarize what happened
			const summaryPrompt = `You just executed a ${functionName} action. Based on this result data, provide a brief, natural summary of what happened that can be used for future context:
Use this data if any: ${session.metadata} .

tehn merge merge this new data : ${JSON.stringify(rawData, null, 2)}

Provide a concise summary that captures the key information. Focus on the most important details that a user might want to reference later.
we will need to accumulate and store critical informations.
For example :
	{
	contacts : [{id : 'actual-uuid-here' , name : John, company : 'adaca' , email_address : 'john.almenanza@adaca.com' , pronoun : him}],
	meetings : [{id : 'actual-uuid-here' , subject : 'This is a test', to_email : ["recipient@email.com"],message :'this is a test'}],
	calendar : [{id : 'actual-uuid-here' , subject : 'This is a test calendar'],
	emails : [{email_id : 'actual-uuid-here' , subject : 'This is a test email', to_emails : ["recipient@email.com"], status : 'draft'}]
		}

IMPORTANT: Use the ACTUAL email_id from the existing context data, not placeholder values like 'uuid' or 'actual-uuid-here'. The email_id must be a real UUID from the database.
`;

			// Call OpenAI to generate the summary
			const summaryResponse = await this.callOpenAIForSummary(summaryPrompt);

			if (summaryResponse) {
				// Initialize metadata if it doesn't exist
				if (!session.metadata) {
					session.metadata = {
						mcpResponses: [],
						contextAccumulated: {},
						sessionType: 'mcp-integrated',
						createdFromUI: false,
						lastMCPInteraction: new Date(),
						totalMCPActions: 0,
						aiSummaries: []
					};
				}

				// Initialize contextAccumulated if it doesn't exist
				if (!session.metadata.contextAccumulated) {
					session.metadata.contextAccumulated = {
						contacts: [],
						meetings: [],
						calendar: [],
						emails: [],
						tasks: []
					};
				}

				// Merge AI-generated structured context with existing context
				this.mergeAIContext(session.metadata.contextAccumulated, summaryResponse);

				// Initialize aiSummaries array if it doesn't exist
				if (!session.metadata.aiSummaries) {
					session.metadata.aiSummaries = [];
				}

				// Store the AI-generated summary
				session.metadata.aiSummaries.push({
					action: functionName,
					summary: `AI processed ${functionName} and updated context`,
					timestamp: new Date(),
					rawDataSize: JSON.stringify(rawData).length
				});

				// Keep only the last 10 summaries to avoid bloat
				if (session.metadata.aiSummaries.length > 10) {
					session.metadata.aiSummaries = session.metadata.aiSummaries.slice(-10);
				}

				// Save the session with the new AI summary
				await this.metadataManager.saveSession(session);

				console.log('🤖 AI summary generated and stored:', {
					action: functionName,
					summaryLength: summaryResponse.length,
					totalSummaries: session.metadata.aiSummaries.length
				});
			}

		} catch (error) {
			console.error('❌ Failed to generate AI summary:', error);
		}
	}

	/**
		* Call OpenAI to generate structured context summary
		*/
	private async callOpenAIForSummary(prompt: string): Promise<any> {
		try {
			const openaiApiKey = this.env.OPENAI_API_KEY;
			if (!openaiApiKey) {
				console.warn('OpenAI API key not configured for summary generation');
				return null;
			}

			const response = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${openaiApiKey}`,
				},
				body: JSON.stringify({
					model: 'gpt-3.5-turbo',
					messages: [{
						role: 'user',
						content: prompt + '\n\nIMPORTANT: Respond with ONLY a valid JSON object matching the structure shown in the example. Do not include any other text or explanation.\n\nCRITICAL: \n1. All property names MUST be quoted (e.g., "contacts", "emails", "email_id")\n2. For emails, always include the email_id field when available, as this is needed for operations like sending emails\n3. The email_id is essential for email operations and should be preserved from the original data\n4. Return valid JSON that can be parsed directly without modification'
					}],
					max_tokens: 1000, // More tokens for structured data
					temperature: 0.1 // Very consistent for JSON
				})
			});

			if (!response.ok) {
				console.error('OpenAI summary API error:', response.status);
				return null;
			}

			const data = await response.json();
			const content = data.choices[0]?.message?.content || null;
			
			if (!content) return null;

			// Try to parse the JSON response
			try {
				// First try parsing as-is
				return JSON.parse(content);
			} catch (parseError) {
				// If that fails, try cleaning unquoted property names
				try {
					const cleanedContent = content.replace(/(\w+):/g, '"$1":');
					return JSON.parse(cleanedContent);
				} catch (secondParseError) {
					console.error('Failed to parse AI response as JSON:', parseError);
					console.log('AI Response:', content);
					return null;
				}
			}

		} catch (error) {
			console.error('Error calling OpenAI for summary:', error);
			return null;
		}
	}

	/**
		* Format and store MCP response data for future AI context
		*/
	private async formatAndStoreMCPResponse(functionName: string, rawData: any, session?: IChatSession): Promise<void> {
		try {
			console.log('📝 Formatting MCP response for storage:', { functionName, dataType: typeof rawData });

			// Format the data based on function type
			const formattedData = await this.formatMCPData(functionName, rawData);

			// Store in session metadata
			if (session) {
				if (!session.metadata) {
					session.metadata = {
						mcpResponses: [],
						contextAccumulated: {},
						sessionType: 'mcp-integrated',
						createdFromUI: false,
						lastMCPInteraction: new Date(),
						totalMCPActions: 0
					};
				}

				// Add to MCP responses (let AI handle summarization)
				session.metadata.mcpResponses = session.metadata.mcpResponses || [];
				session.metadata.mcpResponses.push({
					id: `mcp-${Date.now()}`,
					action: functionName,
					parameters: {},
					result: null, // Don't store full result - AI will handle context
					timestamp: new Date(),
					success: true
				} as any);

				// Keep only the last 5 responses to avoid bloat
				if (session.metadata.mcpResponses.length > 5) {
					session.metadata.mcpResponses = session.metadata.mcpResponses.slice(-5);
				}

				// Context accumulation is now handled by AI summarization in MCPResponseAccumulator
				// No need to store raw data here
				session.metadata.lastMCPInteraction = new Date();
				session.metadata.totalMCPActions = (session.metadata.totalMCPActions || 0) + 1;

				console.log('✅ MCP response stored in session metadata:', {
					functionName,
					dataSize: JSON.stringify(formattedData).length,
					totalResponses: session.metadata.mcpResponses.length
				});
			}

		} catch (error) {
			console.error('❌ Failed to format and store MCP response:', error);
		}
	}

	/**
		* Format raw MCP data into structured, readable format
		*/
	private async formatMCPData(functionName: string, rawData: any): Promise<any> {
		try {
			switch (functionName) {
				case 'search_contacts':
					return this.formatContactsData(rawData);

				case 'get_recent_contacts':
					return this.formatContactsData(rawData);

				case 'draft_email':
					return this.formatEmailData(rawData);

				case 'schedule_meeting':
					return this.formatMeetingData(rawData);

				case 'get_tasks':
				case 'create_task':
					return this.formatTasksData(rawData);

				case 'read_emails':
					return this.formatEmailsData(rawData);

				default:
					// For unknown function types, try to format generically
					return this.formatGenericData(rawData);
			}
		} catch (error) {
			console.error('❌ Error formatting MCP data:', error);
			return rawData; // Return raw data as fallback
		}
	}

	/**
		* Format contacts data
		*/
	private formatContactsData(data: any): any {
		if (!Array.isArray(data)) return data;

		const formatted = data.map(contact => ({
			name: contact.name || contact.display_name || 'Unknown',
			email: contact.email || contact.email_address || '',
			company: contact.company || contact.organization || '',
			phone: contact.phone || contact.phone_number || '',
			lastContact: contact.last_contacted || contact.updated_at || null
		}));

		return {
			type: 'contacts',
			count: formatted.length,
			contacts: formatted,
			summary: `Found ${formatted.length} contact${formatted.length !== 1 ? 's' : ''}`
		};
	}

	/**
		* Format email data
		*/
	private formatEmailData(data: any): any {
		// CRITICAL: Always preserve the email_id field as it's essential for email operations
		const email_id = data.email_id || data.id;
		
		return {
			type: 'email',
			email_id: email_id, // This field is critical for email operations
			subject: data.subject,
			to_emails: Array.isArray(data.to_emails) ? data.to_emails : (Array.isArray(data.to) ? data.to : [data.to]),
			from: data.from,
			body: data.body || data.content,
			status: data.status || 'draft',
			created: data.created_at || new Date().toISOString(),
			summary: `Email "${data.subject}" ${data.status === 'sent' ? 'sent' : 'drafted'} to ${Array.isArray(data.to_emails) ? data.to_emails.join(', ') : (Array.isArray(data.to) ? data.to.join(', ') : data.to)}`
		};
	}

	/**
		* Format meeting data
		*/
	private formatMeetingData(data: any): any {
		return {
			type: 'meeting',
			meetingId: data.id || data.meeting_id,
			title: data.title,
			attendees: Array.isArray(data.attendees) ? data.attendees : [],
			startTime: data.start_time || data.scheduled_time,
			duration: data.duration || 60,
			location: data.location || 'TBD',
			status: data.status || 'scheduled',
			created: data.created_at || new Date().toISOString(),
			summary: `Meeting "${data.title}" scheduled for ${data.start_time} with ${Array.isArray(data.attendees) ? data.attendees.length : 0} attendee${Array.isArray(data.attendees) && data.attendees.length !== 1 ? 's' : ''}`
		};
	}

	/**
		* Format tasks data
		*/
	private formatTasksData(data: any): any {
		if (!Array.isArray(data)) {
			// Single task
			return {
				type: 'task',
				taskId: data.id || data.task_id,
				title: data.title,
				description: data.description,
				status: data.status || 'pending',
				dueDate: data.due_date,
				assignee: data.assignee,
				created: data.created_at || new Date().toISOString(),
				summary: `Task "${data.title}" ${data.status || 'created'}`
			};
		}

		// Multiple tasks
		const formatted = data.map(task => ({
			id: task.id || task.task_id,
			title: task.title,
			status: task.status || 'pending',
			dueDate: task.due_date,
			assignee: task.assignee
		}));

		return {
			type: 'tasks',
			count: formatted.length,
			tasks: formatted,
			summary: `${formatted.length} task${formatted.length !== 1 ? 's' : ''} found`
		};
	}

	/**
		* Format emails data
		*/
	private formatEmailsData(data: any): any {
		if (!Array.isArray(data)) return data;

		const formatted = data.map(email => {
			// CRITICAL: Always preserve the email_id field as it's essential for email operations
			const email_id = email.email_id || email.id;
			
			return {
				email_id: email_id, // This field is critical for email operations
				subject: email.subject,
				from: email.from,
				to_emails: email.to_emails || email.to || [],
				status: email.status || 'draft',
				received: email.received_at || email.created_at,
				isRead: email.is_read || false,
				hasAttachments: email.has_attachments || false,
				body: email.body || email.content || ''
			};
		});

		return {
			type: 'emails',
			count: formatted.length,
			emails: formatted,
			summary: `${formatted.length} email${formatted.length !== 1 ? 's' : ''} in inbox`
		};
	}

	/**
		* Format generic data
		*/
	private formatGenericData(data: any): any {
		if (Array.isArray(data)) {
			return {
				type: 'list',
				count: data.length,
				items: data,
				summary: `${data.length} item${data.length !== 1 ? 's' : ''} found`
			};
		}

		if (typeof data === 'object' && data !== null) {
			return {
				type: 'object',
				data: data,
				summary: 'Data retrieved successfully'
			};
		}

		return {
			type: 'value',
			value: data,
			summary: `Result: ${data}`
		};
	}

	/**
		* Get MCP functions dynamically from server with caching
		*/
	private async getMCPFunctions(): Promise<any[]> {
		const now = Date.now();

		// Check cache first
		if (ChatSession.mcpFunctionsCache &&
			now < ChatSession.mcpFunctionsCacheExpiry) {
			console.log('✅ Using cached MCP functions');
			return ChatSession.mcpFunctionsCache;
		}

		try {
			console.log('🔄 Fetching fresh MCP functions from server...');

			// Set context for MCP client
			this.mcpClient.setContext({
				workspaceId: this.workspaceId || '14f49f8a-1e2f-4159-abf9-bbff0078bfa9',
				userId: this.currentUserId || '330c7620-2914-4a5c-8d5f-e4bac4737d08'
			});

			// Fetch functions from MCP server
			const functions = await this.mcpClient.getAvailableFunctions();

			// Cache the functions
			ChatSession.mcpFunctionsCache = functions;
			ChatSession.mcpFunctionsCacheExpiry = now + this.MCP_FUNCTIONS_CACHE_TTL;

			console.log(`✅ Fetched and cached ${functions.length} MCP functions`);
			return functions;

		} catch (error) {
			console.error('❌ Failed to fetch MCP functions:', error);

			// Return cached functions if available, otherwise empty array
			if (ChatSession.mcpFunctionsCache) {
				console.log('⚠️ Using stale cached MCP functions due to fetch error');
				return ChatSession.mcpFunctionsCache;
			}

			// Last resort: return empty array to prevent crashes
			console.log('⚠️ No cached functions available, returning empty array');
			return [];
		}
	}

	/**
	 * Execute MCP function called by OpenAI
	 */
	private async executeMCPFunction(functionName: string, args: any, session?: IChatSession): Promise<any> {
		try {
			console.log('🔧 Executing MCP function:', { functionName, args });

			// Set the workspace and user context for MCP calls
			const workspaceId = session?.workspaceId || this.workspaceId || '14f49f8a-1e2f-4159-abf9-bbff0078bfa9';
			const userId = session?.userId || this.currentUserId || '330c7620-2914-4a5c-8d5f-e4bac4737d08';

			// Update MCP client with current context
			this.mcpClient.setContext({ workspaceId, userId });

			let result: MCPResponse;

			// Route to appropriate MCP client method
			switch (functionName) {
				// Calendar functions - map to actual MCP client methods
				case 'calendar_draft_event':
					result = await this.mcpClient.draftMeeting(
						args.title,
						args.attendee_emails || args.attendees,
						args.start_time,
						args.duration || 60,
						args.description
					);
					break;
	
				case 'calendar_send_event':
					result = await this.mcpClient.sendMeetingInvite(args.meeting_id);
					break;
	
				case 'calendar_list_events':
					result = await this.mcpClient.listMeetings(args.limit || 20);
					break;
	
				case 'calendar_cancel_event':
					result = await this.mcpClient.cancelMeeting(args.meeting_id);
					break;
	
				// Email functions
				case 'email_draft_email':
					result = await this.mcpClient.draftEmail({
						to_emails: args.to_emails || args.to,
						subject: args.subject,
						body: args.body
					});
					break;
	
				case 'email_send_email':
					// Handle both direct email sending and sending existing drafts
					if (args.email_id) {
						// Send existing draft
						result = await this.mcpClient.sendEmail(args.email_id);
					} else if (args.to_emails && args.subject && args.body) {
						// Check if we have a session context and accumulated context with similar emails
						let emailId: string | null = null;
						
						// Try to get the current session ID from the context
						let currentSessionId: string | null = null;
						if (this.sessions.size === 1) {
							// If there's only one session, use it
							currentSessionId = Array.from(this.sessions.keys())[0];
						}
						
						if (currentSessionId) {
							const session = this.sessions.get(currentSessionId);
							
							if (session && session.metadata && session.metadata.contextAccumulated) {
								const context = session.metadata.contextAccumulated;
								
								// Look for similar emails in the accumulated context
								if (context.emails && Array.isArray(context.emails)) {
									// Find emails with similar subject or recipients
									const similarEmail = context.emails.find((email: any) => {
										// Check if subject is similar (case insensitive, ignoring minor differences)
										const subjectSimilar = email.subject &&
											email.subject.toLowerCase().includes(args.subject.toLowerCase()) ||
											args.subject.toLowerCase().includes(email.subject.toLowerCase());
										
										// Check if recipients are similar
										const recipientsSimilar = email.to_email &&
											Array.isArray(email.to_email) && Array.isArray(args.to_emails) &&
											email.to_email.some((to: string) => args.to_emails.includes(to));
										
										return subjectSimilar || recipientsSimilar;
									});
									
									if (similarEmail && similarEmail.id) {
										emailId = similarEmail.id;
										console.log('📧 Found similar existing draft, updating instead of creating new one:', {
											emailId,
											existingSubject: similarEmail.subject,
											newSubject: args.subject
										});
										
										// Update the existing draft
										if (emailId) {
											const updateResult = await this.mcpClient.updateDraftEmail(emailId, {
												subject: args.subject,
												body: args.body,
												to_emails: args.to_emails
											});
											
											if (!updateResult.success) {
												console.warn('⚠️ Failed to update existing draft, will create new one instead');
												emailId = null; // Reset to create new draft
											}
										}
									}
								}
							}
						}
						
						// If no similar email found or update failed, create a new draft
						if (!emailId) {
							console.log('📧 Creating new email draft...');
							const draftResult = await this.mcpClient.draftEmail({
								to_emails: args.to_emails,
								subject: args.subject,
								body: args.body
							});
							
							if (draftResult.success && draftResult.result && draftResult.result.email_id) {
								emailId = draftResult.result.email_id;
							} else {
								throw new Error('Failed to draft email before sending');
							}
						}
						
						// Send the email (either updated or newly drafted)
						if (emailId) {
							console.log('📧 Sending email...');
							result = await this.mcpClient.sendEmail(emailId);
						} else {
							throw new Error('Failed to obtain email ID for sending');
						}
					} else {
						throw new Error('Either email_id (for existing drafts) or to_emails, subject, and body (for new emails) are required for sending emails');
					}
					break;
	
				case 'email_read_email':
					result = await this.mcpClient.readEmails(
						args.folder || 'inbox',
						args.limit || 10
					);
					break;
	
				case 'email_archive_email':
					// CRITICAL: Ensure email_id is properly passed for archiving emails
					if (!args.email_id) {
						throw new Error('email_id is required for archiving emails');
					}
					result = await this.mcpClient.archiveEmail(args.email_id);
					break;

				case 'email_delete_email':
					// CRITICAL: Ensure email_id is properly passed for deleting emails
					if (!args.email_id) {
						throw new Error('email_id is required for deleting emails');
					}
					result = await this.mcpClient.deleteEmail(args.email_id);
					break;
	
				// Contacts functions
				case 'contacts_search':
					result = await this.mcpClient.searchContacts(args.query, args.limit || 10);
					break;
	
				case 'contacts_get_recent':
					result = await this.mcpClient.getRecentContacts(args.limit || 10);
					break;
	
				case 'contacts_get_by_company':
					result = await this.mcpClient.getContactsByCompany(args.company, args.limit || 10);
					break;
	
				case 'contacts_get_all':
					result = await this.mcpClient.getAllContacts(args.limit || 20);
					break;
	
				// Tasks functions
				case 'tasks_get_tasks':
					result = await this.mcpClient.getTasks(args.limit || 20);
					break;
	
				case 'tasks_get_overdue':
					result = await this.mcpClient.getOverdueTasks();
					break;
	
				case 'tasks_get_today':
					result = await this.mcpClient.getTodayTasks();
					break;
	
				case 'tasks_create':
					result = await this.mcpClient.createTask(
						args.title,
						args.description,
						args.due_date
					);
					break;
	
				case 'tasks_update':
					result = await this.mcpClient.updateTask(args.task_id, args);
					break;
	
				case 'tasks_delete':
					result = await this.mcpClient.deleteTask(args.task_id);
					break;
	
				// Activities functions
				case 'activities_get_feed':
					result = await this.mcpClient.getActivityFeed(args.limit || 20);
					break;
	
				case 'activities_get_analytics':
					result = await this.mcpClient.getActivityAnalytics();
					break;
	
				// Queue functions
				case 'queue_add_job':
					result = await this.mcpClient.addBackgroundJob(args.jobType, args.parameters);
					break;
	
				case 'queue_get_job_status':
					result = await this.mcpClient.getJobStatus(args.job_id);
					break;
	
				case 'queue_cancel_job':
					result = await this.mcpClient.cancelJob(args.job_id);
					break;
	
				// Legacy function names (for backward compatibility)
				case 'search_contacts':
					result = await this.mcpClient.searchContacts(args.query, args.limit || 10);
					break;
	
				case 'get_recent_contacts':
					result = await this.mcpClient.getRecentContacts(args.limit || 10);
					break;
	
				case 'send_email':
					// Handle both direct email sending and sending existing drafts (legacy function)
					if (args.email_id) {
						// Send existing draft
						result = await this.mcpClient.sendEmail(args.email_id);
					} else if (args.to_emails && args.subject && args.body) {
						// Try to find and update an existing draft first, otherwise create a new one
						console.log('📧 Looking for existing email drafts to update...');
						
						// Get accumulated context to find similar emails
						const currentSession = session;
						let emailId: string | null = null;
						
						if (currentSession && currentSession.metadata && currentSession.metadata.contextAccumulated && currentSession.metadata.contextAccumulated.emails) {
							const existingEmails = currentSession.metadata.contextAccumulated.emails;
							
							// Look for emails with similar subject and recipients that are still in draft status
							const similarEmail = existingEmails.find(email =>
								email.subject === args.subject &&
								email.status === 'draft' &&
								email.to_emails &&
								JSON.stringify(email.to_emails.sort()) === JSON.stringify(args.to_emails.sort())
							);
							
							if (similarEmail && similarEmail.email_id) {
								console.log('📧 Found similar existing draft, updating it instead of creating new one...');
								emailId = similarEmail.email_id;
								
								// Update the existing draft
								if (emailId) {
									const updateResult = await this.mcpClient.updateDraftEmail(emailId, {
										subject: args.subject,
										body: args.body,
										to_emails: args.to_emails
									});
								
									if (!updateResult.success) {
										console.warn('⚠️ Failed to update existing draft, will create new one instead');
										emailId = null; // Reset to create new draft
									}
								}
							}
						}
						
						// If no similar email found or update failed, create a new draft
						if (!emailId) {
							console.log('📧 Creating new email draft...');
							const draftResult = await this.mcpClient.draftEmail({
								to_emails: args.to_emails,
								subject: args.subject,
								body: args.body
							});
							
							if (draftResult.success && draftResult.result && draftResult.result.email_id) {
								emailId = draftResult.result.email_id;
							} else {
								throw new Error('Failed to draft email before sending');
							}
						}
						
						// Send the email (either updated or newly drafted)
						if (emailId) {
							console.log('📧 Sending email...');
							result = await this.mcpClient.sendEmail(emailId);
						} else {
							throw new Error('Failed to obtain email ID for sending');
						}
					} else {
						throw new Error('Either email_id (for existing drafts) or to_emails, subject, and body (for new emails) are required for sending emails');
					}
					break;
	
				case 'draft_email':
					result = await this.mcpClient.draftEmail({
						to_emails: args.to,
						subject: args.subject,
						body: args.body
					});
					break;
	
				case 'schedule_meeting':
					result = await this.mcpClient.draftMeeting(
						args.title,
						args.attendees,
						args.start_time,
						args.duration || 60
					);
					break;
	
				case 'get_tasks':
					if (args.status === 'overdue') {
						result = await this.mcpClient.getOverdueTasks();
					} else if (args.status === 'today') {
						result = await this.mcpClient.getTodayTasks();
					} else {
						result = await this.mcpClient.getTasks(args.limit || 20);
					}
					break;
	
				case 'create_task':
					result = await this.mcpClient.createTask(
						args.title,
						args.description,
						args.due_date
					);
					break;
	
				case 'read_emails':
					result = await this.mcpClient.readEmails(
						args.folder || 'inbox',
						args.limit || 10
					);
					break;
	
				// Handle any other function names by directly calling executeAction
				default:
					console.log(`🔄 Using direct executeAction for: ${functionName}`);
					result = await this.mcpClient.executeAction(functionName, args);
					break;
			}

			console.log('✅ MCP function executed:', {
				functionName,
				success: result.success,
				hasData: !!result.result,
				error: result.error
			});

			// Return the result in a format OpenAI can understand
			if (result.success) {
				return {
					success: true,
					data: result.result,
					message: `Successfully executed ${functionName}`
				};
			} else {
				return {
					success: false,
					error: result.error || 'Function execution failed',
					message: `Failed to execute ${functionName}: ${result.error}`
				};
			}

		} catch (error) {
			console.error('❌ MCP function execution error:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error',
				message: `Error executing ${functionName}`
			};
		}
	}

	private async streamOpenAIResponse(
		webSocket: WebSocket,
		aiMessage: ChatMessage,
		fullResponse: string
	): Promise<void> {
		// Split response into chunks for streaming effect
		const words = fullResponse.split(' ');
		let currentChunk = '';

		for (let i = 0; i < words.length; i++) {
			currentChunk += (i > 0 ? ' ' : '') + words[i];

			// Send chunk every few words or at natural breaks
			if (i % 3 === 0 || i === words.length - 1 || words[i].includes('.') || words[i].includes('!') || words[i].includes('?')) {
				aiMessage.content = currentChunk;

				this.sendStreamingChunk(webSocket, {
					type: 'content',
					content: currentChunk,
					messageId: aiMessage.id,
				});

				// Small delay for realistic streaming
				await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
			}
		}
	}

	private sendStreamingChunk(webSocket: WebSocket, chunk: AIStreamChunk): void {
		if (webSocket.readyState === WebSocket.OPEN) {
			webSocket.send(JSON.stringify(chunk));
		
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
			let session = this.sessions.get(sessionId);

			// If session doesn't exist, create it
			if (!session) {
				console.log('📝 Creating session for MCP accumulation:', sessionId);

				const baseSession = {
					id: sessionId,
					supabaseSessionId: sessionId, // Use sessionId as supabaseSessionId
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

				console.log('✅ Created session for MCP accumulation:', sessionId);
			}

			await this.metadataManager.addMCPResponse(session, action, parameters, result, success, error);

			// Save the updated session metadata to database
			await this.metadataManager.saveSession(session);

			console.log('✅ MCP response accumulated and saved for session:', {
				sessionId,
				action,
				success,
				totalMCPActions: session.metadata?.totalMCPActions || 0
			});
		} catch (error) {
			console.error('❌ Failed to accumulate MCP response:', error);
		}
	}

	/**
	 * Get accumulated context for AI prompt
	 */
	getAccumulatedContext(sessionId: string): string {
		const session = this.sessions.get(sessionId);
		if (!session || !session.metadata?.contextAccumulated) return '';

		const context = session.metadata.contextAccumulated;
		let contextString = '';

		// Add contacts
		if (context.contacts && context.contacts.length > 0) {
			contextString += '\n📞 EXISTING CONTACTS:';
			context.contacts.slice(0, 10).forEach((contact, index) => {
				if (contact.name && contact.email_address) {
					contextString += '\n' + (index + 1) + '. ' + contact.name + ' <' + contact.email_address + '>';
					if (contact.company) contextString += ' (' + contact.company + ')';
				}
			});
		}

		// Add meetings
		if (context.meetings && context.meetings.length > 0) {
			contextString += '\n📅 EXISTING MEETINGS:';
			context.meetings.slice(0, 5).forEach((meeting, index) => {
				if (meeting.subject) {
					contextString += '\n' + (index + 1) + '. ' + meeting.subject;
					if (meeting.startTime) contextString += ' (' + meeting.startTime + ')';
				}
			});
		}

		// Add emails with more detailed information including IDs
		if (context.emails && context.emails.length > 0) {
			contextString += '\n📧 EXISTING EMAILS (USE THESE IDs FOR EMAIL OPERATIONS):';
			context.emails.slice(0, 5).forEach((email, index) => {
				if (email.subject) {
					contextString += '\n' + (index + 1) + '. ' + email.subject;
					// CRITICAL: Always show email_id as it's essential for email operations
					if (email.email_id) {
						contextString += ' (ID: ' + email.email_id + ')';
					} else if (email.id) {
						contextString += ' (ID: ' + email.id + ')';
					}
					if (email.status) contextString += ' [Status: ' + email.status + ']';
					if (email.from) contextString += ' (from: ' + email.from + ')';
					if (email.to_emails && email.to_emails.length > 0) {
						contextString += ' (to: ' + email.to_emails.join(', ') + ')';
					}
				}
			});
			contextString += '\n\n  👉 IMPORTANT: Use the EXACT email IDs shown above when calling email functions!';
			contextString += '\n  👉 EXAMPLE: To update email #1, use email_id: "' + (context.emails[0]?.email_id || context.emails[0]?.id || 'REAL_ID_HERE') + '"';
		}

		return contextString;
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

	/**
	 * Merge AI-generated structured context with existing context
	 */
	private mergeAIContext(existingContext: any, aiContext: any): void {
		try {
			
			// Merge contacts
			if (aiContext.contacts && Array.isArray(aiContext.contacts)) {
				existingContext.contacts = existingContext.contacts || [];
				aiContext.contacts.forEach((newContact: any) => {
					// Check if contact already exists (deduplication by id or email)
					const existingIndex = existingContext.contacts.findIndex((existing: any) => 
						existing.id === newContact.id || existing.email_address === newContact.email_address
					);
					
					if (existingIndex >= 0) {
						// Update existing contact
						existingContext.contacts[existingIndex] = { ...existingContext.contacts[existingIndex], ...newContact };
						console.log('🔄 Updated existing contact:', newContact.name);
					} else {
						// Add new contact
						existingContext.contacts.push(newContact);
						console.log('✅ Added new contact:', newContact.name);
					}
				});
			}

			// Merge meetings
			if (aiContext.meetings && Array.isArray(aiContext.meetings)) {
				existingContext.meetings = existingContext.meetings || [];
				aiContext.meetings.forEach((newMeeting: any) => {
					const existingIndex = existingContext.meetings.findIndex((existing: any) => 
						existing.id === newMeeting.id || (existing.subject === newMeeting.subject && existing.to_email === newMeeting.to_email)
					);
					
					if (existingIndex >= 0) {
						existingContext.meetings[existingIndex] = { ...existingContext.meetings[existingIndex], ...newMeeting };
						console.log('🔄 Updated existing meeting:', newMeeting.subject);
					} else {
						existingContext.meetings.push(newMeeting);
						console.log('✅ Added new meeting:', newMeeting.subject);
					}
				});
			}

			// Merge calendar
			if (aiContext.calendar && Array.isArray(aiContext.calendar)) {
				existingContext.calendar = existingContext.calendar || [];
				aiContext.calendar.forEach((newCalendar: any) => {
					const existingIndex = existingContext.calendar.findIndex((existing: any) => 
						existing.id === newCalendar.id || existing.subject === newCalendar.subject
					);
					
					if (existingIndex >= 0) {
						existingContext.calendar[existingIndex] = { ...existingContext.calendar[existingIndex], ...newCalendar };
						console.log('🔄 Updated existing calendar:', newCalendar.subject);
					} else {
						existingContext.calendar.push(newCalendar);
						console.log('✅ Added new calendar:', newCalendar.subject);
					}
				});
			}

			// Merge emails
			if (aiContext.emails && Array.isArray(aiContext.emails)) {
				existingContext.emails = existingContext.emails || [];
				aiContext.emails.forEach((newEmail: any) => {
					// CRITICAL: Always prioritize email_id for deduplication as it's essential for email operations
					const existingIndex = existingContext.emails.findIndex((existing: any) =>
						existing.email_id === newEmail.email_id ||
						(existing.id === newEmail.id && !newEmail.email_id) ||
						(!existing.email_id && !newEmail.email_id && existing.subject === newEmail.subject && existing.from === newEmail.from)
					);
					
					if (existingIndex >= 0) {
						// When merging, ensure we preserve the email_id if it exists in either record
						const mergedEmail = { ...existingContext.emails[existingIndex], ...newEmail };
						if (!mergedEmail.email_id) {
							mergedEmail.email_id = existingContext.emails[existingIndex].email_id || newEmail.email_id || newEmail.id;
						}
						existingContext.emails[existingIndex] = mergedEmail;
						console.log('🔄 Updated existing email:', newEmail.subject, '(ID:', mergedEmail.email_id, ')');
					} else {
						// Ensure new email has email_id set
						if (!newEmail.email_id && newEmail.id) {
							newEmail.email_id = newEmail.id;
						}
						existingContext.emails.push(newEmail);
						console.log('✅ Added new email:', newEmail.subject, '(ID:', newEmail.email_id || newEmail.id, ')');
					}
				});
			}

			// Merge tasks
			if (aiContext.tasks && Array.isArray(aiContext.tasks)) {
				existingContext.tasks = existingContext.tasks || [];
				aiContext.tasks.forEach((newTask: any) => {
					const existingIndex = existingContext.tasks.findIndex((existing: any) => 
						existing.id === newTask.id || existing.title === newTask.title
					);
					
					if (existingIndex >= 0) {
						existingContext.tasks[existingIndex] = { ...existingContext.tasks[existingIndex], ...newTask };
						console.log('🔄 Updated existing task:', newTask.title);
					} else {
						existingContext.tasks.push(newTask);
						console.log('✅ Added new task:', newTask.title);
					}
				});
			}

			// Keep arrays manageable (max 20 items each)
			Object.keys(existingContext).forEach(key => {
				if (Array.isArray(existingContext[key]) && existingContext[key].length > 20) {
					existingContext[key] = existingContext[key].slice(-20);
				}
			});

			console.log('✅ AI context merged successfully');

		} catch (error) {
			console.error('❌ Failed to merge AI context:', error);
		}
	}

}
