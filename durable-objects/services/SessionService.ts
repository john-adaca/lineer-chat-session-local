import type { ChatSession } from '../../types';
import type { MCPEntityContext } from '../types/MCPTypes';

export class SessionService {
	private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
	private lastActivity = Date.now();

	constructor(
		private sessions: Map<string, ChatSession>,
		private workspaceId: string | null,
		private currentUserId: string | null,
		private supabaseEnabled: boolean,
		private loadActionHistoryFromStorage: (
			sessionId: string,
			session: ChatSession,
		) => Promise<void>,
		private loadActionHistoryFromSupabase: (sessionId: string, session: any) => Promise<void>,
		private initializeSessionContext: (sessionId: string, workspaceId: string) => Promise<void>,
		private persistLastActivityToStorage: () => Promise<void>,
		private createSupabaseSession: (
			sessionId?: string,
			userId?: string,
			workspaceId?: string,
		) => Promise<string | null>,
	) {}

	updateIds(workspaceId: string, userId: string): void {
		this.workspaceId = workspaceId;
		this.currentUserId = userId;
		console.log('✅ SessionService updated with IDs:', { workspaceId, userId });
	}

	async getOrCreateSession(
		sessionId: string,
		supabaseSessionId?: string,
		workspaceId?: string,
		userId?: string,
	): Promise<ChatSession> {
		let session = this.sessions.get(sessionId);

		if (!session) {
			session = {
				id: sessionId,
				supabaseSessionId: supabaseSessionId || '',
				userId: userId || this.currentUserId || 'websocket-user',
				workspaceId: workspaceId || this.workspaceId || 'default-workspace',
				messages: [],
				actions: [],
				isActive: true,
				createdAt: new Date(),
				lastActivity: new Date(),
			};

			this.sessions.set(sessionId, session);

			// Load action history from Cloudflare storage (primary) and Supabase (backup)
			this.loadActionHistoryFromStorage(sessionId, session).catch((error) =>
				console.warn('Failed to load action history from storage:', error),
			);

			if (this.supabaseEnabled && supabaseSessionId) {
				// Use existing Supabase session
				this.loadActionHistoryFromSupabase(supabaseSessionId, session).catch((error) =>
					console.warn('Failed to load action history from Supabase:', error),
				);
			} else if (this.supabaseEnabled && !supabaseSessionId) {
				// Only create Supabase session if we're in a WebSocket context (not from frontend)
				// This prevents double session creation
				console.log(
					'⚠️ No Supabase session ID provided - skipping Supabase session creation to prevent duplicates',
				);
				console.log(
					'💡 Frontend should create the Supabase session first, then pass the ID to WebSocket',
				);
			}

			// Initialize session context with contacts for better AI functionality
			this.initializeSessionContext(sessionId, session.workspaceId).catch((error) =>
				console.warn('Failed to initialize session context:', error),
			);
		} else {
			session.lastActivity = new Date();
			this.lastActivity = Date.now();
			// Persist activity to Cloudflare storage
			this.persistLastActivityToStorage().catch((error) => {
				console.warn('Failed to persist last activity:', error);
			});
		}

		return session;
	}

	private async createSupabaseSessionForSession(
		sessionId: string,
		session: ChatSession,
	): Promise<void> {
		try {
			// Call the Supabase service to create a session
			const supabaseSessionId = await this.createSupabaseSession(
				sessionId,
				session.userId,
				session.workspaceId,
			);
			if (supabaseSessionId) {
				session.supabaseSessionId = supabaseSessionId;
				console.log('✅ Created Supabase session for:', sessionId, 'ID:', supabaseSessionId);
			}
		} catch (error) {
			console.error('❌ Failed to create Supabase session:', error);
		}
	}

	cleanupInactiveSessions(): void {
		const now = Date.now();
		const inactiveSessions: string[] = [];

		for (const [sessionId, session] of this.sessions.entries()) {
			const timeSinceLastActivity = now - session.lastActivity.getTime();
			if (timeSinceLastActivity > this.SESSION_TIMEOUT) {
				inactiveSessions.push(sessionId);
			}
		}

		for (const sessionId of inactiveSessions) {
			this.sessions.delete(sessionId);
			console.log(`🧹 Cleaned up inactive session: ${sessionId}`);
		}
	}

	getSession(sessionId: string): ChatSession | undefined {
		return this.sessions.get(sessionId);
	}

	updateSession(sessionId: string, updates: Partial<ChatSession>): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			Object.assign(session, updates);
			session.lastActivity = new Date();
			this.lastActivity = Date.now();
		}
	}

	deleteSession(sessionId: string): boolean {
		return this.sessions.delete(sessionId);
	}

	getAllSessions(): Map<string, ChatSession> {
		return this.sessions;
	}

	getActiveSessionsCount(): number {
		return this.sessions.size;
	}

	getLastActivity(): number {
		return this.lastActivity;
	}

	updateLastActivity(): void {
		this.lastActivity = Date.now();
	}

	// Session validation
	isSessionActive(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		const now = Date.now();
		const timeSinceLastActivity = now - session.lastActivity.getTime();
		return timeSinceLastActivity <= this.SESSION_TIMEOUT;
	}

	// Session statistics
	getSessionStats(): {
		totalSessions: number;
		activeSessions: number;
		inactiveSessions: number;
		oldestSession: Date | null;
		newestSession: Date | null;
	} {
		const now = Date.now();
		let activeSessions = 0;
		let inactiveSessions = 0;
		let oldestSession: Date | null = null;
		let newestSession: Date | null = null;

		for (const session of this.sessions.values()) {
			const timeSinceLastActivity = now - session.lastActivity.getTime();
			if (timeSinceLastActivity <= this.SESSION_TIMEOUT) {
				activeSessions++;
			} else {
				inactiveSessions++;
			}

			if (!oldestSession || session.createdAt < oldestSession) {
				oldestSession = session.createdAt;
			}
			if (!newestSession || session.createdAt > newestSession) {
				newestSession = session.createdAt;
			}
		}

		return {
			totalSessions: this.sessions.size,
			activeSessions,
			inactiveSessions,
			oldestSession,
			newestSession,
		};
	}

	// Memory usage estimation
	estimateMemoryUsage(): number {
		let totalSize = 0;

		for (const session of this.sessions.values()) {
			totalSize += JSON.stringify(session).length;
		}

		return totalSize;
	}

	// Cleanup methods
	cleanupOldSessions(maxAge: number = 24 * 60 * 60 * 1000): void {
		const now = Date.now();
		const oldSessions: string[] = [];

		for (const [sessionId, session] of this.sessions.entries()) {
			const sessionAge = now - session.createdAt.getTime();
			if (sessionAge > maxAge) {
				oldSessions.push(sessionId);
			}
		}

		for (const sessionId of oldSessions) {
			this.sessions.delete(sessionId);
			console.log(`🧹 Cleaned up old session: ${sessionId}`);
		}
	}

	// Session search and filtering
	findSessionsByUser(userId: string): ChatSession[] {
		const userSessions: ChatSession[] = [];
		for (const session of this.sessions.values()) {
			if (session.userId === userId) {
				userSessions.push(session);
			}
		}
		return userSessions;
	}

	findSessionsByWorkspace(workspaceId: string): ChatSession[] {
		const workspaceSessions: ChatSession[] = [];
		for (const session of this.sessions.values()) {
			if (session.workspaceId === workspaceId) {
				workspaceSessions.push(session);
			}
		}
		return workspaceSessions;
	}

	// Session health check
	performHealthCheck(): {
		healthy: boolean;
		issues: string[];
		recommendations: string[];
	} {
		const issues: string[] = [];
		const recommendations: string[] = [];

		// Check for inactive sessions
		const stats = this.getSessionStats();
		if (stats.inactiveSessions > stats.activeSessions) {
			issues.push(
				`More inactive sessions (${stats.inactiveSessions}) than active (${stats.activeSessions})`,
			);
			recommendations.push('Consider cleaning up inactive sessions');
		}

		// Check memory usage
		const memoryUsage = this.estimateMemoryUsage();
		const maxMemoryUsage = 10 * 1024 * 1024; // 10MB
		if (memoryUsage > maxMemoryUsage) {
			issues.push(`High memory usage: ${Math.round(memoryUsage / 1024)}KB`);
			recommendations.push('Consider cleaning up old sessions or reducing session data');
		}

		// Check for very old sessions
		if (stats.oldestSession) {
			const oldestAge = Date.now() - stats.oldestSession.getTime();
			const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
			if (oldestAge > maxAge) {
				issues.push(
					`Very old session exists: ${Math.round(oldestAge / (24 * 60 * 60 * 1000))} days old`,
				);
				recommendations.push('Consider cleaning up very old sessions');
			}
		}

		return {
			healthy: issues.length === 0,
			issues,
			recommendations,
		};
	}
}
