// @ts-ignore - Cloudflare Workers types
import type { DurableObjectStorage } from 'cloudflare:workers';
import type { WebSocketMessage } from '../../types';
import type {
	MCPEntityContext,
	MCPCacheEntry,
	MCPStatusUpdate,
	MCPCapabilities,
	MCPActionMetadata,
	MCPCallOptions,
} from '../types/MCPTypes';
import { ContextSummarizer } from '../../lib/contextSummarizer';
import { enhanceMCPResultForUser } from '../../lib/responseFormatter';

// We'll load MCP capabilities from static JSON files using dynamic imports

export class MCPService {
	private mcpResponseCache = new Map<string, MCPCacheEntry>();
	private sessionEntities = new Map<string, MCPEntityContext>();
	private readonly MCP_RESPONSE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
	private readonly MCP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
	private readonly MCP_MEMORY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

	// Global MCP cache shared across all sessions
	private static globalMCPCapabilitiesCache: any = null;
	private static globalMCPCacheExpiry: number = 0;

	/**
	 * Set the global MCP cache (used when loading from storage)
	 */
	static setGlobalMCPCache(capabilities: any, expiry: number): void {
		MCPService.globalMCPCapabilitiesCache = capabilities;
		MCPService.globalMCPCacheExpiry = expiry;
	}

	/**
	 * Clear the global MCP cache to force immediate reload of capabilities
	 */
	static clearGlobalMCPCache(): void {
		console.log('🔄 Clearing global MCP capabilities cache');
		MCPService.globalMCPCapabilitiesCache = null;
		MCPService.globalMCPCacheExpiry = 0;
	}

	constructor(
		private env: { MCP_SERVER_URL: string },
		private storage: DurableObjectStorage | null,
		private sessions: Map<string, any>,
		private workspaceId: string | null,
		private currentUserId: string | null,
		private supabaseEnabled: boolean,
		private sendMessage: (webSocket: any, message: WebSocketMessage) => void,
		private saveActionToSupabase: (sessionId: string, actionMetadata: any) => Promise<void>,
		private saveSessionMetadataToSupabase: (
			sessionId: string,
			sessionMetadata: any,
		) => Promise<void>,
		private persistSessionActionsToStorage: (sessionId: string, actions: any[]) => Promise<void>,
		private persistSessionEntitiesToStorage: () => Promise<void>,
		private persistMCPCacheToStorage: () => Promise<void>,
		private saveGlobalMCPCacheToStorage: (capabilities: any, expiry: number) => Promise<void>,
		private loadGlobalMCPCacheFromStorage: () => Promise<{
			capabilities: any;
			expiry: number;
		} | null>,
	) {}

	/**
	 * Update the workspace and user IDs (called when they become available)
	 */
	updateIds(workspaceId: string | null, currentUserId: string | null): void {
		this.workspaceId = workspaceId;
		this.currentUserId = currentUserId;
		console.log('🔄 Updated MCP service IDs:', { workspaceId, currentUserId });
	}

	/**
	 * Force reload of MCP capabilities by clearing cache
	 */
	async forceReloadCapabilities(): Promise<MCPCapabilities> {
		MCPService.clearGlobalMCPCache();
		return await this.getMCPCapabilities();
	}

	async getMCPCapabilities(): Promise<MCPCapabilities> {
		// Check global static cache first (shared across all sessions)
		const now = Date.now();
		if (MCPService.globalMCPCapabilitiesCache && now < MCPService.globalMCPCacheExpiry) {
			console.log('🔄 Using global cached MCP capabilities');
			return MCPService.globalMCPCapabilitiesCache;
		}

		try {
			console.log('🔍 Loading MCP capabilities from static JSON files...');

			// Load all actions from static JSON files instead of dynamic discovery
			let allActions: any[] = [];

			try {
				// Load actions from the main capabilities file
				const mcpCapabilitiesModule = await import('../../../docs/mcp_capabilities.json');
				if (mcpCapabilitiesModule.default?.result?.actions) {
					allActions = allActions.concat(mcpCapabilitiesModule.default.result.actions);
				}
			} catch (error) {
				console.warn('Could not load main mcp_capabilities.json:', error);
			}

			// Load actions from individual source files as fallback/additional
			try {
				const contactActionsModule = await import('../../../docs/sources_mcp/contact-actions.json');
				if (contactActionsModule.default?.contact_actions) {
					allActions = allActions.concat(contactActionsModule.default.contact_actions);
				}
			} catch (error) {
				console.warn('Could not load contact-actions.json:', error);
			}

			try {
				const emailActionsModule = await import('../../../docs/sources_mcp/email-actions.json');
				if (emailActionsModule.default?.email_actions) {
					allActions = allActions.concat(emailActionsModule.default.email_actions);
				}
			} catch (error) {
				console.warn('Could not load email-actions.json:', error);
			}

			try {
				const taskActionsModule = await import('../../../docs/sources_mcp/task-actions.json');
				if (taskActionsModule.default?.task_actions) {
					allActions = allActions.concat(taskActionsModule.default.task_actions);
				}
			} catch (error) {
				console.warn('Could not load task-actions.json:', error);
			}

			try {
				const calendarActionsModule = await import(
					'../../../docs/sources_mcp/calendar-actions.json'
				);
				if (calendarActionsModule.default?.calendar_actions) {
					allActions = allActions.concat(calendarActionsModule.default.calendar_actions);
				}
			} catch (error) {
				console.warn('Could not load calendar-actions.json:', error);
			}

			console.log('📋 Loaded', allActions.length, 'MCP actions from static JSON files');

			// If no actions were loaded from JSON files, fall back to hardcoded essential actions
			if (allActions.length === 0) {
				console.warn('⚠️ No actions loaded from JSON files, using hardcoded fallback actions');
				allActions = [
					{
						name: 'contacts_search',
						description: 'Search for contacts in the workspace',
						input_schema: {
							type: 'object',
							properties: {
								workspace_id: { type: 'string', description: 'Workspace identifier' },
								user_id: { type: 'string', description: 'User identifier' },
								search_term: { type: 'string', description: 'Search query' },
								limit: { type: 'number', description: 'Maximum results' },
							},
							required: ['workspace_id', 'search_term'],
						},
					},
					{
						name: 'calendar_get_upcoming_events',
						description: 'Get upcoming calendar events',
						input_schema: {
							type: 'object',
							properties: {
								workspace_id: { type: 'string', description: 'Workspace identifier' },
								user_id: { type: 'string', description: 'User identifier' },
								limit: { type: 'number', description: 'Maximum events' },
							},
							required: ['workspace_id'],
						},
					},
					{
						name: 'email_draft_email',
						description: 'Draft a new email',
						input_schema: {
							type: 'object',
							properties: {
								workspace_id: { type: 'string', description: 'Workspace identifier' },
								user_id: { type: 'string', description: 'User identifier' },
								subject: { type: 'string', description: 'Email subject' },
								body: { type: 'string', description: 'Email body' },
								to_emails: { type: 'array', items: { type: 'string' }, description: 'Recipients' },
							},
							required: ['workspace_id', 'user_id', 'to_emails'],
						},
					},
					{
						name: 'tasks_get_tasks',
						description: 'Get tasks for a workspace',
						input_schema: {
							type: 'object',
							properties: {
								workspace_id: { type: 'string', description: 'Workspace identifier' },
								user_id: { type: 'string', description: 'User identifier' },
								status: { type: 'string', description: 'Task status filter' },
								limit: { type: 'number', description: 'Maximum tasks' },
							},
							required: ['workspace_id', 'user_id'],
						},
					},
				];
			}

			// Convert MCP actions to OpenAI tool format with enhanced descriptions
			const openaiActions = allActions.map((action: any) => {
				// Clone the input schema to modify it
				const modifiedSchema = { ...action.input_schema };
				const originalRequired = action.input_schema?.required || [];

				// Remove workspace_id and user_id from required parameters since they're auto-added
				const filteredRequired = originalRequired.filter(
					(param: string) => !['workspace_id', 'user_id'].includes(param),
				);

				if (filteredRequired.length !== originalRequired.length) {
					modifiedSchema.required = filteredRequired;
				}

				const requiredStr =
					filteredRequired.length > 0
						? ` Required parameters: ${filteredRequired.join(', ')}.`
						: '';

				// Add specific parameter guidance for common functions
				let enhancedDescription = action.description;

				if (action.name === 'contacts_search') {
					enhancedDescription += ' Use "search_term" parameter for the search query, not "query".';
				} else if (action.name === 'tasks_create') {
					enhancedDescription += ' Use "title", "description", "priority", "due_date" parameters.';
				} else if (action.name === 'meeting_draft_meeting') {
					enhancedDescription +=
						' Use "title", "start_time", "end_time", "attendee_emails" parameters.';
				} else if (action.name === 'email_draft_email') {
					enhancedDescription += ' Use "subject", "body", "to_emails" parameters.';
				}

				enhancedDescription += `${requiredStr} Note: workspace_id and user_id are automatically provided - do not include them in your function call.`;

				return {
					type: 'function',
					function: {
						name: action.name,
						description: enhancedDescription,
						parameters: modifiedSchema,
					},
				};
			});

			console.log('🛠️ Converted to OpenAI tools:', openaiActions.length, 'actions');

			const capabilities = {
				actions: openaiActions,
				resources: [
					{ name: 'calendar', description: 'Calendar management actions' },
					{ name: 'contacts', description: 'Contact management actions' },
					{ name: 'email', description: 'Email management actions' },
					{ name: 'tasks', description: 'Task management actions' },
					{ name: 'activities', description: 'Activity tracking actions' },
					{ name: 'queue', description: 'Queue management actions' },
				],
				prompts: [],
			};

			// Cache globally (shared across all sessions) and persist to storage
			MCPService.globalMCPCapabilitiesCache = capabilities;

			// Use shorter TTL if storage is not available
			const cacheTTL = this.storage ? this.MCP_CACHE_TTL : this.MCP_MEMORY_CACHE_TTL;
			MCPService.globalMCPCacheExpiry = now + cacheTTL;

			// Persist to Cloudflare storage for future Durable Object instances (if available)
			if (this.storage) {
				await this.saveGlobalMCPCacheToStorage(capabilities, MCPService.globalMCPCacheExpiry);
				console.log('✅ MCP capabilities cached globally for 24 hours');
			} else {
				console.log('✅ MCP capabilities cached in memory for 10 minutes (storage not available)');
			}
			return capabilities;
		} catch (error) {
			console.error('❌ Error getting MCP capabilities:', error);
			return { actions: [], resources: [], prompts: [] };
		}
	}

	async callMCPMethod(method: string, params: any): Promise<any[]> {
		try {
			const mcpServerUrl = this.env.MCP_SERVER_URL;
			if (!mcpServerUrl) {
				console.warn('⚠️ MCP server URL not configured');
				return [];
			}

			const requestBody = {
				jsonrpc: '2.0',
				id: Date.now(),
				method: method,
				params: params,
			};

			// Small delay to avoid overwhelming the MCP server
			await new Promise((resolve) => setTimeout(resolve, 100));

			const response = await fetch(mcpServerUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error(`❌ MCP ${method} HTTP error ${response.status}:`, errorText);
				return [];
			}

			const jsonRpcResponse = await response.json();

			if (jsonRpcResponse.error) {
				console.error(`❌ MCP ${method} JSON-RPC error:`, jsonRpcResponse.error);
				return [];
			}

			// Handle different response structures based on your MCP server's actual responses
			if (method === 'listResources') {
				// For listResources, return the resources array from result.resources
				return jsonRpcResponse.result?.resources || [];
			} else if (method === 'listActions') {
				// For listActions with resource filter, the result IS the array of actions
				// Example: {"jsonrpc": "2.0", "id": 3, "result": [{"name": "calendar_get_upcoming_events", ...}]}
				if (Array.isArray(jsonRpcResponse.result)) {
					return jsonRpcResponse.result;
				}
				// Fallback: some servers might return {actions: [...]}
				return jsonRpcResponse.result?.actions || [];
			}

			// For other methods, return the result as-is or as array
			if (Array.isArray(jsonRpcResponse.result)) {
				return jsonRpcResponse.result;
			}

			return jsonRpcResponse.result ? [jsonRpcResponse.result] : [];
		} catch (error) {
			console.error(`❌ Error calling MCP ${method}:`, error);
			return [];
		}
	}

	async executeMCPAction(
		webSocket: any,
		functionCall: any,
		messageId: string,
		sessionId: string,
	): Promise<void> {
		// Enhanced MCP execution with context awareness
		await this.executeMCPActionWithContext(webSocket, functionCall, messageId, sessionId);
	}

	async executeMCPActionWithContext(
		webSocket: any,
		functionCall: any,
		messageId: string,
		sessionId: string,
	): Promise<void> {
		try {
			// Send status update: Starting MCP action
			this.sendMCPStatusUpdate(
				webSocket,
				{
					status: 'calling_tool',
					action: functionCall.name,
					details: `Executing ${functionCall.name}...`,
				},
				messageId,
			);

			// Check cache first for read operations
			const cacheResult = await this.checkMCPCache(functionCall);
			if (cacheResult) {
				this.sendMCPStatusUpdate(
					webSocket,
					{
						status: 'processing_results',
						details: 'Using cached result',
					},
					messageId,
				);

				await this.processMCPResult(webSocket, cacheResult, functionCall, messageId, sessionId);
				return;
			}

			// Validate function call
			if (!functionCall.name) {
				throw new Error('Function name is missing from tool call');
			}

			const mcpServerUrl = this.env.MCP_SERVER_URL;
			if (!mcpServerUrl) {
				throw new Error('MCP server URL not configured');
			}

			// Parse and enhance arguments with context
			let args = this.parseAndEnhanceArguments(functionCall, sessionId);

			// Add required workspace_id if not present
			if (!args.workspace_id) {
				args.workspace_id = this.workspaceId || 'default-workspace';
			}

			// Log the final arguments being sent to MCP
			console.log('🔍 MCP Function Call Details:');
			console.log('Function Name:', functionCall.name);
			console.log('Original Arguments:', functionCall.arguments);
			console.log('Enhanced Arguments:', JSON.stringify(args, null, 2));

			// Send status update: Calling MCP server
			this.sendMCPStatusUpdate(
				webSocket,
				{
					status: 'calling_tool',
					action: functionCall.name,
					details: `Calling MCP server for ${functionCall.name}...`,
				},
				messageId,
			);

			const invokeRequestBody = {
				jsonrpc: '2.0',
				id: Date.now(),
				method: 'invokeAction',
				params: {
					name: functionCall.name,
					arguments: args,
				},
			};

			// Execute MCP call with retry logic
			const jsonRpcResponse = await this.executeMCPCallWithRetry(
				mcpServerUrl,
				invokeRequestBody,
				webSocket,
				messageId,
			);
			// Handle JSON-RPC response format
			if (jsonRpcResponse.error) {
				// Store error for AI learning
				await this.storeMCPErrorForLearning(
					functionCall.name,
					args,
					jsonRpcResponse.error,
					sessionId,
				);

				throw new Error(`MCP action error: ${jsonRpcResponse.error.message || 'Unknown error'}`);
			}

			const result = jsonRpcResponse.result;

			// Process MCP result with enhanced context management
			await this.processMCPResult(webSocket, result, functionCall, messageId, sessionId);
		} catch (error) {
			console.error('MCP action execution error:', error);

			this.sendMessage(webSocket, {
				type: 'error',
				content: `MCP action error: ${error instanceof Error ? error.message : 'Unknown error'}`,
				messageId: messageId,
			});
		}
	}

	extractActionMetadata(functionName: string, result: any): any | null {
		try {
			// Extract relevant IDs and metadata based on action type
			if (!result) return null;

			// Use ContextSummarizer to get compact context instead of full result
			const contextSummary = ContextSummarizer.extractContext(functionName, result);

			const metadata: any = {
				functionName,
				timestamp: new Date().toISOString(),
				status: 'completed',
				context: contextSummary,
			};

			// Add specific IDs for quick reference
			if (contextSummary.primary_entity) {
				metadata.primaryId = contextSummary.primary_entity.id;
				metadata.primaryType = contextSummary.primary_entity.type;
			}

			// Add count information
			metadata.totalCount = contextSummary.total_count;

			return metadata;
		} catch (error) {
			console.error('Error extracting action metadata:', error);
			return null;
		}
	}

	storeActionInSession(sessionId: string, actionMetadata: any): void {
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				console.warn('Session not found for storing action metadata:', sessionId);
				return;
			}

			// Initialize actions array if not exists
			if (!session.actions) {
				session.actions = [];
			}

			// Add the action metadata
			session.actions.push(actionMetadata);

			// Keep only the last 20 actions to avoid memory bloat
			if (session.actions.length > 20) {
				session.actions = session.actions.slice(-20);
			}

			console.log('✅ Stored action metadata in session:', actionMetadata.functionName);

			// 🔥 CRITICAL: Update session metadata immediately for AI context
			this.updateSessionMetadata(session, actionMetadata);

			// Save to Cloudflare storage (primary persistence)
			this.persistSessionActionsToStorage(sessionId, session.actions).catch((error) => {
				console.warn('Failed to persist actions to Cloudflare storage:', error);
			});

			// Save to Supabase for persistence (secondary/backup)
			if (
				this.supabaseEnabled &&
				session.supabaseSessionId &&
				session.supabaseSessionId.trim() !== ''
			) {
				this.saveActionToSupabase(session.supabaseSessionId, actionMetadata).catch((error) => {
					console.warn('Failed to save action to Supabase, continuing without persistence:', error);
				});

				// ✅ CRITICAL FIX: Save the updated session metadata to Supabase database
				console.log('🔍 [DEBUG] Saving session metadata to Supabase:', {
					sessionId: sessionId,
					supabaseSessionId: session.supabaseSessionId,
					metadata: session.supabaseMetadata,
				});

				this.saveSessionMetadataToSupabase(
					session.supabaseSessionId,
					session.supabaseMetadata,
				).catch((error) => {
					console.warn('Failed to save session metadata to Supabase:', error);
				});
			} else {
				console.log('⚠️ [DEBUG] Cannot save to Supabase:', {
					supabaseEnabled: this.supabaseEnabled,
					supabaseSessionId: session.supabaseSessionId,
				});
			}
		} catch (error) {
			console.error('Error storing action in session:', error);
		}
	}

	/**
	 * Clean up session actions to prevent metadata bloat
	 */
	cleanupSessionActions(actions: any[]): any[] {
		if (actions.length <= 50) {
			return actions;
		}

		// Sort by timestamp (newest first) and keep only the most recent 50 actions
		const sortedActions = actions
			.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
			.slice(0, 50);

		console.log(
			`🧹 Cleaned up session actions: kept ${sortedActions.length} out of ${actions.length} actions`,
		);
		return sortedActions;
	}

	/**
	 * 🔥 CRITICAL: Update session metadata immediately after MCP actions
	 * This ensures AI gets the latest context on next message
	 * Store only essential, summarized data to avoid overwhelming the AI
	 */
	updateSessionMetadata(session: any, actionMetadata: any): void {
		try {
			// Initialize supabaseMetadata if not exists
			if (!session.supabaseMetadata) {
				session.supabaseMetadata = {};
			}

			// Store only the last 5 actions with minimal data
			if (!session.supabaseMetadata.recent_actions) {
				session.supabaseMetadata.recent_actions = [];
			}

			// Add summarized action data
			const summarizedAction = {
				type: actionMetadata.functionName,
				status: actionMetadata.status,
				timestamp: actionMetadata.timestamp,
				summary: actionMetadata.context?.summary || 'Completed',
				entity_count: actionMetadata.context?.total_count || 0,
			};

			session.supabaseMetadata.recent_actions.push(summarizedAction);

			// Keep only last 5 actions to prevent bloat
			if (session.supabaseMetadata.recent_actions.length > 5) {
				session.supabaseMetadata.recent_actions = session.supabaseMetadata.recent_actions.slice(-5);
			}

			// Update workspace context with essential counts only
			const entityContext = this.sessionEntities.get(session.id);
			session.supabaseMetadata.workspace_context = {
				workspace_id: this.workspaceId,
				user_id: session.userId || this.currentUserId,
				entity_counts: {
					contacts: entityContext?.contacts?.length || 0,
					emails: entityContext?.emails?.length || 0,
					meetings: entityContext?.meetings?.length || 0,
				},
				last_action: {
					type: actionMetadata.functionName,
					time: actionMetadata.timestamp,
				},
			};

			console.log('🔄 Updated session metadata efficiently:', {
				recentActions: session.supabaseMetadata.recent_actions.length,
				entityCounts: session.supabaseMetadata.workspace_context.entity_counts,
			});
		} catch (error) {
			console.error('Error updating session metadata:', error);
		}
	}

	extractContactsFromMetadata(sessionMetadata: any): any[] {
		const contacts: any[] = [];

		// Extract contacts from actions metadata
		if (sessionMetadata.actions && Array.isArray(sessionMetadata.actions)) {
			for (const action of sessionMetadata.actions) {
				if (action.result && action.result.contacts && Array.isArray(action.result.contacts)) {
					// Add contacts from this action
					contacts.push(...action.result.contacts);
				}
			}
		}

		// Remove duplicates based on email
		const uniqueContacts = contacts.filter(
			(contact, index, self) => index === self.findIndex((c) => c.email === contact.email),
		);

		return uniqueContacts;
	}

	extractEmailsFromMetadata(sessionMetadata: any): any[] {
		const emails: any[] = [];

		// Extract emails from actions metadata
		if (sessionMetadata.actions && Array.isArray(sessionMetadata.actions)) {
			for (const action of sessionMetadata.actions) {
				if (action.result && action.result.emails && Array.isArray(action.result.emails)) {
					emails.push(...action.result.emails);
				}
			}
		}

		return emails;
	}

	extractMeetingsFromMetadata(sessionMetadata: any): any[] {
		const meetings: any[] = [];

		// Extract meetings from actions metadata
		if (sessionMetadata.actions && Array.isArray(sessionMetadata.actions)) {
			for (const action of sessionMetadata.actions) {
				if (action.result && action.result.meetings && Array.isArray(action.result.meetings)) {
					meetings.push(...action.result.meetings);
				}
			}
		}

		return meetings;
	}

	extractUserInfoFromSession(session: any): any {
		const userInfo: any = {};

		// Extract user information from session messages
		if (session.messages && session.messages.length > 0) {
			for (const message of session.messages) {
				if (message.role === 'user' && message.content) {
					// Extract name patterns like "Hi I'm John", "My name is John", "I'm John", etc.
					const namePatterns = [
						/^(?:hi|hello|hey)[\s,]*(?:i'?m|i am|my name is|call me)\s+([a-zA-Z]+)/i,
						/^(?:i'?m|i am|my name is|call me)\s+([a-zA-Z]+)/i,
						/^(?:this is|it's)\s+([a-zA-Z]+)/i,
					];

					for (const pattern of namePatterns) {
						const match = message.content.match(pattern);
						if (match && match[1]) {
							userInfo.name = match[1];
							break;
						}
					}

					// Extract email patterns
					const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
					const emailMatch = message.content.match(emailPattern);
					if (emailMatch && emailMatch[1]) {
						userInfo.email = emailMatch[1];
					}

					// Extract company information
					if (
						message.content.toLowerCase().includes('my company is') ||
						message.content.toLowerCase().includes('i work at') ||
						message.content.toLowerCase().includes('i work for')
					) {
						const companyMatch = message.content.match(
							/(?:my company is|i work at|i work for)\s+([a-zA-Z0-9\s&.,-]+)/i,
						);
						if (companyMatch && companyMatch[1]) {
							userInfo.company = companyMatch[1].trim();
						}
					}

					// Extract role/title information
					if (
						message.content.toLowerCase().includes('i am a') ||
						message.content.toLowerCase().includes('i work as') ||
						message.content.toLowerCase().includes('my role is')
					) {
						const roleMatch = message.content.match(
							/(?:i am a|i work as|my role is)\s+([a-zA-Z0-9\s&.,-]+)/i,
						);
						if (roleMatch && roleMatch[1]) {
							userInfo.role = roleMatch[1].trim();
						}
					}
				}
			}
		}

		return Object.keys(userInfo).length > 0 ? userInfo : null;
	}

	// Enhanced MCP Helper Methods
	sendMCPStatusUpdate(webSocket: any, statusUpdate: MCPStatusUpdate, messageId: string): void {
		this.sendMessage(webSocket, {
			type: 'status',
			content: `${statusUpdate.status}: ${statusUpdate.details || statusUpdate.action || ''}`,
			data: statusUpdate,
			messageId,
		});
	}

	async checkMCPCache(functionCall: any): Promise<any | null> {
		if (!this.isCacheableOperation(functionCall.name)) {
			return null;
		}

		const cacheKey = `${functionCall.name}:${JSON.stringify(functionCall.arguments)}`;
		const cached = this.mcpResponseCache.get(cacheKey);

		if (cached && Date.now() < cached.expiry) {
			return cached.data;
		}

		return null;
	}

	isCacheableOperation(functionName: string): boolean {
		return [
			'contacts_search',
			'contacts_get_all',
			'calendar_get_upcoming_events',
			'calendar_list_events',
			'email_read_email',
			'meeting_list_meetings',
			'meeting_get_meeting',
		].includes(functionName);
	}

	/**
	 * Map parameter names to match MCP server expectations
	 * This handles mismatches between AI-generated parameters and MCP server requirements
	 */
	mapParameterNames(functionName: string, args: any): any {
		const mappedArgs = { ...args };

		// Map common parameter name mismatches
		if (functionName === 'contacts_search') {
			// AI might use "query" but MCP server expects "search_term"
			if (args.query && !args.search_term) {
				mappedArgs.search_term = args.query;
				delete mappedArgs.query;
				console.log('🔄 [PARAM_MAPPING] Mapped "query" to "search_term" for contacts_search');
			}
		}

		// Handle email parameter mappings
		if (functionName.includes('email')) {
			if (args.recipient_emails && !args.to_emails) {
				mappedArgs.to_emails = args.recipient_emails;
				delete mappedArgs.recipient_emails;
				console.log(
					'🔄 [PARAM_MAPPING] Mapped "recipient_emails" to "to_emails" for email functions',
				);
			}
			if (args.cc && !args.cc_emails) {
				mappedArgs.cc_emails = args.cc;
				delete mappedArgs.cc;
				console.log('🔄 [PARAM_MAPPING] Mapped "cc" to "cc_emails" for email functions');
			}
			if (args.bcc && !args.bcc_emails) {
				mappedArgs.bcc_emails = args.bcc;
				delete mappedArgs.bcc;
				console.log('🔄 [PARAM_MAPPING] Mapped "bcc" to "bcc_emails" for email functions');
			}
		}

		// Handle meeting parameter mappings
		if (functionName.includes('meeting')) {
			if (args.attendees && !args.attendee_emails) {
				mappedArgs.attendee_emails = args.attendees;
				delete mappedArgs.attendees;
				console.log(
					'🔄 [PARAM_MAPPING] Mapped "attendees" to "attendee_emails" for meeting functions',
				);
			}
			if (args.participants && !args.attendee_emails) {
				mappedArgs.attendee_emails = args.participants;
				delete mappedArgs.participants;
				console.log(
					'🔄 [PARAM_MAPPING] Mapped "participants" to "attendee_emails" for meeting functions',
				);
			}
		}

		// Handle task parameter mappings
		if (functionName.includes('task')) {
			if (args.dueDate && !args.due_date) {
				mappedArgs.due_date = args.dueDate;
				delete mappedArgs.dueDate;
				console.log('🔄 [PARAM_MAPPING] Mapped "dueDate" to "due_date" for task functions');
			}
			if (args.assignee && !args.assignee_id) {
				mappedArgs.assignee_id = args.assignee;
				delete mappedArgs.assignee;
				console.log('🔄 [PARAM_MAPPING] Mapped "assignee" to "assignee_id" for task functions');
			}
		}

		return mappedArgs;
	}

	/**
	 * Store MCP errors for AI learning and parameter correction
	 */
	async storeMCPErrorForLearning(
		functionName: string,
		args: any,
		error: any,
		sessionId: string,
	): Promise<void> {
		try {
			// Store error patterns to help AI learn correct parameters
			const errorPattern = {
				functionName,
				args,
				error: error.message || error,
				timestamp: new Date().toISOString(),
			};

			// Store in session for context
			const session = this.sessions.get(sessionId);
			if (session) {
				if (!(session as any).mcpErrors) {
					(session as any).mcpErrors = [];
				}
				(session as any).mcpErrors.push(errorPattern);

				// Keep only last 10 errors to avoid bloat
				if ((session as any).mcpErrors.length > 10) {
					(session as any).mcpErrors = (session as any).mcpErrors.slice(-10);
				}
			}

			console.log('📚 [MCP_LEARNING] Stored error pattern for AI learning:', errorPattern);
		} catch (error) {
			console.error('❌ Failed to store MCP error for learning:', error);
		}
	}

	parseAndEnhanceArguments(functionCall: any, sessionId: string): any {
		let args: any = {};

		// Parse original arguments
		try {
			args = JSON.parse(functionCall.arguments || '{}');
		} catch (e) {
			console.warn('⚠️ Failed to parse function arguments, using empty object');
			args = {};
		}

		// Map parameter names to match MCP server expectations
		args = this.mapParameterNames(functionCall.name, args);

		// Get session for context
		const session = this.sessions.get(sessionId);

		// 🔍 LOG: Track what IDs we're about to use
		console.log('🔍 [MCP_ARGS_DEBUG] Parsing arguments for function:', functionCall.name);
		console.log('  - sessionId:', sessionId);
		console.log('  - session found:', !!session);
		console.log('  - session.userId:', session?.userId);
		console.log('  - session.workspaceId:', session?.workspaceId);
		console.log('  - this.workspaceId:', this.workspaceId);
		console.log('  - original args:', functionCall.arguments);

		// Always add required context parameters if not present
		if (!args.workspace_id) {
			args.workspace_id = session?.workspaceId || this.workspaceId || 'default-workspace';
			console.log(
				'🔍 [MCP_ARGS_DEBUG] Added workspace_id from session.workspaceId:',
				args.workspace_id,
			);
		} else {
			console.log('🔍 [MCP_ARGS_DEBUG] Using existing workspace_id:', args.workspace_id);
		}

		if (!args.user_id) {
			args.user_id = session?.userId || this.currentUserId || 'websocket-user';
			console.log('🔍 [MCP_ARGS_DEBUG] Added user_id from session.userId:', args.user_id);
		} else {
			console.log('🔍 [MCP_ARGS_DEBUG] Using existing user_id:', args.user_id);
		}

		// Add email_id for email_send_email function if not present
		if (functionCall.name === 'email_send_email' && !args.email_id) {
			const emailId = this.getEmailDraftId(sessionId);
			if (emailId) {
				args.email_id = emailId;
				console.log('🔍 [MCP_ARGS_DEBUG] Added email_id from tracked draft:', args.email_id);
			} else {
				console.log('⚠️ [MCP_ARGS_DEBUG] No email draft found for session, cannot send email');
			}
		}

		console.log('🔧 Enhanced arguments with context:', {
			workspace_id: args.workspace_id,
			user_id: args.user_id,
			original_args: functionCall.arguments,
		});

		// Enhance arguments with contextual entity resolution
		return this.resolveEntityReferences(args, sessionId, functionCall.name);
	}

	resolveEntityReferences(args: any, sessionId: string, actionName: string): any {
		const entityContext = this.sessionEntities.get(sessionId);

		if (!entityContext) {
			return args;
		}

		const enhancedArgs = { ...args };

		// Resolve contact references for both parameter naming conventions
		if (actionName.includes('email') && args.recipient_emails) {
			enhancedArgs.recipient_emails = this.resolveContactEmails(
				args.recipient_emails,
				entityContext,
			);
		}

		// Handle to_emails parameter (primary parameter name for email functions)
		if (actionName.includes('email') && args.to_emails) {
			enhancedArgs.to_emails = this.resolveContactEmails(args.to_emails, entityContext);
		}

		// Handle cc_emails and bcc_emails as well
		if (actionName.includes('email') && args.cc_emails) {
			enhancedArgs.cc_emails = this.resolveContactEmails(args.cc_emails, entityContext);
		}

		if (actionName.includes('email') && args.bcc_emails) {
			enhancedArgs.bcc_emails = this.resolveContactEmails(args.bcc_emails, entityContext);
		}

		if (actionName.includes('meeting') && args.attendee_emails) {
			enhancedArgs.attendee_emails = this.resolveContactEmails(args.attendee_emails, entityContext);
		}

		// Resolve email/meeting ID references
		if (args.email_id && !this.isValidId(args.email_id)) {
			enhancedArgs.email_id = this.findEmailId(args.email_id, entityContext);
		}

		if (args.meeting_id && !this.isValidId(args.meeting_id)) {
			enhancedArgs.meeting_id = this.findMeetingId(args.meeting_id, entityContext, sessionId);
		}

		return enhancedArgs;
	}

	resolveContactEmails(emailsOrNames: string[], entityContext: MCPEntityContext): string[] {
		console.log('🔍 [CONTACT_RESOLUTION_DEBUG] Resolving contact emails:');
		console.log('  - emailsOrNames:', emailsOrNames);
		console.log(
			'  - available contacts:',
			entityContext.contacts.map((c) => ({ name: c.name, email: c.email })),
		);

		return emailsOrNames.map((emailOrName) => {
			// If it's already an email, return as-is
			if (emailOrName.includes('@')) {
				console.log(`✅ [CONTACT_RESOLUTION_DEBUG] ${emailOrName} is already an email`);
				return emailOrName;
			}

			// Try to find contact by name
			const contact = entityContext.contacts.find(
				(c) =>
					c.name.toLowerCase().includes(emailOrName.toLowerCase()) ||
					emailOrName.toLowerCase().includes(c.name.toLowerCase()),
			);

			if (contact) {
				console.log(
					`✅ [CONTACT_RESOLUTION_DEBUG] Resolved "${emailOrName}" to "${contact.email}"`,
				);
				return contact.email;
			} else {
				console.log(`⚠️ [CONTACT_RESOLUTION_DEBUG] Could not resolve "${emailOrName}" to an email`);
				return emailOrName;
			}
		});
	}

	findEmailId(emailReference: string, entityContext: MCPEntityContext): string {
		const email = entityContext.emails.find(
			(e) =>
				e.subject.toLowerCase().includes(emailReference.toLowerCase()) ||
				emailReference.toLowerCase().includes(e.subject.toLowerCase()),
		);
		return email ? email.id : emailReference;
	}

	findMeetingId(
		meetingReference: string,
		entityContext: MCPEntityContext,
		sessionId?: string,
	): string {
		// First try to find from entity context
		const meeting = entityContext.meetings.find(
			(m) =>
				m.title.toLowerCase().includes(meetingReference.toLowerCase()) ||
				meetingReference.toLowerCase().includes(m.title.toLowerCase()),
		);

		if (meeting) {
			return meeting.id;
		}

		// If not found in entity context, try to get from recent session actions
		if (sessionId) {
			const session = this.sessions.get(sessionId);
			if (session?.actions) {
				// Get the most recent meeting action with an ID
				const recentMeetingActions = session.actions
					.filter(
						(action: any) =>
							action.functionName && action.functionName.includes('meeting') && action.meetingId,
					)
					.slice(-3); // Last 3 meeting actions

				if (recentMeetingActions.length > 0) {
					// Return the most recent meeting ID
					const mostRecentMeeting = recentMeetingActions[recentMeetingActions.length - 1];
					console.log(`🔍 Found recent meeting ID from actions: ${mostRecentMeeting.meetingId}`);
					return mostRecentMeeting.meetingId;
				}
			}
		}

		return meetingReference;
	}

	isValidId(id: string): boolean {
		// Check if it looks like a valid ID (not just a name/description)
		// Allow more flexible ID formats and shorter IDs
		if (!id || typeof id !== 'string') return false;

		// If it contains spaces or looks like a description, it's not a valid ID
		if (
			id.includes(' ') ||
			id.toLowerCase().includes('context') ||
			id.toLowerCase().includes('previous')
		) {
			return false;
		}

		// Check if it's a reasonable ID format (alphanumeric with common separators)
		return /^[a-zA-Z0-9_.-]+$/.test(id) && id.length >= 5;
	}

	async executeMCPCallWithRetry(
		mcpServerUrl: string,
		requestBody: any,
		webSocket: any,
		messageId: string,
		maxRetries: number = 3,
	): Promise<any> {
		let lastError: Error;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const response = await fetch(mcpServerUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(requestBody),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`MCP server error: ${response.status} ${response.statusText} - ${errorText}`,
					);
				}

				return await response.json();
			} catch (error) {
				lastError = error as Error;

				if (attempt < maxRetries - 1) {
					const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
					this.sendMCPStatusUpdate(
						webSocket,
						{
							status: 'calling_tool',
							details: `Retrying MCP call (attempt ${attempt + 2}/${maxRetries})...`,
						},
						messageId,
					);

					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		throw lastError!;
	}

	async processMCPResult(
		webSocket: any,
		result: any,
		functionCall: any,
		messageId: string,
		sessionId: string,
	): Promise<void> {
		// Send status update: Processing results
		this.sendMCPStatusUpdate(
			webSocket,
			{
				status: 'processing_results',
				action: functionCall.name,
				details: 'Formatting response...',
			},
			messageId,
		);

		// Store entities in context for future reference (with Cloudflare persistence)
		await this.storeEntitiesInContextWithPersistence(result, functionCall.name, sessionId);

		// Cache the result if it's cacheable (with Cloudflare persistence)
		if (this.isCacheableOperation(functionCall.name)) {
			const cacheKey = `${functionCall.name}:${JSON.stringify(functionCall.arguments)}`;
			await this.storeMCPCacheWithPersistence(
				cacheKey,
				result,
				Date.now() + this.MCP_RESPONSE_CACHE_TTL,
				functionCall.name,
			);
		}

		// Extract action metadata for session tracking
		const actionMetadata = this.extractActionMetadata(functionCall.name, result);
		if (actionMetadata) {
			this.storeActionInSession(sessionId, actionMetadata);
		}

		// Format the result for human-readable display
		const formattedResult = this.formatMCPResultForUser(result, functionCall.name, actionMetadata);

		// Send the formatted result to the user
		this.sendMessage(webSocket, {
			type: 'content',
			content: formattedResult,
			messageId: messageId,
		});

		// Send completion status
		this.sendMCPStatusUpdate(
			webSocket,
			{
				status: 'completing',
				action: functionCall.name,
				details: 'Action completed successfully',
			},
			messageId,
		);

		// Create function result message for AI (for potential future use)
		const functionResultMessage = {
			role: 'function' as const,
			name: functionCall.name,
			content: JSON.stringify(result),
		};

		// Return the function result message for AI processing
		// This will be handled by the calling service
		return functionResultMessage as any;
	}

	// Entity Management Methods
	async storeEntitiesInContext(result: any, actionName: string, sessionId: string): Promise<void> {
		try {
			const entityContext = this.sessionEntities.get(sessionId) || {
				contacts: [],
				emails: [],
				meetings: [],
				lastUpdated: Date.now(),
			};

			// Extract entities based on action type
			if (actionName.includes('contact')) {
				if (result.contacts && Array.isArray(result.contacts)) {
					// Merge new contacts, avoiding duplicates
					const existingEmails = new Set(entityContext.contacts.map((c) => c.email));
					const newContacts = result.contacts.filter(
						(contact: any) => !existingEmails.has(contact.email),
					);
					entityContext.contacts.push(...newContacts);
				}
			}

			if (actionName.includes('email')) {
				if (result.emails && Array.isArray(result.emails)) {
					// Merge new emails, avoiding duplicates
					const existingIds = new Set(entityContext.emails.map((e) => e.id));
					const newEmails = result.emails.filter((email: any) => !existingIds.has(email.id));
					entityContext.emails.push(...newEmails);
				}
			}

			if (actionName.includes('meeting') || actionName.includes('calendar')) {
				if (result.meetings && Array.isArray(result.meetings)) {
					// Merge new meetings, avoiding duplicates
					const existingIds = new Set(entityContext.meetings.map((m) => m.id));
					const newMeetings = result.meetings.filter(
						(meeting: any) => !existingIds.has(meeting.id),
					);
					entityContext.meetings.push(...newMeetings);
				}
			}

			// Update last updated timestamp
			entityContext.lastUpdated = Date.now();

			// Store back in session
			this.sessionEntities.set(sessionId, entityContext);

			// Limit storage to prevent memory bloat
			this.limitEntityStorage(entityContext);

			console.log('✅ Stored entities in context for session:', sessionId, {
				contacts: entityContext.contacts.length,
				emails: entityContext.emails.length,
				meetings: entityContext.meetings.length,
			});
		} catch (error) {
			console.error('Error storing entities in context:', error);
		}
	}

	limitEntityStorage(entityContext: MCPEntityContext): void {
		// Keep only the most recent 50 entities of each type
		if (entityContext.contacts.length > 50) {
			entityContext.contacts = entityContext.contacts.slice(-50);
		}
		if (entityContext.emails.length > 50) {
			entityContext.emails = entityContext.emails.slice(-50);
		}
		if (entityContext.meetings.length > 50) {
			entityContext.meetings = entityContext.meetings.slice(-50);
		}
	}

	async storeEntitiesInContextWithPersistence(
		result: any,
		actionName: string,
		sessionId: string,
	): Promise<void> {
		await this.storeEntitiesInContext(result, actionName, sessionId);
		// Persist to storage
		await this.persistSessionEntitiesToStorage();
	}

	async storeMCPCacheWithPersistence(
		cacheKey: string,
		data: any,
		expiry: number,
		actionType: string,
	): Promise<void> {
		// Store in memory cache
		this.mcpResponseCache.set(cacheKey, {
			data,
			expiry,
			actionType,
		});

		// Persist to storage
		await this.persistMCPCacheToStorage();
	}

	// Helper method for email draft tracking (needs to be implemented by the calling service)
	private getEmailDraftId(sessionId: string): string | null {
		// This should be implemented by the calling service
		// For now, return null
		return null;
	}

	/**
	 * Formats MCP results into human-readable text for users
	 */
	private formatMCPResultForUser(result: any, functionName: string, actionMetadata?: any): string {
		try {
			// Import the formatter function
			const { enhanceMCPResultForUser } = require('../../lib/responseFormatter');
			const enhanced = enhanceMCPResultForUser(result, functionName, actionMetadata);

			// Generate human-readable response based on function type
			let response = enhanced._userFriendlyHints.suggestedResponse;

			// Add specific details based on the data
			const keyData = enhanced._userFriendlyHints.keyData;

			// Handle contacts
			if (keyData.contacts && keyData.contacts.length > 0) {
				response += '\n\n📇 Contacts:';
				keyData.contacts.forEach((contact: any, index: number) => {
					response += `\n${index + 1}. ${contact.name || 'Unknown'}`;
					if (contact.email) {
						response += ` (${contact.email})`;
					}
				});
			}

			// Handle emails
			if (keyData.emails && keyData.emails.length > 0) {
				response += '\n\n📧 Emails:';
				keyData.emails.forEach((email: any, index: number) => {
					response += `\n${index + 1}. "${email.subject || 'No subject'}"`;
					if (email.from) {
						response += ` from ${email.from}`;
					}
					if (email.date) {
						response += ` (${new Date(email.date).toLocaleDateString()})`;
					}
				});
			}

			// Handle tasks
			if (keyData.tasks && keyData.tasks.length > 0) {
				response += '\n\n✅ Tasks:';
				keyData.tasks.forEach((task: any, index: number) => {
					const status =
						task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '⏳' : '○';
					response += `\n${status} ${task.title || 'Untitled task'}`;
					if (task.due_date) {
						response += ` (Due: ${new Date(task.due_date).toLocaleDateString()})`;
					}
				});
			}

			// Handle meetings
			if (keyData.meetings && keyData.meetings.length > 0) {
				response += '\n\n📅 Meetings:';
				keyData.meetings.forEach((meeting: any, index: number) => {
					response += `\n${index + 1}. "${meeting.title || 'Untitled meeting'}"`;
					if (meeting.start) {
						response += ` at ${new Date(meeting.start).toLocaleString()}`;
					}
					if (meeting.attendees && Array.isArray(meeting.attendees)) {
						response += ` with ${meeting.attendees.length} attendee(s)`;
					}
				});
			}

			return response;
		} catch (error) {
			console.error('Error formatting MCP result for user:', error);
			// Fallback to a simple success message
			return `✅ ${functionName.replace(/_/g, ' ')} completed successfully.`;
		}
	}

	// Getters for external access
	getSessionEntities(): Map<string, MCPEntityContext> {
		return this.sessionEntities;
	}

	getMCPResponseCache(): Map<string, MCPCacheEntry> {
		return this.mcpResponseCache;
	}
}
