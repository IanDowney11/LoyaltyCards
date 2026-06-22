import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { nsecEncode, decode } from 'nostr-tools/nip19'

const RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://purplepag.es',
]

const CARD_KIND = 30078
const NSEC_KEY = 'loyalty-cards-nsec'

let secretKey = null
let pubkey = null
let pool = null
let activeSub = null

export function initKey() {
  const stored = localStorage.getItem(NSEC_KEY)
  if (stored) {
    try {
      const { type, data } = decode(stored)
      if (type === 'nsec') {
        secretKey = data
        pubkey = getPublicKey(secretKey)
        return stored
      }
    } catch { /* fall through to generate */ }
  }
  secretKey = generateSecretKey()
  pubkey = getPublicKey(secretKey)
  const nsec = nsecEncode(secretKey)
  localStorage.setItem(NSEC_KEY, nsec)
  return nsec
}

export function importNsec(nsecStr) {
  try {
    const { type, data } = decode(nsecStr.trim())
    if (type !== 'nsec') return false
    secretKey = data
    pubkey = getPublicKey(secretKey)
    localStorage.setItem(NSEC_KEY, nsecStr.trim())
    return true
  } catch {
    return false
  }
}

export function getNsec() {
  return localStorage.getItem(NSEC_KEY) || ''
}

export function getPubkey() {
  return pubkey || ''
}

export function connect(onEvent, onEose) {
  if (activeSub) activeSub.close()
  if (pool) pool.close(RELAYS)
  pool = new SimplePool()

  console.log('[NOSTR] subscribing as', pubkey)

  activeSub = pool.subscribeMany(
    RELAYS,
    { kinds: [CARD_KIND], authors: [pubkey] },
    {
      onevent(event) {
        console.log('[NOSTR] event received', event.tags.find(t => t[0] === 'name')?.[1], event.id.slice(0, 8))
        onEvent(event)
      },
      oneose() {
        console.log('[NOSTR] EOSE — initial sync complete')
        onEose()
      },
    }
  )

  return activeSub
}

export function disconnect() {
  if (activeSub) { activeSub.close(); activeSub = null }
  if (pool) { pool.close(RELAYS); pool = null }
}

export async function publishCard(id, name, imageDataUrl) {
  if (!secretKey || !pool) throw new Error('NOSTR not initialised')
  const event = finalizeEvent(
    {
      kind: CARD_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', id], ['name', name]],
      content: imageDataUrl,
    },
    secretKey
  )
  const results = await Promise.allSettled(pool.publish(RELAYS, event))
  const ok = results.filter(r => r.status === 'fulfilled')
  console.log(`[NOSTR] published "${name}" — ${ok.length}/${results.length} relays accepted`)
  if (ok.length === 0) throw new Error('All relays rejected the event')
  return event
}

export async function tombstoneCard(id) {
  if (!secretKey || !pool) throw new Error('NOSTR not initialised')
  const event = finalizeEvent(
    {
      kind: CARD_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', id], ['deleted', 'true']],
      content: '',
    },
    secretKey
  )
  await Promise.allSettled(pool.publish(RELAYS, event))
}
