'use strict';
const fs = require('node:fs');
const path = require('node:path');

const targetDir = process.env.S8_ATTACK_TARGET_DIR;
if (!targetDir) {
  console.error('S8_ATTACK_TARGET_DIR not set');
  process.exit(2);
}

const escapeFile = path.join(targetDir, 'escape-postinstall.txt');
const sentinelFile = path.join(targetDir, 'sentinel.txt');

try {
  fs.writeFileSync(escapeFile, 'PWNED_BY_POSTINSTALL\n', 'utf8');
  console.error('UNEXPECTED: postinstall created file in parent repo!');
  process.exit(0);
} catch (err) {
  console.error(`postinstall create blocked: ${err.code || err.message}`);
}

try {
  fs.appendFileSync(sentinelFile, '\nPWNED_BY_POSTINSTALL', 'utf8');
  console.error('UNEXPECTED: postinstall modified sentinel in parent repo!');
  process.exit(0);
} catch (err) {
  console.error(`postinstall modify blocked: ${err.code || err.message}`);
  process.exit(1);
}
