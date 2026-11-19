'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');

// Standalone Node tests and unpackaged Electron both use the repository vendor tree.
const source = path.join(__dirname, '..', 'vendor');
const root = !existsSync(source) && process.resourcesPath
  ? path.join(process.resourcesPath, 'vendor')
  : source;

module.exports = (...parts) => path.join(root, ...parts);
