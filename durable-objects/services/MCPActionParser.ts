import { MCPClient } from './MCPClient';
import type { MCPResponse } from '../../types';

export interface ParsedAction {
	action: string;
	parameters: any;
	description: string;
}

export class MCPActionParser {
	private mcpClient: MCPClient;

	constructor(mcpClient: MCPClient) {
		this.mcpClient = mcpClient;
	}

	/**
	 * Parse AI response for MCP actions
	 */
	parseActions(aiResponse: string): ParsedAction[] {
		const actions: ParsedAction[] = [];

		// Look for action patterns in the AI response
		const actionPatterns = [
			// Pattern 1: "I'll use [action] with [parameters]"
			/I['"]?ll use (\w+) with (.+?)(?:\.|$)/gi,

			// Pattern 2: "Execute [action] with [parameters]"
			/Execute (\w+) with (.+?)(?:\.|$)/gi,

			// Pattern 3: "Call [action] with [parameters]"
			/Call (\w+) with (.+?)(?:\.|$)/gi,

			// Pattern 4: "Run [action] with [parameters]"
			/Run (\w+) with (.+?)(?:\.|$)/gi,

			// Pattern 5: "Use [action] for [parameters]"
			/Use (\w+) for (.+?)(?:\.|$)/gi,

			// Pattern 6: "Search for [query]" -> contacts_search
			/Search for ([^.!?]+?)(?:\.|$)/gi,

			// Pattern 7: "Find [query]" -> contacts_search
			/Find ([^.!?]+?)(?:\.|$)/gi,

			// Pattern 8: "Draft an email to [to] about [subject]"
			/Draft an email to ([^.!?]+?) about ([^.!?]+?)(?:\.|$)/gi,

			// Pattern 9: "Send an email to [to] with subject [subject]"
			/Send an email to ([^.!?]+?) with subject ([^.!?]+?)(?:\.|$)/gi,

			// Pattern 10: "Schedule a meeting with [attendees] for [time]"
			/Schedule a meeting with ([^.!?]+?) for ([^.!?]+?)(?:\.|$)/gi,

			// Pattern 11: "Create a task for [title]"
			/Create a task for ([^.!?]+?)(?:\.|$)/gi,

			// Pattern 12: "Get my tasks" -> tasks_get_tasks
			/Get my tasks(?:\.|$)/gi,

			// Pattern 13: "Show me today's tasks" -> tasks_get_today
			/(?:Show me |Get )?(?:today'?s? )?tasks(?:\.|$)/gi,

			// Pattern 14: "Check my calendar" -> meeting_list_meetings
			/(?:Check |Show |Get )?(?:my )?calendar(?:\.|$)/gi,

			// Pattern 15: "Read my emails" -> email_read_email
			/(?:Read |Check |Get )?(?:my )?emails?(?:\.|$)/gi
		];

		for (const pattern of actionPatterns) {
			let match;
			while ((match = pattern.exec(aiResponse)) !== null) {
				const parsedAction = this.parseMatch(match, pattern);
				if (parsedAction) {
					actions.push(parsedAction);
				}
			}
		}

		console.log('🔍 Parsed actions from AI response:', {
			responseLength: aiResponse.length,
			actionsFound: actions.length,
			actions: actions.map(a => ({ action: a.action, description: a.description }))
		});

		return actions;
	}

	/**
	 * Parse a regex match into an action
	 */
	private parseMatch(match: RegExpMatchArray, pattern: RegExp): ParsedAction | null {
		const fullMatch = match[0];
		const groups = match.slice(1);

		// Handle different pattern types
		if (pattern.source.includes('Search for') || pattern.source.includes('Find')) {
			// Search patterns -> contacts_search
			const query = groups[0]?.trim();
			if (query) {
				return {
					action: 'contacts_search',
					parameters: { query, limit: 10 },
					description: `Search for contacts matching "${query}"`
				};
			}
		}

		if (pattern.source.includes('Draft an email')) {
			// Email draft pattern
			const to = groups[0]?.trim();
			const subject = groups[1]?.trim();
			if (to && subject) {
				return {
					action: 'email_draft_email',
					parameters: {
						to: [to],
						subject: subject,
						body: `Regarding: ${subject}`
					},
					description: `Draft email to ${to} about ${subject}`
				};
			}
		}

		if (pattern.source.includes('Send an email')) {
			// Email send pattern
			const to = groups[0]?.trim();
			const subject = groups[1]?.trim();
			if (to && subject) {
				return {
					action: 'email_draft_email',
					parameters: {
						to: [to],
						subject: subject,
						body: `Subject: ${subject}`
					},
					description: `Send email to ${to} with subject ${subject}`
				};
			}
		}

		if (pattern.source.includes('Schedule a meeting')) {
			// Meeting schedule pattern
			const attendees = groups[0]?.trim();
			const time = groups[1]?.trim();
			if (attendees && time) {
				return {
					action: 'meeting_draft_meeting',
					parameters: {
						title: 'Meeting',
						attendees: attendees.split(',').map((a: string) => a.trim()),
						start_time: time,
						duration: 60
					},
					description: `Schedule meeting with ${attendees} at ${time}`
				};
			}
		}

		if (pattern.source.includes('Create a task')) {
			// Task creation pattern
			const title = groups[0]?.trim();
			if (title) {
				return {
					action: 'tasks_create',
					parameters: { title },
					description: `Create task: ${title}`
				};
			}
		}

		if (pattern.source.includes('tasks') && pattern.source.includes('today')) {
			// Today's tasks pattern
			return {
				action: 'tasks_get_today',
				parameters: {},
				description: 'Get today\'s tasks'
			};
		}

		if (pattern.source.includes('tasks') && !pattern.source.includes('today')) {
			// General tasks pattern
			return {
				action: 'tasks_get_tasks',
				parameters: { limit: 20 },
				description: 'Get all tasks'
			};
		}

		if (pattern.source.includes('calendar')) {
			// Calendar pattern
			return {
				action: 'meeting_list_meetings',
				parameters: { limit: 10 },
				description: 'List upcoming meetings'
			};
		}

		if (pattern.source.includes('emails')) {
			// Email reading pattern
			return {
				action: 'email_read_email',
				parameters: { folder: 'inbox', limit: 10 },
				description: 'Read recent emails'
			};
		}

		// Generic action pattern parsing
		if (groups.length >= 1) {
			const action = groups[0]?.trim();
			const params = groups[1]?.trim();

			if (action && this.isValidAction(action)) {
				return {
					action,
					parameters: this.parseParameters(params),
					description: `Execute ${action} with ${params || 'default parameters'}`
				};
			}
		}

		return null;
	}

	/**
	 * Check if action is valid
	 */
	private isValidAction(action: string): boolean {
		const validActions = [
			'contacts_search', 'contacts_get_recent', 'contacts_get_by_company', 'contacts_get_all',
			'email_draft_email', 'email_send_email', 'email_read_email', 'email_archive_email', 'email_delete_email',
			'meeting_draft_meeting', 'meeting_send_invite', 'meeting_list_meetings', 'meeting_cancel_meeting',
			'tasks_get_tasks', 'tasks_get_overdue', 'tasks_get_today', 'tasks_create', 'tasks_update', 'tasks_delete',
			'activities_get_feed', 'activities_get_analytics',
			'queue_add_job', 'queue_get_status', 'queue_cancel_job'
		];

		return validActions.includes(action);
	}

	/**
	 * Parse parameter string into object
	 */
	private parseParameters(paramsString: string): any {
		if (!paramsString) return {};

		try {
			// Try to parse as JSON first
			return JSON.parse(paramsString);
		} catch {
			// Parse key-value pairs
			const params: any = {};
			const pairs = paramsString.split(',');

			for (const pair of pairs) {
				const [key, value] = pair.split(':').map(s => s.trim());
				if (key && value) {
					// Try to parse value as number or boolean
					if (value === 'true') params[key] = true;
					else if (value === 'false') params[key] = false;
					else if (!isNaN(Number(value))) params[key] = Number(value);
					else params[key] = value.replace(/['"]/g, ''); // Remove quotes
				}
			}

			return params;
		}
	}

	/**
	 * Execute parsed actions
	 */
	async executeActions(actions: ParsedAction[]): Promise<MCPResponse[]> {
		const results: MCPResponse[] = [];

		for (const action of actions) {
			try {
				console.log('🚀 Executing parsed action:', action);

				let result: MCPResponse;

				// Route to appropriate MCP client method
				switch (action.action) {
					case 'contacts_search':
						result = await this.mcpClient.searchContacts(
							action.parameters.query,
							action.parameters.limit
						);
						break;

					case 'contacts_get_recent':
						result = await this.mcpClient.getRecentContacts(action.parameters.limit);
						break;

					case 'contacts_get_by_company':
						result = await this.mcpClient.getContactsByCompany(
							action.parameters.company,
							action.parameters.limit
						);
						break;

					case 'contacts_get_all':
						result = await this.mcpClient.getAllContacts(action.parameters.limit);
						break;

					case 'email_draft_email':
						result = await this.mcpClient.draftEmail({
							to_emails: action.parameters.to,  // Map 'to' to 'to_emails' for MCP server
							subject: action.parameters.subject,
							body: action.parameters.body
						});
						break;

					case 'email_send_email':
						result = await this.mcpClient.sendEmail(action.parameters.emailId);
						break;

					case 'email_read_email':
						result = await this.mcpClient.readEmails(
							action.parameters.folder,
							action.parameters.limit
						);
						break;

					case 'meeting_draft_meeting':
						result = await this.mcpClient.draftMeeting(
							action.parameters.title,
							action.parameters.attendees,
							action.parameters.start_time,
							action.parameters.duration
						);
						break;

					case 'meeting_list_meetings':
						result = await this.mcpClient.listMeetings(action.parameters.limit);
						break;

					case 'tasks_get_tasks':
						result = await this.mcpClient.getTasks(action.parameters.limit);
						break;

					case 'tasks_get_today':
						result = await this.mcpClient.getTodayTasks();
						break;

					case 'tasks_create':
						result = await this.mcpClient.createTask(
							action.parameters.title,
							action.parameters.description,
							action.parameters.due_date
						);
						break;

					default:
						// Generic execution
						result = await this.mcpClient.executeAction(action.action, action.parameters);
				}

				results.push(result);

			} catch (error) {
				console.error('❌ Failed to execute action:', action, error);
				results.push({
					id: `error-${Date.now()}`,
					action: action.action,
					parameters: action.parameters,
					result: null,
					timestamp: new Date(),
					success: false,
					error: error instanceof Error ? error.message : 'Execution failed'
				});
			}
		}

		return results;
	}
}