import type { SourceShot } from '../tour/types'

/**
 * Works out how much the standing position cost this capture.
 *
 * Rotating a phone by hand swings the lens around the body rather than around
 * itself, so every shot is taken from a slightly different point. Near objects
 * then land in different places from shot to shot and no rotation can bring them
 * together; the stitch blurs them. The error scales as (how far the lens moved) /
 * (how far away the object is), so the distance to the nearest thing is the one
 * lever the photographer holds, and it is worth measuring rather than guessing.
 *
 * Overlapping shots are compared block by block. A shift shared by every block
 * is a pose error and is subtracted; what is left varies with depth and is the
 * parallax this report is about.
 */

export interface StandingSpotReport {
  /** Worst parallax seen, in pixels of the 4096-wide panorama. */
  worstPx: number
  /** Typical parallax across the room, same units. */
  typicalPx: number
  /** Direction of the worst spot, degrees, same convention as the capture. */
  worstYawDeg: number
  /** Rough distance to the nearest object. Depends on GRIP_RADIUS_M below. */
  nearestMetres: number
  /** How much closer the worst thing is than the typical thing. */
  crowdingRatio: number
  samples: number
  verdict: 'tốt' | 'khá' | 'kém'
  /** Parallax around the room in 30 degree bins, for pointing the viewer at it. */
  byDirection: { yawDeg: number; px: number; samples: number }[]
  /**
   * Where to stand next time, and what it buys. Null when the room is even
   * enough that moving would not pay, or when too little of it was measured to
   * say. `metres` leans on GRIP_RADIUS_M like `nearestMetres` does; the bearing
   * does not, and is the part worth trusting.
   */
  move: { yawDeg: number; metres: number; gainPct: number } | null
}

/**
 * Assumed distance from the lens to the axis the phone swings around, in metres.
 * Only the metre figures depend on it; the pixel figures are measured. Around
 * 5cm for a phone held in against the body, 35cm for an outstretched arm.
 */
// 3.7cm measured on a real capture: the desk was 0.5m away and showed 4.3 deg
// of parallax. An outstretched arm would be nearer 35cm.
const GRIP_RADIUS_M = 0.04
const PANO_WIDTH = 4096
/** Work size per shot. Big enough to match on, small enough to stay quick. */
const W = 192
const H = 256
const BLOCK = 32
const SEARCH = 8

type Grid = { data: Float32Array; width: number; height: number }

async function toGrey(blob: Blob): Promise<Grid> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Không dựng được canvas')
  ctx.drawImage(bitmap, 0, 0, W, H)
  bitmap.close()
  const { data } = ctx.getImageData(0, 0, W, H)
  const out = new Float32Array(W * H)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
  }
  return { data: out, width: W, height: H }
}

/** Removes the broad shading so matching keys on detail, not on brightness. */
function highPass(g: Grid): Float32Array {
  const { data, width, height } = g
  const blur = new Float32Array(data.length)
  const tmp = new Float32Array(data.length)
  const R = 3
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      let n = 0
      for (let k = -R; k <= R; k++) {
        const xx = x + k
        if (xx < 0 || xx >= width) continue
        sum += data[y * width + xx]
        n++
      }
      tmp[y * width + x] = sum / n
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0
      let n = 0
      for (let k = -R; k <= R; k++) {
        const yy = y + k
        if (yy < 0 || yy >= height) continue
        sum += tmp[yy * width + x]
        n++
      }
      blur[y * width + x] = sum / n
    }
  }
  const out = new Float32Array(data.length)
  for (let i = 0; i < out.length; i++) out[i] = data[i] - blur[i]
  return out
}

type Basis = { r: number[]; u: number[]; f: number[] }

function basisOf(shot: SourceShot): Basis {
  if (shot.vectors) {
    return { r: shot.vectors.right, u: shot.vectors.up, f: shot.vectors.forward }
  }
  const y = (shot.yawDeg * Math.PI) / 180
  const p = (shot.pitchDeg * Math.PI) / 180
  const f = [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)]
  const rc = [f[2] * 1 - 0, 0, -f[0] * 1]
  const rl = Math.hypot(rc[0], rc[1], rc[2]) || 1
  const r = [rc[0] / rl, rc[1] / rl, rc[2] / rl]
  const u = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ]
  return { r, u, f }
}

/** Brings `src` into `dst`'s view, returning the warped pixels and a valid mask. */
function warp(
  src: Float32Array,
  a: Basis,
  b: Basis,
  halfTanH: number,
  halfTanV: number,
): { pixels: Float32Array; mask: Uint8Array } {
  const pixels = new Float32Array(W * H)
  const mask = new Uint8Array(W * H)
  // dst camera axes expressed in src camera axes.
  const m = [
    [dot(a.r, b.r), dot(a.r, b.u), dot(a.r, b.f)],
    [dot(a.u, b.r), dot(a.u, b.u), dot(a.u, b.f)],
    [dot(a.f, b.r), dot(a.f, b.u), dot(a.f, b.f)],
  ]
  for (let y = 0; y < H; y++) {
    const ny = 1 - (2 * (y + 0.5)) / H
    for (let x = 0; x < W; x++) {
      const nx = (2 * (x + 0.5)) / W - 1
      const v = [nx * halfTanH, ny * halfTanV, 1]
      const cx = m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2]
      const cy = m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2]
      const cz = m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
      if (cz <= 0.2) continue
      const sx = cx / cz / halfTanH
      const sy = cy / cz / halfTanV
      if (Math.abs(sx) >= 0.97 || Math.abs(sy) >= 0.97) continue
      const px = Math.round((0.5 + sx * 0.5) * (W - 1))
      const py = Math.round((0.5 - sy * 0.5) * (H - 1))
      pixels[y * W + x] = src[py * W + px]
      mask[y * W + x] = 1
    }
  }
  return { pixels, mask }
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function matchBlocks(a: Float32Array, b: Float32Array, mask: Uint8Array) {
  const found: { x: number; y: number; dx: number; dy: number }[] = []
  for (let by = 0; by + BLOCK <= H; by += BLOCK / 2) {
    for (let bx = 0; bx + BLOCK <= W; bx += BLOCK / 2) {
      let covered = true
      let mean = 0
      for (let y = by; y < by + BLOCK && covered; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          if (!mask[y * W + x]) {
            covered = false
            break
          }
          mean += b[y * W + x]
        }
      }
      if (!covered) continue
      mean /= BLOCK * BLOCK
      let variance = 0
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const d = b[y * W + x] - mean
          variance += d * d
        }
      }
      // A blank wall matches everywhere; there is nothing to learn from it.
      if (Math.sqrt(variance / (BLOCK * BLOCK)) < 4) continue

      let best = -2
      let bdx = 0
      let bdy = 0
      for (let dy = -SEARCH; dy <= SEARCH; dy += 2) {
        for (let dx = -SEARCH; dx <= SEARCH; dx += 2) {
          const y0 = by + dy
          const x0 = bx + dx
          if (y0 < 0 || x0 < 0 || y0 + BLOCK > H || x0 + BLOCK > W) continue
          let sa = 0
          let sb = 0
          let saa = 0
          let sbb = 0
          let sab = 0
          for (let y = 0; y < BLOCK; y++) {
            for (let x = 0; x < BLOCK; x++) {
              const va = a[(y0 + y) * W + x0 + x]
              const vb = b[(by + y) * W + bx + x]
              sa += va
              sb += vb
              saa += va * va
              sbb += vb * vb
              sab += va * vb
            }
          }
          const n = BLOCK * BLOCK
          const cov = sab - (sa * sb) / n
          const da = Math.sqrt(Math.max(saa - (sa * sa) / n, 0))
          const db = Math.sqrt(Math.max(sbb - (sb * sb) / n, 0))
          if (da <= 0 || db <= 0) continue
          const score = cov / (da * db)
          if (score > best) {
            best = score
            bdx = dx
            bdy = dy
          }
        }
      }
      if (best > 0.45) found.push({ x: bx + BLOCK / 2, y: by + BLOCK / 2, dx: bdx, dy: bdy })
    }
  }
  return found
}

export async function analyseStandingSpot(
  shots: SourceShot[],
  fov: { horizontal: number; vertical: number },
  onProgress?: (fraction: number) => void,
): Promise<StandingSpotReport | null> {
  if (shots.length < 4) return null
  const halfTanH = Math.tan((fov.horizontal * Math.PI) / 360)
  const halfTanV = Math.tan((fov.vertical * Math.PI) / 360)
  const pxPerDeg = W / fov.horizontal

  const grids = await Promise.all(shots.map((s) => toGrey(s.blob)))
  const detail = grids.map(highPass)
  const bases = shots.map(basisOf)

  const samples: { yaw: number; deg: number }[] = []
  const pairs: [number, number][] = []
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      // Only neighbours share enough view to compare.
      if (dot(bases[i].f, bases[j].f) > 0.35) pairs.push([i, j])
    }
  }

  for (let k = 0; k < pairs.length; k++) {
    const [i, j] = pairs[k]
    const { pixels, mask } = warp(detail[i], bases[i], bases[j], halfTanH, halfTanV)
    const blocks = matchBlocks(pixels, detail[j], mask)
    if (blocks.length >= 6) {
      // The shift every block agrees on is a pose error, not depth. Take it out.
      const mx = blocks.reduce((s, b) => s + b.dx, 0) / blocks.length
      const my = blocks.reduce((s, b) => s + b.dy, 0) / blocks.length
      for (const b of blocks) {
        const deg = Math.hypot(b.dx - mx, b.dy - my) / pxPerDeg
        // Where in the room this block actually is. Two corrections the linear
        // version skipped: a rectilinear lens does not map columns to angles
        // linearly, and on a shot tilted up or down a column spans more azimuth
        // than it does at eye level, by 1/cos(pitch). Six of twelve shots sit at
        // 44 degrees, where that factor is 1.4, so without it their readings
        // land up to half a bin away from the thing they measured.
        const nx = ((b.x + 0.5) / W) * 2 - 1
        const offDeg = (Math.atan(nx * halfTanH) * 180) / Math.PI
        const cosPitch = Math.max(0.35, Math.cos((shots[j].pitchDeg * Math.PI) / 180))
        samples.push({ yaw: shots[j].yawDeg + offDeg / cosPitch, deg })
      }
    }
    onProgress?.((k + 1) / pairs.length)
  }
  if (samples.length < 12) return null

  const sorted = [...samples].sort((a, b) => a.deg - b.deg)
  const typical = sorted[Math.floor(sorted.length * 0.5)].deg

  const toPx = (deg: number) => (deg * PANO_WIDTH) / 360

  const BIN = 30
  const DIRS = 360 / BIN
  /** Half width of the window each direction reads from. */
  const KERNEL_DEG = 35
  /** Weighted readings a direction needs before it is allowed to be the worst. */
  const MIN_WEIGHT = 8

  const angDiff = (a: number, b: number) => {
    let d = (((a - b) % 360) + 540) % 360 - 180
    return Math.abs(d)
  }

  /**
   * Each direction is read from every sample near it, weighted by how near, not
   * from the handful that happened to land in its own 30 degree box.
   *
   * The box version had a bias that pointed this feature at walls. A blank wall
   * gives almost no matchable blocks -- the texture filter above drops them --
   * so wall directions ended up with three or four readings, and the median of
   * four noisy readings swings high often enough to win a max. Measured on three
   * real captures, the direction it named was decided by 5 and 8 samples in two
   * of them, and both changed completely once a real amount of support was
   * required. Weighting by distance and demanding weight before a direction can
   * be called the worst removes both problems.
   */
  const profile: { yawDeg: number; deg: number; px: number; weight: number; samples: number }[] = []
  for (let i = 0; i < DIRS; i++) {
    const yawDeg = i * BIN
    const near: { deg: number; w: number }[] = []
    let weight = 0
    for (const sm of samples) {
      const d = angDiff(sm.yaw, yawDeg)
      if (d >= KERNEL_DEG) continue
      const w = 1 - (d / KERNEL_DEG) ** 2
      near.push({ deg: sm.deg, w })
      weight += w
    }
    if (!near.length) {
      profile.push({ yawDeg, deg: 0, px: 0, weight: 0, samples: 0 })
      continue
    }
    // Weighted upper-middle reading: high enough to notice the close object,
    // robust enough to ignore one bad match.
    near.sort((a, b) => a.deg - b.deg)
    const target = weight * 0.6
    let run = 0
    let deg = near[near.length - 1].deg
    for (const n of near) {
      run += n.w
      if (run >= target) {
        deg = n.deg
        break
      }
    }
    profile.push({ yawDeg, deg, px: toPx(deg), weight, samples: near.length })
  }

  const byDirection = profile.map((d) => ({
    yawDeg: d.yawDeg,
    px: d.px,
    samples: Math.round(d.weight),
  }))

  const solid = profile.filter((d) => d.weight >= MIN_WEIGHT)
  const worstBin = solid.length
    ? solid.reduce((a, b) => (b.px > a.px ? b : a))
    : profile.reduce((a, b) => (b.px > a.px ? b : a))
  const worstPx = worstBin.px
  const worstDeg = (worstPx * 360) / PANO_WIDTH
  const typicalPx = toPx(typical)

  /**
   * Where to stand next time.
   *
   * Parallax runs as grip / distance, so the readings above are a rough map of
   * how far the room reaches in each direction. Stepping by m changes the
   * distance in direction u to about d - m.u, and the shot is only as good as
   * its closest thing, so the spot to want is the one that pushes the nearest
   * wall as far away as it can: maximise the smallest distance. That is a small
   * two dimensional search, done by trying bearings and step sizes directly,
   * which is cheaper than being clever and cannot fall into a local minimum.
   *
   * This is the answer the old card never gave. It named the direction of the
   * closest object and left the photographer to work out what to do about it --
   * and the closest object is usually the wall they were already standing at,
   * so it read as being told to walk into the wall.
   */
  const measured = profile.filter((d) => d.weight >= MIN_WEIGHT && d.deg > 1e-4)
  let move: StandingSpotReport['move'] = null
  if (measured.length >= 5) {
    const dirs = measured.map((d) => ({
      ux: Math.sin((d.yawDeg * Math.PI) / 180),
      uy: -Math.cos((d.yawDeg * Math.PI) / 180),
      dist: GRIP_RADIUS_M / ((d.deg * Math.PI) / 180),
    }))
    const worstNow = Math.min(...dirs.map((d) => d.dist))
    let best = { gain: 0, yawDeg: 0, metres: 0 }
    for (let a = 0; a < 360; a += 10) {
      const mx2 = Math.sin((a * Math.PI) / 180)
      const my2 = -Math.cos((a * Math.PI) / 180)
      for (let step = 0.1; step <= worstNow * 0.8 + 1e-9; step += 0.1) {
        let worstAfter = Infinity
        for (const d of dirs) worstAfter = Math.min(worstAfter, d.dist - step * (mx2 * d.ux + my2 * d.uy))
        const gain = worstAfter / worstNow - 1
        if (gain > best.gain) best = { gain, yawDeg: a, metres: step }
      }
    }
    // Under a tenth is inside the noise of this measurement; do not send anyone
    // walking across a room for it.
    if (best.gain >= 0.1) {
      move = { yawDeg: best.yawDeg, metres: best.metres, gainPct: Math.round(best.gain * 100) }
    }
  }

  return {
    byDirection,
    move,
    worstPx,
    typicalPx,
    worstYawDeg: worstBin.yawDeg,
    nearestMetres: GRIP_RADIUS_M / Math.max((worstDeg * Math.PI) / 180, 1e-4),
    crowdingRatio: worstPx / Math.max(typicalPx, 1e-4),
    samples: samples.length,
    verdict: worstPx < 20 ? 'tốt' : worstPx < 40 ? 'khá' : 'kém',
  }
}
