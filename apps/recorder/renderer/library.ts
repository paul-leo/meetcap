// Recordings window — on-demand list over the crash-safe save dir.
import { deleteRecording } from 'meetcap-renderer'

const $ = (id: string) => document.getElementById(id) as HTMLElement

const ICONS = {
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  finder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13"/></svg>',
}

function fmtSize(n: number) {
  return n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'
}
function fmtWhen(ms: number) {
  const d = Date.now() - ms
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return new Date(ms).toLocaleDateString()
}

async function refresh() {
  const items = await window.recorderApp.library()
  $('lib-count').textContent = items.length ? `(${items.length})` : ''
  const root = $('library')
  root.innerHTML = items.length ? '' : '<div class="empty">No recordings yet — hit record in the bar</div>'
  for (const it of items) {
    const div = document.createElement('div')
    div.className = 'item'
    div.innerHTML = `
      <div class="thumb">${ICONS.film}</div>
      <div class="meta">
        <div class="t" title="${it.name}">${it.name.replace(/\.webm$/, '')}</div>
        <div class="s">${fmtWhen(it.mtimeMs)} · ${fmtSize(it.size)}</div>
      </div>
      <div class="actions"></div>`
    const actions = div.querySelector('.actions') as HTMLElement
    const btn = (svg: string, cls: string, title: string, fn: () => void) => {
      const b = document.createElement('button')
      b.className = 'icon-btn ' + cls
      b.title = title
      b.innerHTML = svg
      b.onclick = fn
      actions.appendChild(b)
    }
    btn(ICONS.play, '', 'Play', () => {
      const media = document.createElement('video')
      media.controls = true
      media.src = `file://${it.filePath}`
      const player = $('player')
      player.innerHTML = ''
      player.appendChild(media)
    })
    btn(ICONS.finder, '', 'Show in Finder', () => void window.recorderApp.reveal(it.filePath))
    btn(ICONS.trash, 'danger', 'Delete', async () => {
      await deleteRecording(it.filePath)
      $('player').innerHTML = ''
      void refresh()
    })
    root.appendChild(div)
  }
}

window.recorderApp.onLibraryUpdated(() => void refresh())
$('btn-open-folder').onclick = () => void window.recorderApp.openFolder()
void refresh()
