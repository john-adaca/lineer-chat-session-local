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

			let sessionMetadata = existingMetadata?.metadata || {
				mcpResponses: [],
				contextAccumulated: {},
				sessionType: 'chat',
				createdFromUI: !!baseSession.supabaseSessionId,
				lastMCPInteraction: null,
				totalMCPActions: 0
			};

			// If we have existing MCP responses but empty contextAccumulated,
			// rebuild the context from the responses
			if (sessionMetadata.mcpResponses?.length > 0 && Object.keys(sessionMetadata.contextAccumulated || {}).length === 0) {
				console.log('🔄 Rebuilding contextAccumulated from existing MCP responses...', {
					responseCount: sessionMetadata.mcpResponses.length,
					sampleActions: sessionMetadata.mcpResponses.slice(0, 3).map(r => r.action)
				});
				sessionMetadata.contextAccumulated = this.rebuildContextFromResponses(sessionMetadata.mcpResponses);
				console.log('✅ Context rebuilt successfully:', {
					responseCount: sessionMetadata.mcpResponses.length,
					contextKeys: Object.keys(sessionMetadata.contextAccumulated),
					contactsCount: sessionMetadata.contextAccumulated.contacts?.length || 0,
					emailsCount: sessionMetadata.contextAccumulated.emails?.length || 0,
					meetingsCount: sessionMetadata.contextAccumulated.meetings?.length || 0
				});
			}

			const session: ChatSession = {
				...baseSession,
				messages: chatMessages.length > 0 ? chatMessages : baseSession.messages,
				metadata: sessionMetadata
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
	 * Rebuild contextAccumulated from existing MCP responses
	 */
	private rebuildContextFromResponses(mcpResponses: any[]): any {
		const contextAccumulated: any = {
			contacts: [],
			emails: [],
			meetings: [],
			tasks: [],
			recentActions: []
		};

		console.log('🔄 Processing', mcpResponses.length, 'MCP responses for context rebuild');

		mcpResponses.forEach((response: any) => {
			const action = response.action?.toLowerCase() || '';
			console.log('🔄 Rebuilding context for action:', action);

			// Accumulate contacts
			if (action.includes('contact') && response.result) {
				const contacts = Array.isArray(response.result) ? response.result : [response.result];
				contacts.forEach((contact: any) => {
					if (contact.id && contact.name) {
						contextAccumulated.contacts.push({
							id: contact.id,
							name: contact.name,
							email: contact.email,
							lastInteraction: response.timestamp,
							source: response.action
						});
						console.log('✅ Rebuilt contact context:', contact.name);
					}
				});
			}

			// Accumulate emails
			if (action.includes('email') && response.result) {
				const emails = Array.isArray(response.result) ? response.result : [response.result];
				emails.forEach((email: any) => {
					// Try to get subject from result, or from parameters if it's a draft
					let subject = email.subject;
					if (!subject && response.parameters?.subject) {
						subject = response.parameters.subject;
					}

					if (email.id || subject) {
						contextAccumulated.emails.push({
							id: email.id,
							subject: subject,
							from: email.from,
							to: email.to || response.parameters?.to,
							timestamp: response.timestamp,
							source: response.action
						});
						console.log('✅ Rebuilt email context:', subject || 'Draft email');
					}
				});
			}

			// Accumulate meetings
			if ((action.includes('calendar') || action.includes('meeting')) && response.result) {
				const meetings = Array.isArray(response.result) ? response.result : [response.result];
				meetings.forEach((meeting: any) => {
					if (meeting.id || meeting.title) {
						contextAccumulated.meetings.push({
							id: meeting.id,
							title: meeting.title,
							startTime: meeting.startTime || meeting.start,
							endTime: meeting.endTime || meeting.end,
							attendees: meeting.attendees || [],
							timestamp: response.timestamp,
							source: response.action
						});
						console.log('✅ Rebuilt meeting context:', meeting.title);
					}
				});
			}

			// Accumulate tasks
			if (action.includes('task') && response.result) {
				const tasks = Array.isArray(response.result) ? response.result : [response.result];
				tasks.forEach((task: any) => {
					if (task.id || task.title) {
						contextAccumulated.tasks.push({
							id: task.id,
							title: task.title,
							status: task.status,
							dueDate: task.dueDate,
							timestamp: response.timestamp,
							source: response.action
						});
						console.log('✅ Rebuilt task context:', task.title);
					}
				});
			}

			// Always add to recent actions
			contextAccumulated.recentActions.push({
				action: response.action,
				timestamp: response.timestamp,
				success: response.success,
				result: response.result
			});
		});

		// Deduplicate and limit arrays
		contextAccumulated.contacts = this.deduplicateById(contextAccumulated.contacts);
		contextAccumulated.emails = contextAccumulated.emails.slice(0, 20);
		contextAccumulated.meetings = contextAccumulated.meetings.slice(0, 10);
		contextAccumulated.tasks = contextAccumulated.tasks.slice(0, 20);
		contextAccumulated.recentActions = contextAccumulated.recentActions.slice(0, 10);

		console.log('✅ Context rebuild complete:', {
			contacts: contextAccumulated.contacts.length,
			emails: contextAccumulated.emails.length,
			meetings: contextAccumulated.meetings.length,
			tasks: contextAccumulated.tasks.length,
			recentActions: contextAccumulated.recentActions.length
		});

		return contextAccumulated;
	}

	/**
	 * Deduplicate array by ID
	 */
	private deduplicateById(array: any[]): any[] {
		return array.filter((item, index, self) =>
			index === self.findIndex((i) => i.id === item.id)
		);
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