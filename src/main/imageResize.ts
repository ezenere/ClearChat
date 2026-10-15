// Redução de imagens para o read_file (tools/media.ts) com o nativeImage do Electron.
// Separado de media.ts para manter as tools testáveis no Node (sem Electron).
// nativeImage decodifica PNG/JPEG em todas as plataformas (outros formatos dependem do SO: no
// Linux, GIF/WebP grandes não reduzem → erro legível no read_file).
import type { NativeImage } from 'electron'
import type { ImageProcessor, ProcessedImage } from './tools/media'

type Factory = { createFromBuffer(b: Buffer): NativeImage }

/**
 * Lado maior ≤ maxSide (mantém a proporção); PNG se couber em maxBytes, senão JPEG (85 → 70 → 55);
 * ainda grande → reduz 25% e tenta de novo (até 6 vezes).
 */
export function nativeImageProcessor(factory: Factory): ImageProcessor {
  return (data, _mime, { maxSide, maxBytes }) => {
    const img = factory.createFromBuffer(Buffer.from(data))
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    if (!width || !height) return null
    let scale = Math.min(1, maxSide / Math.max(width, height))
    for (let attempt = 0; attempt < 6; attempt++) {
      const w = Math.max(1, Math.floor(width * scale))
      const h = Math.max(1, Math.floor(height * scale))
      const r = scale < 1 ? img.resize({ width: w, height: h, quality: 'best' }) : img
      const png = r.toPNG()
      const size = r.getSize()
      if (png.byteLength <= maxBytes) return out(png, 'image/png', size)
      for (const q of [85, 70, 55]) {
        const jpg = r.toJPEG(q)
        if (jpg.byteLength <= maxBytes) return out(jpg, 'image/jpeg', size)
      }
      scale *= 0.75
    }
    return null
  }
}

const out = (b: Buffer, mime: string, size: { width: number; height: number }): ProcessedImage => ({
  data: new Uint8Array(b),
  mime,
  width: size.width,
  height: size.height
})
