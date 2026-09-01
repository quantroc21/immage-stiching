import type { StandingSpotReport } from './standingSpot'

/**
 * Explains what the standing position cost, in the terms the photographer can
 * act on: one direction was crowded, here is how much it hurt, stand further
 * back next time.
 */

interface Props {
  report: StandingSpotReport
  onLook: (yawDeg: number) => void
}

const VERDICT: Record<StandingSpotReport['verdict'], { title: string; note: string }> = {
  tốt: {
    title: 'Chỗ đứng tốt',
    note: 'Không có gì quá gần bạn. Ảnh ghép được sạch.',
  },
  khá: {
    title: 'Chỗ đứng tạm được',
    note: 'Có vật hơi gần, làm nhoè một hướng.',
  },
  kém: {
    title: 'Đứng quá sát đồ đạc',
    note: 'Một hướng nhoè hẳn so với phần còn lại.',
  },
}

export default function StandingSpotCard({ report, onLook }: Props) {
  const v = VERDICT[report.verdict]
  const scale = Math.max(report.worstPx, 24)

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold">{v.title}</p>
        <p className="mt-0.5 text-sm text-neutral-400">{v.note}</p>
      </div>

      <div className="flex items-center gap-4">
        {/* Parallax by direction. One long spoke means one thing was too close. */}
        <svg viewBox="-60 -60 120 120" className="h-28 w-28 shrink-0">
          <circle r="52" fill="none" stroke="rgba(255,255,255,0.10)" />
          <circle r="26" fill="none" stroke="rgba(255,255,255,0.10)" />
          {report.byDirection.map((d) => {
            const a = ((d.yawDeg - 90) * Math.PI) / 180
            const len = 8 + (Math.min(d.px, scale) / scale) * 44
            const worst = d.yawDeg === report.worstYawDeg
            return (
              <line
                key={d.yawDeg}
                x1={Math.cos(a) * 8}
                y1={Math.sin(a) * 8}
                x2={Math.cos(a) * len}
                y2={Math.sin(a) * len}
                stroke={worst ? '#f87171' : 'rgba(255,255,255,0.55)'}
                strokeWidth={worst ? 6 : 4}
                strokeLinecap="round"
              />
            )
          })}
          <circle r="3.5" fill="#fff" />
        </svg>

        <div className="min-w-0 space-y-2 text-sm">
          <div>
            <span className="text-neutral-500">Hướng tệ nhất</span>
            <div className="font-medium">
              lệch {report.worstPx.toFixed(0)}px
              <span className="text-neutral-500"> · cách khoảng {report.nearestMetres.toFixed(1)}m</span>
            </div>
          </div>
          <div>
            <span className="text-neutral-500">Phần còn lại của phòng</span>
            <div className="font-medium">
              lệch {report.typicalPx.toFixed(0)}px
              <span className="text-neutral-500"> · nhoè gấp {report.crowdingRatio.toFixed(1)} lần ở chỗ kia</span>
            </div>
          </div>
        </div>
      </div>

      <button
        onClick={() => onLook(report.worstYawDeg)}
        className="w-full rounded-lg bg-neutral-800 px-4 py-3 text-sm font-medium hover:bg-neutral-700"
      >
        Xem chỗ đó trong ảnh
      </button>

      <p className="text-sm text-neutral-400">
        Sai lệch tỉ lệ nghịch với khoảng cách: đứng xa gấp đôi thì nhoè giảm một nửa.{' '}
        {report.verdict === 'tốt'
          ? 'Lần sau cứ đứng như vậy.'
          : 'Lần sau lùi ra giữa phòng, cách đồ đạc ít nhất 2m.'}
      </p>

      <p className="text-xs text-neutral-600">
        Đo từ {report.samples} điểm khớp giữa các khung hình. Số mét là ước lượng, phụ thuộc
        cách bạn cầm máy; số pixel là đo trực tiếp.
      </p>
    </div>
  )
}
