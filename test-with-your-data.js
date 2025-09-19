#!/usr/bin/env node

/**
 * Test script using YOUR actual user_id, workspace_id, and session_id
 * Replace the placeholders with your real values
 *
 * Usage: node test-with-your-data.js
 */

const WebSocket = require('ws');

// 🔴 REPLACE THESE WITH YOUR ACTUAL VALUES 🔴
const YOUR_USER_ID = '330c7620-2914-4a5c-8d5f-e4bac4737d08';
const YOUR_WORKSPACE_ID = '14f49f8a-1e2f-4159-abf9-bbff0078bfa9';
const YOUR_SESSION_ID = 'f279177d-2e8e-48ad-baa4-607f440f7950'; // Your actual session ID

const BASE_URL = 'http://127.0.0.1:8787';
const WS_BASE_URL = 'ws://127.0.0.1:8787';

console.log('🚀 Testing with YOUR actual data:');
console.log(`   User ID: ${YOUR_USER_ID}`);
console.log(`   Workspace ID: ${YOUR_WORKSPACE_ID}`);
console.log(`   Session ID: ${YOUR_SESSION_ID}`);
console.log('');

async function testWithYourData() {
    return new Promise((resolve) => {
        const wsUrl = `${WS_BASE_URL}/?userId=${encodeURIComponent(YOUR_USER_ID)}&workspaceId=${encodeURIComponent(YOUR_WORKSPACE_ID)}`;

        console.log(`🔌 Connecting to: ${wsUrl}`);

        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log('✅ Connected! Testing MCP accumulation...');

            // Test 1: Accumulate contact search
            setTimeout(() => {
                console.log('\n📇 Testing Contact Search Accumulation...');
                ws.send(JSON.stringify({
                    type: 'accumulate_mcp_response',
                    data: {
                        action: 'contacts_search',
                        parameters: {
                            query: 'john@example.com',
                            workspace_id: YOUR_WORKSPACE_ID
                        },
                        result: [
                            {
                                id: 'contact-001',
                                name: 'John Doe',
                                email: 'john@example.com',
                                company: 'Your Company'
                            }
                        ],
                        success: true
                    },
                    sessionId: YOUR_SESSION_ID,
                    messageId: 'test-contact-1'
                }));
            }, 1000);

            // Test 2: Accumulate email draft
            setTimeout(() => {
                console.log('\n📧 Testing Email Draft Accumulation...');
                ws.send(JSON.stringify({
                    type: 'accumulate_mcp_response',
                    data: {
                        action: 'email_draft_email',
                        parameters: {
                            to: ['john@example.com'],
                            subject: 'Test Email'
                        },
                        result: {
                            id: 'email-draft-001',
                            status: 'draft'
                        },
                        success: true
                    },
                    sessionId: YOUR_SESSION_ID,
                    messageId: 'test-email-1'
                }));
            }, 2000);

            // Test 3: Get session summary
            setTimeout(() => {
                console.log('\n📊 Getting Session Summary...');
                ws.send(JSON.stringify({
                    type: 'get_session_summary',
                    sessionId: YOUR_SESSION_ID,
                    messageId: 'test-summary-1'
                }));
            }, 3000);

            // Close after tests
            setTimeout(() => {
                console.log('\n🔌 Closing connection...');
                ws.close();
            }, 4000);
        });

        ws.on('message', (data) => {
            const message = JSON.parse(data.toString());
            console.log(`📨 Received: ${message.type}`, message.content || '');
        });

        ws.on('close', () => {
            console.log('✅ Test completed! Check your database for accumulated metadata.');
            resolve();
        });

        ws.on('error', (error) => {
            console.error('❌ WebSocket error:', error.message);
            resolve();
        });
    });
}

// Check if server is running
async function checkServer() {
    return new Promise((resolve) => {
        const http = require('http');
        const req = http.get(BASE_URL, () => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function main() {
    console.log('🔍 Checking if server is running...');

    const serverRunning = await checkServer();

    if (!serverRunning) {
        console.log('❌ Server is not running!');
        console.log('💡 Start it with: wrangler dev');
        process.exit(1);
    }

    console.log('✅ Server is running, starting test...');
    await testWithYourData();

    console.log('\n🎉 Test complete!');
    console.log('💾 Check your Supabase database for the accumulated session metadata');
    console.log('🔍 Look for table: chat_sessions with your session_id');
}

if (require.main === module) {
    main().catch(console.error);
}