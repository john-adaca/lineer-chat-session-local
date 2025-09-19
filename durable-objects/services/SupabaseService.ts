export class SupabaseService {
	private supabaseEnabled: boolean = false;
	private supabaseUrl: string = '';
	private supabaseKey: string = '';

	constructor(
		env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string },
		private messageBuffer: Map<string, any[]>,
		private batchSaveTimeout: Map<string, NodeJS.Timeout>,
		private readonly BATCH_SAVE_DELAY = 2000, // 2 seconds
	) {
		console.log('🔍 [SUPABASE_SERVICE_DEBUG] Initializing SupabaseService...');
		console.log(
			'🔍 [SUPABASE_SERVICE_DEBUG] Received env.SUPABASE_URL:',
			env.SUPABASE_URL ? '✅ Present' : '❌ Missing',
		);
		console.log(
			'🔍 [SUPABASE_SERVICE_DEBUG] Received env.SUPABASE_SERVICE_ROLE_KEY:',
			env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Present' : '❌ Missing',
		);

		if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
			this.supabaseEnabled = true;
			this.supabaseUrl = env.SUPABASE_URL;
			this.supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
			console.log('✅ [SUPABASE_SERVICE_DEBUG] SupabaseService initialized successfully');
			console.log('🔍 [SUPABASE_SERVICE_DEBUG] Supabase URL:', this.supabaseUrl);
			console.log(
				'🔍 [SUPABASE_SERVICE_DEBUG] Service Key (first 10 chars):',
				this.supabaseKey.substring(0, 10) + '...',
			);
		} else {
			console.log(
				'❌ [SUPABASE_SERVICE_DEBUG] SupabaseService initialization failed - missing credentials',
			);
			console.log('🔍 [SUPABASE_SERVICE_DEBUG] Missing credentials:', {
				hasUrl: !!env.SUPABASE_URL,
				hasKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
			});
		}
	}

	async saveActionToSupabase(sessionId: string, actionMetadata: any): Promise<void> {
		console.log('🔍 [SUPABASE_ACTION_DEBUG] Attempting to save action to Supabase...');
		console.log('🔍 [SUPABASE_ACTION_DEBUG] supabaseEnabled:', this.supabaseEnabled);
		console.log('🔍 [SUPABASE_ACTION_DEBUG] supabaseUrl:', this.supabaseUrl);
		console.log(
			'🔍 [SUPABASE_ACTION_DEBUG] supabaseKey (first 10 chars):',
			this.supabaseKey ? this.supabaseKey.substring(0, 10) + '...' : 'Missing',
		);

		if (!this.supabaseEnabled) {
			console.log('⚠️ Supabase not enabled, skipping action save');
			return;
		}

		try {
			const response = await fetch(`${this.supabaseUrl}/rest/v1/chat_actions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.supabaseKey}`,
					apikey: this.supabaseKey,
				},
				body: JSON.stringify({
					session_id: sessionId,
					action_data: actionMetadata,
					created_at: new Date().toISOString(),
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Failed to save action to Supabase:', response.status, errorText);
			} else {
				console.log('✅ Action saved to Supabase');
			}
		} catch (error) {
			console.error('❌ Error saving action to Supabase:', error);
		}
	}

	async saveSessionMetadataToSupabase(sessionId: string, sessionMetadata: any): Promise<void> {
		if (!this.supabaseEnabled) {
			console.log('⚠️ Supabase not enabled, skipping session metadata save');
			return;
		}

		try {
			console.log('🔍 [DEBUG] Attempting to save session metadata:', {
				sessionId,
				metadata: sessionMetadata,
				url: `${this.supabaseUrl}/rest/v1/chat_sessions?id=eq.${sessionId}`,
			});

			// Update the chat_sessions table with the new metadata
			const response = await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions?id=eq.${sessionId}`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.supabaseKey}`,
					apikey: this.supabaseKey,
				},
				body: JSON.stringify({
					metadata: sessionMetadata,
					updated_at: new Date().toISOString(),
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error(
					'❌ Failed to save session metadata to Supabase:',
					response.status,
					errorText,
				);
			} else {
				const result = await response.json();
				console.log(
					'✅ Session metadata saved to Supabase for session:',
					sessionId,
					'Result:',
					result,
				);
			}
		} catch (error) {
			console.error('❌ Error saving session metadata to Supabase:', error);
		}
	}

	addToMessageBuffer(sessionId: string, data: any): void {
		if (!this.messageBuffer.has(sessionId)) {
			this.messageBuffer.set(sessionId, []);
		}

		this.messageBuffer.get(sessionId)!.push(data);

		// Clear existing timeout
		const existingTimeout = this.batchSaveTimeout.get(sessionId);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		// Set new timeout for batch save
		const timeout = setTimeout(() => {
			this.flushMessageBuffer(sessionId);
		}, this.BATCH_SAVE_DELAY);

		this.batchSaveTimeout.set(sessionId, timeout);
	}

	async flushMessageBuffer(sessionId: string): Promise<void> {
		if (!this.supabaseEnabled) {
			console.log('⚠️ Supabase not enabled, skipping message flush');
			return;
		}

		const messages = this.messageBuffer.get(sessionId);
		if (!messages || messages.length === 0) {
			return;
		}

		try {
			// Clear the buffer first to avoid duplicate sends
			this.messageBuffer.set(sessionId, []);

			// Clear the timeout
			const timeout = this.batchSaveTimeout.get(sessionId);
			if (timeout) {
				clearTimeout(timeout);
				this.batchSaveTimeout.delete(sessionId);
			}

			// Prepare batch data
			const batchData = messages.map((message) => ({
				session_id: sessionId,
				message_data: message,
				created_at: new Date().toISOString(),
			}));

			const response = await fetch(`${this.supabaseUrl}/rest/v1/chat_messages`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.supabaseKey}`,
					apikey: this.supabaseKey,
					Prefer: 'return=minimal',
				},
				body: JSON.stringify(batchData),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Failed to save messages to Supabase:', response.status, errorText);

				// Re-add messages to buffer for retry
				this.messageBuffer.set(sessionId, [
					...messages,
					...(this.messageBuffer.get(sessionId) || []),
				]);
			} else {
				console.log(`✅ Flushed ${messages.length} messages to Supabase for session: ${sessionId}`);
			}
		} catch (error) {
			console.error('❌ Error flushing message buffer to Supabase:', error);

			// Re-add messages to buffer for retry
			this.messageBuffer.set(sessionId, [
				...messages,
				...(this.messageBuffer.get(sessionId) || []),
			]);
		}
	}

	async saveMessageToSupabase(sessionId: string, message: any): Promise<void> {
		if (!this.supabaseEnabled) {
			console.log('⚠️ Supabase not enabled, skipping message save');
			return;
		}

		// Add to buffer for batch processing
		this.addToMessageBuffer(sessionId, message);
	}

	async createSupabaseSession(
		sessionId?: string,
		userId?: string,
		workspaceId?: string,
	): Promise<string | null> {
		console.log('🔍 [SUPABASE_SESSION_DEBUG] Attempting to create Supabase session...');
		console.log('🔍 [SUPABASE_SESSION_DEBUG] supabaseEnabled:', this.supabaseEnabled);
		console.log('🔍 [SUPABASE_SESSION_DEBUG] supabaseUrl:', this.supabaseUrl);
		console.log(
			'🔍 [SUPABASE_SESSION_DEBUG] supabaseKey (first 10 chars):',
			this.supabaseKey ? this.supabaseKey.substring(0, 10) + '...' : 'Missing',
		);
		console.log('🔍 [SUPABASE_SESSION_DEBUG] Parameters:', { sessionId, userId, workspaceId });

		if (!this.supabaseEnabled) {
			console.log('⚠️ Supabase not enabled, cannot create session');
			return null;
		}

		try {
			const response = await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.supabaseKey}`,
					apikey: this.supabaseKey,
				},
				body: JSON.stringify({
					id: sessionId || this.generateId(),
					user_id: userId || 'websocket-user',
					workspace_id: workspaceId || 'default-workspace',
					mode: 'text',
					created_at: new Date().toISOString(),
					last_activity: new Date().toISOString(),
					metadata: {
						total_messages: 0,
						voice_messages: 0,
						actions_completed: 0,
						created_via: 'websocket',
					},
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error('❌ Failed to create Supabase session:', response.status, errorText);
				return null;
			}

			const data = await response.json();
			console.log('✅ Created Supabase session:', data[0]?.id);
			return data[0]?.id || null;
		} catch (error) {
			console.error('❌ Error creating Supabase session:', error);
			return null;
		}
	}

	async loadActionHistoryFromSupabase(sessionId: string, session: any): Promise<void> {
		if (!this.supabaseEnabled) {
			console.log('⚠️ Supabase not enabled, cannot load action history');
			return;
		}

		try {
			const response = await fetch(
				`${this.supabaseUrl}/rest/v1/chat_actions?session_id=eq.${sessionId}&order=created_at.desc&limit=50`,
				{
					headers: {
						Authorization: `Bearer ${this.supabaseKey}`,
						apikey: this.supabaseKey,
					},
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				console.error(
					'❌ Failed to load action history from Supabase:',
					response.status,
					errorText,
				);
				return;
			}

			const actions = await response.json();
			if (actions && actions.length > 0) {
				// Initialize actions array if not exists
				if (!session.actions) {
					session.actions = [];
				}

				// Add actions from Supabase (most recent first)
				const supabaseActions = actions.map((action: any) => ({
					...action.action_data,
					source: 'supabase',
					created_at: action.created_at,
				}));

				// Merge with existing actions, avoiding duplicates
				const existingActionIds = new Set(session.actions.map((a: any) => a.id));
				const newActions = supabaseActions.filter(
					(action: any) => !existingActionIds.has(action.id),
				);

				session.actions = [...newActions, ...session.actions];

				// Keep only the last 50 actions
				if (session.actions.length > 50) {
					session.actions = session.actions.slice(0, 50);
				}

				console.log(
					`✅ Loaded ${newActions.length} actions from Supabase for session: ${sessionId}`,
				);
			}
		} catch (error) {
			console.error('❌ Error loading action history from Supabase:', error);
		}
	}

	async loadMessageHistoryFromSupabase(sessionId: string): Promise<any[]> {
		if (!this.supabaseEnabled) {
			console.log('⚠️ Supabase not enabled, cannot load message history');
			return [];
		}

		try {
			const response = await fetch(
				`${this.supabaseUrl}/rest/v1/chat_messages?session_id=eq.${sessionId}&order=created_at.asc&limit=100`,
				{
					headers: {
						Authorization: `Bearer ${this.supabaseKey}`,
						apikey: this.supabaseKey,
					},
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				console.error(
					'❌ Failed to load message history from Supabase:',
					response.status,
					errorText,
				);
				return [];
			}

			const messages = await response.json();
			console.log(`✅ Loaded ${messages.length} messages from Supabase for session: ${sessionId}`);
			return messages.map((msg: any) => msg.message_data);
		} catch (error) {
			console.error('❌ Error loading message history from Supabase:', error);
			return [];
		}
	}

	async updateSessionActivity(sessionId: string): Promise<void> {
		if (!this.supabaseEnabled) {
			return;
		}

		try {
			await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions?id=eq.${sessionId}`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.supabaseKey}`,
					apikey: this.supabaseKey,
				},
				body: JSON.stringify({
					last_activity: new Date().toISOString(),
				}),
			});
		} catch (error) {
			console.error('❌ Error updating session activity in Supabase:', error);
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		if (!this.supabaseEnabled) {
			return;
		}

		try {
			// Delete related data first
			await Promise.all([
				fetch(`${this.supabaseUrl}/rest/v1/chat_actions?session_id=eq.${sessionId}`, {
					method: 'DELETE',
					headers: {
						Authorization: `Bearer ${this.supabaseKey}`,
						apikey: this.supabaseKey,
					},
				}),
				fetch(`${this.supabaseUrl}/rest/v1/chat_messages?session_id=eq.${sessionId}`, {
					method: 'DELETE',
					headers: {
						Authorization: `Bearer ${this.supabaseKey}`,
						apikey: this.supabaseKey,
					},
				}),
			]);

			// Delete the session
			await fetch(`${this.supabaseUrl}/rest/v1/chat_sessions?id=eq.${sessionId}`, {
				method: 'DELETE',
				headers: {
					Authorization: `Bearer ${this.supabaseKey}`,
					apikey: this.supabaseKey,
				},
			});

			console.log(`✅ Deleted session from Supabase: ${sessionId}`);
		} catch (error) {
			console.error('❌ Error deleting session from Supabase:', error);
		}
	}

	// Health check
	async healthCheck(): Promise<{
		healthy: boolean;
		enabled: boolean;
		error?: string;
	}> {
		if (!this.supabaseEnabled) {
			return { healthy: true, enabled: false };
		}

		try {
			const response = await fetch(`${this.supabaseUrl}/rest/v1/`, {
				method: 'HEAD',
				headers: {
					Authorization: `Bearer ${this.supabaseKey}`,
					apikey: this.supabaseKey,
				},
			});

			return {
				healthy: response.ok,
				enabled: true,
				error: response.ok ? undefined : `HTTP ${response.status}`,
			};
		} catch (error) {
			return {
				healthy: false,
				enabled: true,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	// Utility methods
	private generateId(): string {
		return Math.random().toString(36).substring(2) + Date.now().toString(36);
	}

	isEnabled(): boolean {
		return this.supabaseEnabled;
	}

	getMessageBuffer(): Map<string, any[]> {
		return this.messageBuffer;
	}

	getBatchSaveTimeout(): Map<string, NodeJS.Timeout> {
		return this.batchSaveTimeout;
	}
}
