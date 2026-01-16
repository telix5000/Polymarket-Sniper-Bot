import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../../src/config/env';
import { DEFAULT_CONFIG } from '../../src/constants/polymarket.constants';

const baseEnv = {
  TARGET_ADDRESSES: '0xabc',
  PUBLIC_KEY: '0x' + '11'.repeat(20),
  PRIVATE_KEY: '0x' + '22'.repeat(32),
  RPC_URL: 'http://localhost:8545',
};

const originalEnv = { ...process.env };

const resetEnv = () => {
  process.env = { ...originalEnv };
};

afterEach(() => {
  resetEnv();
});

test('loadEnv uses MIN_TRADE_SIZE_USD when provided', () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    MIN_TRADE_SIZE_USD: '150',
    MIN_TRADE_SIZE: '25',
  });

  const env = loadEnv();
  assert.equal(env.minTradeSizeUsd, 150);
});

test('loadEnv falls back to legacy MIN_TRADE_SIZE when canonical missing', () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    MIN_TRADE_SIZE: '75',
  });

  const env = loadEnv();
  assert.equal(env.minTradeSizeUsd, 75);
});

test('loadEnv defaults MIN_TRADE_SIZE_USD when invalid', () => {
  resetEnv();
  Object.assign(process.env, baseEnv, {
    MIN_TRADE_SIZE_USD: '-5',
  });

  const env = loadEnv();
  assert.equal(env.minTradeSizeUsd, DEFAULT_CONFIG.MIN_TRADE_SIZE_USD);
});
