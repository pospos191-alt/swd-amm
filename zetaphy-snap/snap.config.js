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
  customizeWebpackConfig: (config) => ({ ...config, plugins: [...config.plugins, ownNoble] }),
};
