const { Client } = require('./client')
const { RakClient } = require('./rak')('raknet-native')
const { sleep } = require('./datatypes/util')
const assert = require('assert')
const Options = require('./options')
const advertisement = require('./server/advertisement')
const auth = require('./client/auth')

/** @param {{ version?: number, host: string, port?: number, connectTimeout?: number, skipPing?: boolean }} options */
function createClient (options) {
  assert(options)
  const client = new Client({ port: 19132, followPort: !options.realms, ...options, delayedInit: true })

  function onServerInfo () {
    client.on('connect_allowed', () => connect(client))
    if (options.skipPing) {
      client.init()
    } else {
      ping(client.options).then(ad => {
        const adVersion = ad.version?.split('.').slice(0, 3).join('.') // Only 3 version units
        client.options.version = options.version ?? (Options.Versions[adVersion] ? adVersion : Options.CURRENT_VERSION)

        if (ad.portV4 && client.options.followPort) {
          client.options.port = ad.portV4
        }

        client.conLog?.(`Connecting to ${client.options.host}:${client.options.port} ${ad.motd} (${ad.levelName}), version ${ad.version} ${client.options.version !== ad.version ? ` (as ${client.options.version})` : ''}`)
        client.init()
      }).catch(e => client.emit('error', e))
    }
  }

  if (options.realms) {
    auth.realmAuthenticate(client.options).then(onServerInfo).catch(e => client.emit('error', e))
  } else {
    onServerInfo()
  }
  return client
}
function connect (client) {
  // Actually connect
  client.connect()

  // --- HEARTBEAT LOGIC START ---
  // Start heartbeat as soon as the client is initializing, not just on spawn
  const keepAliveInterval = 10
  const keepAliveIntervalBig = BigInt(keepAliveInterval)
  let keepalive
  client.tick = 0n

  // Start the heartbeat when we reach the Initializing status
  client.once('status', (status) => {
    // 3 is ClientStatus.Initializing
    if (status >= 3 && !keepalive) {
      keepalive = setInterval(() => {
        // Only queue if we are still connected
        if (client.status >= 3) {
          client.queue('tick_sync', { request_time: client.tick, response_time: 0n })
          client.tick += keepAliveIntervalBig
        }
      }, 50 * keepAliveInterval) // 500ms
    }
  })

  client.on('tick_sync', async packet => {
    client.emit('heartbeat', packet.response_time)
    client.tick = packet.response_time
  })

  client.once('close', () => {
    if (keepalive) clearInterval(keepalive)
  })
  // --- HEARTBEAT LOGIC END ---

  client.once('resource_packs_info', (packet) => {
    client.write('resource_pack_client_response', {
      response_status: 'completed',
      resourcepackids: []
    })

    client.once('resource_pack_stack', (stack) => {
      client.write('resource_pack_client_response', {
        response_status: 'completed',
        resourcepackids: []
      })
    })

    client.queue('client_cache_status', { enabled: false })
    
    // Initial tick sync for newer versions
    client.queue('tick_sync', { request_time: BigInt(Date.now()), response_time: 0n })

    sleep(500).then(() => client.queue('request_chunk_radius', { chunk_radius: client.viewDistance || 10 }))
  })
}
async function ping ({ host, port }) {
  const con = new RakClient({ host, port })

  try {
    return advertisement.fromServerName(await con.ping())
  } finally {
    con.close()
  }
}

module.exports = { createClient, ping }
