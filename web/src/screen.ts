/**
 * "Show BitBull a window": the browser's own screen-share picker, a still of the window you pick,
 * attached to your message as a PNG. While you keep sharing, every message you send carries a
 * fresh picture of it. Nothing is recorded or sent anywhere else: the frames go up as ordinary
 * attachments to this chat, and only when you send.
 */

/** Big enough to read text, small enough not to waste a vision model's tokens. */
const MAX_W = 1920

export class WindowShare {
  private video: HTMLVideoElement
  private stream: MediaStream
  readonly label: string
  private ended = false
  onEnd?: () => void

  private constructor(stream: MediaStream) {
    this.stream = stream
    const track = stream.getVideoTracks()[0]
    this.label = track?.label || 'the shared window'
    track?.addEventListener('ended', () => {
      // "Stop sharing" in the browser bar
      this.ended = true
      this.onEnd?.()
    })
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
    this.video.srcObject = stream
  }

  static supported() {
    return !!navigator.mediaDevices?.getDisplayMedia
  }

  /** Opens the browser's picker (a window is suggested; a tab or the screen works too). */
  static async start(): Promise<WindowShare> {
    if (!WindowShare.supported()) throw new Error('This browser can’t share a window (it needs a recent Chrome, Edge or the BitBull app).')
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'window', frameRate: 5 } as MediaTrackConstraints,
      audio: false,
    })
    const s = new WindowShare(stream)
    await s.video.play()
    return s
  }

  get active() {
    return !this.ended && this.stream.getVideoTracks().some((t) => t.readyState === 'live')
  }

  /** The window as it is now, as a PNG file. */
  async frame(): Promise<File> {
    if (!this.active) throw new Error('The window is no longer shared')
    const v = this.video
    if (!v.videoWidth) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }))
    // one more frame, so a window that just changed is shown as it is now
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    const scale = Math.min(1, MAX_W / v.videoWidth)
    const c = document.createElement('canvas')
    c.width = Math.round(v.videoWidth * scale)
    c.height = Math.round(v.videoHeight * scale)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
    if (!blob) throw new Error('Could not take a picture of the window')
    const name = this.label.replace(/[^\w .-]+/g, ' ').trim().slice(0, 40) || 'window'
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
    return new File([blob], `${name}-${stamp}.png`, { type: 'image/png' })
  }

  stop() {
    this.ended = true
    this.stream.getTracks().forEach((t) => t.stop())
    this.video.srcObject = null
  }
}

/** A page sent by the browser extension, turned into the two files it is attached as. */
export function captureFiles(c: { url: string; title: string; screenshot?: string; summary: string }): File[] {
  let host = 'page'
  try {
    host = new URL(c.url).host || host
  } catch {
    /* keep "page" */
  }
  const base = `${host}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`.replace(/[^\w.-]+/g, '-')
  const files = [new File([c.summary], `${base}.md`, { type: 'text/markdown' })]
  if (c.screenshot) {
    const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(c.screenshot)
    if (m) {
      const bin = atob(m[2])
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      files.unshift(new File([bytes], `${base}.${m[1] === 'image/png' ? 'png' : 'jpg'}`, { type: m[1] }))
    }
  }
  return files
}
