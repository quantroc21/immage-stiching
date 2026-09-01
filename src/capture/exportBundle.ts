import type { CapturedPhoto } from './types'

export const GEMINI_PROMPT = `BẠN LÀ CHUYÊN GIA PHỤC CHẾ HÌNH ẢNH 360° (PIXEL-ACCURATE RESTORATION EXPERT).

Tôi gửi 2 ảnh:
- [ẢNH 00] '00_panorama_base.jpg': Ảnh ghép 360° bị lỗi rách mối nối, nhòe và bóng ma (ghosting).
- [ẢNH 01] '01_tat_ca_goc_chup_grid.jpg': BẢN ĐỒ THỰC TẾ GỐC (GROUND TRUTH) gồm các góc chụp thực tế được đánh số #1 đến #[N].

NHIỆM VỤ PHỤC CHẾ (CHỈ THỰC HIỆN 3 VIỆC NÀY):
1. KHÔI PHỤC ĐỒ VẬT BỊ RÁCH / BỊ CẮT ĐÔI / GHOSTING:
   - Tham chiếu đối chiếu từng đồ vật từ [ẢNH 01] để khôi phục lại phần bị rách hoặc nhòe trên [ẢNH 00] (bàn làm việc, ghế xoay, tủ gỗ, đệm nằm, quạt, tranh, đồ đạc trên bàn, người).
   - Giữ nguyên 100% hình dạng, màu sắc thật từ [ẢNH 01]. TUYỆT ĐỐI KHÔNG vẽ thêm hình Doraemon, logo hoạt hình hay chi tiết lạ.

2. KHỬ NHÒE VÀ LÀM PHẲNG SÀN / TRẦN:
   - Làm liền mạch các đường chỉ ron gạch sàn nhà và mép trần nhà bị gãy khúc, khử hoàn toàn vệt kéo dệt mờ.
   - Cứu lại chi tiết khung cửa sổ/rèm cửa bị lóa sáng.

3. NGUYÊN TẮC ZERO-HALLUCINATION (BẮT BUỘC TUÂN THỦ 100%):
   - Mọi đồ vật xuất hiện trong ảnh đầu ra PHẢI CÓ THẬT trong [ẢNH 01].
   - TUYỆT ĐỐI KHÔNG tự ý sáng tạo hay bịa thêm bất kỳ đồ vật mới nào.

XUẤT BẢN: Trả về ảnh 360° Panorama Equirectangular (tỉ lệ 2:1), sắc nét, trung thực tuyệt đối với căn phòng thật.`

/**
 * Renders all captured photos into a single high-resolution Contact Sheet (All-Angles Grid).
 * This allows uploading just ONE overview image to Gemini instead of hitting the 10-image limit!
 */
export async function generateContactSheet(photos: CapturedPhoto[]): Promise<Blob> {
  const n = photos.length
  if (n === 0) throw new Error('Không có ảnh để tạo bảng tổng hợp')

  // Calculate grid layout
  const cols = n <= 6 ? 3 : n <= 9 ? 3 : n <= 12 ? 4 : n <= 16 ? 4 : 5
  const rows = Math.ceil(n / cols)

  const canvasWidth = 3840
  const headerHeight = 160
  const padding = 20
  const cellWidth = Math.floor((canvasWidth - padding * (cols + 1)) / cols)
  const cellHeight = Math.floor(cellWidth * 1.33) // ~3:4 aspect per cell
  const canvasHeight = headerHeight + rows * cellHeight + (rows + 1) * padding

  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không thể tạo 2D context')

  // 1. Dark background
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)

  // 2. Header
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 52px system-ui, -apple-system, sans-serif'
  ctx.fillText(`📷 BẢN ĐỒ ${n} GÓC CHỤP CHI TIẾT CĂN PHÒNG`, padding + 10, 80)

  ctx.fillStyle = '#a3a3a3'
  ctx.font = '32px system-ui, -apple-system, sans-serif'
  ctx.fillText(
    `Tham chiếu các ô ảnh đánh số từ #1 đến #${n} để sửa lỗi ghép cho ảnh 360° (Equirectangular)`,
    padding + 10,
    130,
  )

  // 3. Load and draw each photo into its cell
  for (let i = 0; i < n; i++) {
    const p = photos[i]
    const col = i % cols
    const row = Math.floor(i / cols)

    const x = padding + col * (cellWidth + padding)
    const y = headerHeight + padding + row * (cellHeight + padding)

    // Cell card background
    ctx.fillStyle = '#171717'
    ctx.beginPath()
    ctx.roundRect(x, y, cellWidth, cellHeight, 16)
    ctx.fill()

    // Load photo
    const img = await createImageBitmap(p.blob)

    // Calculate crop to fit cell (leaving space for bottom label)
    const labelHeight = 60
    const imgAreaHeight = cellHeight - labelHeight
    const scale = Math.max(cellWidth / img.width, imgAreaHeight / img.height)
    const sw = cellWidth / scale
    const sh = imgAreaHeight / scale
    const sx = (img.width - sw) / 2
    const sy = (img.height - sh) / 2

    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, cellWidth, imgAreaHeight, [16, 16, 0, 0])
    ctx.clip()
    ctx.drawImage(img, sx, sy, sw, sh, x, y, cellWidth, imgAreaHeight)
    ctx.restore()
    img.close()

    // Number Badge (Top-Left)
    ctx.fillStyle = 'rgba(16, 185, 129, 0.95)'
    ctx.beginPath()
    ctx.roundRect(x + 16, y + 16, 64, 48, 12)
    ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 30px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`#${i + 1}`, x + 48, y + 40)

    // Subtitle label (Bottom)
    const pitchLabel =
      p.pitchDeg > 20 ? 'Trần (Zenith)' : p.pitchDeg < -20 ? 'Sàn (Nadir)' : 'Tầm mắt (Eye Level)'
    ctx.fillStyle = '#e5e5e5'
    ctx.font = 'bold 26px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      `#${i + 1} · Yaw ${Math.round(p.yawDeg)}° · ${pitchLabel}`,
      x + 16,
      y + imgAreaHeight + labelHeight / 2,
    )
  }

  // 4. Convert canvas to JPEG Blob
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Không tạo được blob từ canvas'))
      },
      'image/jpeg',
      0.92,
    )
  })
}

/**
 * Exports just 2 images:
 * 1. 00_panorama_base.jpg (Stitched 360 base)
 * 2. 01_tat_ca_goc_chup_grid.jpg (Collage of all raw photos)
 * This allows 100% compliance with Gemini's upload limit!
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

  // 2. Generate single contact sheet grid containing ALL raw photos
  if (photos.length > 0) {
    const gridBlob = await generateContactSheet(photos)
    imageFiles.push(new File([gridBlob], '01_tat_ca_goc_chup_grid.jpg', { type: 'image/jpeg' }))
  }

  // 3. Mobile Native Share Sheet (Allows saving the 2 images directly to Camera Roll on iPhone)
  if (typeof navigator !== 'undefined' && navigator.canShare) {
    if (navigator.canShare({ files: imageFiles })) {
      try {
        await navigator.share({
          files: imageFiles,
          title: `Gói 2 ảnh 360° gửi Gemini (${photos.length} góc chụp)`,
        })
        return { sharedCount: imageFiles.length }
      } catch {
        // User cancelled or share dismissed
      }
    }
  }

  // 4. Fallback for desktop: download the 2 images directly
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
