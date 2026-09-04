import type { StandingSpotReport } from './standingSpot'

/**
 * Says where to stand next time, then shows the evidence.
 *
 * The first version led with the direction of the worst parallax, which is the
 * direction of the closest object -- usually the wall the photographer was
 * already backed against. Read as advice it said "walk into that wall". The
 * useful half of the measurement is the room's shape, and what that implies
 * about where to stand, so that goes first now and the worst direction stays
 * as the reason.
 */

interface Props {
  report: StandingSpotReport
  onLook: (yawDeg: number) => void
}

const VERDICT: Record<StandingSpotReport['verdict'], { title: string; note: string }> = {
  tốt: { title: 'Chỗ đứng tốt', note: 'Không có gì quá gần bạn. Ảnh ghép được sạch.' },
  khá: { title: 'Chỗ đứng tạm được', note: 'Có vật hơi gần, làm nhoè một hướng.' },
  kém: { title: 'Đứng quá sát đồ đạc', note: 'Một hướng nhoè hẳn so với phần còn lại.' },
}

export default function StandingSpotCard({ report, onLook }: Props) {
  const v = VERDICT[report.verdict]
  const scale = Math.max(report.worstPx, 24)
  const move = report.move

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold">{v.title}</p>
        <p className="mt-0.5 text-sm text-neutral-400">{v.note}</p>
      </div>

      {move ? (
        <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/40 p-3">
          <p className="text-sm font-medium text-emerald-300">
            Lần sau lùi khoảng {move.metres.toFixed(1)}m theo hướng mũi tên xanh
          </p>
          <p className="mt-0.5 text-sm text-neutral-400">
            Chỗ đó cách vật gần nhất xa hơn {move.gainPct}%, nên chỗ nhoè nhất sẽ nét hơn chừng đó.
          </p>
          <button
            onClick={() => onLook(move.yawDeg)}
            className="mt-2 w-full rounded-lg bg-emerald-800/70 px-4 py-2.5 text-sm font-medium hover:bg-emerald-700/70"
          >
            Xem hướng nên lùi về
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <p className="text-sm text-neutral-300">
            Phòng khá đều quanh bạn. Dời chỗ cũng không giúp thêm được bao nhiêu.
          </p>
        </div>
      )}

      <div className="flex items-center gap-4">
        {/* Khoảng cách theo từng hướng. Nan dài = có vật sát bạn ở hướng đó. */}
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
          {move ? (
            <g stroke="#34d399" fill="#34d399" strokeWidth="4" strokeLinecap="round">
              {(() => {
                const a = ((move.yawDeg - 90) * Math.PI) / 180
                const x = Math.cos(a) * 40
                const y = Math.sin(a) * 40
                return (
                  <>
                    <line x1={0} y1={0} x2={x} y2={y} />
                    <circle cx={x} cy={y} r="5" stroke="none" />
                  </>
                )
              })()}
            </g>
          ) : null}
          <circle r="3.5" fill="#fff" />
        </svg>

        <div className="min-w-0 space-y-2 text-sm">
          <div>
            <span className="text-neutral-500">Vật gần nhất</span>
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
        Xem vật gần nhất trong ảnh
      </button>

      <p className="text-xs text-neutral-600">
        Đo từ {report.samples} điểm khớp giữa các khung hình. Sai lệch tỉ lệ nghịch với khoảng
        cách, nên đứng xa gấp đôi thì nhoè giảm một nửa. Số mét là ước lượng, phụ thuộc cách bạn
        cầm máy; hướng và số pixel là đo trực tiếp.
      </p>
    </div>
  )
}
