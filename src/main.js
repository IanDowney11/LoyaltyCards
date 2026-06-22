import { initKey, importNsec, getNsec, getPubkey, connect, disconnect, publishCard, tombstoneCard } from './nostr.js'
import { saveCard, removeCard, getAllCards } from './store.js'
import { compressImage } from './compress.js'
import { generateQRDataUrl, startScanner } from './qr.js'

// ---- State ----
let cards = []
let activeCard = null
let pendingImage = null // base64 data URL awaiting save

// ---- DOM refs ----
const $ = id => document.getElementById(id)

const cardGrid     = $('card-grid')
const emptyState   = $('empty-state')

const cardModal    = $('card-modal')
const cardName     = $('card-modal-name')
const cardImg      = $('card-modal-img')

const addModal     = $('add-modal')
const addSaveBtn   = $('add-save-btn')
const nameInput    = $('card-name')
const previewImg   = $('preview-img')
const imagePlaceholder = $('image-placeholder')

const settingsModal  = $('settings-modal')
const syncDot        = $('sync-dot')
const syncLabel      = $('sync-label')
const keyDisplay     = $('key-display')
const importKeyInput = $('import-key-input')

// ---- NOSTR event handler ----
let eventCount = 0
function onNostrEvent(event) {
  eventCount++
  setSyncStatus('connected', `Syncing… (${eventCount} received)`)
  const dTag    = event.tags.find(t => t[0] === 'd')?.[1]
  const name    = event.tags.find(t => t[0] === 'name')?.[1] || 'Card'
  const deleted = event.tags.find(t => t[0] === 'deleted')?.[1] === 'true'

  if (!dTag) return

  if (deleted || !event.content) {
    const i = cards.findIndex(c => c.id === dTag)
    if (i !== -1) {
      cards.splice(i, 1)
      removeCard(dTag)
      renderCards()
    }
    return
  }

  const existing = cards.find(c => c.id === dTag)
  if (existing) {
    if (event.created_at > (existing.created_at || 0)) {
      existing.name = name
      existing.image = event.content
      existing.created_at = event.created_at
      saveCard(existing)
      renderCards()
    }
  } else {
    const card = { id: dTag, name, image: event.content, created_at: event.created_at }
    cards.push(card)
    saveCard(card)
    renderCards()
  }
}

// ---- Render ----
function renderCards() {
  cardGrid.querySelectorAll('.card-item').forEach(el => el.remove())

  if (cards.length === 0) {
    emptyState.classList.remove('hidden')
    return
  }
  emptyState.classList.add('hidden')

  cards
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(card => {
      const el = document.createElement('div')
      el.className = 'card-item'
      el.innerHTML = `
        <img class="card-thumb" src="${card.image}" alt="${card.name}" loading="lazy">
        <div class="card-label">${card.name}</div>
      `
      el.addEventListener('click', () => openCard(card))
      cardGrid.appendChild(el)
    })
}

// ---- Card view ----
let cardRotated = false
let cardZoom = 1

function applyCardTransform() {
  if (cardRotated) {
    cardImg.style.transform = `rotate(90deg) scale(${0.75 * cardZoom})`
  } else {
    cardImg.style.transform = cardZoom === 1 ? '' : `scale(${cardZoom})`
  }
}

function resetCardTransform() {
  cardRotated = false
  cardZoom = 1
  cardImg.style.transform = ''
}

function openCard(card) {
  activeCard = card
  cardName.textContent = card.name
  cardImg.src = card.image
  resetCardTransform()
  cardModal.classList.remove('hidden')
  history.pushState({ modal: 'card' }, '')
}

function closeCard() {
  cardModal.classList.add('hidden')
  resetCardTransform()
  activeCard = null
}

// ---- Pinch-to-zoom on card image ----
;(function initPinchZoom() {
  let startDist = 0
  let startZoom = 1

  cardImg.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault()
      startDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      )
      startZoom = cardZoom
    }
  }, { passive: false })

  cardImg.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault()
      const dist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      )
      cardZoom = Math.min(Math.max(startZoom * (dist / startDist), 1), 8)
      applyCardTransform()
    }
  }, { passive: false })

  cardImg.addEventListener('touchend', e => {
    if (e.touches.length === 0 && cardZoom < 1.1) {
      cardZoom = 1
      applyCardTransform()
    }
  })
})()

// ---- Add card ----
function openAdd() {
  nameInput.value = ''
  previewImg.src = ''
  previewImg.classList.add('hidden')
  imagePlaceholder.classList.remove('hidden')
  pendingImage = null
  addSaveBtn.disabled = false
  addSaveBtn.textContent = 'Save'
  addModal.classList.remove('hidden')
  history.pushState({ modal: 'add' }, '')
  setTimeout(() => nameInput.focus(), 100)
}

function closeAdd() {
  addModal.classList.add('hidden')
}

async function handleFile(file) {
  if (!file) return
  addSaveBtn.disabled = true
  addSaveBtn.textContent = 'Processing...'
  try {
    pendingImage = await compressImage(file)
    previewImg.src = pendingImage
    previewImg.classList.remove('hidden')
    imagePlaceholder.classList.add('hidden')
  } catch {
    alert('Could not process that image. Please try another.')
  }
  addSaveBtn.disabled = false
  addSaveBtn.textContent = 'Save'
}

async function saveNewCard() {
  const name = nameInput.value.trim()
  if (!name) { nameInput.focus(); return }
  if (!pendingImage) { alert('Please add an image first.'); return }

  addSaveBtn.disabled = true
  addSaveBtn.textContent = 'Saving...'

  const id = crypto.randomUUID()
  const card = { id, name, image: pendingImage, created_at: Math.floor(Date.now() / 1000) }

  cards.push(card)
  await saveCard(card)
  renderCards()
  closeAdd()
  if (history.state?.modal === 'add') history.back()

  // Publish to NOSTR in background — failure is non-fatal
  publishCard(id, name, pendingImage).catch(e => console.warn('NOSTR publish failed:', e))
}

// ---- Delete card ----
async function deleteActiveCard() {
  if (!activeCard) return
  if (!confirm(`Delete "${activeCard.name}"?`)) return

  const { id } = activeCard
  cards = cards.filter(c => c.id !== id)
  await removeCard(id)
  renderCards()
  closeCard()
  if (history.state?.modal === 'card') history.back()

  tombstoneCard(id).catch(e => console.warn('NOSTR delete failed:', e))
}

// ---- Settings ----
function openSettings() {
  keyDisplay.textContent = getNsec()
  importKeyInput.value = ''
  // Show truncated pubkey for diagnostics
  const pk = getPubkey()
  syncLabel.textContent = syncLabel.textContent.replace(/ \(npub.*\)$/, '') + (pk ? ` (npub: ${pk.slice(0,8)}…)` : '')
  settingsModal.classList.remove('hidden')
  history.pushState({ modal: 'settings' }, '')
}

function closeSettings() {
  settingsModal.classList.add('hidden')
}

function setSyncStatus(state, text) {
  syncDot.className = state
  syncLabel.textContent = text
}

// ---- QR display ----
async function openQRDisplay() {
  const dataUrl = await generateQRDataUrl(getNsec())
  $('qr-img').src = dataUrl
  $('qr-modal').classList.remove('hidden')
  history.pushState({ modal: 'qr' }, '')
}

function closeQRDisplay() {
  $('qr-modal').classList.add('hidden')
}

// ---- QR scanner ----
let activeScanner = null

function openQRScanner() {
  const modal = $('scan-modal')
  const viewport = $('scan-viewport')
  const status = $('scan-status')

  modal.classList.remove('hidden')
  history.pushState({ modal: 'scan' }, '')
  status.textContent = 'Starting camera...'

  activeScanner = startScanner(
    data => {
      // QR detected — check it looks like an nsec key
      if (!data.startsWith('nsec1')) {
        status.textContent = 'Not a valid key QR — try again'
        // Restart scanner after brief pause
        setTimeout(() => openQRScanner(), 1500)
        return
      }
      closeQRScanner()
      if (history.state?.modal === 'scan') history.back()
      applyImportedKey(data)
    },
    err => {
      console.error('Camera error:', err)
      status.textContent = 'Camera access denied. Use manual paste instead.'
    }
  )

  // Inject video element into viewport (before the overlay)
  activeScanner.video.className = 'scan-video'
  viewport.insertBefore(activeScanner.video, viewport.firstChild)
  activeScanner.video.addEventListener('loadedmetadata', () => {
    status.textContent = 'Point camera at QR code'
  })
}

function closeQRScanner() {
  if (activeScanner) {
    activeScanner.stop()
    activeScanner.video.remove()
    activeScanner = null
  }
  $('scan-modal').classList.add('hidden')
}

function applyImportedKey(nsec) {
  if (importNsec(nsec)) {
    // Key saved to localStorage — reload for a clean start with the new identity
    setSyncStatus('connected', 'Key imported — reloading...')
    setTimeout(() => location.reload(), 600)
  } else {
    alert('Invalid key. Please try again.')
  }
}

// ---- Init ----
async function init() {
  initKey()

  cards = await getAllCards()
  renderCards()

  setSyncStatus('', 'Connecting...')
  try {
    connect(
      onNostrEvent,
      () => setSyncStatus('connected', eventCount > 0 ? `Synced (${eventCount} cards)` : 'Connected — no cards found on relays')
    )
    setSyncStatus('connected', 'Connected — fetching…')
  } catch (e) {
    setSyncStatus('error', 'Offline — cards saved locally')
    console.warn('NOSTR connect failed:', e)
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }
}

// ---- Event wiring ----
$('add-btn').addEventListener('click', openAdd)
$('card-back-btn').addEventListener('click', () => { closeCard(); history.back() })
$('card-delete-btn').addEventListener('click', deleteActiveCard)
cardImg.addEventListener('click', () => {
  cardRotated = !cardRotated
  applyCardTransform()
})

$('add-back-btn').addEventListener('click', () => { closeAdd(); history.back() })
addSaveBtn.addEventListener('click', saveNewCard)
$('camera-btn').addEventListener('click', () => $('camera-input').click())
$('upload-btn').addEventListener('click', () => $('file-input').click())
$('camera-input').addEventListener('change', e => handleFile(e.target.files[0]))
$('file-input').addEventListener('change', e => handleFile(e.target.files[0]))

$('settings-btn').addEventListener('click', openSettings)
$('settings-back-btn').addEventListener('click', () => { closeSettings(); history.back() })

$('copy-key-btn').addEventListener('click', async () => {
  const btn = $('copy-key-btn')
  try {
    await navigator.clipboard.writeText(getNsec())
    btn.textContent = 'Copied!'
  } catch {
    btn.textContent = 'Copy failed'
  }
  setTimeout(() => { btn.textContent = 'Copy Key' }, 2000)
})

$('import-key-btn').addEventListener('click', () => {
  const val = importKeyInput.value.trim()
  if (!val) return
  applyImportedKey(val)
  importKeyInput.value = ''
})

$('show-qr-btn').addEventListener('click', openQRDisplay)
$('qr-back-btn').addEventListener('click', () => { closeQRDisplay(); history.back() })

$('scan-qr-btn').addEventListener('click', openQRScanner)
$('scan-cancel-btn').addEventListener('click', () => { closeQRScanner(); history.back() })

$('push-all-btn').addEventListener('click', async () => {
  const btn = $('push-all-btn')
  if (cards.length === 0) { btn.textContent = 'No cards to push'; setTimeout(() => { btn.textContent = '↑ Push local cards to NOSTR' }, 2000); return }
  btn.disabled = true
  btn.textContent = `Pushing 0 / ${cards.length}...`
  let ok = 0, fail = 0
  for (const card of cards) {
    try {
      await publishCard(card.id, card.name, card.image)
      ok++
    } catch {
      fail++
    }
    btn.textContent = `Pushing ${ok + fail} / ${cards.length}...`
  }
  btn.disabled = false
  btn.textContent = fail > 0 ? `Done (${ok} pushed, ${fail} failed)` : `Done — ${ok} card${ok !== 1 ? 's' : ''} pushed`
  setTimeout(() => { btn.textContent = '↑ Push local cards to NOSTR' }, 4000)
})

$('refresh-btn').addEventListener('click', () => {
  setSyncStatus('', 'Re-fetching...')
  disconnect()
  cards = []
  getAllCards().then(local => {
    cards = local
    renderCards()
    connect(
      onNostrEvent,
      () => setSyncStatus('connected', 'Synced')
    )
  })
})

// Handle Android/browser back button
window.addEventListener('popstate', e => {
  const modal = e.state?.modal
  if (modal === 'card' && !cardModal.classList.contains('hidden')) closeCard()
  else if (modal === 'add' && !addModal.classList.contains('hidden')) closeAdd()
  else if (modal === 'settings' && !settingsModal.classList.contains('hidden')) closeSettings()
  else if (modal === 'qr' && !$('qr-modal').classList.contains('hidden')) closeQRDisplay()
  else if (modal === 'scan' && !$('scan-modal').classList.contains('hidden')) closeQRScanner()
})

init()
