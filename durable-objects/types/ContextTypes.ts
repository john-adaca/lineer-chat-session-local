// Enhanced User Context Types
export interface UserPreferences {
	communicationStyle: 'formal' | 'casual' | 'friendly' | 'professional';
	responseLength: 'brief' | 'detailed' | 'comprehensive';
	defaultTimezone: string;
	workingHours: { start: string; end: string };
	preferredMeetingDuration: number;
	emailSignature: string;
	notificationPreferences: string[];
}

export interface ConversationContext {
	userGoals: string[];
	currentTasks: string[];
	mentionedPreferences: Record<string, any>;
	emotionalTone: 'neutral' | 'positive' | 'frustrated' | 'excited' | 'urgent';
	conversationFlow: string[];
	lastUserIntent: string;
	pendingActions: string[];
}

export interface SessionPersonality {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	createdAt: Date;
}

export interface UserContextData {
	preferences: UserPreferences;
	conversationContext: ConversationContext;
	personality?: SessionPersonality;
	lastUpdated: Date;
}
