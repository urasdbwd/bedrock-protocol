const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const { deflateRaw, inflateRaw } = require('./compression')

// Concatenates packets into one batch packet, and adds length prefixs.
class Framer {
  constructor (client) {
    // Encoding
    this.packets = []
    this.batchHeader = client.batchHeader
    this.compressor = client.compressionAlgorithm || 'none'
    this.compressionLevel = client.compressionLevel
    this.compressionThreshold = client.compressionThreshold
    this.compressionHeader = client.compressionHeader || 0
    this.writeCompressor = client.features.compressorInHeader && client.compressionReady
  }

  reset () {
    this.packets.length = 0
  }

  updateSettings (client) {
    this.batchHeader = client.batchHeader
    this.compressor = client.compressionAlgorithm || 'none'
    this.compressionLevel = client.compressionLevel
    this.compressionThreshold = client.compressionThreshold
    this.compressionHeader = client.compressionHeader || 0
    this.writeCompressor = client.features.compressorInHeader && client.compressionReady
  }

  compress (buffer) {
    switch (this.compressor) {
      case 'deflate': return deflateRaw(buffer, this.compressionLevel)
      case 'snappy': throw Error('Snappy compression not implemented')
      case 'none': return buffer
    }
  }

  static decompress (algorithm, buffer) {
    switch (algorithm) {
      case 0:
      case 'deflate':
        return inflateRaw(buffer)
      case 1:
      case 'snappy':
        throw Error('Snappy compression not implemented')
      case 'none':
      case 255:
        return buffer
      default: throw Error('Unknown compression type ' + algorithm)
    }
  }

  static decode (client, buf) {
    // Read header
    if (this.batchHeader && buf[0] !== this.batchHeader) throw Error(`bad batch packet header, received: ${buf[0]}, expected: ${this.batchHeader}`)
    const buffer = buf.subarray(1)
    // Decompress
    let decompressed
    if (client.features.compressorInHeader && client.compressionReady) {
      decompressed = this.decompress(buffer[0], buffer.subarray(1))
    } else {
      // On old versions, compressor is session-wide ; failing to decompress
      // a packet will assume it's not compressed
      try {
        decompressed = this.decompress(client.compressionAlgorithm, buffer)
      } catch (e) {
        decompressed = buffer
      }
    }
    return Framer.getPackets(decompressed)
  }

  encode () {
    const buf = this.packets.length === 1 ? this.packets[0] : Buffer.concat(this.packets)
    const shouldCompress = buf.length > this.compressionThreshold
    const compressed = shouldCompress ? this.compress(buf) : buf

    let headerLen = 0
    if (this.batchHeader) headerLen++
    if (this.writeCompressor) headerLen++

    if (headerLen === 0) return compressed

    const result = Buffer.allocUnsafe(headerLen + compressed.length)
    let offset = 0
    if (this.batchHeader) result[offset++] = this.batchHeader
    if (this.writeCompressor) result[offset++] = shouldCompress ? this.compressionHeader : 255
    compressed.copy(result, offset)
    return result
  }

  addEncodedPacket (chunk) {
    const varIntSize = sizeOfVarInt(chunk.byteLength)
    const buffer = Buffer.allocUnsafe(varIntSize + chunk.byteLength)
    writeVarInt(chunk.length, buffer, 0)
    chunk.copy(buffer, varIntSize)
    this.packets.push(buffer)
  }

  addEncodedPackets (packets) {
    let allocSize = 0
    for (const packet of packets) {
      allocSize += sizeOfVarInt(packet.byteLength)
      allocSize += packet.byteLength
    }
    const buffer = Buffer.allocUnsafe(allocSize)
    let offset = 0
    for (const chunk of packets) {
      offset = writeVarInt(chunk.length, buffer, offset)
      offset += chunk.copy(buffer, offset, 0)
    }

    this.packets.push(buffer)
  }

  getBuffer () {
    return this.packets.length === 1 ? this.packets[0] : Buffer.concat(this.packets)
  }

  static getPackets (buffer) {
    const packets = []
    let offset = 0
    while (offset < buffer.byteLength) {
      const { value, size } = readVarInt(buffer, offset)
      offset += size
      packets.push(buffer.subarray(offset, offset + value))
      offset += value
    }
    return packets
  }
}

module.exports = { Framer }
