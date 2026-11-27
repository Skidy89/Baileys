import { Boom } from '@hapi/boom'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import readline from 'readline'
import { LRUCache } from 'lru-cache'
import makeWASocket, { type AnyMessageContent, delay, DisconnectReason, type GroupMetadata, isJidBroadcast, isJidNewsletter, makeCacheableSignalKeyStore, prepareWAMessageMedia, proto, useSqliteAuthState, type WAVersion } from '../src'
import P from 'pino'

import qrcode from 'qrcode-terminal'


const logger = P({
  level: 'info'
})

const getTestImage = () => readFile(resolve('vendor/s.jpg'))



const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const testCallAudio = process.argv.includes('--test-call-audio')

let commandSocket: ReturnType<typeof makeWASocket> | undefined
let commandReady = false


// Bound group metadata memory and refresh it periodically.
const groups = new LRUCache<string, GroupMetadata>({ max: 500, ttl: 5 * 60_000 })

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))


const auth = await useSqliteAuthState({ dbPath: 'baileys_session/test.db' })
const keys = makeCacheableSignalKeyStore(auth.state.keys, logger)
let reconnectAttempts = 0
let reconnectTimer: NodeJS.Timeout | undefined
let shuttingDown = false

// start a connection
const startSock = async() => {
	const WA_VERSION: WAVersion = [2, 3000, 1050189019]

	const sock = makeWASocket({
		version: WA_VERSION,
		logger: logger,
		auth: { creds: auth.state.creds, keys },
		waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
		// use safari as the browser, so that companion registration works
		browser: ['baileys', "Safari", '1.0.0'],
		companionPlatformDisplay: 'Chrome (Windows)',	
		supportGroupHistory: true,
        shouldIgnoreJid: (jid) => isJidBroadcast(jid)  || isJidNewsletter(jid),
		cachedGroupMetadata: async (jid) => {
			const cached = groups.get(jid)
			if (cached) return cached
			const metadata = await sock.groupMetadata(jid)
			groups.set(jid, metadata)
			return metadata
		},
		countryCode: "MX",
		preferLidForLogin: true
	})
	commandSocket = sock




	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		// todo move to QR event
		const phoneNumber = await question('Please enter your phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber, "OPENWA32")
		console.log(`Pairing code: ${code}`)
	}

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			if (events['call']) {
				console.log('call updates', events['call'].map(({ id, status, from }) => ({ id, status, from })))
			}
			if (events['call'] && testCallAudio) {
				for (const update of events['call']) {
					if (update.status !== 'offer') continue
					try {
						const call = await sock.acceptCall(update.id, { audioFile: resolve('vendor/test.mp3') })
						console.log(`Accepted call ${call.callId} with vendor/test.mp3`)
					} catch (error) {
						logger.error({ err: error, callId: update.id }, 'failed to accept call for audio example')
					}
				}
			}

			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				if (qr) {
					qrcode.generate(qr, { small: true })
				}
				if (connection === 'open') {
					commandReady = true
					reconnectAttempts = 0
					
				}
				if(connection === 'close') {
					commandReady = false
					// reconnect if not logged out
					if ((lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.loggedOut) {
						console.log('Connection closed. You are logged out.')
					} else if (!shuttingDown && !reconnectTimer) {
						const reconnectDelay = Math.min(30_000, 1_000 * 2 ** reconnectAttempts++)
						reconnectTimer = setTimeout(() => {
							reconnectTimer = undefined
							void startSock().catch(err => logger.error({ err }, 'failed to reconnect'))
						}, reconnectDelay)
					}
				}
				logger.info({ connection }, 'connection update')
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await auth.saveCreds()
			}

			if(events['labels.association']) {
				console.log(events['labels.association'])
			}


			if(events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					logger.info({ count: messages.length }, 'received on-demand history')
				}
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        logger.info({ type: upsert.type, count: upsert.messages.length }, 'received messages')

        if (!!upsert.requestId) {
          console.log("placeholder message received for request of id=" + upsert.requestId, upsert)
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
			
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
                console.log('requested placeholder resync, id=', messageId)
              }
              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                console.log('requested on-demand sync, id=', messageId)
              }
			  if (text == "exit") {
				console.log('exiting...')
				process.exit(0)
			  }
			  if (!text) continue
			  
			

			  if (text == "changelabel") {
				await sock.updateMemberLabel(msg.key.remoteJid!, "mi puta madre!!!")
			  }
			  if (text == "pn") {
				await sock.sendMessage(msg.key.remoteJid!, { requestPhoneNumber: true })
				return
			  }
			  if (text == "test") {
				console.time("test")
				const p = Date.now()
				const result = await sock.sendMessage(msg.key.remoteJid!, { text: 'Hello there!' })
				console.timeEnd("test")
				const end = Date.now()
				const toMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2)
				
				await sock.sendMessage(msg.key.remoteJid!, { text: `Response time: ${end - p}ms
					memory Usage:
					rss: ${toMB(process.memoryUsage().rss)} MB
					heapTotal: ${toMB(process.memoryUsage().heapTotal)} MB
					heapUsed: ${toMB(process.memoryUsage().heapUsed)} MB`, edit: result?.key })
			  }
			  if (text === 'test3') {
				const image = await getTestImage()
				if (!image) continue
				const prepared = await prepareWAMessageMedia(
					{ image },
					{ upload: sock.waUploadToServer, logger }
				)
				await sock.relayMessage(msg.key.remoteJid!, { imageMessage: prepared.imageMessage }, {})
			  }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {

                console.log('replying to', msg.key.remoteJid)
                await sock!.readMessages([msg.key])
                await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
              }
            }
          }
        }
      }


		}
	)

	return sock
}

rl.on('line', line => {
	const [command, ...args] = line.trim().split(/\s+/)
	if (command !== 'call') return
	const target = args[0]
	if (!target) {
		console.log('Usage: call <jid>')
		return
	}
	if (!commandReady || !commandSocket) {
		console.log('Wait until WhatsApp is connected before starting a call')
		return
	}
	const sock = commandSocket
	void (async () => {
		console.log(`Calling ${target}; waiting for the server offer ACK`)
		const call = await sock.startCall(target, { audioFile: resolve('vendor/test.mp3') })
		console.log(`Call ${call.callId} was offered with vendor/test.mp3`)
	})().catch(error => logger.error({ err: error, to: target }, 'failed to start example audio call'))
})

void startSock().catch(err => logger.error({ err }, 'failed to start socket'))

process.once('SIGINT', () => {
	shuttingDown = true
	if (reconnectTimer) clearTimeout(reconnectTimer)
	commandSocket?.end(new Error('Interrupted'))
	rl.close()
	void auth.close()
})
