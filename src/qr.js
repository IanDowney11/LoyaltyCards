import QRCode from 'qrcode'
import jsQR from 'jsqr'

export async function generateQRDataUrl(text) {
  return QRCode.toDataURL(text, {
    width: 280,
    margin: 2,
    color: { dark: '#1a1a2e', light: '#e0e0ff' },
    errorCorrectionLevel: 'M',
  })
}

// Starts camera scanning. Returns { video, stop }.
// onDetected(data) called once when a QR code is found.
// onError(err) called if camera access fails.
export function startScanner(onDetected, onError) {
  const video = document.createElement('video')
  video.setAttribute('playsinline', '')  // required on iOS
  video.muted = true

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  let animFrame = null
  let stream = null
  let stopped = false

  function stop() {
    stopped = true
    if (animFrame) cancelAnimationFrame(animFrame)
    if (stream) stream.getTracks().forEach(t => t.stop())
    animFrame = null
    stream = null
  }

  function tick() {
    if (stopped) return
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      })
      if (code?.data) {
        stop()
        onDetected(code.data)
        return
      }
    }
    animFrame = requestAnimationFrame(tick)
  }

  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: 'environment' } })
    .then(s => {
      if (stopped) { s.getTracks().forEach(t => t.stop()); return }
      stream = s
      video.srcObject = stream
      video.play().then(() => { animFrame = requestAnimationFrame(tick) })
    })
    .catch(onError)

  return { video, stop }
}
