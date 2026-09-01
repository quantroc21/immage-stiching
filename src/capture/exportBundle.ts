import type { CapturedPhoto } from './types'

export const GEMINI_PROMPT = `Tôi gửi cho bạn:
1. Ảnh '00_panorama_base.jpg': là ảnh ghép 360° Panorama thô ban đầu (Equirectangular tỉ lệ 2:1).
2. Các ảnh chụp chi tiết từ 'shot_01.jpg' đến 'shot_18.jpg': là các góc chụp vòng quanh căn phòng.

Nhiệm vụ của bạn (Chuyên gia 360 VR Inpainting & Retouching):
1. Tham chiếu các ảnh chụp chi tiết để nắm rõ cấu trúc thật của căn phòng (nội thất, sàn gạch, trần nhà, cửa sổ).
2. Sửa lại bức ảnh 00_panorama_base.jpg:
   - Khử sạch các bóng ma (ghosting), nối liền các chỗ đồ vật/người bị rách hoặc méo bằng ảnh chụp chi tiết tương ứng.
   - Làm mịn và khử vệt kéo nhoè ở sàn nhà và trần nhà.
   - Cứu lại chi tiết bị lóa/cháy sáng ở cửa sổ và rèm cửa.
   - Giữ nguyên cấu trúc thật 100% của căn phòng (không tự ý chế thêm đồ vật lạ).
3. Xuất ra ảnh 360 Panorama hoàn chỉnh (Equirectangular chuẩn tỉ lệ 2:1, chất lượng cao, sắc nét, không còn vết ghép).`

/**
 * Exports all raw shots and the base panorama as direct JPEG image files.
 * On mobile (iOS / Android), this uses navigator.share() with File objects so
 * iOS Safari lets the user tap "Save N Images" directly into the Apple Photos app / Camera Roll!
 */
export async function saveAllImagesToDevice(
  photos: CapturedPhoto[],
  stitchedBlob: Blob | null,
): Promise<{ sharedCount: number }> {
  const imageFiles: File[] = []

  // 1. Base stitched panorama
  if (stitchedBlob) {
    imageFiles.push(new File([stitchedBlob], '00_panorama_base.jpg', { type: 'image/jpeg' }))
  }

  // 2. All raw captured photos
  photos.forEach((p, idx) => {
    const name = `shot_${String(idx + 1).padStart(2, '0')}_yaw${Math.round(p.yawDeg)}_pitch${Math.round(p.pitchDeg)}.jpg`
    imageFiles.push(new File([p.blob], name, { type: 'image/jpeg' }))
  })

  // 3. Mobile Native Share Sheet (Allows "Save N Images" to Camera Roll on iPhone)
  if (typeof navigator !== 'undefined' && navigator.canShare) {
    if (navigator.canShare({ files: imageFiles })) {
      try {
        await navigator.share({
          files: imageFiles,
          title: `Bộ ${imageFiles.length} ảnh 360° phòng`,
        })
        return { sharedCount: imageFiles.length }
      } catch {
        // User cancelled or share dismissed
      }
    }
  }

  // 4. Fallback for desktop / browsers that don't support multi-file share
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i]
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    await new Promise((r) => setTimeout(r, 120))
    URL.revokeObjectURL(url)
  }

  return { sharedCount: imageFiles.length }
}

/**
 * Copies the Gemini prompt to the user's clipboard.
 */
export async function copyGeminiPrompt(): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(GEMINI_PROMPT)
    return true
  } catch {
    return false
  }
}
