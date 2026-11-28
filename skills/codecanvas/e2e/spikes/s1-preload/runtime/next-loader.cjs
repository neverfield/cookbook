'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { instrumentSource } = require('./transform.cjs');

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

module.exports = function codecanvasNextLoader(source) {
  const resourcePath = this.resourcePath;
  if (!resourcePath || typeof source !== 'string') {
    return source;
  }

  const realResource = safeRealpath(resourcePath);
  // Skip third-party node_modules and codecanvas's own cache directory
  if (
    realResource.includes(`${path.sep}node_modules${path.sep}`) ||
    realResource.includes(`${path.sep}.codecanvas${path.sep}`)
  ) {
    return source;
  }

  const options = typeof this.getOptions === 'function' ? this.getOptions() : {};
  const workspaceRoot = safeRealpath(
    options.workspaceRoot || process.env.CC_WORKSPACE_ROOT || process.cwd()
  );

  if (realResource !== workspaceRoot && !realResource.startsWith(workspaceRoot + path.sep)) {
    return source;
  }

  const relPath = path.relative(workspaceRoot, realResource);
  const { code } = instrumentSource(source, relPath);
  return code;
};
