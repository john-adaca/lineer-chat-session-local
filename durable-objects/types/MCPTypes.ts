// MCP Context Management Types
export interface MCPEntityContext {
	contacts: Array<{ id: string; name: string; email: string; metadata?: any }>;
	emails: Array<{ id: string; subject: string; status: string; metadata?: any }>;
	meetings: Array<{ id: string; title: string; status: string; metadata?: any }>;
	lastUpdated: number;
}

export interface MCPCacheEntry {
	data: any;
	expiry: number;
	actionType: string;
}

export interface MCPStatusUpdate {
	status: 'thinking' | 'analyzing' | 'calling_tool' | 'processing_results' | 'completing';
	action?: string;
	details?: string;
}

export interface MCPCapabilities {
	actions: any[];
	resources: any[];
	prompts: any[];
}

export interface MCPActionMetadata {
	actionName: string;
	parameters: any;
	result: any;
	timestamp: number;
	sessionId: string;
	success: boolean;
	error?: string;
}

export interface MCPCallOptions {
	maxRetries?: number;
	timeout?: number;
	enableCaching?: boolean;
}
