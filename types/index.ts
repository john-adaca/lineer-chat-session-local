// WebSocket Message Types
export interface WebSocketMessage {
	type: 'message' | 'interrupt' | 'status' | 'set_preference' | 'set_personality' | 'set_user_context' | 'get_context' | 'context_data' | 'error' | 'test_mcp_cache' | 'accumulate_mcp_response' | 'get_session_summary' | 'session_summary';
	content?: string;
	data?: any;
	messageId?: string;
	sessionId?: string;
	supabaseSessionId?: string;
}

// Chat Message Types
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: Date;
	metadata?: any;
}

// Chat Session Types
export interface ChatSession {
	id: string;
	supabaseSessionId: string;
	userId: string;
	workspaceId: string;
	messages: ChatMessage[];
	actions: any[];
	isActive: boolean;
	createdAt: Date;
	lastActivity: Date;
	personality?: any;
	context?: any;
	metadata?: {
		mcpResponses: MCPResponse[];
		contextAccumulated: Record<string, any>;
		sessionType: string;
		createdFromUI: boolean;
		lastMCPInteraction: Date | null;
		totalMCPActions: number;
		aiSummaries?: Array<{
			action: string;
			summary: string;
			timestamp: Date;
			rawDataSize: number;
		}>;
		lastActionResult?: Record<string, {
			result: any;
			timestamp: Date;
			parameters: any;
		}>;
	};
}

// MCP Response Types for metadata accumulation
export interface MCPResponse {
	id: string;
	action: string;
	parameters: any;
	result: any;
	timestamp: Date;
	success: boolean;
	error?: string;
	errorType?: string;
	metadata?: {
		responseSize?: number;
		executionTime?: number;
		originalError?: string;
		retryable?: boolean;
		[key: string]: any;
	};
}

// AI Stream Chunk Types
export interface AIStreamChunk {
	type: 'thinking' | 'content' | 'done' | 'error';
	content?: string;
	messageId: string;
	metadata?: any;
}

// Re-export types from subdirectories
export * from '../durable-objects/types/ContextTypes';
export * from '../durable-objects/types/MCPTypes';