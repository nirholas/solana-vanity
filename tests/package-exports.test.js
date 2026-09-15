import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../src/index.js';

test('package root exports the supported library surface', () => {
  assert.equal(typeof api.grindVanityNode, 'function');
  assert.equal(typeof api.assertKeypairFeasible, 'function');
  assert.equal(typeof api.mnemonic.generateMnemonic, 'function');
  assert.equal(typeof api.proofOfGrind.verifyProofOfGrind, 'function');
  assert.equal(typeof api.rarity.appraiseAddress, 'function');
  assert.equal(typeof api.splitKey.generateRequesterShare, 'function');
  assert.equal(typeof api.validation.validatePattern, 'function');
  assert.equal(typeof api.verifiableGrind.verifyVanityReceipt, 'function');
});
