import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import { nsecEncode, decode } from 'nostr-tools/nip19'

const RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://nostr.mom',
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

export function connect(onEvent, onConnected) {
  if (activeSub) activeSub.close()
  pool = new SimplePool()

  activeSub = pool.subscribeMany(
    RELAYS,
    [{ kinds: [CARD_KIND], authors: [pubkey] }],
    {
      onevent: onEvent,
      oneose: onConnected,
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
  await Promise.any(pool.publish(RELAYS, event))
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
  await Promise.any(pool.publish(RELAYS, event))
}
