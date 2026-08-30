/**
 * Shrinks a panorama for the room strip.
 *
 * Without this the strip would point at the full 4096px panorama for every
 * room, so a visitor downloads the entire tour just to draw a row of
 * thumbnails. Equirectangular images are 2:1, and the strip crops to fill.
 */
const THUMB_WIDTH = 320
const THUMB_QUALITY = 0.72

export async function makeThumbnail(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_WIDTH
  canvas.height = Math.round(THUMB_WIDTH / 2)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không tạo được ảnh thu nhỏ')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Không tạo được ảnh thu nhỏ'))),
      'image/jpeg',
      THUMB_QUALITY,
    )
  })
}
