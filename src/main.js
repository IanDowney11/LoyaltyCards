import { initKey, importNsec, getNsec, connect, disconnect, publishCard, tombstoneCard } from './nostr.js'
import { saveCard, removeCard, getAllCards } from './store.js'
import { compressImage } from './compress.js'
import { generateQRDataUrl, startScanner } from './qr.js'

// ---- State ----
let cards = []
let activeCard = null
let pendingImage = null
let wakeLock = null

// ---- DOM refs ----
const $ = id => document.getElementById(id)

const cardGrid         = $('card-grid')
const emptyState       = $('empty-state')
const cardModal        = $('card-modal')
const cardName         = $('card-modal-name')
const cardImg          = $('card-modal-img')
const addModal         = $('add-modal')
const addSaveBtn       = $('add-save-btn')
const nameInput        = $('card-name')
const previewImg       = $('preview-img')
const imagePlaceholder = $('image-placeholder')
const settingsModal    = $('settings-modal')
const syncDot          = $('sync-dot')
const syncLabel        = $('sync-label')
const keyDisplay       = $('key-display')
const importKeyInput   = $('import-key-input')
const sheetOverlay     = $('sheet-overlay')

// ---- Modal / sheet animation ----
// Elements start hidden (display:none). Open: remove hidden → double rAF → add is-open.
// Close: remove is-open → transitionend → add hidden.

function openModal(el) {
  el.classList.remove('hidden')
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')))
}

function closeModal(el, cb) {
  el.classList.remove('is-open')
  el.style.transform = ''
  el.style.transition = ''
  el.addEventListener('transitionend', () => {
    el.classList.add('hidden')
    cb?.()
  }, { once: true })
}

let activeSheet = null

function openSheet(el) {
  activeSheet = el
  openModal(el)
  sheetOverlay.classList.add('visible')
}

function closeSheet(el, cb) {
  if (activeSheet === el) activeSheet = null
  el.style.transform = ''
  el.style.transition = ''
  sheetOverlay.style.opacity = ''
  closeModal(el, cb)
  sheetOverlay.classList.remove('visible')
}

sheetOverlay.addEventListener('click', () => {
  if (activeSheet === addModal)      { closeAdd();      history.back() }
  else if (activeSheet === settingsModal) { closeSettings(); history.back() }
})

// ---- Wake Lock ----
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return
  try { wakeLock = await navigator.wakeLock.request('screen') } catch {}
}

function releaseWakeLock() {
  wakeLock?.release()
  wakeLock = null
}

// Re-acquire if tab becomes visible while card is open
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cardModal.classList.contains('is-open')) {
    acquireWakeLock()
  }
})

// ---- NOSTR event handler ----
let eventCount = 0
let renderTimer = null

function scheduleRender() {
  clearTimeout(renderTimer)
  renderTimer = setTimeout(renderCards, 60)
}

function onNostrEvent(event) {
  eventCount++
  setSyncStatus('connected', `Syncing… (${eventCount})`)
  const dTag    = event.tags.find(t => t[0] === 'd')?.[1]
  const name    = event.tags.find(t => t[0] === 'name')?.[1] || 'Card'
  const deleted = event.tags.find(t => t[0] === 'deleted')?.[1] === 'true'
  if (!dTag) return

  if (deleted || !event.content) {
    const i = cards.findIndex(c => c.id === dTag)
    if (i !== -1) { cards.splice(i, 1); removeCard(dTag); scheduleRender() }
    return
  }

  const existing = cards.find(c => c.id === dTag)
  if (existing) {
    if (event.created_at > (existing.created_at || 0)) {
      existing.name = name
      existing.image = event.content
      existing.created_at = event.created_at
      saveCard(existing)
      scheduleRender()
    }
  } else {
    const card = { id: dTag, name, image: event.content, created_at: event.created_at }
    cards.push(card)
    saveCard(card)
    scheduleRender()
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
  const frag = document.createDocumentFragment()
  cards
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(card => {
      const el = document.createElement('div')
      el.className = 'card-item'
      el.innerHTML = `
        <img class="card-thumb" src="${card.image}" alt="${card.name}" loading="lazy" decoding="async">
        <div class="card-label">${card.name}</div>
      `
      el.addEventListener('click', () => openCard(card))
      frag.appendChild(el)
    })
  cardGrid.appendChild(frag)
}

// ---- Card view ----
let cardRotated = false
let cardZoom = 1
let cardTx = 0
let cardTy = 0

function applyCardTransform() {
  const t = (cardTx || cardTy) ? `translate(${cardTx}px, ${cardTy}px) ` : ''
  if (cardRotated) {
    cardImg.style.transform = `${t}rotate(90deg) scale(${0.75 * cardZoom})`
  } else if (cardZoom !== 1 || cardTx || cardTy) {
    cardImg.style.transform = `${t}scale(${cardZoom})`
  } else {
    cardImg.style.transform = ''
  }
}

function resetCardTransform(animate) {
  cardRotated = false
  cardZoom = 1
  cardTx = 0
  cardTy = 0
  if (animate) {
    cardImg.classList.add('settling')
    cardImg.style.transform = ''
    cardImg.addEventListener('transitionend', () => cardImg.classList.remove('settling'), { once: true })
  } else {
    cardImg.classList.remove('settling')
    cardImg.style.transform = ''
  }
}

function openCard(card) {
  activeCard = card
  cardName.textContent = card.name
  cardImg.src = card.image
  resetCardTransform(false)
  openModal(cardModal)
  history.pushState({ modal: 'card' }, '')
  acquireWakeLock()
}

function closeCard() {
  releaseWakeLock()
  closeModal(cardModal, () => {
    resetCardTransform(false)
    activeCard = null
  })
}

// ---- Swipe down the modal header to close card view ----
;(function initCardSwipe() {
  const header = cardModal.querySelector('.modal-header')
  let startY = 0

  header.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY
    cardModal.style.transition = 'none'
  }, { passive: true })

  header.addEventListener('touchmove', e => {
    const dy = Math.max(0, e.touches[0].clientY - startY)
    cardModal.style.transform = `translateY(${dy}px)`
  }, { passive: true })

  header.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - startY
    if (dy > 100) {
      closeCard()
      if (history.state?.modal === 'card') history.back()
    } else {
      cardModal.style.transition = ''
      cardModal.style.transform = ''
    }
  }, { passive: true })
})()

// ---- Pinch-to-zoom + pan on card image ----
;(function initPinchZoom() {
  let startDist = 0, startZoom = 1
  let panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0
  let panning = false

  cardImg.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault()
      panning = false
      cardImg.classList.remove('settling')
      startDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      )
      startZoom = cardZoom
    } else if (e.touches.length === 1 && cardZoom > 1) {
      e.preventDefault()
      panning = true
      panStartX = e.touches[0].clientX
      panStartY = e.touches[0].clientY
      panStartTx = cardTx
      panStartTy = cardTy
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
    } else if (e.touches.length === 1 && panning) {
      e.preventDefault()
      cardTx = panStartTx + (e.touches[0].clientX - panStartX)
      cardTy = panStartTy + (e.touches[0].clientY - panStartY)
      applyCardTransform()
    }
  }, { passive: false })

  cardImg.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      panning = false
      if (cardZoom < 1.1) resetCardTransform(true)
    } else if (e.touches.length === 1 && cardZoom > 1) {
      panning = true
      panStartX = e.touches[0].clientX
      panStartY = e.touches[0].clientY
      panStartTx = cardTx
      panStartTy = cardTy
    }
  })
})()

// ---- Tap image to rotate ----
cardImg.addEventListener('click', () => {
  cardRotated = !cardRotated
  cardZoom = 1
  cardTx = 0
  cardTy = 0
  cardImg.classList.add('settling')
  applyCardTransform()
  cardImg.addEventListener('transitionend', () => cardImg.classList.remove('settling'), { once: true })
})

// ---- Drag-to-dismiss for bottom sheets ----
function initSheetDrag(sheetEl, closeFn, historyModal) {
  const handle = sheetEl.querySelector('.sheet-handle')
  if (!handle) return
  let startY = 0
  let dragging = false

  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY
    dragging = true
    sheetEl.style.transition = 'none'
  }, { passive: true })

  handle.addEventListener('touchmove', e => {
    if (!dragging) return
    const dy = Math.max(0, e.touches[0].clientY - startY)
    sheetEl.style.transform = `translateY(${dy}px)`
    sheetOverlay.style.opacity = String(Math.max(0, (1 - dy / 200) * 0.55))
  }, { passive: true })

  handle.addEventListener('touchend', e => {
    if (!dragging) return
    dragging = false
    const dy = e.changedTouches[0].clientY - startY
    if (dy > 120) {
      closeFn()
      if (history.state?.modal === historyModal) history.back()
    } else {
      sheetEl.style.transition = ''
      sheetEl.style.transform = ''
      sheetOverlay.style.opacity = ''
    }
  }, { passive: true })
}

// ---- Add card ----
function openAdd() {
  nameInput.value = ''
  previewImg.src = ''
  previewImg.classList.add('hidden')
  imagePlaceholder.classList.remove('hidden')
  pendingImage = null
  addSaveBtn.disabled = false
  addSaveBtn.textContent = 'Save'
  openSheet(addModal)
  history.pushState({ modal: 'add' }, '')
  setTimeout(() => nameInput.focus(), 420)
}

function closeAdd() {
  closeSheet(addModal)
}

async function handleFile(file) {
  if (!file) return
  addSaveBtn.disabled = true
  addSaveBtn.textContent = 'Processing…'
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
  addSaveBtn.textContent = 'Saving…'

  const id = crypto.randomUUID()
  const card = { id, name, image: pendingImage, created_at: Math.floor(Date.now() / 1000) }

  cards.push(card)
  await saveCard(card)
  renderCards()
  closeAdd()
  if (history.state?.modal === 'add') history.back()

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
  openSheet(settingsModal)
  history.pushState({ modal: 'settings' }, '')
}

function closeSettings() {
  closeSheet(settingsModal)
}

function setSyncStatus(state, text) {
  syncDot.className = state
  syncLabel.textContent = text
}

// ---- QR display ----
async function openQRDisplay() {
  const dataUrl = await generateQRDataUrl(getNsec())
  $('qr-img').src = dataUrl
  openModal($('qr-modal'))
  history.pushState({ modal: 'qr' }, '')
}

function closeQRDisplay() {
  closeModal($('qr-modal'))
}

// ---- QR scanner ----
let activeScanner = null

function openQRScanner() {
  const modal   = $('scan-modal')
  const viewport = $('scan-viewport')
  const status  = $('scan-status')

  openModal(modal)
  history.pushState({ modal: 'scan' }, '')
  status.textContent = 'Starting camera…'

  activeScanner = startScanner(
    data => {
      if (!data.startsWith('nsec1')) {
        status.textContent = 'Not a valid key QR — try again'
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
  closeModal($('scan-modal'))
}

function applyImportedKey(nsec) {
  if (importNsec(nsec)) {
    setSyncStatus('connected', 'Key imported — reloading…')
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

  setSyncStatus('', 'Connecting…')
  try {
    connect(
      onNostrEvent,
      () => setSyncStatus('connected', eventCount > 0 ? `Synced (${eventCount})` : 'Connected')
    )
    setSyncStatus('connected', 'Fetching…')
  } catch (e) {
    setSyncStatus('error', 'Offline')
    console.warn('NOSTR connect failed:', e)
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  }

  initSheetDrag(addModal, closeAdd, 'add')
  initSheetDrag(settingsModal, closeSettings, 'settings')
}

// ---- Event wiring ----
$('add-btn').addEventListener('click', openAdd)

$('card-back-btn').addEventListener('click', () => { closeCard(); history.back() })
$('card-delete-btn').addEventListener('click', deleteActiveCard)

$('add-back-btn').addEventListener('click', () => { closeAdd(); history.back() })
addSaveBtn.addEventListener('click', saveNewCard)
$('camera-btn').addEventListener('click', () => $('camera-input').click())
$('upload-btn').addEventListener('click', () => $('file-input').click())
$('camera-input').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value = '' })
$('file-input').addEventListener('change',  e => { handleFile(e.target.files[0]); e.target.value = '' })

document.querySelectorAll('.pick').forEach(btn => {
  btn.addEventListener('click', () => {
    nameInput.value = btn.dataset.name
    nameInput.focus()
  })
})

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
  if (cards.length === 0) {
    btn.textContent = 'No cards to push'
    setTimeout(() => { btn.textContent = '↑ Push local cards to NOSTR' }, 2000)
    return
  }
  btn.disabled = true
  btn.textContent = `Pushing 0 / ${cards.length}…`
  let ok = 0, fail = 0
  for (const card of cards) {
    try { await publishCard(card.id, card.name, card.image); ok++ }
    catch { fail++ }
    btn.textContent = `Pushing ${ok + fail} / ${cards.length}…`
  }
  btn.disabled = false
  btn.textContent = fail > 0
    ? `Done (${ok} pushed, ${fail} failed)`
    : `Done — ${ok} card${ok !== 1 ? 's' : ''} pushed`
  setTimeout(() => { btn.textContent = '↑ Push local cards to NOSTR' }, 4000)
})

$('refresh-btn').addEventListener('click', () => {
  setSyncStatus('', 'Re-fetching…')
  disconnect()
  cards = []
  getAllCards().then(local => {
    cards = local
    renderCards()
    connect(onNostrEvent, () => setSyncStatus('connected', 'Synced'))
  })
})

window.addEventListener('popstate', e => {
  const modal = e.state?.modal
  if      (modal === 'card'     && cardModal.classList.contains('is-open'))       closeCard()
  else if (modal === 'add'      && addModal.classList.contains('is-open'))        closeAdd()
  else if (modal === 'settings' && settingsModal.classList.contains('is-open'))   closeSettings()
  else if (modal === 'qr'       && $('qr-modal').classList.contains('is-open'))   closeQRDisplay()
  else if (modal === 'scan'     && $('scan-modal').classList.contains('is-open')) closeQRScanner()
})

init()
