// npm test: Jest with @metamask/snaps-jest, which runs the built snap (dist/bundle.js,
// so `npm run build` first) in MetaMask's simulated environment: no browser, no MetaMask.
const { resolve, sep } = require('path');

module.exports = {
  preset: '@metamask/snaps-jest',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  // A fixed port gives the snap a fixed ID (local:http://localhost:18096), so its
  // snap_getEntropy, and the account, can be checked against SIP-6 in the tests.
  testEnvironmentOptions: { server: { port: 18096 } },
  // Tests and @noble (ESM only) run through SWC; zetaphy-network/src/pqtx.js resolves
  // @noble from this package, as in the bundle (test/resolver.js).
  transform: { '^.+\\.(js|jsx)$': ['@swc/jest', { jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic', importSource: '@metamask/snaps-sdk' } } } }] },
  transformIgnorePatterns: [`\\${sep}node_modules\\${sep}(?!@noble\\${sep})`],
  resolver: resolve(__dirname, 'test', 'resolver.js'),
};
