// Jest resolver: an @noble import from outside this package (zetaphy-network/src/pqtx.js)
// resolves from this package's node_modules, the same rule snap.config.js gives webpack.
const { sep } = require('path');

const ROOT = require('path').resolve(__dirname, '..');

module.exports = (request, options) => {
  if (/^@noble\//.test(request) && !(options.basedir + sep).startsWith(ROOT + sep)) {
    return options.defaultResolver(request, { ...options, basedir: ROOT });
  }
  return options.defaultResolver(request, options);
};
