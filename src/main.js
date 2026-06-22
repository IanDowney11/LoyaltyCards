import { initKey, importNsec, getNsec, connect, disconnect, publishCard, tombstoneCard } from './nostr.js'
import { saveCard, removeCard, getAllCards } from './store.js'
import { compressImage } from './compress.js'

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
function onNostrEvent(event) {
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
function openCard(card) {
  activeCard = card
  cardName.textContent = card.name
  cardImg.src = card.image
  cardImg.classList.remove('rotated')
  cardModal.classList.remove('hidden')
  history.pushState({ modal: 'card' }, '')
}

function closeCard() {
  cardModal.classList.add('hidden')
  activeCard = null
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

// ---- Init ----
async function init() {
  initKey()

  cards = await getAllCards()
  renderCards()

  setSyncStatus('', 'Connecting...')
  try {
    connect(
      onNostrEvent,
      () => setSyncStatus('connected', 'Synced')
    )
    setSyncStatus('connected', 'Connected')
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
cardImg.addEventListener('click', () => cardImg.classList.toggle('rotated'))

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
  if (importNsec(val)) {
    disconnect()
    setSyncStatus('', 'Reconnecting...')
    keyDisplay.textContent = getNsec()
    cards = []
    renderCards()
    connect(
      onNostrEvent,
      () => setSyncStatus('connected', 'Synced')
    )
    setSyncStatus('connected', 'Connected — fetching cards...')
    importKeyInput.value = ''
  } else {
    alert('Invalid key. Please paste the full nsec1... key.')
  }
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
})

init()
