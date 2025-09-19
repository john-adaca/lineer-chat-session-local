import type { ChatSession, MCPResponse, ChatMessage } from '../../types';
import { DatabaseService } from './DatabaseService';
import { MCPResponseAccumulator } from './MCPResponseAccumulator';

export class SessionMetadataManager {
	private databaseService: DatabaseService;
	private mcpAccumulator: MCPResponseAccumulator;

	constructor(env: any) {
		this.databaseService = new DatabaseService(env);
		this.mcpAccumulator = new MCPResponseAccumulator(this.databaseService);
	}

	/**
	 * Initialize session with metadata and messages from database
	 */
	async initializeSession(sessionId: string, baseSession: Omit<ChatSession, 'metadata'>): Promise<ChatSession> {
		try {
			// Try to load existing metadata from database
			const existingMetadata = await this.databaseService.loadSessionMetadata(sessionId);

			// Try to load existing chat messages from database
			const existingMessages = await this.databaseService.loadChatMessages(sessionId);

			// Convert database messages to ChatMessage format
			const chatMessages: ChatMessage[] = existingMessages.map((msg: any) => ({
				id: msg.message_id,
				role: msg.role,
				content: msg.content,
				timestamp: new Date(msg.created_at),
				metadata: msg.metadata || {}
			}));

			const session: ChatSession = {
				...baseSession,
				messages: chatMessages.length > 0 ? chatMessages : baseSession.messages,
				metadata: existingMetadata?.metadata || {
					mcpResponses: [],
					contextAccumulated: {},
					sessionType: 'chat',
					createdFromUI: !!baseSession.supabaseSessionId,
					lastMCPInteraction: null,
					totalMCPActions: 0
				}
			};

			console.log('✅ Session initialized with database data:', {
				sessionId,
				hasExistingMetadata: !!existingMetadata,
				existingMessagesCount: chatMessages.length,
				totalMCPActions: session.metadata?.totalMCPActions || 0
			});

			return session;
		} catch (error) {
			console.error('❌ Failed to initialize session with database data:', error);
			// Return session with default metadata
			return {
				...baseSession,
				metadata: {
					mcpResponses: [],
					contextAccumulated: {},
					sessionType: 'chat',
					createdFromUI: !!baseSession.supabaseSessionId,
					lastMCPInteraction: null,
					totalMCPActions: 0
				}
			};
		}
	}

	/**
	 * Save session to database
	 */
	async saveSession(session: ChatSession): Promise<void> {
		await this.databaseService.saveSessionMetadata(session);
	}

	/**
	 * Add MCP response to session
	 */
	async addMCPResponse(session: ChatSession, action: string, parameters: any, result: any, success: boolean, error?: string): Promise<void> {
		await this.mcpAccumulator.addMCPResponse(session, action, parameters, result, success, error);
	}

	/**
	 * Get accumulated context for AI
	 */
	getAccumulatedContext(session: ChatSession): string {
		return this.mcpAccumulator.getAccumulatedContext(session);
	}

	/**
	 * Get MCP statistics
	 */
	getMCPStatistics(session: ChatSession): any {
		return this.mcpAccumulator.getMCPStatistics(session);
	}

	/**
	 * Get MCP response history
	 */
	async getMCPResponseHistory(sessionId: string): Promise<MCPResponse[]> {
		return await this.databaseService.getMCPResponseHistory(sessionId);
	}

	/**
	 * Update session activity
	 */
	async updateSessionActivity(session: ChatSession): Promise<void> {
		try {
			session.lastActivity = new Date();

			// Update in database (lightweight update)
			const updateData = {
				id: session.id,
				lastActivity: session.lastActivity
			};

			const response = await fetch(`${this.databaseService['supabaseUrl']}/rest/v1/chat_sessions?id=eq.${session.id}`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.databaseService['supabaseKey']}`,
					'apikey': this.databaseService['supabaseKey']
				},
				body: JSON.stringify(updateData)
			});

			if (!response.ok) {
				console.warn('⚠️ Failed to update session activity:', response.status);
			}
		} catch (error) {
			console.warn('⚠️ Failed to update session activity:', error);
		}
	}

	/**
	 * Save a chat message to database
	 */
	async saveChatMessage(sessionId: string, message: ChatMessage, userId?: string, workspaceId?: string): Promise<void> {
		await this.databaseService.saveChatMessage(sessionId, message, userId, workspaceId);
	}

	/**
	 * Get session summary with metadata
	 */
	getSessionSummary(session: ChatSession): any {
		if (!session.metadata) {
			return {
				sessionId: session.id,
				messageCount: session.messages.length,
				actionCount: session.actions.length,
				isActive: session.isActive,
				createdAt: session.createdAt,
				lastActivity: session.lastActivity
			};
		}

		const stats = this.getMCPStatistics(session);
		const context = this.getAccumulatedContext(session);

		return {
			sessionId: session.id,
			messageCount: session.messages.length,
			actionCount: session.actions.length,
			isActive: session.isActive,
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
			metadata: {
				sessionType: session.metadata.sessionType,
				createdFromUI: session.metadata.createdFromUI,
				totalMCPActions: session.metadata.totalMCPActions,
				lastMCPInteraction: session.metadata.lastMCPInteraction,
				mcpStatistics: stats,
				accumulatedContext: context.substring(0, 200) + (context.length > 200 ? '...' : '')
			}
		};
	}
}