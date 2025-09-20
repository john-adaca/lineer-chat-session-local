import type { MCPResponse, ChatSession } from '../../types';
import { DatabaseService } from './DatabaseService';
import { AIContextSummarizer } from './AIContextSummarizer';

export class MCPResponseAccumulator {
	private databaseService: DatabaseService;
	private aiSummarizer: AIContextSummarizer;

	constructor(databaseService: DatabaseService, aiService?: any) {
		this.databaseService = databaseService;
		this.aiSummarizer = new AIContextSummarizer(aiService);
	}

	/**
	 * Add MCP response to session metadata
	 */
	async addMCPResponse(session: ChatSession, action: string, parameters: any, result: any, success: boolean, error?: string): Promise<void> {
		try {
			const mcpResponse: MCPResponse = {
				id: `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				action,
				parameters,
				result, // Keep full result for AI processing, but don't store in mcpResponses array
				timestamp: new Date(),
				success,
				error,
				metadata: {
					sessionId: session.id,
					userId: session.userId,
					workspaceId: session.workspaceId,
					responseSize: JSON.stringify(result).length
				}
			};

			// Initialize metadata if it doesn't exist
			if (!session.metadata) {
				session.metadata = {
					mcpResponses: [],
					contextAccumulated: {},
					sessionType: 'chat',
					createdFromUI: !!session.supabaseSessionId,
					lastMCPInteraction: null,
					totalMCPActions: 0
				};
			}

			// Add to in-memory session (store only essential data, not full result)
			const compactResponse = {
				id: mcpResponse.id,
				action: mcpResponse.action,
				success: mcpResponse.success,
				timestamp: mcpResponse.timestamp,
				error: mcpResponse.error,
				parameters: mcpResponse.parameters,
				result: null, // Don't store full result
				// Store only a summary, not the full result data
				resultSummary: this.createCompactSummary(result, action),
				metadata: mcpResponse.metadata
			};
			
			session.metadata.mcpResponses.push(compactResponse as MCPResponse);
			if (session.metadata.mcpResponses.length > 10) {
				session.metadata.mcpResponses = session.metadata.mcpResponses.slice(-10);
			}
			session.metadata.lastMCPInteraction = new Date();
			// Increment total count instead of using array length
			session.metadata.totalMCPActions = (session.metadata.totalMCPActions || 0) + 1;
	
			// Use AI to intelligently summarize and merge context
			await this.summarizeContextWithAI(session, mcpResponse);

			// Save to database
			await this.databaseService.updateMCPResponses(session.id, mcpResponse, session.userId, session.workspaceId);

			console.log('✅ MCP response accumulated:', {
				sessionId: session.id,
				action: mcpResponse.action,
				success: mcpResponse.success,
				totalResponses: session.metadata.mcpResponses.length
			});

		} catch (error) {
			console.error('❌ Failed to accumulate MCP response:', error);
		}
	}

	/**
	 * Use AI to intelligently summarize and merge context
	 */
	private async summarizeContextWithAI(session: ChatSession, mcpResponse: MCPResponse): Promise<void> {
		if (!session.metadata) return;

		try {
			console.log('🤖 Starting AI context summarization for action:', mcpResponse.action);

			// Get current context
			const currentContext = session.metadata.contextAccumulated || {};

			// Use AI to summarize and merge
			const summarizedContext = await this.aiSummarizer.summarizeContext(
				{ contextAccumulated: currentContext },
				mcpResponse,
				session
			);

			// Update session metadata with AI-summarized context
			session.metadata.contextAccumulated = summarizedContext;

			console.log('✅ AI context summarization completed:', {
				contactsCount: summarizedContext.contacts?.length || 0,
				emailsCount: summarizedContext.emails?.length || 0,
				meetingsCount: summarizedContext.meetings?.length || 0,
				tasksCount: summarizedContext.tasks?.length || 0,
				hasSummary: !!summarizedContext.summary
			});

		} catch (error) {
			console.error('❌ AI context summarization failed, using fallback:', error);
			
			// Fallback to simple context update
			this.fallbackContextUpdate(session, mcpResponse);
		}
	}

	/**
	 * Fallback context update if AI summarization fails
	 */
	private fallbackContextUpdate(session: ChatSession, mcpResponse: MCPResponse): void {
		if (!session.metadata) return;

		const context = session.metadata.contextAccumulated;

		// Initialize context categories if they don't exist
		if (!context.contacts) context.contacts = [];
		if (!context.emails) context.emails = [];
		if (!context.meetings) context.meetings = [];
		if (!context.tasks) context.tasks = [];
		if (!context.recentActions) context.recentActions = [];

		// Simple fallback: add new data without AI intelligence
		const action = mcpResponse.action.toLowerCase();
		
		if (action.includes('contact') && mcpResponse.success && mcpResponse.result) {
			const contacts = Array.isArray(mcpResponse.result) ? mcpResponse.result : [mcpResponse.result];
			contacts.slice(0, 3).forEach((contact: any) => {
				if (contact.id && contact.name) {
					context.contacts.push({
						id: contact.id,
						name: contact.name,
						email: contact.email,
						lastInteraction: mcpResponse.timestamp,
						source: mcpResponse.action
					});
				}
			});
		}

		// Keep arrays manageable
		context.contacts = context.contacts.slice(-10);
		context.emails = context.emails.slice(-8);
		context.meetings = context.meetings.slice(-6);
		context.tasks = context.tasks.slice(-8);

		// Add to recent actions
		context.recentActions.unshift({
			action: mcpResponse.action,
			timestamp: mcpResponse.timestamp,
			success: mcpResponse.success,
			result: 'Brief description'
		});
		context.recentActions = context.recentActions.slice(0, 10);
	}


	/**
	 * Get accumulated context for AI prompt
	 */
	getAccumulatedContext(session: ChatSession): string {
		if (!session.metadata?.contextAccumulated) {
			console.log('❌ No contextAccumulated in session metadata');
			return '';
		}

		const context = session.metadata.contextAccumulated;
		
		// Use AI summarizer to get intelligent context summary
		const contextSummary = this.aiSummarizer.getContextSummary(context);
		
		console.log('📝 AI-generated context summary:', contextSummary || '(empty)');
		return contextSummary;
	}

	/**
	 * Get MCP response statistics
	 */
	getMCPStatistics(session: ChatSession): any {
		if (!session.metadata?.mcpResponses) {
			return { total: 0, success: 0, failure: 0, byAction: {} };
		}

		const responses = session.metadata.mcpResponses;
		const stats = {
			total: responses.length,
			success: responses.filter(r => r.success).length,
			failure: responses.filter(r => !r.success).length,
			byAction: {} as Record<string, number>
		};

		responses.forEach(response => {
			stats.byAction[response.action] = (stats.byAction[response.action] || 0) + 1;
		});

		return stats;
	}

	/**
	 * Create a compact summary of MCP result data to prevent storage bloat
	 */
	private createCompactSummary(result: any, action: string): any {
		if (!result) return null;

		const actionLower = action.toLowerCase();

		// For contact-related actions
		if (actionLower.includes('contact')) {
			if (Array.isArray(result.contacts)) {
				return {
					type: 'contacts',
					count: result.contacts.length,
					total: result.total,
					success: result.success,
					sample: result.contacts.slice(0, 2).map((c: any) => ({
						name: c.name,
						email: c.email
					}))
				};
			}
		}

		// For email-related actions
		if (actionLower.includes('email')) {
			if (Array.isArray(result.emails)) {
				return {
					type: 'emails',
					count: result.emails.length,
					total: result.total,
					success: result.success,
					sample: result.emails.slice(0, 2).map((e: any) => ({
						subject: e.subject,
						from: e.from
					}))
				};
			}
		}

		// For calendar/meeting actions
		if (actionLower.includes('calendar') || actionLower.includes('meeting')) {
			if (Array.isArray(result.meetings)) {
				return {
					type: 'meetings',
					count: result.meetings.length,
					total: result.total,
					success: result.success,
					sample: result.meetings.slice(0, 2).map((m: any) => ({
						title: m.title,
						startTime: m.startTime
					}))
				};
			}
		}

		// For task actions
		if (actionLower.includes('task')) {
			if (Array.isArray(result.tasks)) {
				return {
					type: 'tasks',
					count: result.tasks.length,
					total: result.total,
					success: result.success,
					sample: result.tasks.slice(0, 2).map((t: any) => ({
						title: t.title,
						status: t.status
					}))
				};
			}
		}

		// Generic fallback for other actions
		return {
			type: 'generic',
			success: result.success || true,
			hasData: !!result,
			dataType: Array.isArray(result) ? 'array' : typeof result
		};
	}
}