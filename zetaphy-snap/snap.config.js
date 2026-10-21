// mm-snap build / serve / watch. src/pqtx.js re-exports zetaphy-network/src/pqtx.js;
// an @noble import from outside this folder (pqtx.js) is resolved from this
// package's node_modules (package-lock.json), so the bundle and the manifest
// shasum depend on nothing else in the repo.
import { resolve, sep } from 'path';

const ROOT = __dirname + sep;

const ownNoble = {
  apply(compiler) {
    compiler.hooks.normalModuleFactory.tap('own-noble', (factory) => {
      factory.hooks.beforeResolve.tap('own-noble', (data) => {
        if (/^@noble\//.test(data.request) && !(data.context + sep).startsWith(ROOT)) data.context = __dirname;
      });
    });
  },
};

export default {
  input: resolve(__dirname, 'src/index.jsx'),
  server: { port: 8080 },
  polyfills: false,
  // A dependency of @metamask/snaps-sdk feature-checks for Buffer; nothing in the bundle uses it.
  stats: { buffer: false },
  // The vaccine's build-time constants (src/threats.js), placeholders until the
  // owner knows them: the ZETAPHY JSON-RPC (https) the transaction insight asks,
  // the ThreatRegistry there (zero: none, so every insight says "couldn't check"),
  // and the web wallet origin(s) allowed to override both (zetaphy_setThreatSource).
  // Change them here, then npm run build and commit snap.manifest.json (shasum).
  environment: {
    ZETAPHY_THREAT_RPC: 'https://rpc.zetaphy.invalid',
    ZETAPHY_THREAT_REGISTRY: '0x0000000000000000000000000000000000000000',
    ZETAPHY_WALLET_ORIGINS: 'https://wallet.zetaphy.invalid',
  },
  customizeWebpackConfig: (config) => ({ ...config, plugins: [...config.plugins, ownNoble] }),
};
