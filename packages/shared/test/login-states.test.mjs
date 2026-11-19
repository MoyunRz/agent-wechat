import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLoginQrExpiry,
  isFailedLoginState,
  isTerminalLoginState,
  loginCanCancel,
  loginCanStart,
  shouldShowLoginLanHint,
  shouldShowLoginQr,
} from '../src/login-states.ts';

test('terminal states cover every daemon end state, failed excludes success', () => {
  for (const state of ['succeeded', 'cancelled', 'failed', 'rejected', 'expired', 'needs_login', 'needs_slot_login'])
    assert.equal(isTerminalLoginState(state), true, state);
  assert.equal(isTerminalLoginState('succeeded'), true);
  assert.equal(isFailedLoginState('succeeded'), false);
  assert.equal(isFailedLoginState('needs_slot_login'), false);
  for (const state of ['cancelled', 'failed', 'rejected', 'expired', 'needs_login'])
    assert.equal(isFailedLoginState(state), true, state);
});

test('in-flight and unknown states are not terminal', () => {
  for (const state of ['starting', 'resuming', 'awaiting_scan', 'awaiting_approval', 'authenticating', 'idle', 'bogus-future-state'])
    assert.equal(isTerminalLoginState(state), false, state);
});

test('start is blocked while active, cancel only where meaningful', () => {
  for (const state of ['starting', 'resuming', 'awaiting_scan', 'awaiting_approval', 'authenticating', 'succeeded'])
    assert.equal(loginCanStart(state, false), false, state);
  assert.equal(loginCanStart('idle', false), true);
  assert.equal(loginCanStart('failed', false), true);
  assert.equal(loginCanStart('needs_slot_login', false), true);
  assert.equal(loginCanStart('idle', true), false);
  for (const state of ['starting', 'awaiting_scan', 'awaiting_approval', 'authenticating'])
    assert.equal(loginCanCancel(state, false), true, state);
  assert.equal(loginCanCancel('succeeded', false), false);
  assert.equal(loginCanCancel('failed', false), false);
  assert.equal(loginCanCancel('needs_slot_login', false), false);
});

test('qr shows only while awaiting scan with bytes loaded', () => {
  assert.equal(shouldShowLoginQr('awaiting_scan', true, false), true);
  assert.equal(shouldShowLoginQr('awaiting_scan', false, false), false);
  assert.equal(shouldShowLoginQr('awaiting_scan', true, true), false);
  assert.equal(shouldShowLoginQr('awaiting_approval', true, false), false);
});

test('expiry formats unix seconds as local time, garbage yields empty', () => {
  assert.match(formatLoginQrExpiry(0), /^\d{2}:\d{2}$/);
  assert.equal(formatLoginQrExpiry(null), '');
  assert.equal(formatLoginQrExpiry('17:44'), '');
  assert.equal(formatLoginQrExpiry(Number.NaN), '');
});

test('lan hint needs approval state plus a live challenge', () => {
  assert.equal(shouldShowLoginLanHint('awaiting_approval', 'waiting_for_phone'), true);
  assert.equal(shouldShowLoginLanHint('awaiting_approval', null), false);
  assert.equal(shouldShowLoginLanHint('awaiting_approval', 'stopped'), false);
  assert.equal(shouldShowLoginLanHint('awaiting_scan', 'waiting_for_phone'), false);
});
