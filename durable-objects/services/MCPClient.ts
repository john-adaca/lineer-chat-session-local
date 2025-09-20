import type { MCPResponse } from '../../types';

export class MCPClient {
	private mcpServerUrl: string;
	private apiKey?: string;
	private context: { workspaceId?: string; userId?: string } = {};

	constructor(mcpServerUrl: string, apiKey?: string) {
		this.mcpServerUrl = mcpServerUrl;
		this.apiKey = apiKey;
	}

	/**
	 * Set the context for MCP calls
	 */
	setContext(context: { workspaceId?: string; userId?: string }): void {
		this.context = { ...this.context, ...context };
		console.log('🔧 MCP context updated:', this.context);
	}

	/**
	 * Execute an MCP action using JSON-RPC format
	 */
	async executeAction(action: string, parameters: any = {}): Promise<MCPResponse> {
		try {
			console.log('🔄 Executing MCP action:', { action, parameters });

			const url = `${this.mcpServerUrl}/mcp`;

			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};

			if (this.apiKey) {
				headers['Authorization'] = `Bearer ${this.apiKey}`;
			}

			// Use JSON-RPC 2.0 format as expected by MCP server
			const jsonRpcRequest = {
				jsonrpc: '2.0',
				method: 'invokeAction',
				params: {
					name: action,
					arguments: {
						workspace_id: this.context.workspaceId || '14f49f8a-1e2f-4159-abf9-bbff0078bfa9',
						user_id: this.context.userId || '330c7620-2914-4a5c-8d5f-e4bac4737d08',
						...parameters
					}
				},
				id: Date.now() // Unique request ID
			};


			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(jsonRpcRequest)
			});

			if (!response.ok) {
				throw new Error(`MCP server error: ${response.status} ${response.statusText}`);
			}

			const jsonRpcResponse = await response.json();
		
			// Handle JSON-RPC error responses
			if (jsonRpcResponse.error) {
				throw new Error(`MCP JSON-RPC error: ${jsonRpcResponse.error.message || jsonRpcResponse.error.code}`);
			}

			const result = jsonRpcResponse.result;

			const mcpResponse: MCPResponse = {
				id: `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				action,
				parameters,
				result,
				timestamp: new Date(),
				success: true,
				metadata: {
					responseSize: JSON.stringify(result).length,
					executionTime: Date.now()
				}
			};

	
			return mcpResponse;

		} catch (error) {
			console.error('❌ MCP action failed:', {
				action,
				parameters,
				error: error instanceof Error ? error.message : 'Unknown error',
				timestamp: new Date().toISOString()
			});

			// Enhanced error handling with more context
			let errorMessage = 'Unknown error occurred';
			let errorType = 'unknown_error';

			if (error instanceof Error) {
				errorMessage = error.message;

				// Categorize error types for better AI handling
				if (error.message.includes('404') || error.message.includes('Not Found')) {
					errorType = 'resource_not_found';
					errorMessage = `The requested resource was not found. Please check if the data exists.`;
				} else if (error.message.includes('403') || error.message.includes('Forbidden')) {
					errorType = 'permission_denied';
					errorMessage = `You don't have permission to perform this action. Please check your access rights.`;
				} else if (error.message.includes('400') || error.message.includes('Bad Request')) {
					errorType = 'validation_error';
					errorMessage = `The request was invalid. Please check the parameters and try again.`;
				} else if (error.message.includes('409') || error.message.includes('Conflict')) {
					errorType = 'conflict_error';
					errorMessage = `There was a conflict with the current state. The resource might already exist or be in use.`;
				} else if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
					errorType = 'rate_limit_error';
					errorMessage = `Too many requests. Please wait a moment before trying again.`;
				} else if (error.message.includes('500') || error.message.includes('Internal Server Error')) {
					errorType = 'server_error';
					errorMessage = `The server encountered an error. Please try again later.`;
				} else if (error.message.includes('timeout') || error.message.includes('TimeoutError')) {
					errorType = 'timeout_error';
					errorMessage = `The request timed out. Please try again.`;
				} else if (error.message.includes('network') || error.message.includes('ECONNREFUSED')) {
					errorType = 'network_error';
					errorMessage = `Network error. Please check your connection and try again.`;
				}
			}

			return {
				id: `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				action,
				parameters,
				result: null,
				timestamp: new Date(),
				success: false,
				error: errorMessage,
				errorType,
				metadata: {
					responseSize: 0,
					executionTime: Date.now(),
					originalError: error instanceof Error ? error.message : String(error),
					retryable: this.isRetryableError(errorType)
				}
			};
		}
	}

	/**
	 * Search for contacts
	 */
	async searchContacts(query: string, limit: number = 10): Promise<MCPResponse> {
		return this.executeAction('contacts_search', { query, limit });
	}

	/**
	 * Get recent contacts
	 */
	async getRecentContacts(limit: number = 10): Promise<MCPResponse> {
		return this.executeAction('contacts_get_recent', { limit });
	}

	/**
	 * Get contacts by company
	 */
	async getContactsByCompany(company: string, limit: number = 10): Promise<MCPResponse> {
		return this.executeAction('contacts_get_by_company', { company, limit });
	}

	/**
	 * Get all contacts
	 */
	async getAllContacts(limit: number = 50): Promise<MCPResponse> {
		return this.executeAction('contacts_get_all', { limit });
	}

	/**
	 * Draft an email
	 */
	async draftEmail(emailData: { to_emails: string[]; subject: string; body: string }): Promise<MCPResponse> {
		// Map the parameters to what the MCP server expects
		const parameters = {
			to_emails: emailData.to_emails,
			subject: emailData.subject,
			body: emailData.body
		};

		return this.executeAction('email_draft_email', parameters);
	}

	/**
	 * Update an existing email draft
	 */
	async updateDraftEmail(emailId: string, updateData: { subject?: string; body?: string; to_emails?: string[]; cc_emails?: string[]; bcc_emails?: string[] }): Promise<MCPResponse> {
		// Map the parameters to what the MCP server expects
		console.log("----------------------------- , e" , emailId)
		const parameters = {
			email_id: emailId,
			...updateData
		};
		console.log("----------------------------- , p" , parameters)
		return this.executeAction('email_update_draft', parameters);
	}

	/**
	 * Send an email
	 */
	async sendEmail(emailId: string): Promise<MCPResponse> {
		return this.executeAction('email_send_email', { email_id:emailId });
	}

	/**
	 * Read emails
	 */
	async readEmails(folder: string = 'inbox', limit: number = 10): Promise<MCPResponse> {
		return this.executeAction('email_read_email', { folder, limit });
	}

	/**
	 * Archive an email
	 */
	async archiveEmail(emailId: string): Promise<MCPResponse> {
		return this.executeAction('email_archive_email', { emailId });
	}

	/**
	 * Delete an email
	 */
	async deleteEmail(emailId: string): Promise<MCPResponse> {
		return this.executeAction('email_delete_email', { emailId });
	}

	/**
	 * Draft a meeting
	 */
	async draftMeeting(title: string, attendees: string[], startTime: string, duration: number = 60): Promise<MCPResponse> {
		return this.executeAction('meeting_draft_meeting', {
			title,
			attendees,
			start_time: startTime,
			duration
		});
	}

	/**
	 * Send meeting invite
	 */
	async sendMeetingInvite(meetingId: string): Promise<MCPResponse> {
		return this.executeAction('meeting_send_invite', { meetingId });
	}

	/**
	 * List meetings
	 */
	async listMeetings(limit: number = 10): Promise<MCPResponse> {
		return this.executeAction('meeting_list_meetings', { limit });
	}

	/**
	 * Cancel meeting
	 */
	async cancelMeeting(meetingId: string): Promise<MCPResponse> {
		return this.executeAction('meeting_cancel_meeting', { meetingId });
	}

	/**
	 * Get tasks
	 */
	async getTasks(limit: number = 20): Promise<MCPResponse> {
		return this.executeAction('tasks_get_tasks', { limit });
	}

	/**
	 * Get overdue tasks
	 */
	async getOverdueTasks(): Promise<MCPResponse> {
		return this.executeAction('tasks_get_overdue', {});
	}

	/**
	 * Get today's tasks
	 */
	async getTodayTasks(): Promise<MCPResponse> {
		return this.executeAction('tasks_get_today', {});
	}

	/**
	 * Create a task
	 */
	async createTask(title: string, description?: string, dueDate?: string): Promise<MCPResponse> {
		return this.executeAction('tasks_create', { title, description, due_date: dueDate });
	}

	/**
	 * Update a task
	 */
	async updateTask(taskId: string, updates: any): Promise<MCPResponse> {
		return this.executeAction('tasks_update', { taskId, ...updates });
	}

	/**
	 * Delete a task
	 */
	async deleteTask(taskId: string): Promise<MCPResponse> {
		return this.executeAction('tasks_delete', { taskId });
	}

	/**
	 * Get activity feed
	 */
	async getActivityFeed(limit: number = 20): Promise<MCPResponse> {
		return this.executeAction('activities_get_feed', { limit });
	}

	/**
	 * Get activity analytics
	 */
	async getActivityAnalytics(): Promise<MCPResponse> {
		return this.executeAction('activities_get_analytics', {});
	}

	/**
	 * Add background job
	 */
	async addBackgroundJob(jobType: string, parameters: any): Promise<MCPResponse> {
		return this.executeAction('queue_add_job', { jobType, parameters });
	}

	/**
	 * Check if an error is retryable
	 */
	private isRetryableError(errorType: string): boolean {
		const retryableErrors = [
			'timeout_error',
			'network_error',
			'rate_limit_error',
			'server_error'
		];

		return retryableErrors.includes(errorType);
	}

	/**
	 * Get available MCP functions from the server
	 */
	async getAvailableFunctions(): Promise<any[]> {
		try {
			console.log('🔍 Fetching available MCP functions from server...');

			const response = await fetch(`${this.mcpServerUrl}/mcp`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'listActions',
					params: {
						// workspace_id: this.context.workspaceId ,
						// user_id: this.context.userId 
					},
					id: Date.now()
				})
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch capabilities: ${response.status}`);
			}

			const result = await response.json();

			if (result.error) {
				console.warn('⚠️ MCP server returned error for capabilities:', result.error);
				// Return default functions if server doesn't support getCapabilities
				return this.getDefaultFunctions();
			}

			const capabilities = result.result;
			
			// Convert MCP capabilities to OpenAI function format
			return this.convertMCPCapabilitiesToOpenAIFunctions(capabilities);

		} catch (error) {
			console.warn('⚠️ Failed to fetch MCP capabilities, using defaults:', error);
			return this.getDefaultFunctions();
		}
	}

	/**
	 * Convert MCP capabilities to OpenAI function format
	 */
	private convertMCPCapabilitiesToOpenAIFunctions(capabilities: any): any[] {
		const functions: any[] = [];

		// Handle listActions response format (array of actions)
		if (Array.isArray(capabilities)) {
			for (const action of capabilities) {
				if (action.name && action.input_schema) {
					functions.push({
						name: action.name,
						description: action.description || `Execute ${action.name}`,
						parameters: action.input_schema
					});
				}
			}
		}
		// Handle listResources response format (resources with capabilities)
		else if (capabilities.resources) {
			for (const resource of capabilities.resources) {
				if (resource.capabilities) {
					for (const capability of resource.capabilities) {
						if (capability.actions) {
							for (const action of capability.actions) {
								functions.push({
									name: action.name || action,
									description: action.description || `${action} in ${resource.name}`,
									parameters: {
										type: "object",
										properties: {
											// Add common parameters
											limit: {
												type: "number",
												description: "Maximum number of results",
												default: 10
											}
										}
									}
								});
							}
						}
					}
				}
			}
		}

		// If no functions found, return defaults
		if (functions.length === 0) {
			return this.getDefaultFunctions();
		}

		console.log(`✅ Converted ${functions.length} MCP actions to OpenAI functions`);
		return functions;
	}

	/**
	 * Get default functions when server doesn't provide capabilities
	 */
	private getDefaultFunctions(): any[] {
		return [
			{
				name: "search_contacts",
				description: "Search for contacts in the workspace by name, email, or company",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query (name, email, or company)" },
						limit: { type: "number", description: "Maximum number of results to return", default: 10 }
					},
					required: ["query"]
				}
			},
			{
				name: "get_recent_contacts",
				description: "Get recently added or updated contacts",
				parameters: {
					type: "object",
					properties: {
						limit: { type: "number", description: "Maximum number of contacts to return", default: 10 }
					}
				}
			},
			{
				name: "send_email",
				description: "Send an email to one or more recipients",
				parameters: {
					type: "object",
					properties: {
						to: { type: "array", items: { type: "string" }, description: "Email addresses of recipients" },
						subject: { type: "string", description: "Email subject line" },
						body: { type: "string", description: "Email body content" }
					},
					required: ["to", "subject", "body"]
				}
			},
			{
				name: "draft_email",
				description: "Create a draft email without sending it",
				parameters: {
					type: "object",
					properties: {
						to: { type: "array", items: { type: "string" }, description: "Email addresses of recipients" },
						subject: { type: "string", description: "Email subject line" },
						body: { type: "string", description: "Email body content" }
					},
					required: ["to", "subject", "body"]
				}
			},
			{
				name: "schedule_meeting",
				description: "Schedule a new meeting or calendar event",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "Meeting title" },
						attendees: { type: "array", items: { type: "string" }, description: "Email addresses of attendees" },
						start_time: { type: "string", description: "Meeting start time (ISO format or natural language)" },
						duration: { type: "number", description: "Meeting duration in minutes", default: 60 },
						location: { type: "string", description: "Meeting location (optional)" }
					},
					required: ["title", "attendees", "start_time"]
				}
			},
			{
				name: "get_tasks",
				description: "Get workspace tasks, optionally filtered by status",
				parameters: {
					type: "object",
					properties: {
						status: { type: "string", enum: ["all", "pending", "completed", "overdue"], description: "Filter tasks by status", default: "all" },
						limit: { type: "number", description: "Maximum number of tasks to return", default: 20 }
					}
				}
			},
			{
				name: "create_task",
				description: "Create a new task in the workspace",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string", description: "Task title" },
						description: { type: "string", description: "Task description (optional)" },
						due_date: { type: "string", description: "Task due date (ISO format or natural language)" },
						assignee: { type: "string", description: "Email of person to assign task to (optional)" }
					},
					required: ["title"]
				}
			},
			{
				name: "read_emails",
				description: "Read emails from inbox or other folders",
				parameters: {
					type: "object",
					properties: {
						folder: { type: "string", description: "Email folder to read from", default: "inbox" },
						limit: { type: "number", description: "Maximum number of emails to return", default: 10 },
						unread_only: { type: "boolean", description: "Only return unread emails", default: false }
					}
				}
			}
		];
	}

	/**
	 * Get job status
	 */
	async getJobStatus(jobId: string): Promise<MCPResponse> {
		return this.executeAction('queue_get_status', { jobId });
	}

	/**
	 * Cancel background job
	 */
	async cancelJob(jobId: string): Promise<MCPResponse> {
		return this.executeAction('queue_cancel_job', { jobId });
	}
}