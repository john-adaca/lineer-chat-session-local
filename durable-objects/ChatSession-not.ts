// @ts-ignore - Cloudflare Workers types
import { DurableObject, DurableObjectStorage, DurableObjectState } from 'cloudflare:workers';
import type {
	WebSocketMessage,
	ChatMessage,
	ChatSession as IChatSession,
	AIStreamChunk,
} from '../types';
import { ChatDatabaseService } from '../services/chatDatabaseService';
import { AIService } from '../services/aiService';

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

interface AIContext {
	messages: ChatMessage[];
	userId: string;
	workspaceId: string;
	sessionId: string;
	actions?: any[];
	metadata?: any;
	userPreferences?: any;
	workspaceContext?: any;
}

interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	OPENAI_API_KEY: string;
	OPENAI_BASE_URL?: string;
	MCP_SERVER_URL: string;
}

export class ChatSession extends DurableObject {
	private sessions: Map<string, IChatSession> = new Map();
	private activeConnections: Map<string, WebSocket> = new Map();
	private aiStreamController: ReadableStreamDefaultController | null = null;
	private isStreaming = false;
	private currentStreamAbortController: AbortController | null = null;
	private workspaceId: string | null = null;
	private currentUserId: string | null = null;
	private supabaseEnabled: boolean = false;
	private env: Env;
	private databaseService: ChatDatabaseService;
	private aiService: AIService;
	private state: DurableObjectState;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.state = state;
		this.env = env;

		// Initialize services
		this.databaseService = new ChatDatabaseService(env);
		this.aiService = new AIService(env);
		this.supabaseEnabled = this.databaseService.isEnabled();

		// Initialize storage immediately
		console.log('🏗️ ChatSession constructor called');
		console.log('🏗️ Storage available:', !!state.storage);
		console.log('🏗️ State available:', !!state);
		console.log('🗄️ Database service enabled:', this.supabaseEnabled);

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
	private batchSaveTimeout: Map<string, NodeJS.Timeout> = new Map();

	// MCP Context Management
	private sessionEntities = new Map<string, MCPEntityContext>();
	private mcpResponseCache = new Map<string, MCPCacheEntry>();

	// Enhanced Context Management
	private userPreferences = new Map<string, UserPreferences>();
	private conversationContexts = new Map<string, ConversationContext>();

	// Message persistence (immediate save for reliability)

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

	// ==================== STORAGE INITIALIZATION ====================

	private async initializeStorage(): Promise<void> {
		try {
			console.log('📦 Initializing storage...');

			// Load any existing sessions from storage
			const storedSessions = await this.state.storage.get('sessions');
			if (storedSessions) {
				this.sessions = new Map(storedSessions);
				console.log('✅ Loaded sessions from storage:', this.sessions.size);
			}

			console.log('✅ Storage initialization complete');
		} catch (error) {
			console.error('❌ Storage initialization failed:', error);
		}
	}

	private async handleChatRequest(request: Request): Promise<Response> {
		try {
			const body = await request.json();
			const { message, sessionId } = body;

			if (!message || !sessionId) {
				return new Response('Missing message or sessionId', { status: 400 });
			}

			// Get or create session
			let session = this.sessions.get(sessionId);
			if (!session) {
				session = {
					id: sessionId,
					supabaseSessionId: '',
					userId: this.currentUserId!,
					workspaceId: this.workspaceId!,
					messages: [],
					actions: [],
					isActive: true,
					createdAt: new Date(),
					lastActivity: new Date(),
				};
				this.sessions.set(sessionId, session);
			}

			// Add user message
			const userMessage: ChatMessage = {
				id: `user-${Date.now()}`,
				role: 'user',
				content: message,
				timestamp: new Date(),
			};
			session.messages.push(userMessage);
			session.lastActivity = new Date();

			// Generate AI response
			const aiContext = {
				messages: session.messages,
				userId: session.userId,
				workspaceId: session.workspaceId,
				sessionId: session.id,
				actions: session.actions || [],
				metadata: {},
			};

			// For now, return a simple response (streaming will be handled via WebSocket)
			const aiResponse = await this.generateSimpleAIResponse(aiContext);

			// Add AI message
			const aiMessage: ChatMessage = {
				id: `ai-${Date.now()}`,
				role: 'assistant',
				content: aiResponse,
				timestamp: new Date(),
			};
			session.messages.push(aiMessage);

			// Save to storage
			await this.state.storage.put('sessions', Array.from(this.sessions.entries()));

			return new Response(
				JSON.stringify({
					success: true,
					response: aiResponse,
					messageId: aiMessage.id,
				}),
				{
					headers: { 'Content-Type': 'application/json' },
				},
			);
		} catch (error) {
			console.error('Chat request error:', error);
			return new Response('Internal server error', { status: 500 });
		}
	}

	private async handleSessionsRequest(): Promise<Response> {
		try {
			const sessions = Array.from(this.sessions.values()).map((session) => ({
				id: session.id,
				userId: session.userId,
				workspaceId: session.workspaceId,
				messageCount: session.messages.length,
				createdAt: session.createdAt,
				lastActivity: session.lastActivity,
				isActive: session.isActive,
			}));

			return new Response(JSON.stringify({ sessions }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			console.error('Sessions request error:', error);
			return new Response('Internal server error', { status: 500 });
		}
	}

	private async handleActionsRequest(): Promise<Response> {
		try {
			const allActions: any[] = [];
			for (const session of this.sessions.values()) {
				if (session.actions) {
					allActions.push(...session.actions);
				}
			}

			return new Response(JSON.stringify({ actions: allActions }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			console.error('Actions request error:', error);
			return new Response('Internal server error', { status: 500 });
		}
	}

	// ==================== AI RESPONSE GENERATION ====================

	private async generateSimpleAIResponse(context: AIContext): Promise<string> {
		try {
			// Build conversation context for AI
			const messages = this.buildConversationContext(context);

			console.log('🤖 Generating AI response:', {
				messageCount: messages.length,
				userId: context.userId,
				workspaceId: context.workspaceId,
			});

			// Call OpenAI API
			const response = await fetch(
				`${this.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						model: 'gpt-3.5-turbo',
						messages: messages,
						temperature: 0.7,
						max_tokens: 1000,
					}),
				},
			);

			if (!response.ok) {
				throw new Error(`AI API error: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			return (
				data.choices[0]?.message?.content || 'I apologize, but I was unable to generate a response.'
			);
		} catch (error) {
			console.error('AI response generation error:', error);
			return 'I apologize, but I encountered an error while processing your request. Please try again.';
		}
	}

	private buildConversationContext(context: AIContext): any[] {
		const messages: any[] = [];

		// Add system prompt
		messages.push({
			role: 'system',
			content: `You are Lineer, a helpful AI assistant for managing emails, schedules, tasks, and contacts.

USER CONTEXT:
- User ID: ${context.userId}
- Workspace ID: ${context.workspaceId}
- Session ID: ${context.sessionId}

CAPABILITIES:
- Schedule meetings and appointments
- Manage contacts and email
- Create and manage tasks
- Send and draft emails
- Calendar management

INSTRUCTIONS:
- Be helpful and professional
- Ask clarifying questions when needed
- Provide specific, actionable responses
- Use the conversation history to maintain context
- If you need to perform actions, explain what you're doing

Current conversation has ${context.messages.length} messages.`,
		});

		// Add conversation history (last 20 messages for context)
		const recentMessages = context.messages.slice(-20);
		for (const message of recentMessages) {
			messages.push({
				role: message.role,
				content: message.content,
			});
		}

		return messages;
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

			// Get or create session (load from DB only once per session)
			let session = this.sessions.get(sessionId);
			if (!session) {
				// Try to load existing session from database first (only once)
				if (this.supabaseEnabled && supabaseSessionId) {
					console.log('🔄 Loading session from database (one-time):', supabaseSessionId);
					const existingSession = await this.databaseService.loadSessionFromSupabase(
						supabaseSessionId,
					);
					if (existingSession) {
						session = existingSession;
						this.sessions.set(sessionId, session);
						console.log('✅ Loaded session from database:', {
							sessionId,
							messageCount: session.messages.length,
						});
					}
				}

				// Create new session if not found in database
				if (!session) {
					session = {
						id: sessionId,
						supabaseSessionId: supabaseSessionId || '',
						userId: this.currentUserId!, // Now guaranteed to be set
						workspaceId: this.workspaceId!, // Now guaranteed to be set
						messages: [],
						actions: [],
						isActive: true,
						createdAt: new Date(),
						lastActivity: new Date(),
					};
					this.sessions.set(sessionId, session);
					console.log('✅ Created new session in memory:', {
						sessionId,
						userId: this.currentUserId,
						workspaceId: this.workspaceId,
					});

					// Create session in database if Supabase is enabled (async, non-blocking)
					if (this.supabaseEnabled) {
						this.databaseService
							.createSupabaseSession(session)
							.then((dbSessionId) => {
								if (dbSessionId && session) {
									session.supabaseSessionId = dbSessionId;
									console.log('💾 Session created in database:', dbSessionId);
								}
							})
							.catch((error) => console.warn('Failed to create session in database:', error));
					}
				}
			}

			// Add user message to session (in memory)
			if (session) {
				session.messages.push(userMessage);
				session.lastActivity = new Date();
			}

			// Save user message to database immediately (for persistence)
			if (this.supabaseEnabled && session?.supabaseSessionId) {
				this.databaseService
					.saveMessageToSupabase(session.supabaseSessionId, userMessage)
					.catch((error) => console.warn('Failed to save user message to database:', error));
			}

			// Send confirmation
			this.sendMessage(webSocket, {
				type: 'status',
				content: 'Message received, processing...',
				messageId: userMessage.id,
			});

			// Start streaming response
			if (session) {
				await this.streamResponse(webSocket, session, userMessage);
			}
		} catch (error) {
			console.error('Error handling user message:', error);
			this.sendError(webSocket, 'Failed to process message');
		}
	}

	private async handleSetUserPreference(sessionId: string, data: any): Promise<void> {
		// TODO: Implement user preference handling
		console.log('⚙️ User preference handling placeholder:', { sessionId, data });
	}

	private async handleSetSessionPersonality(sessionId: string, personality: any): Promise<void> {
		// TODO: Implement session personality handling
		console.log('🎭 Session personality handling placeholder:', { sessionId, personality });
	}

	private async handleSetUserContext(sessionId: string, data: any): Promise<void> {
		// TODO: Implement user context handling
		console.log('📋 User context handling placeholder:', { sessionId, data });
	}

	private getSessionContextData(sessionId: string): any {
		// TODO: Implement session context data retrieval
		console.log('📊 Session context data retrieval placeholder:', { sessionId });
		return {};
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

		// Stream AI response with real AI service
		await this.streamRealAIResponse(webSocket, session, aiMessage, userMessage);

		// Save AI message to database immediately (for persistence)
		if (this.supabaseEnabled && session.supabaseSessionId) {
			this.databaseService
				.saveMessageToSupabase(session.supabaseSessionId, aiMessage)
				.catch((error) => console.warn('Failed to save AI message to database:', error));
		}

		// Mark streaming as complete
		this.sendStreamingChunk(webSocket, {
			type: 'done',
			messageId: aiMessage.id,
		});

		console.log('✅ Streaming response completed for message:', aiMessage.id);
	}

	private async streamRealAIResponse(
		webSocket: WebSocket,
		session: IChatSession,
		aiMessage: ChatMessage,
		userMessage: ChatMessage,
	): Promise<void> {
		try {
			// Set up abort controller for this stream
			this.currentStreamAbortController = new AbortController();
			this.isStreaming = true;

			// Build AI context with full conversation history and metadata
			const aiContext = {
				messages: session.messages,
				userId: session.userId,
				workspaceId: session.workspaceId,
				sessionId: session.id,
				actions: session.actions || [],
				metadata: (session as any).supabaseMetadata || {},
			};

			// Stream AI response
			await this.aiService.streamAIResponse(
				aiContext,
				(chunk: AIStreamChunk) => {
					if (chunk.type === 'content' && chunk.content) {
						// Update AI message content
						aiMessage.content += chunk.content;

						// Send chunk to client
						this.sendStreamingChunk(webSocket, {
							type: 'content',
							content: chunk.content,
							messageId: aiMessage.id,
						});
					} else if (chunk.type === 'error') {
						// Handle AI errors
						this.sendStreamingChunk(webSocket, {
							type: 'error',
							error: chunk.error || 'AI error',
							messageId: aiMessage.id,
						});
					}
				},
				this.currentStreamAbortController,
			);
		} catch (error) {
			console.error('AI streaming error:', error);
			this.sendStreamingChunk(webSocket, {
				type: 'error',
				error: error instanceof Error ? error.message : 'AI streaming failed',
				messageId: aiMessage.id,
			});
		} finally {
			this.isStreaming = false;
			this.currentStreamAbortController = null;
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
}
