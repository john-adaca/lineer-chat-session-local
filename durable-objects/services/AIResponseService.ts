import type { WebSocketMessage, ChatMessage, ChatSession } from '../../types';
import type { MCPCapabilities } from '../types/MCPTypes';

export class AIResponseService {
	private isStreaming = false;
	private currentStreamAbortController: AbortController | null = null;
	private interruptionHandler: (() => void) | null = null;

	constructor(
		private env: { OPENAI_API_KEY: string },
		private getMCPCapabilities: () => Promise<MCPCapabilities>,
		private executeMCPAction: (
			webSocket: any,
			functionCall: any,
			messageId: string,
			sessionId: string,
		) => Promise<void>,
		private buildMainConversationMessages: (
			session: any,
			userMessage: any,
			availableActions: any[],
		) => any[],
		private sendMessage: (webSocket: any, message: WebSocketMessage) => void,
		private sendError: (webSocket: any, error: string) => void,
		private generateId: () => string,
		private currentUserQueries: Map<string, string>,
	) {}

	async generateAIResponse(
		webSocket: any,
		session: ChatSession,
		userMessage: ChatMessage,
	): Promise<void> {
		if (this.isStreaming) {
			this.sendError(webSocket, 'AI is already responding');
			return;
		}

		this.isStreaming = true;
		this.currentStreamAbortController = new AbortController();

		try {
			// Create AI message
			const aiMessage: ChatMessage = {
				id: this.generateId(),
				role: 'assistant',
				content: '',
				timestamp: new Date(),
			};

			session.messages.push(aiMessage);

			// Send initial status
			this.sendMessage(webSocket, {
				type: 'status',
				content: 'AI is thinking...',
				messageId: aiMessage.id,
			});

			// Generate AI response with streaming
			await this.streamAIResponse(webSocket, session, aiMessage, userMessage);
		} catch (error) {
			console.error('Error generating AI response:', error);
			this.sendError(webSocket, 'Failed to generate AI response');
		} finally {
			this.isStreaming = false;
			this.currentStreamAbortController = null;
		}
	}

	async streamAIResponse(
		webSocket: any,
		session: ChatSession,
		aiMessage: ChatMessage,
		userMessage: ChatMessage,
	): Promise<void> {
		let streamingTimeout: NodeJS.Timeout | null = null;

		try {
			// Store the current user query for intelligent response crafting
			this.currentUserQueries.set(session.id, userMessage.content);

			// Create abort controller for this specific stream
			const streamAbortController = new AbortController();
			this.currentStreamAbortController = streamAbortController;

			// Set up interruption handler
			const handleInterruption = () => {
				if (streamAbortController && !streamAbortController.signal.aborted) {
					streamAbortController.abort();
					this.sendMessage(webSocket, {
						type: 'status',
						content: 'AI response interrupted by user',
						messageId: aiMessage.id,
					});
				}
			};

			// Store interruption handler for this stream
			this.setInterruptionHandler(handleInterruption);

			// Call OpenAI API with streaming
			try {
				const openaiApiKey = this.env.OPENAI_API_KEY;
				if (!openaiApiKey) {
					throw new Error('OpenAI API key not configured');
				}

				// First, discover available MCP actions
				const mcpCapabilities = await this.getMCPCapabilities();
				const availableActions = mcpCapabilities.actions;

				console.log('🛠️ Available MCP actions for OpenAI:', availableActions.length);
				if (availableActions.length === 0) {
					console.warn('⚠️ No MCP actions available - AI will not be able to call MCP functions');
				}

				// Set up a timeout to prevent infinite "Calling external services" state
				streamingTimeout = setTimeout(() => {
					console.log('⏰ Streaming timeout reached - forcing completion');
					if (streamAbortController && !streamAbortController.signal.aborted) {
						streamAbortController.abort();
					}
				}, 30000); // 30 second timeout

				const response = await this.retryOpenAICall(() =>
					fetch('https://api.openai.com/v1/chat/completions', {
						method: 'POST',
						headers: {
							Authorization: `Bearer ${openaiApiKey}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							model: 'gpt-3.5-turbo',
							messages: this.buildMainConversationMessages(session, userMessage, availableActions),
							stream: true,
							temperature: 0.7,
							max_tokens: 1000,
							tools: availableActions,
							tool_choice: 'auto',
						}),
						// Don't use signal in retry to avoid conflicts
						// signal: streamAbortController.signal,
					}),
				);

				const reader = response.body?.getReader();
				if (!reader) {
					throw new Error('No response body reader available');
				}

				const decoder = new TextDecoder();
				let buffer = '';
				let accumulatedToolCalls: any[] = [];

				while (true) {
					// Check for interruption
					if (streamAbortController.signal.aborted) {
						console.log('🛑 AI response interrupted by user');
						reader.cancel();
						break;
					}

					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const data = line.slice(6);
							if (data === '[DONE]') {
								break;
							}

							try {
								const parsed = JSON.parse(data);
								const choice = parsed.choices?.[0];

								// Handle content streaming
								const content = choice?.delta?.content;
								if (content) {
									aiMessage.content += content;

									this.sendMessage(webSocket, {
										type: 'content',
										content: content,
										messageId: aiMessage.id,
									});
								}

								// Handle tool calls (streaming - may be incomplete)
								const toolCalls = choice?.delta?.tool_calls;
								if (toolCalls) {
									for (const toolCall of toolCalls) {
										const index = toolCall.index || 0;

										// Initialize tool call if it doesn't exist
										if (!accumulatedToolCalls[index]) {
											accumulatedToolCalls[index] = {
												id: toolCall.id || '',
												type: 'function',
												function: {
													name: '',
													arguments: '',
												},
											};
										}

										// Accumulate the function name and arguments
										if (toolCall.function?.name) {
											accumulatedToolCalls[index].function.name = toolCall.function.name;
										}
										if (toolCall.function?.arguments) {
											accumulatedToolCalls[index].function.arguments += toolCall.function.arguments;
										}
									}
								}

								// Handle complete tool calls (when the entire tool call is received)
								const completeToolCalls = choice?.tool_calls;
								if (completeToolCalls) {
									for (const toolCall of completeToolCalls) {
										if (toolCall.function) {
											console.log(
												'🔧 Processing complete tool call:',
												toolCall.function.name,
												'with args:',
												toolCall.function.arguments,
											);

											// Validate that we have complete arguments
											if (
												!toolCall.function.arguments ||
												toolCall.function.arguments.trim() === ''
											) {
												console.log('❌ Tool call has empty arguments, skipping execution');
												continue;
											}

											// Try to parse arguments to ensure they're valid JSON
											try {
												const parsedArgs = JSON.parse(toolCall.function.arguments);
												console.log('✅ Tool call arguments are valid JSON:', parsedArgs);
											} catch (error) {
												console.log(
													'❌ Tool call arguments are not valid JSON, skipping execution:',
													error,
												);
												continue;
											}

											// Send function call notification
											this.sendMessage(webSocket, {
												type: 'function_call',
												content: `Calling ${toolCall.function.name}...`,
												data: {
													functionName: toolCall.function.name,
													arguments: toolCall.function.arguments,
												},
												messageId: aiMessage.id,
											});

											// Execute the MCP function
											await this.executeMCPAction(
												webSocket,
												{
													name: toolCall.function.name,
													arguments: toolCall.function.arguments,
												},
												aiMessage.id,
												session.id,
											);
										}
									}
								}
							} catch (e) {
								// Skip invalid JSON lines
								continue;
							}
						}
					}
				}

				reader.releaseLock();

				clearTimeout(streamingTimeout);

				// Execute any accumulated tool calls that appear to be complete
				let executedCount = 0;
				for (const toolCall of accumulatedToolCalls) {
					if (toolCall && toolCall.function.name && toolCall.function.arguments) {
						// Validate that we have complete arguments
						if (toolCall.function.arguments.trim() === '') {
							continue;
						}

						// Try to parse arguments to ensure they're valid JSON
						try {
							const parsedArgs = JSON.parse(toolCall.function.arguments);
						} catch (error) {
							continue;
						}

						// Send function call notification
						this.sendMessage(webSocket, {
							type: 'function_call',
							content: `Calling ${toolCall.function.name}...`,
							data: {
								functionName: toolCall.function.name,
								arguments: toolCall.function.arguments,
							},
							messageId: aiMessage.id,
						});

						// Execute the MCP function
						// The MCPService will now send properly formatted human-readable responses
						await this.executeMCPAction(
							webSocket,
							{
								name: toolCall.function.name,
								arguments: toolCall.function.arguments,
							},
							aiMessage.id,
							session.id,
						);

						// MCP execution is complete - no need for additional AI response
						// The MCPService has already sent a human-readable response to the user

						executedCount++;
					}
				}
			} catch (error) {
				console.error('OpenAI API error:', error);

				// Clear the timeout since we're handling the error
				if (streamingTimeout) {
					clearTimeout(streamingTimeout);
				}

				// Send error message to client
				this.sendMessage(webSocket, {
					type: 'error',
					content: `AI Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
					messageId: aiMessage.id,
				});
				return;
			}

			// Only send completion if not interrupted
			if (!streamAbortController.signal.aborted) {
				// Send completion signal first
				this.sendMessage(webSocket, {
					type: 'complete',
					content: aiMessage.content,
					messageId: aiMessage.id,
				});

				// Note: AI message saving is now handled by the WebSocket client
				// after receiving the complete signal to ensure proper content
			}

			// Clean up
			this.clearInterruptionHandler();
		} catch (error) {
			console.error('Error streaming AI response:', error);
			this.sendError(webSocket, 'Failed to stream AI response');
		} finally {
			// Always clear the timeout
			if (streamingTimeout) {
				clearTimeout(streamingTimeout);
			}
		}
	}

	async continueAIResponseWithFunctionResult(
		webSocket: any,
		functionResultMessage: any,
		messageId: string,
		sessionId: string,
		functionName: string,
		actionMetadata?: any,
	): Promise<void> {
		try {
			const session = this.sessions?.get(sessionId);
			if (!session) {
				console.error('Session not found for continuing AI response');
				return;
			}

			// Add function result to session messages
			session.messages.push(functionResultMessage);

			// Update conversation context with the function result
			if (this.updateConversationContext) {
				await this.updateConversationContext(sessionId, functionResultMessage.content);
			}

			// Build conversation context for AI
			const conversationContext = this.buildConversationContext
				? this.buildConversationContext(
						session,
						functionResultMessage,
						functionName,
						actionMetadata,
				  )
				: [];

			// Get MCP capabilities for available actions
			const mcpCapabilities = await this.getMCPCapabilities();
			const availableActions = mcpCapabilities.actions;

			// Create AI message for the continuation
			const aiMessage: ChatMessage = {
				id: this.generateId(),
				role: 'assistant',
				content: '',
				timestamp: new Date(),
			};

			session.messages.push(aiMessage);

			// Send status update
			this.sendMessage(webSocket, {
				type: 'status',
				content: 'AI is processing the results...',
				messageId: aiMessage.id,
			});

			// Call OpenAI API with the function result
			const openaiApiKey = this.env.OPENAI_API_KEY;
			if (!openaiApiKey) {
				throw new Error('OpenAI API key not configured');
			}

			const response = await this.retryOpenAICall(() =>
				fetch('https://api.openai.com/v1/chat/completions', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${openaiApiKey}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						model: 'gpt-3.5-turbo',
						messages: conversationContext,
						stream: true,
						temperature: 0.7,
						max_tokens: 1000,
						tools: availableActions,
						tool_choice: 'auto',
					}),
				}),
			);

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('No response body reader available');
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.slice(6);
						if (data === '[DONE]') {
							break;
						}

						try {
							const parsed = JSON.parse(data);
							const choice = parsed.choices?.[0];

							// Handle content streaming
							const content = choice?.delta?.content;
							if (content) {
								aiMessage.content += content;

								this.sendMessage(webSocket, {
									type: 'content',
									content: content,
									messageId: aiMessage.id,
								});
							}

							// Handle tool calls
							const toolCalls = choice?.tool_calls;
							if (toolCalls) {
								for (const toolCall of toolCalls) {
									if (toolCall.function) {
										console.log(
											'🔧 Processing tool call in continuation:',
											toolCall.function.name,
											'with args:',
											toolCall.function.arguments,
										);

										// Send function call notification
										this.sendMessage(webSocket, {
											type: 'function_call',
											content: `Calling ${toolCall.function.name}...`,
											data: {
												functionName: toolCall.function.name,
												arguments: toolCall.function.arguments,
											},
											messageId: aiMessage.id,
										});

										// Execute the MCP function
										await this.executeMCPAction(
											webSocket,
											{
												name: toolCall.function.name,
												arguments: toolCall.function.arguments,
											},
											aiMessage.id,
											sessionId,
										);
									}
								}
							}
						} catch (e) {
							// Skip invalid JSON lines
							continue;
						}
					}
				}
			}

			reader.releaseLock();

			// Send completion signal
			this.sendMessage(webSocket, {
				type: 'complete',
				content: aiMessage.content,
				messageId: aiMessage.id,
			});
		} catch (error) {
			console.error('Error continuing AI response with function result:', error);
			this.sendError(webSocket, 'Failed to continue AI response');
		}
	}

	async retryOpenAICall(
		apiCall: () => Promise<Response>,
		maxRetries: number = 3,
		baseDelayMs: number = 1000,
	): Promise<Response> {
		let lastError: Error;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const response = await apiCall();

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`,
					);
				}

				return response;
			} catch (error) {
				lastError = error as Error;

				if (attempt < maxRetries - 1) {
					const delay = baseDelayMs * Math.pow(2, attempt); // Exponential backoff
					console.log(
						`Retrying OpenAI API call in ${delay}ms (attempt ${attempt + 2}/${maxRetries})`,
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		throw lastError!;
	}

	async delayWithInterruption(ms: number, abortController: AbortController): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(resolve, ms);
			abortController.signal.addEventListener('abort', () => {
				clearTimeout(timeout);
				reject(new Error('Operation aborted'));
			});
		});
	}

	setInterruptionHandler(handler: () => void): void {
		this.interruptionHandler = handler;
	}

	clearInterruptionHandler(): void {
		this.interruptionHandler = null;
	}

	handleInterrupt(): void {
		if (this.interruptionHandler) {
			this.interruptionHandler();
		}

		if (this.currentStreamAbortController && !this.currentStreamAbortController.signal.aborted) {
			this.currentStreamAbortController.abort();
		}
	}

	handlePause(): void {
		// Pause streaming by aborting current stream
		if (this.currentStreamAbortController && !this.currentStreamAbortController.signal.aborted) {
			this.currentStreamAbortController.abort();
		}
	}

	handleResume(): void {
		// Resume is handled by starting a new stream
		// This is typically called from the WebSocket message handler
	}

	// Helper methods that need to be implemented by the calling service
	private sessions?: Map<string, any>;
	private updateConversationContext?: (sessionId: string, content: string) => Promise<void>;
	private buildConversationContext?: (
		session: any,
		functionResultMessage: any,
		functionName: string,
		actionMetadata?: any,
	) => any[];

	// These methods should be injected by the calling service
	setDependencies(
		sessions: Map<string, any>,
		updateConversationContext: (sessionId: string, content: string) => Promise<void>,
		buildConversationContext: (
			session: any,
			functionResultMessage: any,
			functionName: string,
			actionMetadata?: any,
		) => any[],
	) {
		this.sessions = sessions;
		this.updateConversationContext = updateConversationContext;
		this.buildConversationContext = buildConversationContext;
	}
}
