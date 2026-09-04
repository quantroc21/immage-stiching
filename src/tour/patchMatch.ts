/**
 * Lấp một vùng ảnh bằng PatchMatch — đúng thuật toán Photoshop dùng cho
 * Content-Aware Fill (Barnes và cộng sự, 2009).
 *
 * Cách cũ tôi tự nghĩ là dời NGUYÊN MỘT mảng lớn về đắp vào, nên kết quả là một
 * cái đĩa phẳng dán lên tường: cả vùng chỉ có một nguồn duy nhất, sai một chỗ là
 * sai cả mảng. PatchMatch khác hẳn ở chỗ MỖI PIXEL trong lỗ tự đi tìm mảng nhỏ
 * hợp với nó nhất, rồi giá trị cuối là trung bình của mọi mảng phủ lên nó. Nhờ
 * vậy chỗ giáp tường thì lấy tường, chỗ giáp sàn thì lấy sàn, và độ sáng chuyển
 * dần chứ không gãy thành một đường tròn.
 *
 * Ba bước lặp lại, đúng như bài báo:
 *   - gieo ngẫu nhiên một ánh xạ ban đầu
 *   - LAN TRUYỀN: thử ánh xạ của pixel bên trái và bên trên, vì các mảng tốt
 *     thường đi thành cụm
 *   - DÒ NGẪU NHIÊN: thử vài vị trí quanh ánh xạ hiện tại, bán kính giảm dần
 *
 * Chạy từ ảnh thu nhỏ lên ảnh gốc: ở mức thô thuật toán tìm được bố cục lớn,
 * mức mịn chỉ còn tinh chỉnh, nên vừa nhanh vừa không kẹt ở đáp án tồi.
 */

const PATCH = 7
const HALF = PATCH >> 1
/** Độ nhạy của trọng số bầu chọn, tính trên sai màu bình phương mỗi pixel. */
const SIGMA2 = 260

interface Level {
  w: number
  h: number
  rgb: Float32Array
  hole: Uint8Array
}

function buildLevel(rgb: Float32Array, hole: Uint8Array, w: number, h: number): Level {
  return { w, h, rgb, hole }
}

/** Thu nhỏ một nửa. Ô nào chạm lỗ thì coi như lỗ, để không lấy pixel rác. */
function downscale(l: Level): Level {
  const w = l.w >> 1
  const h = l.h >> 1
  const rgb = new Float32Array(w * h * 3)
  const hole = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      let holed = 0
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = (2 * y + dy) * l.w + (2 * x + dx)
          if (l.hole[si]) {
            holed = 1
            continue
          }
          r += l.rgb[si * 3]
          g += l.rgb[si * 3 + 1]
          b += l.rgb[si * 3 + 2]
          n++
        }
      }
      const i = y * w + x
      hole[i] = holed && n === 0 ? 1 : holed
      if (n > 0) {
        rgb[i * 3] = r / n
        rgb[i * 3 + 1] = g / n
        rgb[i * 3 + 2] = b / n
      }
    }
  }
  return { w, h, rgb, hole }
}

/**
 * Khoảng cách giữa hai mảng, CHỈ tính trên những pixel của mảng đích đã biết.
 *
 * Đây là điểm sống còn. Nếu tính cả pixel nằm trong lỗ thì thuật toán đang so
 * mảng nguồn với chính cái vật sắp xoá, nên nó đi tìm thứ GIỐNG cái vật đó --
 * bản đầu vì lỗi này mà cái balô bị thay bằng một khối tối nhoè thay vì mặt
 * băng ghế. Chuẩn hoá theo số pixel đếm được để mảng ở rìa lỗ, vốn có nhiều
 * pixel đã biết hơn, không bị thiệt.
 */
function patchDist(
  l: Level,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cutoff: number,
): number {
  let sum = 0
  let n = 0
  const { w, h, rgb, hole } = l
  for (let dy = -HALF; dy <= HALF; dy++) {
    const ayy = ay + dy
    const byy = by + dy
    if (ayy < 0 || ayy >= h || byy < 0 || byy >= h) return Infinity
    for (let dx = -HALF; dx <= HALF; dx++) {
      const axx = ((ax + dx) % w + w) % w
      const ai0 = ayy * w + axx
      if (hole[ai0]) continue
      const bxx = ((bx + dx) % w + w) % w
      const ai = ai0 * 3
      const bi = (byy * w + bxx) * 3
      const d0 = rgb[ai] - rgb[bi]
      const d1 = rgb[ai + 1] - rgb[bi + 1]
      const d2 = rgb[ai + 2] - rgb[bi + 2]
      sum += d0 * d0 + d1 * d1 + d2 * d2
      n++
    }
    if (n > 0 && sum / n >= cutoff) return sum / n
  }
  return n > 0 ? sum / n : Infinity
}

/** Nguồn hợp lệ: mảng 7x7 quanh nó không được chạm vào lỗ. */
function validSources(l: Level): Uint8Array {
  const ok = new Uint8Array(l.w * l.h)
  for (let y = HALF; y < l.h - HALF; y++) {
    for (let x = 0; x < l.w; x++) {
      let clean = 1
      for (let dy = -HALF; dy <= HALF && clean; dy++) {
        for (let dx = -HALF; dx <= HALF; dx++) {
          const xx = ((x + dx) % l.w + l.w) % l.w
          if (l.hole[(y + dy) * l.w + xx]) {
            clean = 0
            break
          }
        }
      }
      ok[y * l.w + x] = clean
    }
  }
  return ok
}

function solveLevel(l: Level, iterations: number, seedX?: Int32Array, seedY?: Int32Array) {
  const { w, h } = l
  const n = w * h
  const ok = validSources(l)
  const sources: number[] = []
  for (let i = 0; i < n; i++) if (ok[i]) sources.push(i)
  if (!sources.length) return { nnX: new Int32Array(n), nnY: new Int32Array(n) }

  const holes: number[] = []
  for (let i = 0; i < n; i++) if (l.hole[i]) holes.push(i)

  const nnX = new Int32Array(n)
  const nnY = new Int32Array(n)
  const dist = new Float64Array(n).fill(Infinity)

  // Gieo: mức thô gieo ngẫu nhiên, mức mịn thừa hưởng từ mức trên.
  for (const i of holes) {
    if (seedX && seedY) {
      nnX[i] = seedX[i]
      nnY[i] = seedY[i]
    } else {
      const s = sources[(Math.random() * sources.length) | 0]
      nnX[i] = s % w
      nnY[i] = (s / w) | 0
    }
    const y = (i / w) | 0
    dist[i] = patchDist(l, i % w, y, nnX[i], nnY[i], Infinity)
  }

  const maxSearch = Math.max(w, h)
  for (let it = 0; it < iterations; it++) {
    const forward = it % 2 === 0
    for (let k = 0; k < holes.length; k++) {
      const i = holes[forward ? k : holes.length - 1 - k]
      const y = (i / w) | 0
      const x = i - y * w
      const step = forward ? -1 : 1

      // Lan truyền từ hàng xóm ngang và dọc.
      for (const [ox, oy] of [[step, 0], [0, step]] as const) {
        const nx2 = x + ox
        const ny2 = y + oy
        if (ny2 < 0 || ny2 >= h) continue
        const ni = ny2 * w + ((nx2 % w + w) % w)
        if (!l.hole[ni] || dist[ni] === Infinity) continue
        const cx = nnX[ni] - ox
        const cy = nnY[ni] - oy
        if (cy < HALF || cy >= h - HALF) continue
        const cxw = ((cx % w) + w) % w
        if (!ok[cy * w + cxw]) continue
        const d = patchDist(l, x, y, cxw, cy, dist[i])
        if (d < dist[i]) {
          dist[i] = d
          nnX[i] = cxw
          nnY[i] = cy
        }
      }

      // Dò ngẫu nhiên, bán kính giảm một nửa mỗi lần.
      for (let radius = maxSearch; radius >= 1; radius >>= 1) {
        const cx = nnX[i] + ((Math.random() * 2 - 1) * radius) | 0
        const cy = nnY[i] + (((Math.random() * 2 - 1) * radius) | 0)
        if (cy < HALF || cy >= h - HALF) continue
        const cxw = ((cx % w) + w) % w
        if (!ok[cy * w + cxw]) continue
        const d = patchDist(l, x, y, cxw, cy, dist[i])
        if (d < dist[i]) {
          dist[i] = d
          nnX[i] = cxw
          nnY[i] = cy
        }
      }
    }

    // Bầu chọn: mỗi pixel trong lỗ là trung bình của MỌI mảng phủ lên nó. Đây
    // là chỗ khử vết nối -- một mảng lệch bị các mảng khác kéo về.
    const accR = new Float32Array(n)
    const accG = new Float32Array(n)
    const accB = new Float32Array(n)
    const accW = new Float32Array(n)
    for (const i of holes) {
      const y = (i / w) | 0
      const x = i - y * w
      // Trọng số theo độ khớp: mảng khớp sát được nghe nhiều hơn hẳn mảng
      // khớp tạm. Trung bình đều là thứ làm kết quả nhoè như sương.
      const wgt = Math.exp(-dist[i] / SIGMA2)
      for (let dy = -HALF; dy <= HALF; dy++) {
        const ty = y + dy
        const sy = nnY[i] + dy
        if (ty < 0 || ty >= h || sy < 0 || sy >= h) continue
        for (let dx = -HALF; dx <= HALF; dx++) {
          const tx = ((x + dx) % w + w) % w
          const sx = ((nnX[i] + dx) % w + w) % w
          const ti = ty * w + tx
          if (!l.hole[ti]) continue
          const si = (sy * w + sx) * 3
          accR[ti] += l.rgb[si] * wgt
          accG[ti] += l.rgb[si + 1] * wgt
          accB[ti] += l.rgb[si + 2] * wgt
          accW[ti] += wgt
        }
      }
    }
    for (const i of holes) {
      if (accW[i] <= 0) continue
      l.rgb[i * 3] = accR[i] / accW[i]
      l.rgb[i * 3 + 1] = accG[i] / accW[i]
      l.rgb[i * 3 + 2] = accB[i] / accW[i]
    }
    for (const i of holes) dist[i] = patchDist(l, i % w, (i / w) | 0, nnX[i], nnY[i], Infinity)
  }
  return { nnX, nnY }
}

/**
 * Lấp `hole` trong ảnh RGB. Sửa `rgb` tại chỗ.
 * @param levels số mức thu nhỏ; mỗi mức nhanh gấp bốn mức dưới nó.
 */
export function patchMatchFill(
  rgb: Float32Array,
  hole: Uint8Array,
  w: number,
  h: number,
  levels = 4,
  iterations = 5,
): void {
  const pyramid: Level[] = [buildLevel(rgb, hole, w, h)]
  for (let i = 1; i < levels; i++) {
    const prev = pyramid[i - 1]
    if (prev.w < 64 || prev.h < 64) break
    pyramid.push(downscale(prev))
  }

  let seedX: Int32Array | undefined
  let seedY: Int32Array | undefined
  for (let i = pyramid.length - 1; i >= 0; i--) {
    const l = pyramid[i]
    const res = solveLevel(l, iterations, seedX, seedY)
    if (i > 0) {
      // Nâng ánh xạ lên mức mịn hơn: toạ độ nhân đôi.
      const fine = pyramid[i - 1]
      seedX = new Int32Array(fine.w * fine.h)
      seedY = new Int32Array(fine.w * fine.h)
      for (let y = 0; y < fine.h; y++) {
        for (let x = 0; x < fine.w; x++) {
          const ci = (y >> 1) * l.w + (x >> 1)
          seedX[y * fine.w + x] = Math.min(fine.w - 1, res.nnX[ci] * 2 + (x & 1))
          seedY[y * fine.w + x] = Math.min(fine.h - 1 - HALF, Math.max(HALF, res.nnY[ci] * 2 + (y & 1)))
        }
      }
    }
  }
}
