import type { WebSocketMessage, ChatMessage } from '../../types';

export class WebSocketService {
	private activeConnections = new Map<string, WebSocket>();

	constructor(
		private sessions: Map<string, any>,
		private handleUserMessage: (
			webSocket: WebSocket,
			content: string,
			sessionId: string,
			messageId?: string,
			supabaseSessionId?: string,
		) => Promise<void>,
		private handleInterrupt: () => void,
		private handlePause: () => void,
		private handleResume: () => void,
		private handleSetUserPreference: (sessionId: string, preferenceData: any) => Promise<void>,
		private handleSetSessionPersonality: (sessionId: string, personality: string) => Promise<void>,
		private handleSetUserContext: (sessionId: string, userContext: any) => Promise<void>,
		private getSessionContextData: (sessionId: string) => any,
		private generateId: () => string,
	) {}

	async handleWebSocket(
		request: Request,
		sessionId?: string,
		supabaseSessionId?: string,
	): Promise<Response> {
		console.log(
			'🔌 Setting up WebSocket connection for session:',
			sessionId,
			'with Supabase session:',
			supabaseSessionId,
		);
		// @ts-ignore - Cloudflare Workers WebSocketPair
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket];

		(server as any).accept();
		console.log('🔌 WebSocket server accepted');
		this.setupWebSocketHandlers(server, sessionId, supabaseSessionId);

		return new Response(null, {
			status: 101,
			webSocket: client,
		} as any);
	}

	private setupWebSocketHandlers(
		webSocket: WebSocket,
		sessionId?: string,
		supabaseSessionId?: string,
	): void {
		console.log(
			'🔌 Setting up WebSocket event handlers for session:',
			sessionId,
			'with Supabase session:',
			supabaseSessionId,
		);

		// Store the session IDs in the WebSocket for later use
		if (sessionId) {
			(webSocket as any).sessionId = sessionId;
		}
		if (supabaseSessionId) {
			(webSocket as any).supabaseSessionId = supabaseSessionId;
		}

		webSocket.addEventListener('message', async (event) => {
			try {
				console.log('📨 WebSocket message received on server:', event.data);
				const message: WebSocketMessage = JSON.parse(event.data);
				await this.handleWebSocketMessage(webSocket, message, sessionId);
			} catch (error) {
				console.error('Error handling WebSocket message:', error);
				this.sendError(webSocket, 'Invalid message format');
			}
		});

		webSocket.addEventListener('close', (event) => {
			console.log('🔌 WebSocket closed on server:', event.code, event.reason);
			this.cleanupConnection(webSocket);
		});

		webSocket.addEventListener('error', (error) => {
			console.log('❌ WebSocket error on server:', error);
			this.cleanupConnection(webSocket);
		});
	}

	private async handleWebSocketMessage(
		webSocket: WebSocket,
		message: WebSocketMessage,
		urlSessionId?: string,
	): Promise<void> {
		const { type, content, data, messageId, sessionId, supabaseSessionId } = message;

		// Use sessionId from message, or fall back to URL sessionId
		const effectiveSessionId = sessionId || urlSessionId || (webSocket as any).sessionId;

		// Use supabaseSessionId from message, or fall back to WebSocket stored value
		const effectiveSupabaseSessionId = supabaseSessionId || (webSocket as any).supabaseSessionId;

		// Type assertion for enhanced message types
		const messageType = type as WebSocketMessage['type'];

		switch (messageType) {
			case 'message':
				if (content && effectiveSessionId) {
					await this.handleUserMessage(
						webSocket,
						content,
						effectiveSessionId,
						messageId,
						effectiveSupabaseSessionId,
					);
				} else {
					console.warn('⚠️ Missing content or sessionId for message:', {
						content: !!content,
						sessionId: effectiveSessionId,
					});
				}
				break;

			case 'interrupt':
				this.handleInterrupt();
				break;

			case 'pause':
				this.handlePause();
				break;

			case 'resume':
				this.handleResume();
				break;

			case 'status':
				this.sendStatus(webSocket, 'Connected to chat session');
				break;

			case 'set_preference':
				if (data && effectiveSessionId) {
					await this.handleSetUserPreference(effectiveSessionId, data);
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'Preference updated successfully',
						messageId: messageId || '',
					});
				}
				break;

			case 'set_personality':
				if (data && effectiveSessionId) {
					await this.handleSetSessionPersonality(effectiveSessionId, data.personality);
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'AI personality updated for this session',
						messageId: messageId || '',
					});
				}
				break;

			case 'set_user_context':
				if (data && effectiveSessionId) {
					await this.handleSetUserContext(effectiveSessionId, data);
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'User context updated successfully',
						messageId: messageId || '',
					});
				}
				break;

			case 'get_context':
				if (effectiveSessionId) {
					const contextData = this.getSessionContextData(effectiveSessionId);
					this.sendMessage(webSocket, {
						type: 'context_data',
						content: JSON.stringify(contextData),
						data: contextData,
						messageId: messageId || '',
					});
				}
				break;

			default:
				console.warn('Unknown message type:', type);
		}
	}

	sendMessage(webSocket: WebSocket, message: WebSocketMessage): void {
		if (webSocket.readyState === WebSocket.OPEN) {
			webSocket.send(JSON.stringify(message));
		}
	}

	sendError(webSocket: WebSocket, error: string): void {
		this.sendMessage(webSocket, {
			type: 'error',
			content: error,
		});
	}

	sendStatus(webSocket: WebSocket, status: string): void {
		this.sendMessage(webSocket, {
			type: 'status',
			content: status,
		});
	}

	broadcast(message: WebSocketMessage): void {
		for (const webSocket of this.activeConnections.values()) {
			this.sendMessage(webSocket, message);
		}
	}

	cleanupConnection(webSocket: WebSocket): void {
		const sessionId = this.getSessionIdFromWebSocket(webSocket);
		if (sessionId) {
			this.activeConnections.delete(sessionId);
			console.log(`🧹 Cleaned up connection for session: ${sessionId}`);
		}
	}

	private getSessionIdFromWebSocket(webSocket: WebSocket): string | null {
		for (const [sessionId, ws] of this.activeConnections.entries()) {
			if (ws === webSocket) {
				return sessionId;
			}
		}
		return null;
	}

	addConnection(sessionId: string, webSocket: WebSocket): void {
		this.activeConnections.set(sessionId, webSocket);
		console.log(`🔌 Added connection for session: ${sessionId}`);
	}

	getActiveConnections(): Map<string, WebSocket> {
		return this.activeConnections;
	}

	getConnection(sessionId: string): WebSocket | undefined {
		return this.activeConnections.get(sessionId);
	}
}
