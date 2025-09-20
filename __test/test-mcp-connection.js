#!/usr/bin/env node

/**
 * Test MCP Server Connection
 * Tests the JSON-RPC format communication with your MCP server
 */

const MCP_SERVER_URL = 'https://lineer-mcp-server.jlalmenanza10.workers.dev';

async function testMCPConnection() {
    console.log('🔍 Testing MCP Server Connection...');
    console.log('📡 Server URL:', MCP_SERVER_URL);

    try {
        // Test 1: Basic connectivity
        console.log('\n📋 Test 1: Basic Server Connectivity');
        const basicTest = await fetch(`${MCP_SERVER_URL}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'invokeAction',
                params: {
                    name: 'contacts_get_recent',
                    arguments: {
                        workspace_id: '14f49f8a-1e2f-4159-abf9-bbff0078bfa9',
                        user_id: '330c7620-2914-4a5c-8d5f-e4bac4737d08',
                        limit: 5
                    }
                },
                id: Date.now()
            })
        });

        if (!basicTest.ok) {
            throw new Error(`HTTP ${basicTest.status}: ${basicTest.statusText}`);
        }

        const response = await basicTest.json();
        console.log('✅ Server responded with JSON-RPC format');
        console.log('📄 Response:', JSON.stringify(response, null, 2));

        if (response.error) {
            console.log('⚠️ Server returned error:', response.error);
        } else {
            console.log('🎉 Server returned successful response!');
            console.log('📊 Result type:', typeof response.result);
            if (Array.isArray(response.result)) {
                console.log('📊 Result count:', response.result.length);
            }
        }

    } catch (error) {
        console.error('❌ Connection test failed:', error.message);
        console.log('\n💡 Troubleshooting tips:');
        console.log('1. Check if the MCP server is running');
        console.log('2. Verify the server URL is correct');
        console.log('3. Check network connectivity');
        console.log('4. Verify workspace and user IDs are valid');
    }
}

// Test different MCP actions
async function testMCPActions() {
    console.log('\n🔧 Testing MCP Actions...');

    const actions = [
        {
            name: 'contacts_get_recent',
            description: 'Get recent contacts',
            args: { limit: 3 }
        },
        {
            name: 'contacts_search',
            description: 'Search for contacts',
            args: { query: 'john', limit: 3 }
        }
    ];

    for (const action of actions) {
        console.log(`\n📋 Testing: ${action.description} (${action.name})`);

        try {
            const response = await fetch(`${MCP_SERVER_URL}/mcp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'invokeAction',
                    params: {
                        name: action.name,
                        arguments: {
                            workspace_id: '14f49f8a-1e2f-4159-abf9-bbff0078bfa9',
                            user_id: '330c7620-2914-4a5c-8d5f-e4bac4737d08',
                            ...action.args
                        }
                    },
                    id: Date.now()
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();

            if (result.error) {
                console.log(`⚠️ ${action.name}:`, result.error.message);
            } else {
                console.log(`✅ ${action.name}: Success`);
                if (Array.isArray(result.result)) {
                    console.log(`   📊 Found ${result.result.length} items`);
                }
            }

        } catch (error) {
            console.log(`❌ ${action.name}:`, error.message);
        }
    }
}

// Main test runner
async function main() {
    console.log('🚀 MCP Server Connection Test');
    console.log('=' * 50);

    await testMCPConnection();
    await testMCPActions();

    console.log('\n🎯 Test completed!');
    console.log('\n💡 Next steps:');
    console.log('1. If tests pass: Your MCP integration is ready!');
    console.log('2. If tests fail: Check server logs and configuration');
    console.log('3. Test with your chat application using wrangler dev');
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { testMCPConnection, testMCPActions };