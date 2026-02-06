const net = require('net')
const dgram = require('dgram')
const dns = require('dns').promises
const { EventEmitter } = require('events')

class Socks5UdpProxy extends EventEmitter {
  constructor(options) {
    super()
    this.proxyHost = options.proxyHost
    this.proxyPort = options.proxyPort
    this.proxyUsername = options.proxyUsername
    this.proxyPassword = options.proxyPassword
    this.targetHost = options.targetHost
    this.targetPort = options.targetPort
    this.targetIp = null
    
    this.tcpSocket = null
    this.udpSocket = null
    this.udpRelayHost = null
    this.udpRelayPort = null
    this.isConnected = false
    this.keepAliveInterval = null
    this.heartbeatInterval = null
    this.reconnectTimer = null
    this.shouldReconnect = true
    this.connectionAttempts = 0
    this.maxReconnectAttempts = 10
    
    // Store handler references for proper cleanup
    this.handlers = {
      tcpError: null,
      tcpClose: null,
      tcpEnd: null,
      tcpTimeout: null,
      tcpData: null
    }
  }

  async connect() {
    try {
      await this.resolveTargetHost()
      await this.establishConnection()
      this.startKeepAlive()
      this.startHeartbeat()
      return {
        udpSocket: this.udpSocket,
        relayHost: this.udpRelayHost,
        relayPort: this.udpRelayPort
      }
    } catch (err) {
      this.cleanup()
      throw err
    }
  }

  async resolveTargetHost() {
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/
    
    if (ipRegex.test(this.targetHost)) {
      this.targetIp = this.targetHost
    } else {
      try {
        const addresses = await dns.resolve4(this.targetHost)
        this.targetIp = addresses[0]
        console.log(`[SOCKS5] Resolved ${this.targetHost} → ${this.targetIp}`)
      } catch (err) {
        throw new Error(`DNS resolution failed for ${this.targetHost}: ${err.message}`)
      }
    }
  }

  async establishConnection() {
    return new Promise(async (resolve, reject) => {
      this.tcpSocket = net.connect(this.proxyPort, this.proxyHost)
      
      // Increase max listeners to prevent warnings
      this.tcpSocket.setMaxListeners(20)
      
      // Enhanced TCP keep-alive settings
      this.tcpSocket.setKeepAlive(true, 5000)
      this.tcpSocket.setTimeout(0)
      this.tcpSocket.setNoDelay(true)
      
      // Define handlers once and store references
      this.handlers.tcpError = (err) => {
        console.error('[SOCKS5] ❌ TCP error:', err.message)
        if (!this.isConnected) {
          reject(err)
        } else {
          this.handleTcpDisconnect('TCP error: ' + err.message)
        }
      }

      this.handlers.tcpClose = () => {
        if (this.isConnected) {
          this.handleTcpDisconnect('TCP connection closed')
        }
      }

      this.handlers.tcpEnd = () => {
        if (this.isConnected) {
          this.handleTcpDisconnect('TCP ended by server')
        }
      }

      this.handlers.tcpTimeout = () => {
        if (this.isConnected) {
          this.handleTcpDisconnect('TCP timeout')
        }
      }

      // Attach handlers
      this.tcpSocket.on('error', this.handlers.tcpError)
      this.tcpSocket.on('close', this.handlers.tcpClose)
      this.tcpSocket.on('end', this.handlers.tcpEnd)
      this.tcpSocket.on('timeout', this.handlers.tcpTimeout)

      try {
        await this.sendGreeting()
        await this.authenticate()
        await this.requestUdpAssociation()
        await this.createUdpSocket()
        
        this.isConnected = true
        this.connectionAttempts = 0
        console.log('[SOCKS5] ✅ Connected - UDP relay:', `${this.udpRelayHost}:${this.udpRelayPort}`)
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  }

  startKeepAlive() {
    this.keepAliveInterval = setInterval(() => {
      if (!this.tcpSocket || this.tcpSocket.destroyed) {
        console.warn('[SOCKS5] ⚠️  TCP destroyed, reconnecting...')
        this.handleTcpDisconnect('TCP socket destroyed')
        return
      }

      if (!this.tcpSocket.writable) {
        console.warn('[SOCKS5] ⚠️  TCP not writable, reconnecting...')
        this.handleTcpDisconnect('TCP socket not writable')
        return
      }

      if (this.tcpSocket.readyState !== 'open') {
        console.warn('[SOCKS5] ⚠️  TCP not open, reconnecting...')
        this.handleTcpDisconnect('TCP socket not open')
      }
    }, 5000)
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      if (!this.tcpSocket || this.tcpSocket.destroyed || !this.tcpSocket.writable) {
        return
      }

      try {
        const request = Buffer.from([
          0x05, 0x03, 0x00, 0x01,
          0x00, 0x00, 0x00, 0x00,
          0x00, 0x00
        ])
        
        // Use a timeout to remove the listener if no response
        const timeoutId = setTimeout(() => {
          if (this.handlers.heartbeatResponse) {
            this.tcpSocket.removeListener('data', this.handlers.heartbeatResponse)
            this.handlers.heartbeatResponse = null
          }
        }, 3000)
        
        // Create handler for this specific heartbeat
        this.handlers.heartbeatResponse = (data) => {
          clearTimeout(timeoutId)
          if (data[0] === 0x05 && data[1] === 0x00) {
            console.log('[SOCKS5] 💓 Heartbeat: UDP association refreshed')
          }
          this.tcpSocket.removeListener('data', this.handlers.heartbeatResponse)
          this.handlers.heartbeatResponse = null
        }
        
        this.tcpSocket.once('data', this.handlers.heartbeatResponse)
        this.tcpSocket.write(request)
      } catch (err) {
        console.warn('[SOCKS5] ⚠️  Heartbeat failed:', err.message)
        this.handleTcpDisconnect('Heartbeat write failed')
      }
    }, 15000)
  }

  handleTcpDisconnect(reason) {
    console.error(`[SOCKS5] ❌ TCP disconnected: ${reason}`)
    
    if (!this.shouldReconnect) return

    // Clear intervals
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    this.emit('tcp-disconnected', reason)
    this.isConnected = false
    
    this.connectionAttempts++
    if (this.connectionAttempts > this.maxReconnectAttempts) {
      console.error('[SOCKS5] ❌ Max reconnection attempts reached, giving up')
      this.emit('max-reconnect-failed')
      this.cleanup()
      return
    }
    
    const delay = Math.min(5000 * Math.pow(1.5, this.connectionAttempts - 1), 30000)
    console.log(`[SOCKS5] 🔄 Reconnecting in ${delay / 1000}s... (attempt ${this.connectionAttempts}/${this.maxReconnectAttempts})`)
    
    this.reconnectTimer = setTimeout(async () => {
      try {
        console.log('[SOCKS5] 🔄 Reconnecting...')
        
        // Clean up old socket properly
        this.cleanupTcpSocket()
        
        await this.resolveTargetHost()
        await this.establishConnection()
        this.startKeepAlive()
        this.startHeartbeat()
        
        console.log('[SOCKS5] ✅ Reconnected successfully!')
        this.emit('tcp-reconnected')
      } catch (err) {
        console.error('[SOCKS5] ❌ Reconnection failed:', err.message)
        this.handleTcpDisconnect('Reconnection failed: ' + err.message)
      }
    }, delay)
  }

  cleanupTcpSocket() {
    if (!this.tcpSocket) return
    
    // Remove all handlers using stored references
    if (this.handlers.tcpError) {
      this.tcpSocket.removeListener('error', this.handlers.tcpError)
    }
    if (this.handlers.tcpClose) {
      this.tcpSocket.removeListener('close', this.handlers.tcpClose)
    }
    if (this.handlers.tcpEnd) {
      this.tcpSocket.removeListener('end', this.handlers.tcpEnd)
    }
    if (this.handlers.tcpTimeout) {
      this.tcpSocket.removeListener('timeout', this.handlers.tcpTimeout)
    }
    if (this.handlers.heartbeatResponse) {
      this.tcpSocket.removeListener('data', this.handlers.heartbeatResponse)
    }
    
    // Reset handler references
    this.handlers.tcpError = null
    this.handlers.tcpClose = null
    this.handlers.tcpEnd = null
    this.handlers.tcpTimeout = null
    this.handlers.heartbeatResponse = null
    
    // Remove any remaining listeners
    this.tcpSocket.removeAllListeners('data')
    
    // Destroy the socket
    if (!this.tcpSocket.destroyed) {
      this.tcpSocket.destroy()
    }
    
    this.tcpSocket = null
  }

  sendGreeting() {
    return new Promise((resolve, reject) => {
      const greeting = Buffer.from([0x05, 0x01, 0x02])
      
      const responseHandler = (data) => {
        this.tcpSocket.removeListener('data', responseHandler)
        
        if (data[0] !== 0x05) {
          return reject(new Error('Invalid SOCKS version'))
        }
        if (data[1] === 0xFF) {
          return reject(new Error('No acceptable authentication method'))
        }
        resolve()
      }
      
      this.tcpSocket.once('data', responseHandler)
      this.tcpSocket.write(greeting)
    })
  }

  authenticate() {
    return new Promise((resolve, reject) => {
      const username = Buffer.from(this.proxyUsername)
      const password = Buffer.from(this.proxyPassword)
      
      const authPacket = Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from([username.length]),
        username,
        Buffer.from([password.length]),
        password
      ])
      
      const responseHandler = (data) => {
        this.tcpSocket.removeListener('data', responseHandler)
        
        if (data[0] !== 0x01 || data[1] !== 0x00) {
          return reject(new Error('Authentication failed'))
        }
        resolve()
      }
      
      this.tcpSocket.once('data', responseHandler)
      this.tcpSocket.write(authPacket)
    })
  }

  requestUdpAssociation() {
    return new Promise((resolve, reject) => {
      const request = Buffer.from([
        0x05, 0x03, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00
      ])
      
      const responseHandler = (data) => {
        this.tcpSocket.removeListener('data', responseHandler)
        
        if (data[0] !== 0x05) {
          return reject(new Error('Invalid SOCKS version in response'))
        }
        
        if (data[1] !== 0x00) {
          const errors = {
            0x01: 'General SOCKS server failure',
            0x02: 'Connection not allowed by ruleset',
            0x03: 'Network unreachable',
            0x04: 'Host unreachable',
            0x05: 'Connection refused',
            0x06: 'TTL expired',
            0x07: 'Command not supported',
            0x08: 'Address type not supported'
          }
          return reject(new Error(errors[data[1]] || `SOCKS5 error code: ${data[1]}`))
        }
        
        const addrType = data[3]
        let relayHost, relayPort
        
        if (addrType === 0x01) {
          relayHost = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`
          relayPort = data.readUInt16BE(8)
        } else if (addrType === 0x03) {
          const domainLen = data[4]
          relayHost = data.slice(5, 5 + domainLen).toString()
          relayPort = data.readUInt16BE(5 + domainLen)
        } else {
          return reject(new Error(`Unsupported address type: ${addrType}`))
        }
        
        this.udpRelayHost = relayHost
        this.udpRelayPort = relayPort
        resolve()
      }
      
      this.tcpSocket.once('data', responseHandler)
      this.tcpSocket.write(request)
    })
  }

  createUdpSocket() {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4')
      
      this.udpSocket.on('error', (err) => {
        console.error('[SOCKS5] ❌ UDP error:', err.message)
        if (!this.isConnected) {
          reject(err)
        }
      })
      
      this.udpSocket.on('message', (msg, rinfo) => {
        try {
          const { data, srcHost, srcPort } = this.parseSocks5UdpHeader(msg)
          this.udpSocket.emit('proxyMessage', data, { host: srcHost, port: srcPort })
        } catch (err) {
          console.error('[SOCKS5] ❌ Failed to parse UDP packet:', err.message)
        }
      })
      
      this.udpSocket.bind(() => {
        resolve()
      })
    })
  }

  sendPacket(data) {
    if (!this.udpSocket || !this.isConnected) {
      console.error('[SOCKS5] ❌ Cannot send packet: not connected')
      return
    }

    const header = this.createSocks5UdpHeader(this.targetIp, this.targetPort)
    const packet = Buffer.concat([header, data])
    
    this.udpSocket.send(packet, this.udpRelayPort, this.udpRelayHost, (err) => {
      if (err) {
        console.error('[SOCKS5] ❌ Failed to send UDP packet:', err.message)
      }
    })
  }

  createSocks5UdpHeader(ip, port) {
    const ipParts = ip.split('.').map(Number)
    const hostBuffer = Buffer.from(ipParts)
    const portBuffer = Buffer.allocUnsafe(2)
    portBuffer.writeUInt16BE(port)
    
    return Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00]),
      Buffer.from([0x01]),
      hostBuffer,
      portBuffer
    ])
  }

  parseSocks5UdpHeader(packet) {
    if (packet.length < 10) {
      throw new Error('Packet too short')
    }
    
    const addrType = packet[3]
    let headerLength, srcHost, srcPort
    
    if (addrType === 0x01) {
      srcHost = `${packet[4]}.${packet[5]}.${packet[6]}.${packet[7]}`
      srcPort = packet.readUInt16BE(8)
      headerLength = 10
    } else if (addrType === 0x03) {
      const domainLen = packet[4]
      srcHost = packet.slice(5, 5 + domainLen).toString()
      srcPort = packet.readUInt16BE(5 + domainLen)
      headerLength = 5 + domainLen + 2
    } else {
      throw new Error(`Unsupported address type: ${addrType}`)
    }
    
    const data = packet.slice(headerLength)
    return { data, srcHost, srcPort }
  }

  cleanup() {
    this.shouldReconnect = false
    
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    
    this.cleanupTcpSocket()
    
    if (this.udpSocket) {
      this.udpSocket.close()
    }
    
    this.isConnected = false
  }

  close() {
    this.cleanup()
  }
}

module.exports = { Socks5UdpProxy }