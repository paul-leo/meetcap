/**
 * Canvas compositor: bakes the camera into the recorded video as a circular
 * picture-in-picture bubble. Used for WINDOW captures — a floating overlay
 * window is not part of the captured window's pixels, so the bubble has to be
 * composited into the stream itself. (Full-screen captures don't need this:
 * an on-screen overlay window is simply filmed by the capture.)
 */

export interface CameraBubbleOptions {
  /** Corner for the bubble. Default 'bottom-left'. */
  position?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
  /** Bubble diameter as a fraction of the shorter video edge. Default 0.22. */
  sizeRatio?: number
  /** Output frame rate. Default 30. */
  frameRate?: number
}

export interface CompositeHandle {
  /** The composited video track — screen with the camera bubble drawn in. */
  track: MediaStreamTrack
  /** Stop drawing and release the canvas track (source tracks are NOT stopped). */
  stop(): void
}

async function playTrack(track: MediaStreamTrack): Promise<HTMLVideoElement> {
  const v = document.createElement('video')
  v.srcObject = new MediaStream([track])
  v.muted = true
  v.playsInline = true
  await v.play()
  return v
}

/**
 * Draw `screen` continuously onto a canvas with `camera` as a corner bubble
 * and return the canvas capture track. Runs on a timer (not rAF) so the
 * recording keeps flowing even when the host window is hidden or occluded.
 */
export async function createCameraBubbleTrack(
  screen: MediaStreamTrack,
  camera: MediaStreamTrack,
  options: CameraBubbleOptions = {},
): Promise<CompositeHandle> {
  const { position = 'bottom-left', sizeRatio = 0.22, frameRate = 30 } = options
  const [screenEl, cameraEl] = await Promise.all([playTrack(screen), playTrack(camera)])

  const canvas = document.createElement('canvas')
  const settings = screen.getSettings()
  canvas.width = settings.width || screenEl.videoWidth || 1920
  canvas.height = settings.height || screenEl.videoHeight || 1080
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('meetcap: canvas 2d context unavailable')

  const draw = () => {
    // Window captures resize when the window does — follow the source.
    if (screenEl.videoWidth && (screenEl.videoWidth !== canvas.width || screenEl.videoHeight !== canvas.height)) {
      canvas.width = screenEl.videoWidth
      canvas.height = screenEl.videoHeight
    }
    const { width: w, height: h } = canvas
    ctx.drawImage(screenEl, 0, 0, w, h)

    const cw = cameraEl.videoWidth
    const ch = cameraEl.videoHeight
    if (!cw || !ch) return
    const d = Math.round(Math.min(w, h) * sizeRatio)
    const margin = Math.round(d * 0.18)
    const x = position.endsWith('left') ? margin : w - d - margin
    const y = position.startsWith('top') ? margin : h - d - margin

    // cover-crop the camera into a circle
    const scale = Math.max(d / cw, d / ch)
    const sw = d / scale
    const sh = d / scale
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(cameraEl, (cw - sw) / 2, (ch - sh) / 2, sw, sh, x, y, d, d)
    ctx.restore()
    ctx.beginPath()
    ctx.arc(x + d / 2, y + d / 2, d / 2 - 1, 0, Math.PI * 2)
    ctx.lineWidth = Math.max(2, Math.round(d * 0.02))
    ctx.strokeStyle = 'rgba(255,255,255,.85)'
    ctx.stroke()
  }

  draw()
  const interval = setInterval(draw, Math.round(1000 / frameRate))
  const stream = canvas.captureStream(frameRate)
  const track = stream.getVideoTracks()[0]

  const stop = () => {
    clearInterval(interval)
    track.stop()
    screenEl.srcObject = null
    cameraEl.srcObject = null
  }
  // If the source window closes mid-recording the screen track ends — end the
  // composited track the same way so the recorder's onended handling kicks in.
  screen.addEventListener('ended', () => {
    clearInterval(interval)
    track.stop()
  })

  return { track, stop }
}
