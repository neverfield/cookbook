// Binds a zlib function only a future Node has, as undici 8 binds one Node 22.14 lacks: on an older
// Node it fails as it loads.
const zlib = require("node:zlib");

module.exports = { decompress: zlib.createFutureDecompress.bind(zlib) };
