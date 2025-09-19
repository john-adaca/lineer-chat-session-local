// @ts-ignore - Cloudflare Workers types
import { DurableObject, DurableObjectStorage, DurableObjectState } from 'cloudflare:workers';
import type {
	WebSocketMessage,
	ChatMessage,
	ChatSession as ChatSessionInterface,
	AIStreamChunk,
} from '../types';
import { IntelligentResponseService } from '../services/intelligentResponseService';
import type { ResponseCraftingOptions } from '../services/intelligentResponseService';
import { enhanceMCPResultForUser } from '../lib/responseFormatter';
import { ContextSummarizer, type ContextSummary } from '../lib/contextSummarizer';

// Import our new services
import { MCPService } from './services/MCPService';
import { WebSocketService } from './services/WebSocketService';
import { AIResponseService } from './services/AIResponseService';
import { StorageService } from './services/StorageService';
import { SupabaseService } from './services/SupabaseService';
import { ContextService } from './services/ContextService';
import { SessionService } from './services/SessionService';

// Import types
import type { MCPEntityContext, MCPCapabilities } from './types/MCPTypes';
import type { UserPreferences, ConversationContext } from './types/ContextTypes';

interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	OPENAI_API_KEY: string;
	MCP_SERVER_URL: string;
}

export class ChatSession extends DurableObject {
	private sessions: Map<string, ChatSessionInterface> = new Map();
	private activeConnections: Map<string, WebSocket> = new Map();
	private aiStreamController: ReadableStreamDefaultController | null = null;
	private isStreaming = false;
	private currentStreamAbortController: AbortController | null = null;
	private workspaceId: string | null = null;
	private currentUserId: string | null = null;
	private supabaseEnabled: boolean = false;
	private intelligentResponseService: IntelligentResponseService | null = null;
	private env: Env;

	// Service instances
	private mcpService!: MCPService;
	private webSocketService!: WebSocketService;
	private aiResponseService!: AIResponseService;
	private storageService!: StorageService;
	private supabaseService!: SupabaseService;
	private contextService!: ContextService;
	private sessionService!: SessionService;

	// Storage optimization settings
	private readonly STORAGE_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
	private readonly MAX_STORAGE_SIZE = 100 * 1024; // 100KB per session
	private readonly CACHE_CLEANUP_THRESHOLD = 50; // Clean when >50 entries

	// Add storage property with proper typing
	declare storage: DurableObjectStorage;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.env = env;

		// Initialize storage immediately
		console.log('🏗️ ChatSessionRefactored constructor called');
		console.log('🏗️ Storage available:', !!this.storage);
		console.log('🏗️ State available:', !!state);

		// Log environment variables for debugging
		console.log('🔍 [ENV_DEBUG] Environment variables received:');
		console.log('🔍 [ENV_DEBUG] SUPABASE_URL:', env.SUPABASE_URL ? '✅ Present' : '❌ Missing');
		console.log(
			'🔍 [ENV_DEBUG] SUPABASE_SERVICE_ROLE_KEY:',
			env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Present' : '❌ Missing',
		);
		console.log('🔍 [ENV_DEBUG] OPENAI_API_KEY:', env.OPENAI_API_KEY ? '✅ Present' : '❌ Missing');
		console.log('🔍 [ENV_DEBUG] MCP_SERVER_URL:', env.MCP_SERVER_URL ? '✅ Present' : '❌ Missing');

		// Initialize Supabase first (needed by services)
		this.initializeSupabase();

		// Initialize services
		this.initializeServices();

		// Initialize storage and other components
		this.initializeStorage().catch((error) => {
			console.error('❌ Failed to initialize storage in constructor:', error);
		});
	}

	private initializeServices(): void {
		// Initialize Supabase service first
		this.supabaseService = new SupabaseService(this.env, new Map(), new Map());

		// Initialize storage service
		this.storageService = new StorageService(
			this.storage,
			this.sessions,
			new Map<string, MCPEntityContext>(),
			new Map(),
			this.contextService?.getUserPreferencesMap() || new Map(),
			this.contextService?.getConversationContextMap() || new Map(),
			this.contextService?.getSessionPersonalitiesMap() || new Map(),
			Date.now(),
		);

		// Initialize context service
		this.contextService = new ContextService(
			this.storage,
			() => this.storageService.persistConversationContextToStorage(),
			() => this.storageService.persistUserPreferencesToStorage(),
			() => this.storageService.persistSessionPersonalitiesToStorage(),
		);

		// Initialize session service
		this.sessionService = new SessionService(
			this.sessions, // ✅ Pass shared sessions map
			this.workspaceId,
			this.currentUserId,
			this.supabaseEnabled,
			(sessionId, session) => this.loadActionHistoryFromStorage(sessionId, session),
			(sessionId, session) =>
				this.supabaseService.loadActionHistoryFromSupabase(sessionId, session),
			(sessionId, workspaceId) => this.initializeSessionContext(sessionId, workspaceId),
			() => this.storageService.persistLastActivityToStorage(),
			(sessionId, userId, workspaceId) =>
				this.supabaseService.createSupabaseSession(sessionId, userId, workspaceId),
		);

		// Initialize MCP service
		this.mcpService = new MCPService(
			this.env,
			this.storage,
			this.sessions,
			this.workspaceId,
			this.currentUserId,
			this.supabaseEnabled,
			(webSocket, message) => this.sendMessage(webSocket, message),
			(sessionId, actionMetadata) =>
				this.supabaseService.saveActionToSupabase(sessionId, actionMetadata),
			(sessionId, sessionMetadata) =>
				this.supabaseService.saveSessionMetadataToSupabase(sessionId, sessionMetadata),
			(sessionId, actions) =>
				this.storageService.persistSessionActionsToStorage(sessionId, actions),
			() => this.storageService.persistSessionEntitiesToStorage(),
			() => this.storageService.persistMCPCacheToStorage(),
			(capabilities, expiry) =>
				this.storageService.saveGlobalMCPCacheToStorage(capabilities, expiry),
			() => this.storageService.loadGlobalMCPCacheFromStorage(),
		);

		// Initialize WebSocket service
		this.webSocketService = new WebSocketService(
			this.sessions,
			(webSocket, content, sessionId, messageId, supabaseSessionId) =>
				this.handleUserMessage(webSocket, content, sessionId, messageId, supabaseSessionId),
			() => this.handleInterrupt(),
			() => this.handlePause(),
			() => this.handleResume(),
			(sessionId, preferenceData) =>
				this.contextService.setUserPreference(sessionId, preferenceData),
			(sessionId, personality) => this.contextService.setSessionPersonality(sessionId, personality),
			(sessionId, userContext) => this.contextService.setUserContext(sessionId, userContext),
			(sessionId) => this.contextService.getUserContext(sessionId),
			() => this.generateId(),
		);

		// Initialize AI response service
		this.aiResponseService = new AIResponseService(
			this.env,
			() => this.mcpService.getMCPCapabilities(),
			(webSocket, functionCall, messageId, sessionId) =>
				this.mcpService.executeMCPAction(webSocket, functionCall, messageId, sessionId),
			(session, userMessage, availableActions) =>
				this.buildMainConversationMessages(session, userMessage, availableActions),
			(webSocket, message) => this.sendMessage(webSocket, message),
			(webSocket, error) => this.sendError(webSocket, error),
			() => this.generateId(),
			this.contextService.getCurrentUserQueriesMap(),
		);

		// Set up AI response service dependencies
		this.aiResponseService.setDependencies(
			this.sessions,
			(sessionId, content) => this.contextService.updateConversationContext(sessionId, content),
			(session, functionResultMessage, functionName, actionMetadata) =>
				this.buildConversationContext(session, functionResultMessage, functionName, actionMetadata),
		);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		console.log('🔍 ChatSession fetch called:', path);

		// Extract session ID from URL path (e.g., /chat/sessionId)
		const pathParts = path.split('/');
		const sessionId = pathParts[pathParts.length - 1]; // Get the last part of the path
		console.log('🔍 Extracted session ID from path:', sessionId);

		// Extract user ID and workspace ID from URL parameters - REQUIRED
		const userId = url.searchParams.get('userId');
		const workspaceId = url.searchParams.get('workspaceId');
		const supabaseSessionId = url.searchParams.get('supabaseSessionId');

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
		console.log('✅ Required parameters validated:', {
			userId,
			workspaceId,
			sessionId,
			supabaseSessionId,
		});

		// Update services with the new IDs
		this.updateServiceIds(userId, workspaceId);

		// Handle WebSocket connections
		if (request.headers.get('Upgrade') === 'websocket') {
			// Pass the session ID and Supabase session ID to the WebSocket service
			return this.webSocketService.handleWebSocket(
				request,
				sessionId,
				supabaseSessionId || undefined,
			);
		}

		// Handle API endpoints
		if (path === '/api/chat') {
			return this.handleChatAPI(request);
		}

		// Handle health check
		if (path === '/health') {
			return new Response(
				JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }),
				{
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		return new Response('Not Found', { status: 404 });
	}

	private async initializeStorage(): Promise<void> {
		try {
			console.log('🔄 Initializing storage...');

			await this.storageService.initializeStorage();

			// Load global MCP cache from storage to prevent rediscovery on every request
			await this.loadGlobalMCPCacheFromStorage();

			console.log('✅ Storage initialized successfully');
		} catch (error) {
			console.error('❌ Failed to initialize storage:', error);
		}
	}

	private initializeSupabase(): void {
		console.log('🔍 [SUPABASE_DEBUG] Checking Supabase credentials...');
		console.log(
			'🔍 [SUPABASE_DEBUG] SUPABASE_URL:',
			this.env.SUPABASE_URL ? '✅ Present' : '❌ Missing',
		);
		console.log(
			'🔍 [SUPABASE_DEBUG] SUPABASE_SERVICE_ROLE_KEY:',
			this.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Present' : '❌ Missing',
		);

		if (this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY) {
			this.supabaseEnabled = true;
			console.log('✅ Supabase initialized with credentials');
			console.log('🔍 [SUPABASE_DEBUG] Supabase URL:', this.env.SUPABASE_URL);
			console.log(
				'🔍 [SUPABASE_DEBUG] Service Key (first 10 chars):',
				this.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 10) + '...',
			);
		} else {
			console.log('⚠️ Supabase not configured - running without persistence');
			console.log('🔍 [SUPABASE_DEBUG] Missing credentials:', {
				hasUrl: !!this.env.SUPABASE_URL,
				hasKey: !!this.env.SUPABASE_SERVICE_ROLE_KEY,
			});
		}
	}

	private updateServiceIds(userId: string, workspaceId: string): void {
		// Update MCP service with new IDs
		this.mcpService.updateIds(workspaceId, userId);

		// Update session service with new IDs
		this.sessionService.updateIds(workspaceId, userId);

		console.log('✅ Updated service IDs:', { userId, workspaceId });
	}

	private getIntelligentResponseService(): IntelligentResponseService {
		if (!this.intelligentResponseService) {
			this.intelligentResponseService = new IntelligentResponseService(this.env.OPENAI_API_KEY);
		}
		return this.intelligentResponseService;
	}

	private getSessionActions(sessionId: string): any[] {
		const session = this.sessions.get(sessionId);
		return session?.actions || [];
	}

	private async handleUserMessage(
		webSocket: WebSocket,
		content: string,
		sessionId: string,
		messageId?: string,
		supabaseSessionId?: string,
	): Promise<void> {
		try {
			// Store user message
			const userMessage: ChatMessage = {
				id: messageId || this.generateId(),
				role: 'user',
				content,
				timestamp: new Date(),
			};

			// Get or create session
			let session = await this.sessionService.getOrCreateSession(
				sessionId,
				supabaseSessionId,
				this.workspaceId!,
				this.currentUserId!,
			);
			session.messages.push(userMessage);

			// Update conversation context
			await this.contextService.updateConversationContext(sessionId, content);

			// Add connection
			this.webSocketService.addConnection(sessionId, webSocket);

			// Generate AI response
			await this.aiResponseService.generateAIResponse(webSocket, session, userMessage);
		} catch (error) {
			console.error('Error handling user message:', error);
			this.sendError(webSocket, 'Failed to process message');
		}
	}

	private async generateAIResponse(
		webSocket: WebSocket,
		session: ChatSessionInterface,
		userMessage: ChatMessage,
	): Promise<void> {
		await this.aiResponseService.generateAIResponse(webSocket, session, userMessage);
	}

	private async getMCPCapabilities(): Promise<MCPCapabilities> {
		return this.mcpService.getMCPCapabilities();
	}

	private async callMCPMethod(method: string, params: any): Promise<any[]> {
		return this.mcpService.callMCPMethod(method, params);
	}

	private async executeMCPAction(
		webSocket: WebSocket,
		functionCall: any,
		messageId: string,
		sessionId: string,
	): Promise<void> {
		// Ensure MCP service has the correct workspace and user IDs
		this.mcpService.updateIds(this.workspaceId, this.currentUserId);
		await this.mcpService.executeMCPAction(webSocket, functionCall, messageId, sessionId);
	}

	private async executeMCPActionWithContext(
		webSocket: WebSocket,
		functionCall: any,
		messageId: string,
		sessionId: string,
	): Promise<void> {
		await this.mcpService.executeMCPActionWithContext(
			webSocket,
			functionCall,
			messageId,
			sessionId,
		);
	}

	private extractActionMetadata(functionName: string, result: any): any | null {
		return this.mcpService.extractActionMetadata(functionName, result);
	}

	private storeActionInSession(sessionId: string, actionMetadata: any): void {
		this.mcpService.storeActionInSession(sessionId, actionMetadata);
	}

	private cleanupSessionActions(actions: any[]): any[] {
		return this.mcpService.cleanupSessionActions(actions);
	}

	private updateSessionMetadata(session: any, actionMetadata: any): void {
		this.mcpService.updateSessionMetadata(session, actionMetadata);
	}

	private extractContactsFromMetadata(sessionMetadata: any): any[] {
		return this.mcpService.extractContactsFromMetadata(sessionMetadata);
	}

	private extractEmailsFromMetadata(sessionMetadata: any): any[] {
		return this.mcpService.extractEmailsFromMetadata(sessionMetadata);
	}

	private extractMeetingsFromMetadata(sessionMetadata: any): any[] {
		return this.mcpService.extractMeetingsFromMetadata(sessionMetadata);
	}

	private extractUserInfoFromSession(session: any): any {
		return this.mcpService.extractUserInfoFromSession(session);
	}

	private buildMainConversationMessages(
		session: any,
		userMessage: any,
		availableActions: any[],
	): any[] {
		// This is a complex method that builds the conversation context
		// For now, we'll implement a simplified version
		const messages: any[] = [];

		// Add system message
		const userPrefs = this.contextService.getUserPreferences(session.id);
		const convContext = this.contextService.getConversationContextMap().get(session.id);
		const personality = this.contextService.getSessionPersonality(session.id);

		const systemPrompt = this.contextService.buildPersonalizedSystemPrompt(
			userPrefs,
			convContext || this.contextService.getDefaultConversationContext(),
			personality || undefined,
			session.supabaseMetadata,
			this.workspaceId || undefined,
			this.currentUserId || undefined,
		);

		messages.push({
			role: 'system',
			content: systemPrompt,
		});

		// Add conversation history
		const recentMessages = session.messages.slice(-10); // Last 10 messages
		messages.push(...recentMessages);

		// Add current user message
		messages.push(userMessage);

		return messages;
	}

	private trackEmailDraft(sessionId: string, emailId: string): void {
		this.contextService.trackEmailDraft(sessionId, emailId);
	}

	private getEmailDraftId(sessionId: string): string | null {
		return this.contextService.getEmailDraftId(sessionId);
	}

	private buildConversationContextSummary(session: any): string {
		const contextItems: string[] = [];

		// Get entities from session metadata (this is where MCP actions store their results)
		const sessionMetadata = session.supabaseMetadata || {};

		// Extract contacts from metadata
		const contacts = this.extractContactsFromMetadata(sessionMetadata);
		if (contacts.length > 0) {
			const contactList = contacts
				.slice(0, 10)
				.map((contact) => `${contact.name} (${contact.email})`)
				.join(', ');
			contextItems.push(`Recent contacts: ${contactList}`);
		}

		// Extract emails from metadata
		const emails = this.extractEmailsFromMetadata(sessionMetadata);
		if (emails.length > 0) {
			const emailList = emails
				.slice(0, 5)
				.map((email) => `${email.subject} (${email.from})`)
				.join(', ');
			contextItems.push(`Recent emails: ${emailList}`);
		}

		// Extract meetings from metadata
		const meetings = this.extractMeetingsFromMetadata(sessionMetadata);
		if (meetings.length > 0) {
			const meetingList = meetings
				.slice(0, 5)
				.map((meeting) => `${meeting.title} (${meeting.start_time})`)
				.join(', ');
			contextItems.push(`Recent meetings: ${meetingList}`);
		}

		// Add recent actions context
		if (sessionMetadata.recent_actions && sessionMetadata.recent_actions.length > 0) {
			const recentActions = sessionMetadata.recent_actions
				.slice(-3)
				.map((action: any) => `${action.type}: ${action.summary}`)
				.join(', ');
			contextItems.push(`Recent actions: ${recentActions}`);
		}

		// Add workspace context
		if (sessionMetadata.workspace_context) {
			const entityCounts = sessionMetadata.workspace_context.entity_counts;
			if (entityCounts) {
				const counts = [];
				if (entityCounts.contacts > 0) counts.push(`${entityCounts.contacts} contacts`);
				if (entityCounts.emails > 0) counts.push(`${entityCounts.emails} emails`);
				if (entityCounts.meetings > 0) counts.push(`${entityCounts.meetings} meetings`);
				if (counts.length > 0) {
					contextItems.push(`Workspace has: ${counts.join(', ')}`);
				}
			}
		}

		return contextItems.join('\n');
	}

	private buildMCPErrorContext(mcpErrors: any[]): string {
		// Implementation for building MCP error context
		return 'MCP error context';
	}

	private buildCurrentSessionContext(session: any): string {
		// Implementation for building current session context
		return 'Current session context';
	}

	private async retryOpenAICall(
		apiCall: () => Promise<Response>,
		maxRetries: number = 3,
		baseDelayMs: number = 1000,
	): Promise<Response> {
		return this.aiResponseService.retryOpenAICall(apiCall, maxRetries, baseDelayMs);
	}

	private extractRecentMeetingContext(session: any): string | null {
		// Implementation for extracting recent meeting context
		return null;
	}

	private buildConversationContext(
		session: any,
		functionResultMessage: any,
		functionName: string,
		actionMetadata?: any,
	): any[] {
		const messages = [];

		// Get user preferences and conversation context
		const userPrefs = this.contextService.getUserPreferences(session.id);
		const convContext = this.contextService.getConversationContextMap().get(session.id);
		const personality = this.contextService.getSessionPersonality(session.id);

		// Build personalized system prompt with session metadata
		const systemPrompt = this.contextService.buildPersonalizedSystemPrompt(
			userPrefs,
			convContext || this.contextService.getDefaultConversationContext(),
			personality || undefined,
			session.supabaseMetadata,
			this.workspaceId || undefined,
			this.currentUserId || undefined,
		);

		messages.push({
			role: 'system',
			content: systemPrompt,
		});

		// Add conversation context summary if available
		const conversationContext = this.buildConversationContextSummary(session);
		if (conversationContext) {
			messages.push({
				role: 'system',
				content: `CONVERSATION CONTEXT SUMMARY:\n${conversationContext}\n\nUse this context to understand references like "him", "her", "that person", etc. from previous messages.`,
			});
		}

		// Add recent conversation history (last 10 messages)
		const recentMessages = session.messages.slice(-10);
		messages.push(...recentMessages);

		// Add the function result message
		messages.push(functionResultMessage);

		return messages;
	}

	private async saveActionToSupabase(sessionId: string, actionMetadata: any): Promise<void> {
		await this.supabaseService.saveActionToSupabase(sessionId, actionMetadata);
	}

	private addToMessageBuffer(sessionId: string, data: any): void {
		this.supabaseService.addToMessageBuffer(sessionId, data);
	}

	private async flushMessageBuffer(sessionId: string): Promise<void> {
		await this.supabaseService.flushMessageBuffer(sessionId);
	}

	private async saveMessageToSupabase(sessionId: string, message: any): Promise<void> {
		await this.supabaseService.saveMessageToSupabase(sessionId, message);
	}

	private async createSupabaseSession(sessionId?: string): Promise<string | null> {
		return this.supabaseService.createSupabaseSession(sessionId);
	}

	private async loadActionHistoryFromStorage(
		sessionId: string,
		session: ChatSessionInterface,
	): Promise<void> {
		const actions = await this.storageService.loadSessionActionsFromStorage(sessionId);
		if (actions.length > 0) {
			session.actions = actions;
		}
	}

	private async loadActionHistoryFromSupabase(sessionId: string, session: any): Promise<void> {
		await this.supabaseService.loadActionHistoryFromSupabase(sessionId, session);
	}

	private async continueAIResponseWithFunctionResult(
		webSocket: WebSocket,
		functionResultMessage: any,
		messageId: string,
		sessionId: string,
		functionName: string,
		actionMetadata?: any,
	): Promise<void> {
		await this.aiResponseService.continueAIResponseWithFunctionResult(
			webSocket,
			functionResultMessage,
			messageId,
			sessionId,
			functionName,
			actionMetadata,
		);
	}

	private async streamAIResponse(
		webSocket: WebSocket,
		session: ChatSessionInterface,
		aiMessage: ChatMessage,
		userMessage: ChatMessage,
	): Promise<void> {
		await this.aiResponseService.streamAIResponse(webSocket, session, aiMessage, userMessage);
	}

	private async delayWithInterruption(ms: number, abortController: AbortController): Promise<void> {
		return this.aiResponseService.delayWithInterruption(ms, abortController);
	}

	private interruptionHandler: (() => void) | null = null;

	private setInterruptionHandler(handler: () => void): void {
		this.aiResponseService.setInterruptionHandler(handler);
	}

	private clearInterruptionHandler(): void {
		this.aiResponseService.clearInterruptionHandler();
	}

	private handleInterrupt(): void {
		this.aiResponseService.handleInterrupt();
	}

	private handlePause(): void {
		this.aiResponseService.handlePause();
	}

	private handleResume(): void {
		this.aiResponseService.handleResume();
	}

	private sendMessage(webSocket: WebSocket, message: WebSocketMessage): void {
		this.webSocketService.sendMessage(webSocket, message);
	}

	private sendError(webSocket: WebSocket, error: string): void {
		this.webSocketService.sendError(webSocket, error);
	}

	private sendStatus(webSocket: WebSocket, status: string): void {
		this.webSocketService.sendStatus(webSocket, status);
	}

	private broadcast(message: WebSocketMessage): void {
		this.webSocketService.broadcast(message);
	}

	private cleanupConnection(webSocket: WebSocket): void {
		this.webSocketService.cleanupConnection(webSocket);
	}

	private getSessionIdFromWebSocket(webSocket: WebSocket): string | null {
		// Implementation for getting session ID from WebSocket
		return null;
	}

	private generateId(): string {
		return Math.random().toString(36).substring(2) + Date.now().toString(36);
	}

	private cleanupInactiveSessions(): void {
		this.sessionService.cleanupInactiveSessions();
	}

	private async getOrCreateSession(
		sessionId: string,
		supabaseSessionId?: string,
		workspaceId?: string,
	): Promise<ChatSessionInterface> {
		return this.sessionService.getOrCreateSession(sessionId, supabaseSessionId, workspaceId);
	}

	private addConnection(sessionId: string, webSocket: WebSocket): void {
		this.webSocketService.addConnection(sessionId, webSocket);
	}

	getMemoryUsage(): any {
		return {
			sessions: this.sessions.size,
			activeConnections: this.activeConnections.size,
			memoryUsage: this.sessionService.estimateMemoryUsage(),
		};
	}

	private sendMCPStatusUpdate(webSocket: WebSocket, statusUpdate: any, messageId: string): void {
		this.mcpService.sendMCPStatusUpdate(webSocket, statusUpdate, messageId);
	}

	private async checkMCPCache(functionCall: any): Promise<any | null> {
		return this.mcpService.checkMCPCache(functionCall);
	}

	private isCacheableOperation(functionName: string): boolean {
		return this.mcpService.isCacheableOperation(functionName);
	}

	private mapParameterNames(functionName: string, args: any): any {
		return this.mcpService.mapParameterNames(functionName, args);
	}

	private async storeMCPErrorForLearning(
		functionName: string,
		args: any,
		error: any,
		sessionId: string,
	): Promise<void> {
		await this.mcpService.storeMCPErrorForLearning(functionName, args, error, sessionId);
	}

	private parseAndEnhanceArguments(functionCall: any, sessionId: string): any {
		return this.mcpService.parseAndEnhanceArguments(functionCall, sessionId);
	}

	private resolveEntityReferences(args: any, sessionId: string, actionName: string): any {
		return this.mcpService.resolveEntityReferences(args, sessionId, actionName);
	}

	private resolveContactEmails(emailsOrNames: string[], entityContext: MCPEntityContext): string[] {
		return this.mcpService.resolveContactEmails(emailsOrNames, entityContext);
	}

	private findEmailId(emailReference: string, entityContext: MCPEntityContext): string {
		return this.mcpService.findEmailId(emailReference, entityContext);
	}

	private findMeetingId(
		meetingReference: string,
		entityContext: MCPEntityContext,
		sessionId?: string,
	): string {
		return this.mcpService.findMeetingId(meetingReference, entityContext, sessionId);
	}

	private isValidId(id: string): boolean {
		return this.mcpService.isValidId(id);
	}

	private async executeMCPCallWithRetry(
		mcpServerUrl: string,
		requestBody: any,
		webSocket: WebSocket,
		messageId: string,
		maxRetries: number = 3,
	): Promise<any> {
		return this.mcpService.executeMCPCallWithRetry(
			mcpServerUrl,
			requestBody,
			webSocket,
			messageId,
			maxRetries,
		);
	}

	private async processMCPResult(
		webSocket: WebSocket,
		result: any,
		functionCall: any,
		messageId: string,
		sessionId: string,
	): Promise<void> {
		await this.mcpService.processMCPResult(webSocket, result, functionCall, messageId, sessionId);
	}

	private async initializeSessionContext(sessionId: string, workspaceId: string): Promise<void> {
		// Implementation for initializing session context
		console.log('Initializing session context for:', sessionId, workspaceId);
	}

	private async loadContactsForSession(sessionId: string, workspaceId: string): Promise<void> {
		// Implementation for loading contacts for session
		console.log('Loading contacts for session:', sessionId, workspaceId);
	}

	private async storeEntitiesInContext(
		result: any,
		actionName: string,
		sessionId: string,
	): Promise<void> {
		await this.mcpService.storeEntitiesInContext(result, actionName, sessionId);
	}

	private limitEntityStorage(entityContext: MCPEntityContext): void {
		this.mcpService.limitEntityStorage(entityContext);
	}

	private async handleChatAPI(request: Request): Promise<Response> {
		try {
			const data = await request.json();
			return new Response(JSON.stringify({ message: 'Chat API endpoint' }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: 'Invalid request' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	private async persistSessionEntitiesToStorage(): Promise<void> {
		await this.storageService.persistSessionEntitiesToStorage();
	}

	private async persistMCPCacheToStorage(): Promise<void> {
		await this.storageService.persistMCPCacheToStorage();
	}

	private async persistSessionActionsToStorage(sessionId: string, actions: any[]): Promise<void> {
		await this.storageService.persistSessionActionsToStorage(sessionId, actions);
	}

	private async persistLastActivityToStorage(): Promise<void> {
		await this.storageService.persistLastActivityToStorage();
	}

	private async loadSessionActionsFromStorage(sessionId: string): Promise<any[]> {
		return this.storageService.loadSessionActionsFromStorage(sessionId);
	}

	private async storeEntitiesInContextWithPersistence(
		result: any,
		actionName: string,
		sessionId: string,
	): Promise<void> {
		await this.mcpService.storeEntitiesInContextWithPersistence(result, actionName, sessionId);
	}

	private async storeMCPCacheWithPersistence(
		cacheKey: string,
		data: any,
		expiry: number,
		actionType: string,
	): Promise<void> {
		await this.mcpService.storeMCPCacheWithPersistence(cacheKey, data, expiry, actionType);
	}

	private cachePersistTimeout: NodeJS.Timeout | null = null;

	// Enhanced User Context Methods
	private getDefaultUserPreferences(): UserPreferences {
		return this.contextService.getDefaultUserPreferences();
	}

	private getDefaultConversationContext(): ConversationContext {
		return this.contextService.getDefaultConversationContext();
	}

	private buildPersonalizedSystemPrompt(
		userPrefs: UserPreferences,
		convContext: ConversationContext,
		customPersonality?: string,
	): string {
		return this.contextService.buildPersonalizedSystemPrompt(
			userPrefs,
			convContext,
			customPersonality,
		);
	}

	private getStyleInstructions(userPrefs: UserPreferences): string {
		return this.contextService.getStyleInstructions(userPrefs);
	}

	private buildContextualInformation(convContext: ConversationContext): string {
		return this.contextService.buildContextualInformation(convContext);
	}

	private getEmotionalAdaptation(tone: ConversationContext['emotionalTone']): string {
		return this.contextService.getEmotionalAdaptation(tone);
	}

	private enhanceMCPResultForUserLocal(
		result: any,
		functionName: string,
		actionMetadata?: any,
	): any {
		// Implementation for enhancing MCP result for user
		return result;
	}

	private async getMCPActionSchema(resource: string, actionName: string): Promise<any> {
		// Implementation for getting MCP action schema
		return null;
	}

	private async updateConversationContext(sessionId: string, userMessage: string): Promise<void> {
		await this.contextService.updateConversationContext(sessionId, userMessage);
	}

	private async analyzeAndUpdateContext(
		context: ConversationContext,
		userMessage: string,
	): Promise<ConversationContext> {
		// This method is now handled by the context service
		return context;
	}

	private async persistConversationContextToStorage(): Promise<void> {
		await this.storageService.persistConversationContextToStorage();
	}

	private async persistUserPreferencesToStorage(): Promise<void> {
		await this.storageService.persistUserPreferencesToStorage();
	}

	private async persistSessionPersonalitiesToStorage(): Promise<void> {
		await this.storageService.persistSessionPersonalitiesToStorage();
	}

	private async cleanupExpiredData(): Promise<void> {
		await this.storageService.cleanupExpiredData();
	}

	private async optimizeStorageUsage(): Promise<void> {
		await this.storageService.optimizeStorageUsage();
	}

	private estimateStorageUsage(): number {
		return this.storageService.estimateStorageUsage();
	}

	private scheduleStorageCleanup(): void {
		// Implementation for scheduling storage cleanup
		console.log('Scheduling storage cleanup');
	}

	private async loadGlobalMCPCacheFromStorage(): Promise<void> {
		const cached = await this.storageService.loadGlobalMCPCacheFromStorage();
		if (cached) {
			// Set the global cache in MCPService static properties
			const { MCPService } = await import('./services/MCPService');
			MCPService.setGlobalMCPCache(cached.capabilities, cached.expiry);
			console.log('✅ Loaded global MCP cache from storage');
		}
	}

	private async saveGlobalMCPCacheToStorage(capabilities: any, expiry: number): Promise<void> {
		await this.storageService.saveGlobalMCPCacheToStorage(capabilities, expiry);
	}

	private async handleSetUserPreference(sessionId: string, preferenceData: any): Promise<void> {
		await this.contextService.setUserPreference(sessionId, preferenceData);
	}

	private async handleSetSessionPersonality(sessionId: string, personality: string): Promise<void> {
		await this.contextService.setSessionPersonality(sessionId, personality);
	}

	private async handleSetUserContext(sessionId: string, userContext: any): Promise<void> {
		await this.contextService.setUserContext(sessionId, userContext);
	}

	private getSessionContextData(sessionId: string): any {
		return this.contextService.getUserContext(sessionId);
	}
}
