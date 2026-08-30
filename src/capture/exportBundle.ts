import { zipSync, strToU8 } from 'fflate'
import type { CapturedPhoto } from './types'

export const GEMINI_PROMPT = `Tôi gửi cho bạn:
1. Bộ ảnh gốc chụp 360° theo vòng tròn xung quanh căn phòng (được đánh số theo thứ tự góc quay yaw/pitch).
2. Ảnh 'panorama_stitched_base.jpg' là ảnh ghép 360° equirectangular thô ban đầu (tỉ lệ 2:1).

Nhiệm vụ của bạn (Chuyên gia 360 VR Retouching & Seamless Inpainting):
1. Phân tích toàn bộ không gian phòng từ các góc chụp chi tiết đính kèm.
2. Sửa chữa ảnh panorama_stitched_base.jpg:
   - Xóa bỏ triệt để các vết bóng ma (ghosting), nối liền người hoặc đồ nội thất (bàn, ghế, giường, quạt, tranh) bị rách/cắt đôi bằng cách tham chiếu ảnh chụp gốc tương ứng.
   - Làm mịn và khử vệt kéo nhoè ở sàn nhà và trần nhà.
   - Cứu lại chi tiết bị lóa/cháy sáng ở cửa sổ hoặc rèm cửa.
   - Giữ nguyên cấu trúc thật 100% của căn phòng (không tự ý vẽ thêm đồ vật lạ).
3. Xuất ra ảnh 360 độ Panorama hoàn chỉnh (Equirectangular chuẩn tỉ lệ 2:1, sắc nét, liền mạch, không còn vết nối).`

/**
 * Creates and downloads/shares a ZIP bundle containing all raw captured shots,
 * the stitched base panorama, camera metadata, and the Gemini prompt.
 */
export async function downloadSourceBundle(
  photos: CapturedPhoto[],
  stitchedBlob: Blob | null,
  roomName = 'room',
): Promise<void> {
  const files: Record<string, Uint8Array> = {}

  // 1. Add PROMPT_CHO_GEMINI.txt
  files['PROMPT_CHO_GEMINI.txt'] = strToU8(GEMINI_PROMPT)

  // 2. Add metadata.json
  const metadata = {
    totalShots: photos.length,
    capturedAt: new Date().toISOString(),
    shots: photos.map((p, idx) => ({
      index: idx + 1,
      id: p.id,
      yawDeg: p.yawDeg,
      pitchDeg: p.pitchDeg,
      filename: `shot_${String(idx + 1).padStart(2, '0')}_yaw${Math.round(p.yawDeg)}_pitch${Math.round(p.pitchDeg)}.jpg`,
    })),
  }
  files['metadata.json'] = strToU8(JSON.stringify(metadata, null, 2))

  // 3. Add stitched base panorama if present
  if (stitchedBlob) {
    const buf = await stitchedBlob.arrayBuffer()
    files['panorama_stitched_base.jpg'] = new Uint8Array(buf)
  }

  // 4. Add each raw captured photo
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i]
    const buf = await p.blob.arrayBuffer()
    const filename = `shots/shot_${String(i + 1).padStart(2, '0')}_yaw${Math.round(p.yawDeg)}_pitch${Math.round(p.pitchDeg)}.jpg`
    files[filename] = new Uint8Array(buf)
  }

  // 5. Generate ZIP in memory
  const zipped = zipSync(files, { level: 6 })
  const zipBlob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
  const filename = `${roomName}_360_source_bundle.zip`

  // 6. Share or download
  if (typeof navigator !== 'undefined' && navigator.canShare) {
    const file = new File([zipBlob], filename, { type: 'application/zip' })
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: `Gói ảnh gốc 360° - ${roomName}`,
        })
        return
      } catch {
        // Fallback to browser download if user cancels/dismisses native share
      }
    }
  }

  const url = URL.createObjectURL(zipBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
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
