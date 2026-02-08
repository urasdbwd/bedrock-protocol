const isBun = typeof Bun !== 'undefined'
let _zlib
function getZlib () {
  if (!_zlib) _zlib = require('zlib')
  return _zlib
}

function toBuffer (uint8) {
  // Wrap the Uint8Array as a Buffer view without copying
  return Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength)
}

function deflateRaw (buffer, level) {
  if (isBun) {
    return toBuffer(Bun.deflateSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), { level }))
  }
  return getZlib().deflateRawSync(buffer, { level })
}

function inflateRaw (buffer) {
  if (isBun) {
    return toBuffer(Bun.inflateSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)))
  }
  return getZlib().inflateRawSync(buffer, { chunkSize: 512000 })
}

module.exports = { deflateRaw, inflateRaw }
