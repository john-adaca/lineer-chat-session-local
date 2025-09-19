import type { ChatSession, MCPResponse } from '../../types';

export interface SessionMetadata {
	id: string;
	supabaseSessionId: string;
	userId: string;
	workspaceId: string;
	metadata: {
		mcpResponses: MCPResponse[];
		contextAccumulated: Record<string, any>;
		sessionType: string;
		createdFromUI: boolean;
		lastMCPInteraction: Date | null;
		totalMCPActions: number;
	};
	createdAt: Date;
	lastActivity: Date;
	isActive: boolean;
}

export class DatabaseService {
	private supabaseUrl: string;
	private supabaseKey: string;

	constructor(env: any) {
		this.supabaseUrl = env.SUPABASE_URL;
		this.supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
	}

	/**
	 * Save session metadata to database
	 */
	async saveSessionMetadata(session: ChatSession): Promise<void> {
		try {
			// Use the actual database schema
			const sessionData = {
				id: session.id,
				user_id: session.userId,
				workspace_id: session.workspaceId,
				mode: 'text', // Default mode
				metadata: session.metadata || {
					mcpResponses: [],
					contextAccumulated: {},
					sessionType: 'chat',
					createdFromUI: !!session.supabaseSessionId,
					lastMCPInteraction: null,
					totalMCPActions: 0
				}
			};

			// First try to update existing session
			let response = await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions?id=eq.${sessionData.id}`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.supabaseKey}`,
					'apikey': this.supabaseKey
				},
				body: JSON.stringify({
					metadata: sessionData.metadata,
					updated_at: new Date().toISOString()
				})
			});

			// If no existing session (404), create new one
			if (response.status === 404) {
				response = await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this.supabaseKey}`,
						'apikey': this.supabaseKey
					},
					body: JSON.stringify(sessionData)
				});
			}

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Failed to save session metadata:', errorText);
				throw new Error(`Database save failed: ${response.status}`);
			}

			console.log('✅ Session metadata saved to database:', {
				sessionId: session.id,
				userId: sessionData.user_id,
				workspaceId: sessionData.workspace_id,
				hasMetadata: !!sessionData.metadata,
				totalMCPActions: sessionData.metadata?.totalMCPActions || 0
			});
		} catch (error) {
			console.error('❌ Database service error:', error);
			// Don't throw - we don't want database failures to break chat
		}
	}

	/**
	 * Load session metadata from database
	 */
	async loadSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
		try {
			const response = await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions?id=eq.${sessionId}`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.supabaseKey}`,
					'apikey': this.supabaseKey
				}
			});

			if (!response.ok) {
				console.warn('⚠️ No existing session metadata found:', {
					sessionId,
					status: response.status,
					statusText: response.statusText
				});
				return null;
			}

			const data = await response.json();
			return data.length > 0 ? data[0] : null;
		} catch (error) {
			console.error('❌ Failed to load session metadata:', error);
			return null;
		}
	}

	/**
	 * Update MCP responses in session metadata
	 */
	async updateMCPResponses(sessionId: string, mcpResponse: MCPResponse, userId?: string, workspaceId?: string): Promise<void> {
		try {
			// First load existing metadata
			const existing = await this.loadSessionMetadata(sessionId);
			const metadata = existing?.metadata || {
				mcpResponses: [],
				contextAccumulated: {},
				sessionType: 'chat',
				createdFromUI: false,
				lastMCPInteraction: null,
				totalMCPActions: 0
			};

			// Add new MCP response
			metadata.mcpResponses.push(mcpResponse);
			metadata.lastMCPInteraction = new Date();
			metadata.totalMCPActions = metadata.mcpResponses.length;

			// Try to update existing session first
			let response = await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions?id=eq.${sessionId}`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.supabaseKey}`,
					'apikey': this.supabaseKey
				},
				body: JSON.stringify({
					metadata: metadata,
					updated_at: new Date().toISOString()
				})
			});

			// If session doesn't exist (404), create it
			if (response.status === 404) {
				console.log('📝 Session not found in database, creating for MCP update:', sessionId);

				const sessionData = {
					id: sessionId,
					user_id: userId || 'system',
					workspace_id: workspaceId || 'default',
					mode: 'text',
					metadata: metadata
				};

				response = await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this.supabaseKey}`,
						'apikey': this.supabaseKey
					},
					body: JSON.stringify(sessionData)
				});
			}

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Failed to update MCP responses:', {
					sessionId,
					status: response.status,
					error: errorText
				});
				throw new Error(`Failed to update MCP responses: ${response.status}`);
			}

			console.log('✅ MCP response saved to database:', {
				sessionId,
				action: mcpResponse.action,
				success: mcpResponse.success,
				totalMCPActions: metadata.totalMCPActions
			});
		} catch (error) {
			console.error('❌ Failed to update MCP responses:', error);
		}
	}

	/**
	 * Get MCP response history for a session
	 */
	async getMCPResponseHistory(sessionId: string): Promise<MCPResponse[]> {
		try {
			const existing = await this.loadSessionMetadata(sessionId);
			return existing?.metadata?.mcpResponses || [];
		} catch (error) {
			console.error('❌ Failed to get MCP response history:', error);
			return [];
		}
	}

	/**
	 * Load existing chat messages for a session
	 */
	async loadChatMessages(sessionId: string): Promise<any[]> {
		try {
			const response = await fetch(`${this.supabaseUrl}/rest/v1/chat_messages?session_id=eq.${sessionId}&order=created_at.asc`, {
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.supabaseKey}`,
					'apikey': this.supabaseKey
				}
			});

			if (!response.ok) {
				console.warn('⚠️ No existing chat messages found:', sessionId);
				return [];
			}

			const messages = await response.json();
			console.log(`✅ Loaded ${messages.length} existing chat messages for session: ${sessionId}`);
			return messages;
		} catch (error) {
			console.error('❌ Failed to load chat messages:', error);
			return [];
		}
	}

	/**
	 * Save a new chat message to database
	 */
	async saveChatMessage(sessionId: string, message: any, userId?: string, workspaceId?: string): Promise<void> {
		try {
			const messageData = {
				session_id: sessionId,
				user_id: userId || message.userId || 'system',
				workspace_id: workspaceId || message.workspaceId || 'default',
				text: message.content,
				mode: 'text', // Default to text mode
				is_own_message: message.role === 'user',
				sender_name: message.role === 'user' ? 'User' : 'Assistant',
				actions: message.metadata?.actions || [],
				created_at: message.timestamp || new Date().toISOString()
			};

			const response = await fetch(`${this.supabaseUrl}/rest/v1/chat_messages`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.supabaseKey}`,
					'apikey': this.supabaseKey,
					'Prefer': 'return=minimal'
				},
				body: JSON.stringify(messageData)
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Failed to save chat message:', errorText);
				throw new Error(`Database save failed: ${response.status}`);
			}

			console.log('✅ Chat message saved to database:', {
				messageId: message.id,
				role: message.role,
				contentLength: message.content?.length || 0,
				contentPreview: message.content?.substring(0, 100) + (message.content?.length > 100 ? '...' : ''),
				isOwnMessage: message.role === 'user'
			});
		} catch (error) {
			console.error('❌ Database service error saving message:', error);
			// Don't throw - we don't want database failures to break chat
		}
	}
}