const crypto = require('crypto')
const { deflateRaw, inflateRaw } = require('./compression')

const isBun = typeof Bun !== 'undefined'

function createCipher (secret, initialValue, cipherAlgorithm) {
  return crypto.createCipheriv(cipherAlgorithm, secret, initialValue)
}

function createDecipher (secret, initialValue, cipherAlgorithm) {
  return crypto.createDecipheriv(cipherAlgorithm, secret, initialValue)
}

const _counterBuf = Buffer.alloc(8)
// Bun.CryptoHasher auto-resets after digest(), so a single instance can be reused
const _hasher = isBun ? new Bun.CryptoHasher('sha256') : null

function computeCheckSum (packetPlaintext, sendCounter, secretKeyBytes) {
  _counterBuf.writeBigInt64LE(sendCounter, 0)
  if (_hasher) {
    _hasher.update(_counterBuf)
    _hasher.update(packetPlaintext)
    _hasher.update(secretKeyBytes)
    return _hasher.digest().subarray(0, 8)
  }
  const digest = crypto.createHash('sha256')
  digest.update(_counterBuf)
  digest.update(packetPlaintext)
  digest.update(secretKeyBytes)
  return digest.digest().subarray(0, 8)
}

function createEncryptor (client, iv) {
  if (client.versionLessThan('1.16.220')) {
    client.cipher = createCipher(client.secretKeyBytes, iv, 'aes-256-cfb8')
  } else {
    client.cipher = createCipher(client.secretKeyBytes, iv.slice(0, 12), 'aes-256-gcm')
  }
  client.sendCounter = client.sendCounter || 0n
  const hasHeader = client.features.compressorInHeader
  const compressionLevel = client.compressionLevel
  const secretKeyBytes = client.secretKeyBytes

  // A packet is encrypted via AES256(plaintext + SHA256(send_counter + plaintext + secret_key)[0:8]).
  // The send counter is represented as a little-endian 64-bit long and incremented after each packet.

  function process (chunk) {
    const compressed = deflateRaw(chunk, compressionLevel)
    const headerLen = hasHeader ? 1 : 0

    const packet = Buffer.allocUnsafe(headerLen + compressed.length + 8)
    let offset = 0
    if (hasHeader) {
      packet[0] = 0
      offset = 1
    }
    compressed.copy(packet, offset)
    offset += compressed.length

    const checksumInput = packet.subarray(0, offset)
    const checksum = computeCheckSum(checksumInput, client.sendCounter, secretKeyBytes)
    checksum.copy(packet, offset)

    client.sendCounter++
    client.cipher.write(packet)
  }

  client.cipher.on('data', client.onEncryptedPacket)

  return (blob) => {
    process(blob)
  }
}

function createDecryptor (client, iv) {
  if (client.versionLessThan('1.16.220')) {
    client.decipher = createDecipher(client.secretKeyBytes, iv, 'aes-256-cfb8')
  } else {
    client.decipher = createDecipher(client.secretKeyBytes, iv.slice(0, 12), 'aes-256-gcm')
  }

  client.receiveCounter = client.receiveCounter || 0n
  const decHasHeader = client.features.compressorInHeader
  const decSecretKeyBytes = client.secretKeyBytes

  function verify (chunk) {
    const packet = chunk.subarray(0, chunk.length - 8)
    const checksum = chunk.subarray(chunk.length - 8)
    const computedCheckSum = computeCheckSum(packet, client.receiveCounter, decSecretKeyBytes)
    client.receiveCounter++

    if (!checksum.equals(computedCheckSum)) {
      client.emit('error', Error(`Checksum mismatch ${checksum.toString('hex')} != ${computedCheckSum.toString('hex')}`))
      client.disconnect('disconnectionScreen.badPacket')
      return
    }

    let buffer
    if (decHasHeader) {
      switch (packet[0]) {
        case 0:
          buffer = inflateRaw(packet.subarray(1))
          break
        case 255:
          buffer = packet.subarray(1)
          break
        default:
          client.emit('error', Error(`Unsupported compressor: ${packet[0]}`))
      }
    } else {
      buffer = inflateRaw(packet)
    }

    client.onDecryptedPacket(buffer)
  }

  client.decipher.on('data', verify)

  return (blob) => {
    client.decipher.write(blob)
  }
}

module.exports = {
  createCipher, createDecipher, createEncryptor, createDecryptor
}
