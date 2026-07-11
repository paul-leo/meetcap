// meetcap Recorder — visual screen/window picker (its own frameless window).
// Two tabs (Screens / Windows) of live thumbnails; resolves the choice back to
// the bar via recorderApp.pickerDone().

const $ = (id: string) => document.getElementById(id) as HTMLElement

let tab: 'screen' | 'window' = 'screen'
let selected: string | null = new URLSearchParams(location.search).get('current')
if (selected?.startsWith('window:')) tab = 'window'
let sources: CaptureSource[] = []

const done = (r: PickResult | null) => window.recorderApp.pickerDone(r)
const current = () => sources.find((s) => s.id === selected) ?? null

function confirm() {
  const c = current()
  if (c) done({ sourceId: c.id, label: c.name })
}

function renderTabs() {
  $('tab-screen').classList.toggle('active', tab === 'screen')
  $('tab-window').classList.toggle('active', tab === 'window')
}

function renderGrid() {
  const grid = $('grid')
  const items = sources.filter((s) => s.kind === tab)
  grid.classList.toggle('screens', tab === 'screen')
  grid.innerHTML = ''
  if (items.length === 0) {
    grid.innerHTML = `<div class="none" style="grid-column: 1 / -1">No ${tab === 'screen' ? 'screens' : 'windows'} available</div>`
    return
  }
  for (const s of items) {
    const card = document.createElement('button')
    card.className = 'card' + (s.id === selected ? ' selected' : '')
    const thumb = s.thumbnail ? `<img src="${s.thumbnail}" alt="" />` : '<span class="empty">No preview</span>'
    const icon = s.appIcon ? `<img src="${s.appIcon}" alt="" />` : ''
    const name = document.createElement('span')
    name.textContent = s.name
    card.innerHTML = `<div class="thumb">${thumb}</div><div class="label">${icon}</div>`
    card.title = s.name
    card.querySelector('.label')!.appendChild(name)
    card.onclick = () => {
      selected = s.id
      renderGrid()
      renderShare()
    }
    card.ondblclick = confirm
    grid.appendChild(card)
  }
}

function renderShare() {
  ;($('btn-share') as HTMLButtonElement).disabled = !current()
}

$('tab-screen').onclick = () => {
  tab = 'screen'
  renderTabs()
  renderGrid()
}
$('tab-window').onclick = () => {
  tab = 'window'
  renderTabs()
  renderGrid()
}
$('btn-cancel').onclick = () => done(null)
$('btn-share').onclick = confirm
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') done(null)
  if (e.key === 'Enter') confirm()
})

void (async () => {
  sources = await window.recorderApp.captureSources().catch(() => [])
  // Preselect: the bar's current source if still present, else the first screen.
  if (!current()) selected = sources.find((s) => s.kind === 'screen')?.id ?? null
  if (selected?.startsWith('window:')) tab = 'window'
  renderTabs()
  renderGrid()
  renderShare()
})()
