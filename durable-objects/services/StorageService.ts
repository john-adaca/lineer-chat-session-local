// @ts-ignore - Cloudflare Workers types
import type { DurableObjectStorage } from 'cloudflare:workers';
import type { MCPEntityContext, MCPCacheEntry } from '../types/MCPTypes';

export class StorageService {
	private readonly STORAGE_KEYS = {
		SESSIONS: 'sessions',
		MCP_CACHE: 'mcp_cache',
		MCP_CAPABILITIES: 'mcp_capabilities',
		MCP_CAPABILITIES_EXPIRY: 'mcp_capabilities_expiry',
		SESSION_ENTITIES: 'session_entities',
		USER_PREFERENCES: 'user_preferences',
		CONVERSATION_CONTEXT: 'conversation_context',
		SESSION_PERSONALITIES: 'session_personalities',
		LAST_ACTIVITY: 'last_activity',
	};

	constructor(
		private storage: DurableObjectStorage | null,
		private sessions: Map<string, any>,
		private sessionEntities: Map<string, MCPEntityContext>,
		private mcpResponseCache: Map<string, MCPCacheEntry>,
		private userPreferences: Map<string, any>,
		private conversationContext: Map<string, any>,
		private sessionPersonalities: Map<string, string>,
		private lastActivity: number,
	) {}

	async initializeStorage(): Promise<void> {
		if (!this.storage) {
			console.warn('⚠️ Storage not available - running in memory-only mode');
			return;
		}

		try {
			console.log('🔄 Initializing storage...');

			// Load all data from storage
			await Promise.all([
				this.loadSessionsFromStorage(),
				this.loadSessionEntitiesFromStorage(),
				this.loadMCPCacheFromStorage(),
				this.loadUserPreferencesFromStorage(),
				this.loadConversationContextFromStorage(),
				this.loadSessionPersonalitiesFromStorage(),
				this.loadLastActivityFromStorage(),
			]);

			console.log('✅ Storage initialized successfully');
		} catch (error) {
			console.error('❌ Failed to initialize storage:', error);
		}
	}

	// Session Management
	async loadSessionsFromStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const sessionsData = await this.storage.get(this.STORAGE_KEYS.SESSIONS);
			if (sessionsData) {
				const sessions = JSON.parse(sessionsData as string);
				for (const [id, session] of Object.entries(sessions)) {
					this.sessions.set(id, session);
				}
				console.log('✅ Loaded sessions from storage:', this.sessions.size);
			}
		} catch (error) {
			console.error('❌ Failed to load sessions from storage:', error);
		}
	}

	async saveSessionsToStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const sessionsObj = Object.fromEntries(this.sessions);
			await this.storage.put(this.STORAGE_KEYS.SESSIONS, JSON.stringify(sessionsObj));
			console.log('✅ Saved sessions to storage');
		} catch (error) {
			console.error('❌ Failed to save sessions to storage:', error);
		}
	}

	// MCP Entity Management
	async loadSessionEntitiesFromStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const entitiesData = await this.storage.get(this.STORAGE_KEYS.SESSION_ENTITIES);
			if (entitiesData) {
				const entities = JSON.parse(entitiesData as string);
				for (const [id, entity] of Object.entries(entities)) {
					this.sessionEntities.set(id, entity as MCPEntityContext);
				}
				console.log('✅ Loaded session entities from storage:', this.sessionEntities.size);
			}
		} catch (error) {
			console.error('❌ Failed to load session entities from storage:', error);
		}
	}

	async persistSessionEntitiesToStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const entitiesObj = Object.fromEntries(this.sessionEntities);
			await this.storage.put(this.STORAGE_KEYS.SESSION_ENTITIES, JSON.stringify(entitiesObj));
			console.log('✅ Persisted session entities to storage');
		} catch (error) {
			console.error('❌ Failed to persist session entities to storage:', error);
		}
	}

	// MCP Cache Management
	async loadMCPCacheFromStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const cacheData = await this.storage.get(this.STORAGE_KEYS.MCP_CACHE);
			if (cacheData) {
				const cache = JSON.parse(cacheData as string);
				for (const [key, entry] of Object.entries(cache)) {
					this.mcpResponseCache.set(key, entry as MCPCacheEntry);
				}
				console.log('✅ Loaded MCP cache from storage:', this.mcpResponseCache.size);
			}
		} catch (error) {
			console.error('❌ Failed to load MCP cache from storage:', error);
		}
	}

	async persistMCPCacheToStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const cacheObj = Object.fromEntries(this.mcpResponseCache);
			await this.storage.put(this.STORAGE_KEYS.MCP_CACHE, JSON.stringify(cacheObj));
			console.log('✅ Persisted MCP cache to storage');
		} catch (error) {
			console.error('❌ Failed to persist MCP cache to storage:', error);
		}
	}

	// User Preferences Management
	async loadUserPreferencesFromStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const prefsData = await this.storage.get(this.STORAGE_KEYS.USER_PREFERENCES);
			if (prefsData) {
				const prefs = JSON.parse(prefsData as string);
				for (const [id, pref] of Object.entries(prefs)) {
					this.userPreferences.set(id, pref);
				}
				console.log('✅ Loaded user preferences from storage:', this.userPreferences.size);
			}
		} catch (error) {
			console.error('❌ Failed to load user preferences from storage:', error);
		}
	}

	async persistUserPreferencesToStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const prefsObj = Object.fromEntries(this.userPreferences);
			await this.storage.put(this.STORAGE_KEYS.USER_PREFERENCES, JSON.stringify(prefsObj));
			console.log('✅ Persisted user preferences to storage');
		} catch (error) {
			console.error('❌ Failed to persist user preferences to storage:', error);
		}
	}

	// Conversation Context Management
	async loadConversationContextFromStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const contextData = await this.storage.get(this.STORAGE_KEYS.CONVERSATION_CONTEXT);
			if (contextData) {
				const context = JSON.parse(contextData as string);
				for (const [id, ctx] of Object.entries(context)) {
					this.conversationContext.set(id, ctx);
				}
				console.log('✅ Loaded conversation context from storage:', this.conversationContext.size);
			}
		} catch (error) {
			console.error('❌ Failed to load conversation context from storage:', error);
		}
	}

	async persistConversationContextToStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const contextObj = Object.fromEntries(this.conversationContext);
			await this.storage.put(this.STORAGE_KEYS.CONVERSATION_CONTEXT, JSON.stringify(contextObj));
			console.log('✅ Persisted conversation context to storage');
		} catch (error) {
			console.error('❌ Failed to persist conversation context to storage:', error);
		}
	}

	// Session Personalities Management
	async loadSessionPersonalitiesFromStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const personalitiesData = await this.storage.get(this.STORAGE_KEYS.SESSION_PERSONALITIES);
			if (personalitiesData) {
				const personalities = JSON.parse(personalitiesData as string);
				for (const [id, personality] of Object.entries(personalities)) {
					this.sessionPersonalities.set(id, personality as string);
				}
				console.log(
					'✅ Loaded session personalities from storage:',
					this.sessionPersonalities.size,
				);
			}
		} catch (error) {
			console.error('❌ Failed to load session personalities from storage:', error);
		}
	}

	async persistSessionPersonalitiesToStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const personalitiesObj = Object.fromEntries(this.sessionPersonalities);
			await this.storage.put(
				this.STORAGE_KEYS.SESSION_PERSONALITIES,
				JSON.stringify(personalitiesObj),
			);
			console.log('✅ Persisted session personalities to storage');
		} catch (error) {
			console.error('❌ Failed to persist session personalities to storage:', error);
		}
	}

	// Last Activity Management
	async loadLastActivityFromStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			const activityData = await this.storage.get(this.STORAGE_KEYS.LAST_ACTIVITY);
			if (activityData) {
				this.lastActivity = activityData as number;
				console.log('✅ Loaded last activity from storage:', new Date(this.lastActivity));
			}
		} catch (error) {
			console.error('❌ Failed to load last activity from storage:', error);
		}
	}

	async persistLastActivityToStorage(): Promise<void> {
		if (!this.storage) return;

		try {
			await this.storage.put(this.STORAGE_KEYS.LAST_ACTIVITY, this.lastActivity);
			console.log('✅ Persisted last activity to storage');
		} catch (error) {
			console.error('❌ Failed to persist last activity to storage:', error);
		}
	}

	// Session Actions Management
	async loadSessionActionsFromStorage(sessionId: string): Promise<any[]> {
		if (!this.storage) return [];

		try {
			const actionsData = await this.storage.get(`session_actions_${sessionId}`);
			if (actionsData) {
				return JSON.parse(actionsData as string);
			}
		} catch (error) {
			console.error('❌ Failed to load session actions from storage:', error);
		}

		return [];
	}

	async persistSessionActionsToStorage(sessionId: string, actions: any[]): Promise<void> {
		if (!this.storage) return;

		try {
			await this.storage.put(`session_actions_${sessionId}`, JSON.stringify(actions));
			console.log('✅ Persisted session actions to storage for session:', sessionId);
		} catch (error) {
			console.error('❌ Failed to persist session actions to storage:', error);
		}
	}

	// Global MCP Cache Management
	async loadGlobalMCPCacheFromStorage(): Promise<{ capabilities: any; expiry: number } | null> {
		if (!this.storage) return null;

		try {
			const capabilitiesData = await this.storage.get(this.STORAGE_KEYS.MCP_CAPABILITIES);
			const expiryData = await this.storage.get(this.STORAGE_KEYS.MCP_CAPABILITIES_EXPIRY);

			if (capabilitiesData && expiryData) {
				const capabilities = JSON.parse(capabilitiesData as string);
				const expiry = expiryData as number;

				console.log('✅ Loaded global MCP cache from storage');
				return { capabilities, expiry };
			}
		} catch (error) {
			console.error('❌ Failed to load global MCP cache from storage:', error);
		}

		return null;
	}

	async saveGlobalMCPCacheToStorage(capabilities: any, expiry: number): Promise<void> {
		if (!this.storage) return;

		try {
			await Promise.all([
				this.storage.put(this.STORAGE_KEYS.MCP_CAPABILITIES, JSON.stringify(capabilities)),
				this.storage.put(this.STORAGE_KEYS.MCP_CAPABILITIES_EXPIRY, expiry),
			]);
			console.log('✅ Saved global MCP cache to storage');
		} catch (error) {
			console.error('❌ Failed to save global MCP cache to storage:', error);
		}
	}

	// Cleanup and Optimization
	async cleanupExpiredData(): Promise<void> {
		if (!this.storage) return;

		try {
			const now = Date.now();
			const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

			// Clean up expired sessions
			for (const [sessionId, session] of this.sessions.entries()) {
				if (now - session.lastActivity.getTime() > SESSION_TIMEOUT) {
					this.sessions.delete(sessionId);
					this.sessionEntities.delete(sessionId);
					console.log('🧹 Cleaned up expired session:', sessionId);
				}
			}

			// Clean up expired MCP cache entries
			for (const [key, entry] of this.mcpResponseCache.entries()) {
				if (now > entry.expiry) {
					this.mcpResponseCache.delete(key);
				}
			}

			console.log('✅ Cleaned up expired data');
		} catch (error) {
			console.error('❌ Failed to cleanup expired data:', error);
		}
	}

	async optimizeStorageUsage(): Promise<void> {
		if (!this.storage) return;

		try {
			// Estimate storage usage
			const estimatedSize = this.estimateStorageUsage();
			const MAX_STORAGE_SIZE = 100 * 1024; // 100KB

			if (estimatedSize > MAX_STORAGE_SIZE) {
				console.log('🧹 Storage usage exceeds limit, optimizing...');

				// Clean up old session data
				await this.cleanupExpiredData();

				// Limit session entities
				for (const [sessionId, entities] of this.sessionEntities.entries()) {
					if (entities.contacts.length > 50) {
						entities.contacts = entities.contacts.slice(-50);
					}
					if (entities.emails.length > 50) {
						entities.emails = entities.emails.slice(-50);
					}
					if (entities.meetings.length > 50) {
						entities.meetings = entities.meetings.slice(-50);
					}
				}

				// Persist optimized data
				await this.persistSessionEntitiesToStorage();
				await this.persistMCPCacheToStorage();

				console.log('✅ Storage optimized');
			}
		} catch (error) {
			console.error('❌ Failed to optimize storage usage:', error);
		}
	}

	estimateStorageUsage(): number {
		let size = 0;

		// Estimate size of sessions
		for (const session of this.sessions.values()) {
			size += JSON.stringify(session).length;
		}

		// Estimate size of session entities
		for (const entities of this.sessionEntities.values()) {
			size += JSON.stringify(entities).length;
		}

		// Estimate size of MCP cache
		for (const entry of this.mcpResponseCache.values()) {
			size += JSON.stringify(entry).length;
		}

		return size;
	}

	// Getters for external access
	getStorageKeys() {
		return this.STORAGE_KEYS;
	}

	isStorageAvailable(): boolean {
		return this.storage !== null;
	}
}
