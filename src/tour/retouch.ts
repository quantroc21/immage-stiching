import { patchMatchFill } from './patchMatch'

/**
 * Sửa tay trên tấm toàn cảnh đã ghép.
 *
 * Ba việc, đều chạy trên đúng vùng người dùng tô, không đụng phần còn lại:
 * làm mịn, làm rõ, và xoá vật.
 *
 * Xoá vật không bịa pixel. Nó đi tìm một chỗ KHÁC trong chính bức ảnh trông
 * giống viền quanh vùng bị xoá nhất, rồi dời mảng đó về đắp vào. Với tường,
 * sàn gạch, trần nhà -- gần như mọi thứ quanh một vật cần xoá trong phòng --
 * bức ảnh luôn có sẵn một mảng y hệt ở chỗ khác, nên kết quả là hoạ tiết thật
 * chứ không phải vệt nhoè. Đây cũng là lý do không cần tới AI tạo sinh, thứ đã
 * bị loại vì bịa chi tiết không có thật.
 */

export type RetouchTool = 'erase' | 'smooth' | 'sharpen'

/** Mặt nạ vùng cần sửa, cùng kích thước với ảnh, 0..255. */
export type Mask = Uint8Array

/** Làm mềm mép mặt nạ để chỗ sửa hoà vào phần không sửa. */
function featherMask(mask: Mask, w: number, h: number, radius: number): Float32Array {
  const out = new Float32Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] / 255
  const tmp = new Float32Array(mask.length)
  const passes = Math.max(1, Math.round(radius / 3))
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        const l = out[row + (x === 0 ? w - 1 : x - 1)]
        const r = out[row + (x === w - 1 ? 0 : x + 1)]
        tmp[row + x] = (l + 2 * out[row + x] + r) / 4
      }
    }
    for (let y = 0; y < h; y++) {
      const up = Math.max(0, y - 1) * w
      const dn = Math.min(h - 1, y + 1) * w
      const row = y * w
      for (let x = 0; x < w; x++) out[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x]) / 4
    }
  }
  return out
}

/** Hộp bao quanh vùng đã tô, nới thêm `pad`. Trả null nếu không tô gì. */
function maskBounds(mask: Mask, w: number, h: number, pad: number) {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  return {
    x0: Math.max(0, x0 - pad),
    y0: Math.max(0, y0 - pad),
    x1: Math.min(w - 1, x1 + pad),
    y1: Math.min(h - 1, y1 + pad),
  }
}

function blurRegion(data: Uint8ClampedArray, w: number, h: number, weight: Float32Array, passes: number) {
  const src = new Float32Array(3)
  const copy = new Uint8ClampedArray(data)
  for (let p = 0; p < passes; p++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const a = weight[i]
        if (a <= 0.002) continue
        const xl = x === 0 ? w - 1 : x - 1
        const xr = x === w - 1 ? 0 : x + 1
        for (let c = 0; c < 3; c++) {
          src[c] =
            (copy[((y - 1) * w + x) * 4 + c] +
              copy[((y + 1) * w + x) * 4 + c] +
              copy[(y * w + xl) * 4 + c] +
              copy[(y * w + xr) * 4 + c] +
              4 * copy[i * 4 + c]) /
            8
        }
        for (let c = 0; c < 3; c++) data[i * 4 + c] = copy[i * 4 + c] * (1 - a) + src[c] * a
      }
    }
    copy.set(data)
  }
}

function sharpenRegion(data: Uint8ClampedArray, w: number, h: number, weight: Float32Array, amount: number) {
  const copy = new Uint8ClampedArray(data)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const a = weight[i]
      if (a <= 0.002) continue
      const xl = x === 0 ? w - 1 : x - 1
      const xr = x === w - 1 ? 0 : x + 1
      for (let c = 0; c < 3; c++) {
        const centre = copy[i * 4 + c]
        const around =
          (copy[((y - 1) * w + x) * 4 + c] +
            copy[((y + 1) * w + x) * 4 + c] +
            copy[(y * w + xl) * 4 + c] +
            copy[(y * w + xr) * 4 + c]) /
          4
        const boosted = centre + (centre - around) * amount
        data[i * 4 + c] = centre * (1 - a) + boosted * a
      }
    }
  }
}

/**
 * Xoá vật bằng PatchMatch, chạy trên đúng khung bao quanh vùng tô chứ không
 * phải cả bức 4096x2048 -- ngoài khung đó không có gì thay đổi, mà thu hẹp
 * lại thì nhanh hơn hàng chục lần.
 *
 * Khung được nới rộng gấp rưỡi bán kính vùng tô để thuật toán có đủ tường, đủ
 * sàn xung quanh mà mượn.
 */
function inpaintRegion(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  mask: Mask,
  weight: Float32Array,
  bounds: { x0: number; y0: number; x1: number; y1: number },
) {
  const mw = bounds.x1 - bounds.x0 + 1
  const mh = bounds.y1 - bounds.y0 + 1
  const pad = Math.round(Math.max(mw, mh) * 0.75) + 24
  const x0 = bounds.x0 - pad
  const y0 = Math.max(0, bounds.y0 - pad)
  const y1 = Math.min(h - 1, bounds.y1 + pad)
  const rw = mw + pad * 2
  const rh = y1 - y0 + 1
  if (rw < 32 || rh < 32) return

  const rgb = new Float32Array(rw * rh * 3)
  const hole = new Uint8Array(rw * rh)
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const sx = ((x0 + x) % w + w) % w
      const si = (y0 + y) * w + sx
      const di = y * rw + x
      rgb[di * 3] = data[si * 4]
      rgb[di * 3 + 1] = data[si * 4 + 1]
      rgb[di * 3 + 2] = data[si * 4 + 2]
      hole[di] = mask[si] ? 1 : 0
    }
  }

  patchMatchFill(rgb, hole, rw, rh)

  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const sx = ((x0 + x) % w + w) % w
      const di = (y0 + y) * w + sx
      const a = weight[di]
      if (a <= 0.002) continue
      const si = (y * rw + x) * 3
      for (let c = 0; c < 3; c++) data[di * 4 + c] = data[di * 4 + c] * (1 - a) + rgb[si + c] * a
    }
  }
}

/** Áp một nét tô lên ảnh. Sửa `image` tại chỗ. */
export function applyRetouch(image: ImageData, mask: Mask, tool: RetouchTool, featherPx = 12): boolean {
  const { width: w, height: h, data } = image
  const bounds = maskBounds(mask, w, h, Math.round(featherPx * 2 + 4))
  if (!bounds) return false
  const weight = featherMask(mask, w, h, featherPx)
  if (tool === 'smooth') blurRegion(data, w, h, weight, 3)
  else if (tool === 'sharpen') sharpenRegion(data, w, h, weight, 1.1)
  else inpaintRegion(data, w, h, mask, weight, bounds)
  return true
}
