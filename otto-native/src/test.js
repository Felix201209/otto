/**
 * Test suite for @otto/native
 */

const { SessionStore, EncryptionStore, Tokenizer, AgentPool } = require('./index');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BINARY_PATH = path.join(__dirname, '..', 'target', 'x86_64-pc-windows-gnu', 'release', 'otto-native.exe');

async function testSessionStore() {
  console.log('\n=== Testing SessionStore ===');
  
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-'));
  const dbPath = path.join(tmpDir, 'sessions.db');
  
  const store = new SessionStore(dbPath, 100, BINARY_PATH);
  
  // Save
  await store.save('session-1', 'Test Session', [
    { role: 'user', content: 'Hello', timestamp: Date.now() },
    { role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
  ]);
  console.log('✅ Saved session');
  
  // Load
  const loaded = await store.load('session-1');
  console.log('✅ Loaded session:', loaded?.meta?.title, `(${loaded?.messages?.length} messages)`);
  
  // List
  const list = await store.list();
  console.log('✅ Listed sessions:', list.length);
  
  // Size
  const size = await store.sizeBytes();
  console.log('✅ DB size:', size, 'bytes');
  
  // Delete
  const deleted = await store.delete('session-1');
  console.log('✅ Deleted:', deleted);
  
  await store.close();
  
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
  console.log('✅ SessionStore tests passed');
}

async function testEncryptionStore() {
  console.log('\n=== Testing EncryptionStore ===');
  
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-'));
  const dbPath = path.join(tmpDir, 'encrypted.db');
  const key = EncryptionStore.generateKey();
  
  const store = new EncryptionStore(dbPath, key, BINARY_PATH);
  
  // Save
  await store.save('secret-1', 'This is sensitive data');
  console.log('✅ Saved encrypted data');
  
  // Load
  const loaded = await store.load('secret-1');
  console.log('✅ Loaded decrypted:', loaded === 'This is sensitive data' ? '✅ Match' : '❌ Mismatch');
  
  // List
  const ids = await store.listIds();
  console.log('✅ Listed IDs:', ids);
  
  // Delete
  const deleted = await store.delete('secret-1');
  console.log('✅ Deleted:', deleted);
  
  await store.close();
  
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
  console.log('✅ EncryptionStore tests passed');
}

async function testTokenizer() {
  console.log('\n=== Testing Tokenizer ===');
  
  const tokenizer = new Tokenizer('gpt-4', BINARY_PATH);
  
  // Count
  const count = await tokenizer.count('Hello, world! This is a test.');
  console.log('✅ Token count:', count);
  
  // Truncate
  const truncated = await tokenizer.truncate('This is a long text that should be truncated to fewer tokens', 5);
  console.log('✅ Truncated:', truncated);
  
  // Supported models
  const models = await Tokenizer.supportedModels(BINARY_PATH);
  console.log('✅ Supported models:', models.length);
  
  await tokenizer.close();
  console.log('✅ Tokenizer tests passed');
}

async function testAgentPool() {
  console.log('\n=== Testing AgentPool ===');
  
  const pool = new AgentPool(256, 10, BINARY_PATH);
  
  // Register
  const registered = await pool.register('agent-1', 50);
  console.log('✅ Registered agent-1:', registered);
  
  // Stats
  const stats = await pool.stats();
  console.log('✅ Stats:', `memory=${stats.current_memory_mb.toFixed(1)}MB, agents=${stats.agent_count}`);
  
  // Add log
  const logged = await pool.addLog('agent-1', 'Started processing');
  console.log('✅ Added log:', logged);
  
  // List
  const agents = await pool.listAgents();
  console.log('✅ Agents:', agents.map(a => a.id));
  
  // Cleanup idle (0 seconds = cleanup all)
  const cleaned = await pool.cleanupIdle(0);
  console.log('✅ Cleaned idle:', cleaned);
  
  await pool.close();
  console.log('✅ AgentPool tests passed');
}

async function main() {
  console.log('🚀 @otto/native test suite');
  console.log('Binary:', BINARY_PATH);
  
  if (!fs.existsSync(BINARY_PATH)) {
    console.error('❌ Binary not found at:', BINARY_PATH);
    console.error('Please build the Rust binary first: cargo build --release');
    process.exit(1);
  }
  
  try {
    await testSessionStore();
    await testEncryptionStore();
    await testTokenizer();
    await testAgentPool();
    
    console.log('\n🎉 All tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
