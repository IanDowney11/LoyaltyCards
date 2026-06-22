const MAX_WIDTH = 900
const TARGET_BYTES = 28 * 1024 // 28KB binary → ~38KB base64 — safely under all relay limits

export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img
      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width)
        width = MAX_WIDTH
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)

      // Try progressively lower quality until we hit the target size
      const qualities = [0.85, 0.7, 0.55, 0.4, 0.3]
      let idx = 0

      const tryQuality = () => {
        const q = qualities[idx++]
        canvas.toBlob(
          blob => {
            if (!blob) { reject(new Error('Canvas toBlob failed')); return }
            if (blob.size <= TARGET_BYTES || idx >= qualities.length) {
              const reader = new FileReader()
              reader.onload = () => resolve(reader.result)
              reader.readAsDataURL(blob)
            } else {
              tryQuality()
            }
          },
          'image/jpeg',
          q
        )
      }

      tryQuality()
    }

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}
