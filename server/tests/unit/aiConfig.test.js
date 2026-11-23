'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, DEFAULT_GEMINI_MODEL } = require('../../src/config');

test('AI config defaults to off in test environment and gemini in development', () => {
  const testCfg = loadConfig({ NODE_ENV: 'test' });
  assert.equal(testCfg.ai.provider, 'off');
  assert.equal(testCfg.ai.enabled, false);
  assert.equal(testCfg.ai.model, DEFAULT_GEMINI_MODEL);
  assert.equal(testCfg.ai.model, 'gemini-3.5-flash-lite');
  assert.equal(testCfg.ai.timeoutMs, 8000);

  const devNoKey = loadConfig({ NODE_ENV: 'development' });
  assert.equal(devNoKey.ai.provider, 'gemini');
  assert.equal(devNoKey.ai.enabled, false);
  assert.equal(devNoKey.ai.apiKey, '');

  const devWithKey = loadConfig({ NODE_ENV: 'development', GEMINI_API_KEY: 'dummy-key-value' });
  assert.equal(devWithKey.ai.provider, 'gemini');
  assert.equal(devWithKey.ai.enabled, true);
  assert.equal(devWithKey.ai.apiKey, 'dummy-key-value');
});

test('AI config respects AI_PROVIDER=off even when GEMINI_API_KEY is set', () => {
  const cfg = loadConfig({
    NODE_ENV: 'development',
    AI_PROVIDER: 'off',
    GEMINI_API_KEY: 'dummy-key-value',
  });
  assert.equal(cfg.ai.provider, 'off');
  assert.equal(cfg.ai.enabled, false);
});

test('AI config rejects invalid AI_PROVIDER', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', AI_PROVIDER: 'openai' }),
    /AI_PROVIDER must be one of/
  );
});

test('AI config rejects invalid GEMINI_MODEL', () => {
  for (const badModel of ['bad model with spaces', '../etc/passwd', 'model?key=123']) {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', GEMINI_MODEL: badModel }),
      /GEMINI_MODEL must be a valid model identifier/
    );
  }
});

test('AI config rejects invalid AI_TIMEOUT_MS', () => {
  for (const badTimeout of ['500', '30001', 'abc', '1000.5']) {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', AI_TIMEOUT_MS: badTimeout }),
      /AI_TIMEOUT_MS must be a whole number from 1000 to 30000/
    );
  }
});