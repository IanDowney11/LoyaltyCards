const DB_NAME = 'loyalty-cards-db'
const DB_VERSION = 1
const STORE = 'cards'

let db = null

async function openDB() {
  if (db) return db
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      const d = e.target.result
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = e => { db = e.target.result; resolve(db) }
    req.onerror = e => reject(e.target.error)
  })
}

export async function saveCard(card) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(card)
    tx.oncomplete = resolve
    tx.onerror = e => reject(e.target.error)
  })
}

export async function removeCard(id) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = resolve
    tx.onerror = e => reject(e.target.error)
  })
}

export async function getAllCards() {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = e => reject(e.target.error)
  })
}
