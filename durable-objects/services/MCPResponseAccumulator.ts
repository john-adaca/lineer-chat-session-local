import type { MCPResponse, ChatSession } from '../../types';
import { DatabaseService } from './DatabaseService';

export class MCPResponseAccumulator {
	private databaseService: DatabaseService;

	constructor(databaseService: DatabaseService) {
		this.databaseService = databaseService;
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
				result,
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

			// Add to in-memory session
			session.metadata.mcpResponses.push(mcpResponse);
			session.metadata.lastMCPInteraction = new Date();
			session.metadata.totalMCPActions = session.metadata.mcpResponses.length;

			// Accumulate context based on action type
			this.accumulateContext(session, mcpResponse);

			// Save to database
			await this.databaseService.updateMCPResponses(session.id, mcpResponse);

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
	 * Accumulate context from MCP responses for future AI interactions
	 */
	private accumulateContext(session: ChatSession, mcpResponse: MCPResponse): void {
		if (!session.metadata) return;

		const context = session.metadata.contextAccumulated;

		// Initialize context categories if they don't exist
		if (!context.contacts) context.contacts = [];
		if (!context.emails) context.emails = [];
		if (!context.meetings) context.meetings = [];
		if (!context.tasks) context.tasks = [];
		if (!context.recentActions) context.recentActions = [];

		// Extract and accumulate context based on action type
		const action = mcpResponse.action.toLowerCase();

		if (action.includes('contact')) {
			this.accumulateContactContext(context, mcpResponse);
		} else if (action.includes('email')) {
			this.accumulateEmailContext(context, mcpResponse);
		} else if (action.includes('calendar') || action.includes('meeting')) {
			this.accumulateMeetingContext(context, mcpResponse);
		} else if (action.includes('task')) {
			this.accumulateTaskContext(context, mcpResponse);
		}

		// Always add to recent actions (keep last 10)
		context.recentActions.unshift({
			action: mcpResponse.action,
			timestamp: mcpResponse.timestamp,
			success: mcpResponse.success,
			result: mcpResponse.result
		});
		context.recentActions = context.recentActions.slice(0, 10);
	}

	private accumulateContactContext(context: any, response: MCPResponse): void {
		if (response.success && response.result) {
			const contacts = Array.isArray(response.result) ? response.result : [response.result];
			contacts.forEach((contact: any) => {
				if (contact.id && contact.name) {
					context.contacts.push({
						id: contact.id,
						name: contact.name,
						email: contact.email,
						lastInteraction: response.timestamp,
						source: response.action
					});
				}
			});
			// Keep only unique contacts (by ID)
			context.contacts = context.contacts.filter((contact: any, index: number, self: any[]) =>
				index === self.findIndex((c: any) => c.id === contact.id)
			);
		}
	}

	private accumulateEmailContext(context: any, response: MCPResponse): void {
		if (response.success && response.result) {
			const emails = Array.isArray(response.result) ? response.result : [response.result];
			emails.forEach((email: any) => {
				if (email.id || email.subject) {
					context.emails.push({
						id: email.id,
						subject: email.subject,
						from: email.from,
						to: email.to,
						timestamp: response.timestamp,
						source: response.action
					});
				}
			});
			// Keep last 20 emails
			context.emails = context.emails.slice(0, 20);
		}
	}

	private accumulateMeetingContext(context: any, response: MCPResponse): void {
		if (response.success && response.result) {
			const meetings = Array.isArray(response.result) ? response.result : [response.result];
			meetings.forEach((meeting: any) => {
				if (meeting.id || meeting.title) {
					context.meetings.push({
						id: meeting.id,
						title: meeting.title,
						startTime: meeting.startTime || meeting.start,
						endTime: meeting.endTime || meeting.end,
						attendees: meeting.attendees || [],
						timestamp: response.timestamp,
						source: response.action
					});
				}
			});
			// Keep last 10 meetings
			context.meetings = context.meetings.slice(0, 10);
		}
	}

	private accumulateTaskContext(context: any, response: MCPResponse): void {
		if (response.success && response.result) {
			const tasks = Array.isArray(response.result) ? response.result : [response.result];
			tasks.forEach((task: any) => {
				if (task.id || task.title) {
					context.tasks.push({
						id: task.id,
						title: task.title,
						status: task.status,
						dueDate: task.dueDate,
						timestamp: response.timestamp,
						source: response.action
					});
				}
			});
			// Keep last 20 tasks
			context.tasks = context.tasks.slice(0, 20);
		}
	}

	/**
	 * Get accumulated context for AI prompt
	 */
	getAccumulatedContext(session: ChatSession): string {
		if (!session.metadata?.contextAccumulated) {
			return '';
		}

		const context = session.metadata.contextAccumulated;
		let contextString = '';

		// Recent contacts
		if (context.contacts?.length > 0) {
			contextString += `\nRecent contacts: ${context.contacts.slice(0, 5).map((c: any) => c.name).join(', ')}`;
		}

		// Recent emails
		if (context.emails?.length > 0) {
			contextString += `\nRecent email subjects: ${context.emails.slice(0, 3).map((e: any) => e.subject).join(', ')}`;
		}

		// Upcoming meetings
		if (context.meetings?.length > 0) {
			contextString += `\nRecent meetings: ${context.meetings.slice(0, 3).map((m: any) => m.title).join(', ')}`;
		}

		// Recent tasks
		if (context.tasks?.length > 0) {
			contextString += `\nRecent tasks: ${context.tasks.slice(0, 3).map((t: any) => t.title).join(', ')}`;
		}

		// Recent actions
		if (context.recentActions?.length > 0) {
			contextString += `\nRecent actions: ${context.recentActions.slice(0, 3).map((a: any) => a.action).join(', ')}`;
		}

		return contextString;
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
}