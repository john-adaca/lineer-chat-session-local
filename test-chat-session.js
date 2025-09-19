#!/usr/bin/env node

/**
 * Test script for ChatSession Durable Object
 * Tests both HTTP endpoints and WebSocket functionality
 *
 * Usage: node test-chat-session.js
 */

const WebSocket = require('ws');
const http = require('http');

// Configuration
const BASE_URL = 'http://127.0.0.1:8787';
const WS_BASE_URL = 'ws://127.0.0.1:8787';

// Test data - Replace with your actual IDs
const TEST_USER_ID = '330c7620-2914-4a5c-8d5f-e4bac4737d08';
const TEST_WORKSPACE_ID = '14f49f8a-1e2f-4159-abf9-bbff0078bfa9';
const TEST_SESSION_ID = 'f279177d-2e8e-48ad-baa4-607f440f7950'; // Your actual session ID

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(testName, passed = null) {
    const status = passed === null ? '🔄 RUNNING' : passed ? '✅ PASSED' : '❌ FAILED';
    const color = passed === null ? 'yellow' : passed ? 'green' : 'red';
    log(`\n${status} ${testName}`, color);
}

// HTTP GET request helper
function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve({ statusCode: res.statusCode, data: jsonData });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, data });
                }
            });
        }).on('error', reject);
    });
}

// Test HTTP endpoints
async function testHttpEndpoints() {
    log('\n' + '='.repeat(50), 'cyan');
    log('🧪 TESTING HTTP ENDPOINTS', 'cyan');
    log('='.repeat(50), 'cyan');

    // Test 1: Sessions endpoint
    logTest('GET /api/sessions');
    try {
        const url = `${BASE_URL}/api/sessions?userId=${TEST_USER_ID}&workspaceId=${TEST_WORKSPACE_ID}`;
        const response = await httpGet(url);

        if (response.statusCode === 200) {
            log(`✅ Response: ${JSON.stringify(response.data, null, 2)}`, 'green');
            logTest('GET /api/sessions', true);
        } else {
            log(`❌ Status: ${response.statusCode}`, 'red');
            logTest('GET /api/sessions', false);
        }
    } catch (error) {
        log(`❌ Error: ${error.message}`, 'red');
        logTest('GET /api/sessions', false);
    }

    // Test 2: Chat endpoint
    logTest('GET /api/chat');
    try {
        const url = `${BASE_URL}/api/chat?userId=${TEST_USER_ID}&workspaceId=${TEST_WORKSPACE_ID}&sessionId=${TEST_SESSION_ID}`;
        const response = await httpGet(url);

        if (response.statusCode === 200) {
            log(`✅ Response: ${JSON.stringify(response.data, null, 2)}`, 'green');
            logTest('GET /api/chat', true);
        } else {
            log(`❌ Status: ${response.statusCode}`, 'red');
            logTest('GET /api/chat', false);
        }
    } catch (error) {
        log(`❌ Error: ${error.message}`, 'red');
        logTest('GET /api/chat', false);
    }

    // Test 3: Actions endpoint
    logTest('GET /api/actions');
    try {
        const url = `${BASE_URL}/api/actions?userId=${TEST_USER_ID}&workspaceId=${TEST_WORKSPACE_ID}`;
        const response = await httpGet(url);

        if (response.statusCode === 200) {
            log(`✅ Response: ${JSON.stringify(response.data, null, 2)}`, 'green');
            logTest('GET /api/actions', true);
        } else {
            log(`❌ Status: ${response.statusCode}`, 'red');
            logTest('GET /api/actions', false);
        }
    } catch (error) {
        log(`❌ Error: ${error.message}`, 'red');
        logTest('GET /api/actions', false);
    }
}

// Test WebSocket functionality
async function testWebSocket() {
    log('\n' + '='.repeat(50), 'magenta');
    log('🔌 TESTING WEBSOCKET FUNCTIONALITY', 'magenta');
    log('='.repeat(50), 'magenta');

    return new Promise((resolve) => {
        const wsUrl = `${WS_BASE_URL}/?userId=${TEST_USER_ID}&workspaceId=${TEST_WORKSPACE_ID}`;
        log(`🔌 Connecting to: ${wsUrl}`, 'blue');

        const ws = new WebSocket(wsUrl);

        let testResults = {
            connection: false,
            message: false,
            preference: false,
            personality: false,
            context: false,
            status: false
        };

        ws.on('open', () => {
            logTest('WebSocket Connection');
            log('✅ WebSocket connected successfully', 'green');
            testResults.connection = true;
            logTest('WebSocket Connection', true);

            // Test 1: Send status message
            logTest('Send Status Message');
            ws.send(JSON.stringify({
                type: 'status',
                content: 'Test connection established',
                messageId: 'test-status-1'
            }));

            // Test 2: Send user message
            setTimeout(() => {
                logTest('Send User Message');
                ws.send(JSON.stringify({
                    type: 'message',
                    content: 'Hello, this is a test message!',
                    sessionId: TEST_SESSION_ID,
                    messageId: 'test-msg-1'
                }));
            }, 500);

            // Test 3: Set user preference
            setTimeout(() => {
                logTest('Set User Preference');
                ws.send(JSON.stringify({
                    type: 'set_preference',
                    data: {
                        communicationStyle: 'casual',
                        responseLength: 'brief',
                        defaultTimezone: 'UTC'
                    },
                    sessionId: TEST_SESSION_ID,
                    messageId: 'test-pref-1'
                }));
            }, 1000);

            // Test 4: Set session personality
            setTimeout(() => {
                logTest('Set Session Personality');
                ws.send(JSON.stringify({
                    type: 'set_personality',
                    data: {
                        personality: {
                            id: 'friendly-assistant',
                            name: 'Friendly Assistant',
                            systemPrompt: 'You are a friendly and helpful assistant.'
                        }
                    },
                    sessionId: TEST_SESSION_ID,
                    messageId: 'test-personality-1'
                }));
            }, 1500);

            // Test 5: Set user context
            setTimeout(() => {
                logTest('Set User Context');
                ws.send(JSON.stringify({
                    type: 'set_user_context',
                    data: {
                        userGoals: ['Help with coding', 'Learn new technologies'],
                        currentTasks: ['Testing chat system'],
                        emotionalTone: 'curious'
                    },
                    sessionId: TEST_SESSION_ID,
                    messageId: 'test-context-1'
                }));
            }, 2000);

            // Test 6: Get context
            setTimeout(() => {
                logTest('Get Session Context');
                ws.send(JSON.stringify({
                    type: 'get_context',
                    sessionId: TEST_SESSION_ID,
                    messageId: 'test-get-context-1'
                }));
            }, 2500);

            // Close connection after tests
            setTimeout(() => {
                logTest('Close WebSocket Connection');
                ws.close();
            }, 3000);
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                log(`📨 Received: ${JSON.stringify(message, null, 2)}`, 'blue');

                // Track test results based on message types
                switch (message.type) {
                    case 'status':
                        if (message.content.includes('Test connection established')) {
                            testResults.status = true;
                            logTest('Send Status Message', true);
                        }
                        break;
                    case 'message':
                    case 'content':
                        if (message.messageId === 'test-msg-1' || message.messageId?.includes('ai-')) {
                            testResults.message = true;
                            logTest('Send User Message', true);
                        }
                        break;
                    case 'status':
                        if (message.content.includes('Preference updated')) {
                            testResults.preference = true;
                            logTest('Set User Preference', true);
                        } else if (message.content.includes('AI personality updated')) {
                            testResults.personality = true;
                            logTest('Set Session Personality', true);
                        } else if (message.content.includes('User context updated')) {
                            testResults.context = true;
                            logTest('Set User Context', true);
                        }
                        break;
                    case 'context_data':
                        logTest('Get Session Context', true);
                        break;
                }
            } catch (error) {
                log(`❌ Error parsing message: ${error.message}`, 'red');
            }
        });

        ws.on('close', (code, reason) => {
            log(`🔌 WebSocket closed: ${code} - ${reason}`, 'yellow');
            logTest('Close WebSocket Connection', true);

            // Summary
            log('\n' + '='.repeat(50), 'cyan');
            log('📊 TEST SUMMARY', 'cyan');
            log('='.repeat(50), 'cyan');

            const passedTests = Object.values(testResults).filter(Boolean).length;
            const totalTests = Object.keys(testResults).length;

            Object.entries(testResults).forEach(([test, passed]) => {
                const status = passed ? '✅' : '❌';
                const color = passed ? 'green' : 'red';
                log(`${status} ${test.replace(/([A-Z])/g, ' $1').toLowerCase()}`, color);
            });

            log(`\n🎯 Overall: ${passedTests}/${totalTests} tests passed`, passedTests === totalTests ? 'green' : 'yellow');
            resolve();
        });

        ws.on('error', (error) => {
            log(`❌ WebSocket error: ${error.message}`, 'red');
            logTest('WebSocket Connection', false);
            resolve();
        });
    });
}

// Main test runner
async function runTests() {
    log('\n🚀 STARTING CHAT SESSION TESTS', 'bright');
    log('=' * 60, 'bright');

    try {
        // Test HTTP endpoints first
        await testHttpEndpoints();

        // Then test WebSocket functionality
        await testWebSocket();

        log('\n🎉 ALL TESTS COMPLETED!', 'bright');

    } catch (error) {
        log(`\n💥 Test runner error: ${error.message}`, 'red');
        process.exit(1);
    }
}

// Check if server is running
function checkServer() {
    return new Promise((resolve) => {
        const req = http.get(BASE_URL, (res) => {
            resolve(true);
        });

        req.on('error', () => {
            resolve(false);
        });

        req.setTimeout(3000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

// Main execution
async function main() {
    log('🔍 Checking if server is running...', 'yellow');

    const serverRunning = await checkServer();

    if (!serverRunning) {
        log('❌ Server is not running!', 'red');
        log('💡 Please start the server first with: wrangler dev', 'yellow');
        log('💡 Then run this test script.', 'yellow');
        process.exit(1);
    }

    log('✅ Server is running, starting tests...', 'green');
    await runTests();
}

if (require.main === module) {
    main().catch((error) => {
        log(`💥 Fatal error: ${error.message}`, 'red');
        process.exit(1);
    });
}

module.exports = { runTests, testHttpEndpoints, testWebSocket };