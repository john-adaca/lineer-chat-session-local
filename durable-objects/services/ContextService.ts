import type { DurableObjectStorage } from 'cloudflare:workers';
import type {
	UserPreferences,
	ConversationContext,
	SessionPersonality,
	UserContextData,
} from '../types/ContextTypes';

export class ContextService {
	private userPreferences = new Map<string, UserPreferences>();
	private conversationContext = new Map<string, ConversationContext>();
	private sessionPersonalities = new Map<string, string>(); // Custom AI personalities per session
	private currentUserQueries = new Map<string, string>(); // Track current user query per session
	private emailDrafts = new Map<string, string>(); // Track email drafts per session (sessionId -> email_id)

	constructor(
		private storage: DurableObjectStorage | null,
		private persistConversationContextToStorage: () => Promise<void>,
		private persistUserPreferencesToStorage: () => Promise<void>,
		private persistSessionPersonalitiesToStorage: () => Promise<void>,
	) {}

	// Enhanced User Context Methods
	getDefaultUserPreferences(): UserPreferences {
		return {
			communicationStyle: 'friendly',
			responseLength: 'detailed',
			defaultTimezone: 'UTC',
			workingHours: { start: '09:00', end: '17:00' },
			preferredMeetingDuration: 30,
			emailSignature: '',
			notificationPreferences: ['email', 'push'],
		};
	}

	getDefaultConversationContext(): ConversationContext {
		return {
			userGoals: [],
			currentTasks: [],
			mentionedPreferences: {},
			emotionalTone: 'neutral',
			conversationFlow: [],
			lastUserIntent: '',
			pendingActions: [],
		};
	}

	buildPersonalizedSystemPrompt(
		userPrefs: UserPreferences,
		convContext: ConversationContext,
		customPersonality?: string,
		sessionMetadata?: any,
		workspaceId?: string,
		userId?: string,
	): string {
		let systemPrompt = `You are Lineer, a personal AI assistant that helps manage tasks, calendar, meetings, contacts, and emails.

CORE ROLE:
- Act as a proactive personal assistant for scheduling, task management, and communication
- Use available tools (MCP functions) to perform actions when the user requests them
- Provide clear, actionable responses without unnecessary verbosity
- Only use tools when the user's request clearly requires an action (scheduling, creating, searching, etc.)

TOOL USAGE GUIDELINES:
- Use MCP tools ONLY when the user explicitly requests an action or when it's clearly needed
- For informational requests, respond conversationally without calling tools
- When using tools, explain what you're doing briefly, then execute the action
- After tool execution, provide a concise summary of what was accomplished
- Don't call tools repeatedly for the same request

AVAILABLE CAPABILITIES:
- Calendar: Schedule meetings, check availability, list upcoming events
- Tasks: Create, update, list, and manage tasks with priorities and due dates
- Contacts: Search, view, and manage contact information
- Email: Draft, send, read, and manage emails

CRITICAL: When using MCP tools, use EXACT parameter names from the function schema:
- contacts_search: use "search_term" (not "query"), always include workspace_id and user_id
- tasks_create: use "title", "description", "priority", "due_date", "assignee_id", workspace_id, user_id
- meeting_draft_meeting: use "title", "start_time", "end_time", "attendee_emails", workspace_id, user_id
- email_draft_email: use "subject", "body", "to_emails", workspace_id, user_id

Always check the function's input_schema for exact parameter names before calling any tool.

RESPONSE STYLE:
- Be direct and helpful
- Use the user's preferred communication style: ${this.getStyleInstructions(userPrefs)}
- Keep responses ${userPrefs.responseLength}
- Focus on getting things done efficiently

CONTEXT AWARENESS:
${
	this.buildContextualInformation(convContext)
		? `Current context: ${this.buildContextualInformation(convContext)}`
		: 'No specific context available.'
}

${this.buildMetadataContext(sessionMetadata)}

REMEMBER: You're a personal assistant - anticipate needs but don't overwhelm with unnecessary actions.`;

		// Add workspace and user ID information for MCP function calls
		if (workspaceId && userId) {
			systemPrompt += `\n\n🚨 CRITICAL FUNCTION CALL RULE: When calling MCP functions, you MUST use the actual workspace_id and user_id values from this request. DO NOT use placeholder strings like "workspace" or "user".

CURRENT REQUEST VALUES (USE THESE EXACT VALUES):
- workspace_id: "${workspaceId}"
- user_id: "${userId}"

EXAMPLE: If workspace_id is "abc-123-def", use "abc-123-def" in your function call, NOT "workspace_id" or "workspace".

ALWAYS use the actual UUID values shown above in your function calls.`;
		}

		// Add personality customization if specified
		if (customPersonality) {
			systemPrompt += `\n\nPERSONALITY ADJUSTMENT: ${customPersonality}`;
		}

		return systemPrompt;
	}

	getStyleInstructions(userPrefs: UserPreferences): string {
		switch (userPrefs.communicationStyle) {
			case 'formal':
				return 'Use formal language, complete sentences, and professional terminology. Avoid contractions and casual expressions.';
			case 'casual':
				return 'Use casual, friendly language with contractions and informal expressions. Be conversational and approachable.';
			case 'friendly':
				return 'Use warm, encouraging language. Be supportive and show enthusiasm. Use positive reinforcement.';
			case 'professional':
				return 'Use clear, concise language. Be direct and efficient. Focus on facts and actionable information.';
			default:
				return "Use clear, helpful language that matches the user's needs.";
		}
	}

	buildContextualInformation(convContext: ConversationContext): string {
		const info: string[] = [];

		if (convContext.userGoals.length > 0) {
			info.push(`User Goals: ${convContext.userGoals.join(', ')}`);
		}

		if (convContext.currentTasks.length > 0) {
			info.push(`Current Tasks: ${convContext.currentTasks.join(', ')}`);
		}

		if (convContext.pendingActions.length > 0) {
			info.push(`Pending Actions: ${convContext.pendingActions.join(', ')}`);
		}

		if (convContext.lastUserIntent) {
			info.push(`Last Intent: ${convContext.lastUserIntent}`);
		}

		if (convContext.emotionalTone !== 'neutral') {
			info.push(`Emotional Tone: ${convContext.emotionalTone}`);
		}

		return info.join('. ');
	}

	getEmotionalAdaptation(tone: ConversationContext['emotionalTone']): string {
		switch (tone) {
			case 'positive':
				return 'The user seems positive and engaged. Match their enthusiasm and provide encouraging responses.';
			case 'frustrated':
				return 'The user seems frustrated. Be patient, understanding, and focus on solving their problem efficiently.';
			case 'excited':
				return 'The user is excited. Share in their enthusiasm while providing helpful information.';
			case 'urgent':
				return 'The user needs urgent help. Prioritize speed and efficiency in your response.';
			default:
				return 'Maintain a helpful and professional tone.';
		}
	}

	buildMetadataContext(sessionMetadata?: any): string {
		if (!sessionMetadata) return '';

		let context = '';

		// Add recent actions context
		if (sessionMetadata.recent_actions && sessionMetadata.recent_actions.length > 0) {
			context += '\n\nRECENT ACTIVITY:\n';
			sessionMetadata.recent_actions.slice(-3).forEach((action: any, index: number) => {
				context += `${index + 1}. ${action.type}: ${action.summary} (${
					action.entity_count
				} items)\n`;
			});
		}

		// Add workspace summary
		if (sessionMetadata.workspace_context?.entity_counts) {
			const counts = sessionMetadata.workspace_context.entity_counts;
			context += '\n\nWORKSPACE SUMMARY:\n';
			context += `- ${counts.contacts} contacts, ${counts.emails} emails, ${counts.meetings} meetings\n`;
			if (sessionMetadata.workspace_context.last_action) {
				context += `- Last action: ${sessionMetadata.workspace_context.last_action.type}\n`;
			}
		}

		return context;
	}

	async updateConversationContext(sessionId: string, userMessage: string): Promise<void> {
		try {
			let context = this.conversationContext.get(sessionId) || this.getDefaultConversationContext();

			// Analyze and update context based on user message
			context = await this.analyzeAndUpdateContext(context, userMessage);

			// Store updated context
			this.conversationContext.set(sessionId, context);

			// Persist to storage
			await this.persistConversationContextToStorage();

			console.log('✅ Updated conversation context for session:', sessionId);
		} catch (error) {
			console.error('Error updating conversation context:', error);
		}
	}

	async analyzeAndUpdateContext(
		context: ConversationContext,
		userMessage: string,
	): Promise<ConversationContext> {
		const updatedContext = { ...context };

		// Analyze emotional tone
		const emotionalTone = this.detectEmotionalTone(userMessage);
		if (emotionalTone !== 'neutral') {
			updatedContext.emotionalTone = emotionalTone;
		}

		// Extract user intent
		const intent = this.extractUserIntent(userMessage);
		if (intent) {
			updatedContext.lastUserIntent = intent;
		}

		// Extract goals and tasks
		const goals = this.extractGoals(userMessage);
		if (goals.length > 0) {
			updatedContext.userGoals = [...new Set([...updatedContext.userGoals, ...goals])];
		}

		const tasks = this.extractTasks(userMessage);
		if (tasks.length > 0) {
			updatedContext.currentTasks = [...new Set([...updatedContext.currentTasks, ...tasks])];
		}

		// Extract pending actions
		const actions = this.extractPendingActions(userMessage);
		if (actions.length > 0) {
			updatedContext.pendingActions = [...new Set([...updatedContext.pendingActions, ...actions])];
		}

		// Update conversation flow
		updatedContext.conversationFlow.push(userMessage);
		if (updatedContext.conversationFlow.length > 10) {
			updatedContext.conversationFlow = updatedContext.conversationFlow.slice(-10);
		}

		return updatedContext;
	}

	private detectEmotionalTone(message: string): ConversationContext['emotionalTone'] {
		const lowerMessage = message.toLowerCase();

		if (
			lowerMessage.includes('urgent') ||
			lowerMessage.includes('asap') ||
			lowerMessage.includes('immediately')
		) {
			return 'urgent';
		}

		if (
			lowerMessage.includes('frustrated') ||
			lowerMessage.includes('annoying') ||
			lowerMessage.includes('problem')
		) {
			return 'frustrated';
		}

		if (
			lowerMessage.includes('excited') ||
			lowerMessage.includes('great') ||
			lowerMessage.includes('awesome')
		) {
			return 'excited';
		}

		if (
			lowerMessage.includes('thanks') ||
			lowerMessage.includes('appreciate') ||
			lowerMessage.includes('helpful')
		) {
			return 'positive';
		}

		return 'neutral';
	}

	private extractUserIntent(message: string): string {
		const lowerMessage = message.toLowerCase();

		if (lowerMessage.includes('schedule') || lowerMessage.includes('meeting')) {
			return 'schedule_meeting';
		}

		if (lowerMessage.includes('email') || lowerMessage.includes('send message')) {
			return 'send_email';
		}

		if (lowerMessage.includes('find') || lowerMessage.includes('search')) {
			return 'search_information';
		}

		if (lowerMessage.includes('help') || lowerMessage.includes('how')) {
			return 'request_help';
		}

		return '';
	}

	private extractGoals(message: string): string[] {
		const goals: string[] = [];
		const lowerMessage = message.toLowerCase();

		if (lowerMessage.includes('want to') || lowerMessage.includes('goal is')) {
			// Extract goals from phrases like "I want to..." or "My goal is..."
			const goalMatches = message.match(/(?:want to|goal is|trying to)\s+([^.!?]+)/gi);
			if (goalMatches) {
				goalMatches.forEach((match) => {
					const goal = match.replace(/(?:want to|goal is|trying to)\s+/i, '').trim();
					if (goal) goals.push(goal);
				});
			}
		}

		return goals;
	}

	private extractTasks(message: string): string[] {
		const tasks: string[] = [];
		const lowerMessage = message.toLowerCase();

		if (lowerMessage.includes('need to') || lowerMessage.includes('have to')) {
			// Extract tasks from phrases like "I need to..." or "I have to..."
			const taskMatches = message.match(/(?:need to|have to|must)\s+([^.!?]+)/gi);
			if (taskMatches) {
				taskMatches.forEach((match) => {
					const task = match.replace(/(?:need to|have to|must)\s+/i, '').trim();
					if (task) tasks.push(task);
				});
			}
		}

		return tasks;
	}

	private extractPendingActions(message: string): string[] {
		const actions: string[] = [];
		const lowerMessage = message.toLowerCase();

		if (lowerMessage.includes('follow up') || lowerMessage.includes('remind me')) {
			actions.push('follow_up');
		}

		if (lowerMessage.includes('check back') || lowerMessage.includes('update me')) {
			actions.push('status_update');
		}

		return actions;
	}

	// User Preferences Management
	async setUserPreference(sessionId: string, preferenceData: any): Promise<void> {
		try {
			const currentPrefs = this.userPreferences.get(sessionId) || this.getDefaultUserPreferences();
			const updatedPrefs = { ...currentPrefs, ...preferenceData };

			this.userPreferences.set(sessionId, updatedPrefs);

			// Persist to storage
			await this.persistUserPreferencesToStorage();

			console.log('✅ Updated user preferences for session:', sessionId);
		} catch (error) {
			console.error('Error setting user preference:', error);
		}
	}

	getUserPreferences(sessionId: string): UserPreferences {
		return this.userPreferences.get(sessionId) || this.getDefaultUserPreferences();
	}

	// Session Personality Management
	async setSessionPersonality(sessionId: string, personality: string): Promise<void> {
		try {
			this.sessionPersonalities.set(sessionId, personality);

			// Persist to storage
			await this.persistSessionPersonalitiesToStorage();

			console.log('✅ Set session personality for session:', sessionId);
		} catch (error) {
			console.error('Error setting session personality:', error);
		}
	}

	getSessionPersonality(sessionId: string): string | null {
		return this.sessionPersonalities.get(sessionId) || null;
	}

	// User Context Management
	async setUserContext(sessionId: string, userContext: any): Promise<void> {
		try {
			// Update preferences if provided
			if (userContext.preferences) {
				await this.setUserPreference(sessionId, userContext.preferences);
			}

			// Update conversation context if provided
			if (userContext.conversationContext) {
				const currentContext =
					this.conversationContext.get(sessionId) || this.getDefaultConversationContext();
				const updatedContext = { ...currentContext, ...userContext.conversationContext };
				this.conversationContext.set(sessionId, updatedContext);
				await this.persistConversationContextToStorage();
			}

			// Update personality if provided
			if (userContext.personality) {
				await this.setSessionPersonality(sessionId, userContext.personality);
			}

			console.log('✅ Updated user context for session:', sessionId);
		} catch (error) {
			console.error('Error setting user context:', error);
		}
	}

	getUserContext(sessionId: string): UserContextData {
		return {
			preferences: this.getUserPreferences(sessionId),
			conversationContext:
				this.conversationContext.get(sessionId) || this.getDefaultConversationContext(),
			personality: this.getSessionPersonality(sessionId)
				? {
						id: sessionId,
						name: 'Custom',
						description: this.getSessionPersonality(sessionId)!,
						systemPrompt: this.getSessionPersonality(sessionId)!,
						createdAt: new Date(),
				  }
				: undefined,
			lastUpdated: new Date(),
		};
	}

	// Email Draft Tracking
	trackEmailDraft(sessionId: string, emailId: string): void {
		this.emailDrafts.set(sessionId, emailId);
	}

	getEmailDraftId(sessionId: string): string | null {
		return this.emailDrafts.get(sessionId) || null;
	}

	// Getters for external access
	getUserPreferencesMap(): Map<string, UserPreferences> {
		return this.userPreferences;
	}

	getConversationContextMap(): Map<string, ConversationContext> {
		return this.conversationContext;
	}

	getSessionPersonalitiesMap(): Map<string, string> {
		return this.sessionPersonalities;
	}

	getCurrentUserQueriesMap(): Map<string, string> {
		return this.currentUserQueries;
	}

	getEmailDraftsMap(): Map<string, string> {
		return this.emailDrafts;
	}
}
