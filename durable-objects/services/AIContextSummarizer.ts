import type { MCPResponse, ChatSession } from '../../types';

export class AIContextSummarizer {
	private aiService: any;

	constructor(aiService: any) {
		this.aiService = aiService;
	}

	/**
	 * Intelligently summarize and merge old metadata with new MCP response
	 */
	async summarizeContext(
		oldMetadata: any,
		newMCPResponse: MCPResponse,
		session: ChatSession
	): Promise<any> {
		try {
			console.log('🤖 Starting AI context summarization...');

			// Prepare the summarization prompt
			const prompt = this.buildSummarizationPrompt(oldMetadata, newMCPResponse, session);
			
			// Call AI service to get summarized context
			const response = await this.aiService.generateResponse({
				messages: [
					{
						role: 'system',
						content: 'You are an expert at analyzing and summarizing contextual data. Your job is to intelligently merge old metadata with new MCP response data, identifying relationships, deduplicating information, and creating a clean, organized summary.'
					},
					{
						role: 'user',
						content: prompt
					}
				],
				max_tokens: 2000,
				temperature: 0.3
			});

			// Parse the AI response and return structured context
			const summarizedContext = this.parseAIResponse(response);
			
			console.log('✅ AI context summarization completed:', {
				contactsCount: summarizedContext.contacts?.length || 0,
				emailsCount: summarizedContext.emails?.length || 0,
				meetingsCount: summarizedContext.meetings?.length || 0,
				tasksCount: summarizedContext.tasks?.length || 0
			});

			return summarizedContext;

		} catch (error) {
			console.error('❌ AI context summarization failed:', error);
			// Fallback to simple merge if AI fails
			return this.fallbackMerge(oldMetadata, newMCPResponse);
		}
	}

	/**
	 * Build the AI prompt for context summarization
	 */
	private buildSummarizationPrompt(oldMetadata: any, newMCPResponse: MCPResponse, session: ChatSession): string {
		const oldContext = oldMetadata?.contextAccumulated || {};
		const newData = this.extractNewData(newMCPResponse);

		return `
Please analyze and intelligently merge the following data:

## OLD METADATA CONTEXT:
${JSON.stringify(oldContext, null, 2)}

## NEW MCP RESPONSE DATA:
Action: ${newMCPResponse.action}
Success: ${newMCPResponse.success}
Result: ${JSON.stringify(newMCPResponse.result, null, 2)}
Timestamp: ${newMCPResponse.timestamp}

## SESSION INFO:
Session ID: ${session.id}
User ID: ${session.userId}
Workspace ID: ${session.workspaceId}

## INSTRUCTIONS:
1. Analyze the old context and new MCP response data
2. Identify relationships and connections between old and new data
3. Deduplicate any repeated information (same contacts, emails, meetings, tasks)
4. Merge related information intelligently (e.g., if same contact appears with updated info)
5. Organize data into clean, structured categories
6. Keep only the most relevant and recent information
7. Maintain data integrity and relationships

## OUTPUT FORMAT:
Return a JSON object with this exact structure:
{
  "contacts": [
    {
      "id": "contact_id",
      "name": "Contact Name",
      "email": "email@example.com",
      "lastInteraction": "2024-01-01T00:00:00.000Z",
      "source": "action_name",
      "relevanceScore": 0.9,
      "tags": ["important", "frequent"]
    }
  ],
  "emails": [
    {
      "id": "email_id",
      "subject": "Email Subject",
      "from": "sender@example.com",
      "to": "recipient@example.com",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "source": "action_name",
      "relevanceScore": 0.8,
      "tags": ["urgent", "follow-up"]
    }
  ],
  "meetings": [
    {
      "id": "meeting_id",
      "title": "Meeting Title",
      "startTime": "2024-01-01T10:00:00.000Z",
      "endTime": "2024-01-01T11:00:00.000Z",
      "attendees": ["attendee1@example.com", "attendee2@example.com"],
      "timestamp": "2024-01-01T00:00:00.000Z",
      "source": "action_name",
      "relevanceScore": 0.9,
      "tags": ["upcoming", "important"]
    }
  ],
  "tasks": [
    {
      "id": "task_id",
      "title": "Task Title",
      "status": "pending",
      "dueDate": "2024-01-01T00:00:00.000Z",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "source": "action_name",
      "relevanceScore": 0.7,
      "tags": ["urgent", "work"]
    }
  ],
  "recentActions": [
    {
      "action": "action_name",
      "timestamp": "2024-01-01T00:00:00.000Z",
      "success": true,
      "result": "brief_description"
    }
  ],
  "summary": "Brief summary of the current context state and key insights"
}

## IMPORTANT RULES:
- Keep only the most relevant items (max 10 contacts, 8 emails, 6 meetings, 8 tasks)
- Assign relevance scores (0.0 to 1.0) based on recency and importance
- Add meaningful tags to categorize items
- Maintain data relationships and connections
- Remove duplicates intelligently
- Preserve the most recent and complete information
`;
	}

	/**
	 * Extract structured data from new MCP response
	 */
	private extractNewData(mcpResponse: MCPResponse): any {
		if (!mcpResponse.success || !mcpResponse.result) {
			return null;
		}

		const action = mcpResponse.action.toLowerCase();
		const result = Array.isArray(mcpResponse.result) ? mcpResponse.result : [mcpResponse.result];

		if (action.includes('contact')) {
			return { type: 'contacts', data: result };
		} else if (action.includes('email')) {
			return { type: 'emails', data: result };
		} else if (action.includes('calendar') || action.includes('meeting')) {
			return { type: 'meetings', data: result };
		} else if (action.includes('task')) {
			return { type: 'tasks', data: result };
		}

		return { type: 'other', data: result };
	}

	/**
	 * Parse AI response into structured context
	 */
	private parseAIResponse(aiResponse: any): any {
		try {
			// Extract JSON from AI response
			const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error('No JSON found in AI response');
			}

			const parsed = JSON.parse(jsonMatch[0]);
			
			// Ensure all required arrays exist
			return {
				contacts: parsed.contacts || [],
				emails: parsed.emails || [],
				meetings: parsed.meetings || [],
				tasks: parsed.tasks || [],
				recentActions: parsed.recentActions || [],
				summary: parsed.summary || 'Context summarized by AI',
				lastSummarized: new Date()
			};

		} catch (error) {
			console.error('❌ Failed to parse AI response:', error);
			throw error;
		}
	}

	/**
	 * Fallback merge if AI summarization fails
	 */
	private fallbackMerge(oldMetadata: any, newMCPResponse: MCPResponse): any {
		console.log('⚠️ Using fallback merge due to AI failure');
		
		const oldContext = oldMetadata?.contextAccumulated || {};
		const newData = this.extractNewData(newMCPResponse);

		// Simple merge without AI intelligence
		const merged = {
			contacts: oldContext.contacts || [],
			emails: oldContext.emails || [],
			meetings: oldContext.meetings || [],
			tasks: oldContext.tasks || [],
			recentActions: oldContext.recentActions || [],
			summary: 'Context merged using fallback method',
			lastSummarized: new Date()
		};

		// Add new data based on type
		if (newData?.type === 'contacts' && newData.data) {
			merged.contacts = [...merged.contacts, ...newData.data.slice(0, 3)];
		} else if (newData?.type === 'emails' && newData.data) {
			merged.emails = [...merged.emails, ...newData.data.slice(0, 3)];
		} else if (newData?.type === 'meetings' && newData.data) {
			merged.meetings = [...merged.meetings, ...newData.data.slice(0, 3)];
		} else if (newData?.type === 'tasks' && newData.data) {
			merged.tasks = [...merged.tasks, ...newData.data.slice(0, 3)];
		}

		// Add to recent actions
		merged.recentActions.unshift({
			action: newMCPResponse.action,
			timestamp: newMCPResponse.timestamp,
			success: newMCPResponse.success,
			result: 'Brief description'
		});

		// Keep only recent items
		merged.recentActions = merged.recentActions.slice(0, 10);

		return merged;
	}

	/**
	 * Get context summary for AI prompt
	 */
	getContextSummary(context: any): string {
		if (!context) return '';

		let summary = '';

		// Add AI-generated summary if available
		if (context.summary) {
			summary += `\nContext Summary: ${context.summary}`;
		}

		// Add recent contacts
		if (context.contacts?.length > 0) {
			const contactNames = context.contacts
				.slice(0, 5)
				.map((c: any) => c.name)
				.join(', ');
			summary += `\nRecent contacts: ${contactNames}`;
		}

		// Add recent emails
		if (context.emails?.length > 0) {
			const emailSubjects = context.emails
				.slice(0, 3)
				.map((e: any) => e.subject)
				.join(', ');
			summary += `\nRecent emails: ${emailSubjects}`;
		}

		// Add upcoming meetings
		if (context.meetings?.length > 0) {
			const meetingTitles = context.meetings
				.slice(0, 3)
				.map((m: any) => m.title)
				.join(', ');
			summary += `\nUpcoming meetings: ${meetingTitles}`;
		}

		// Add recent tasks
		if (context.tasks?.length > 0) {
			const taskTitles = context.tasks
				.slice(0, 3)
				.map((t: any) => t.title)
				.join(', ');
			summary += `\nRecent tasks: ${taskTitles}`;
		}

		return summary;
	}
}
