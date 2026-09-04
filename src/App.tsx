import { useEffect, useMemo, useRef, useState } from 'react'
import CaptureView from './capture/CaptureView'
import { checkCaptureSupport } from './capture/support'
import InstallBanner from './pwa/InstallBanner'
import { buildTourHtml, type TourExport } from './tour/exportTour'
import { shareSources } from './tour/exportSources'
import { analyseStandingSpot, type StandingSpotReport } from './capture/standingSpot'
import StandingSpotCard from './capture/StandingSpotCard'
import { fovFromAspect, ASSUMED_ULTRAWIDE_VERTICAL_FOV_DEG } from './capture/cameraFov'
import { uploadDiagnostics, uploadTour, type SharedTour } from './tour/shareTour'
import ProjectsView from './tour/ProjectsView'
import { migrateLooseScenes } from './tour/storage'
import RetouchView from './tour/RetouchView'
import SceneStrip from './tour/SceneStrip'
import TourStage, { type Travel } from './tour/TourStage'
import type { Hotspot, SourceShot } from './tour/types'
import { useTour } from './tour/useTour'

type Screen = 'tour' | 'capture'
type Mode = 'edit' | 'preview'

/**
 * Một mục trên thanh việc: biểu tượng nét mảnh và nhãn nhỏ dưới nó.
 *
 * Bề rộng chia đều nên hàng không bao giờ vỡ, dù nhãn dài ngắn khác nhau, và
 * nhãn vẫn giữ được vì biểu tượng trần thì người dùng phải đoán.
 */
function ToolButton({
  label,
  icon,
  onClick,
  disabled,
  title,
  active,
  highlight,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  active?: boolean
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1.5 transition active:scale-[0.94] disabled:opacity-40 ${
        active ? 'bg-white/10' : 'hover:bg-white/5'
      } ${highlight ? 'text-white' : 'text-neutral-300'}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-[22px] w-[22px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon}
      </svg>
      <span className="max-w-full truncate text-[10px] font-medium leading-none">{label}</span>
    </button>
  )
}

function App() {
  // Dự án đang mở. Chưa chọn thì hiện danh sách dự án.
  const [projectId, setProjectId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // Dữ liệu từ bản chỉ có một tour phải được gom vào một dự án trước khi đọc.
  useEffect(() => {
    void migrateLooseScenes()
      .catch((err: unknown) => console.error('Không chuyển được dữ liệu cũ:', err))
      .finally(() => setReady(true))
  }, [])

  if (!ready) return <div className="h-screen w-screen bg-neutral-950" />
  if (!projectId) return <ProjectsView onOpen={setProjectId} />
  return <ProjectApp projectId={projectId} onExit={() => setProjectId(null)} />
}

function ProjectApp({ projectId, onExit }: { projectId: string; onExit: () => void }) {
  const tour = useTour(projectId)
  const { scenes , replaceSceneImage } = tour
  const [screen, setScreen] = useState<Screen>('tour')
  const [mode, setMode] = useState<Mode>('edit')
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null)
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const [pendingImage, setPendingImage] = useState<Blob | null>(null)
  const [pendingSources, setPendingSources] = useState<SourceShot[] | undefined>(undefined)
  const [pendingName, setPendingName] = useState('')
  const [placing, setPlacing] = useState(false)
  const [pendingPlacement, setPendingPlacement] = useState<{ yaw: number; pitch: number } | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [travel, setTravel] = useState<Travel | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<TourExport | null>(null)
  const [sharing, setSharing] = useState(false)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [shared, setShared] = useState<SharedTour | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagId, setDiagId] = useState<string | null>(null)
  const [spotBusy, setSpotBusy] = useState(false)
  /** Công cụ đo đạc, để dưới một nút phụ thay vì bày hết ra thanh chính. */
  const [toolsOpen, setToolsOpen] = useState(false)
  const [retouching, setRetouching] = useState(false)
  /** Việc thuộc về căn phòng, mở từ cạnh tên phòng. */
  const [roomMenuOpen, setRoomMenuOpen] = useState(false)
  const [spot, setSpot] = useState<StandingSpotReport | null>(null)
  const [lookAt, setLookAt] = useState<{ yawDeg: number; pitchDeg: number; nonce: number }>()
  const [renameValue, setRenameValue] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'scene' } | { kind: 'hotspot'; hotspot: Hotspot } | null
  >(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const stageRef = useRef<HTMLElement>(null)

  const captureSupport = useMemo(() => checkCaptureSupport(), [])
  const sceneNames = useMemo(
    () => new Map(scenes.map((scene) => [scene.id, scene.name])),
    [scenes],
  )
  const currentScene = scenes.find((scene) => scene.id === currentSceneId) ?? scenes[0] ?? null

  // Keep a valid selection as rooms come and go.
  useEffect(() => {
    if (scenes.length === 0) {
      setCurrentSceneId(null)
    } else if (!scenes.some((scene) => scene.id === currentSceneId)) {
      setCurrentSceneId(scenes[0].id)
    }
  }, [scenes, currentSceneId])

  useEffect(() => {
    if (!currentScene) return
    for (const hotspot of currentScene.hotspots) {
      const target = scenes.find((s) => s.id === hotspot.targetSceneId)
      if (target) new Image().src = target.url
    }
  }, [currentScene, scenes])

  const openNamePrompt = (image: Blob, sources?: SourceShot[]) => {
    setPendingImage(image)
    setPendingSources(sources)
    setPendingName(`Phòng ${scenes.length + 1}`)
  }

  const confirmAddScene = () => {
    if (!pendingImage) return
    const scene = tour.addScene(
      pendingImage,
      pendingName.trim() || `Phòng ${scenes.length + 1}`,
      pendingSources,
    )
    setCurrentSceneId(scene.id)
    setPendingImage(null)
    setPendingSources(undefined)
    setPendingName('')
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAddSheetOpen(false)
    openNamePrompt(file)
  }

  const navigateTo = (sceneId: string, heading: Travel | null) => {
    if (currentScene) setHistory((prev) => [...prev, currentScene.id])
    setTravel(heading)
    setCurrentSceneId(sceneId)
  }

  const goBack = () => {
    setHistory((prev) => {
      if (prev.length === 0) return prev
      setTravel(null)
      setCurrentSceneId(prev[prev.length - 1])
      return prev.slice(0, -1)
    })
  }

  const handleHotspotClick = (hotspot: Hotspot, event?: MouseEvent) => {
    if (mode === 'preview') {
      // Aim the rush at the doorway itself, not the middle of the screen. The
      // marker's own box is the reliable source: a click's coordinates are
      // absent when the hotspot is activated by anything but a real tap.
      const stage = stageRef.current?.getBoundingClientRect()
      const marker = (event?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect()
      const pointX = marker ? marker.left + marker.width / 2 : event?.clientX
      const pointY = marker ? marker.top + marker.height / 2 : event?.clientY
      // A zero-area stage (an offscreen or not-yet-laid-out pane) would make
      // these NaN, and the browser silently drops an invalid transform-origin.
      const sized = stage !== undefined && stage.width > 0 && stage.height > 0
      const originX = sized && pointX !== undefined ? (pointX - stage.left) / stage.width : 0.5
      const originY = sized && pointY !== undefined ? (pointY - stage.top) / stage.height : 0.5
      navigateTo(hotspot.targetSceneId, {
        yaw: hotspot.yaw,
        pitch: hotspot.pitch,
        originX: Math.min(Math.max(originX, 0), 1),
        originY: Math.min(Math.max(originY, 0), 1),
      })
      return
    }
    setPendingDelete({ kind: 'hotspot', hotspot })
  }

  const confirmRename = () => {
    if (!currentScene || renameValue === null) return
    const name = renameValue.trim()
    if (name) tour.renameScene(currentScene.id, name)
    setRenameValue(null)
  }

  const handleExportTour = async () => {
    if (scenes.length === 0 || exporting) return
    setExporting(true)
    try {
      setExported(await buildTourHtml(scenes, 'Virtual Tour 360'))
    } catch (err) {
      console.error('Không xuất được tour:', err)
    } finally {
      setExporting(false)
    }
  }

  const handleShareTour = async () => {
    if (scenes.length === 0 || sharing) return
    setSharing(true)
    setShareError(null)
    setUploadPercent(0)
    try {
      setShared(
        await uploadTour(scenes, 'Virtual Tour 360', ({ fraction }) => {
          setUploadPercent(fraction === null ? null : Math.round(fraction * 100))
        }),
      )
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Không tải lên được')
    } finally {
      setSharing(false)
      setUploadPercent(null)
    }
  }

  const checkStandingSpot = async () => {
    const sources = currentScene?.sources
    if (!sources || sources.length < 4 || spotBusy) return
    setSpotBusy(true)
    try {
      const report = await analyseStandingSpot(
        sources,
        fovFromAspect(ASSUMED_ULTRAWIDE_VERTICAL_FOV_DEG, 3 / 4),
      )
      if (report) setSpot(report)
      else setShareError('Không đủ chi tiết trong ảnh để đo được chỗ đứng.')
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Không phân tích được')
    } finally {
      setSpotBusy(false)
    }
  }

  const sendDiagnostics = async () => {
    if (!currentScene || diagBusy) return
    setDiagBusy(true)
    try {
      const { id } = await uploadDiagnostics(currentScene)
      setDiagId(id)
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Không gửi được')
    } finally {
      setDiagBusy(false)
    }
  }

  const copyLink = async () => {
    if (!shared) return
    try {
      await navigator.clipboard.writeText(shared.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setShareError('Trình duyệt không cho sao chép, hãy chạm giữ vào link để copy tay.')
    }
  }

  const shareLink = async () => {
    if (!shared) return
    try {
      await navigator.share({ title: 'Virtual tour 360', url: shared.url })
    } catch {
      // Cancelled, or the browser has no share sheet. The link is on screen anyway.
    }
  }

  const downloadExport = () => {
    if (!exported) return
    const url = URL.createObjectURL(exported.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exported.filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const shareExport = async () => {
    if (!exported) return
    const file = new File([exported.blob], exported.filename, { type: 'text/html' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Virtual tour 360' })
        return
      } catch {
        // Cancelled or refused by the OS, fall through to a plain download.
      }
    }
    downloadExport()
  }

  const confirmDelete = () => {
    if (!currentScene || !pendingDelete) return
    if (pendingDelete.kind === 'scene') tour.removeScene(currentScene.id)
    else tour.removeHotspot(currentScene.id, pendingDelete.hotspot.id)
    setPendingDelete(null)
  }

  if (screen === 'capture') {
    return (
      <CaptureView
        onAccept={async (url, sources) => {
          setScreen('tour')
          try {
            const blob = await fetch(url).then((res) => res.blob())
            openNamePrompt(blob, sources)
          } catch (err) {
            console.error('Không đọc được ảnh vừa chụp:', err)
          }
        }}
        onCancel={() => setScreen('tour')}
      />
    )
  }

  const otherScenes = scenes.filter((scene) => scene.id !== currentScene?.id)

  if (retouching && currentScene) {
    return (
      <RetouchView
        name={currentScene.name}
        image={currentScene.image}
        onCancel={() => setRetouching(false)}
        onSave={(image) => {
          replaceSceneImage(currentScene.id, image)
          setRetouching(false)
        }}
      />
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-white">
      {scenes.length === 0 && (
        <header className="flex items-center gap-2 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <button onClick={onExit} aria-label="Về danh sách dự án" className="-ml-2 rounded-full p-2">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <h1 className="text-base font-semibold">Dự án</h1>
        </header>
      )}

      <InstallBanner />

      <main ref={stageRef} className="relative flex-1 overflow-hidden">
        {currentScene ? (
          <>
            <TourStage
              scene={currentScene}
              sceneNames={sceneNames}
              placing={placing}
              onPlace={(yaw, pitch) => {
                setPlacing(false)
                setPendingPlacement({ yaw, pitch })
              }}
              onHotspotClick={handleHotspotClick}
              travel={travel}
              lookAt={lookAt}
              className="h-full w-full"
            />

            {/* Thanh trên nổi trên ảnh, không phải dải đặc cắt ngang màn hình:
                tên phòng ở giữa, công tắc chế độ và việc của phòng ở hai bên. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-2 px-3 pt-[max(0.6rem,env(safe-area-inset-top))]">
              <button
                onClick={onExit}
                aria-label="Về danh sách dự án"
                className="lg lg-sheen pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>

              <div className="lg lg-sheen pointer-events-auto min-w-0 flex-1 rounded-full px-4 py-2">
                <p className="truncate text-sm font-semibold leading-tight">{currentScene.name}</p>
                <p className="truncate whitespace-nowrap text-[11px] leading-tight text-neutral-400">
                  {currentScene.hotspots.length} lối đi · {scenes.length} phòng
                </p>
              </div>

              <div className="pointer-events-auto flex shrink-0 items-center gap-2">
                <div className="lg flex rounded-full p-0.5 text-sm">
                  {(['edit', 'preview'] as Mode[]).map((value) => (
                    <button
                      key={value}
                      onClick={() => {
                        setMode(value)
                        setPlacing(false)
                        setToolsOpen(false)
                        setRoomMenuOpen(false)
                        setHistory([])
                      }}
                      className={`rounded-full px-3 py-1.5 font-medium transition ${
                        mode === value ? 'bg-white text-neutral-900' : 'text-neutral-300'
                      }`}
                    >
                      {value === 'edit' ? 'Sửa' : 'Xem thử'}
                    </button>
                  ))}
                </div>

                {mode === 'edit' && (
                  <div className="relative">
                    <button
                      onClick={() => {
                        setToolsOpen(false)
                        setRoomMenuOpen((v) => !v)
                      }}
                      aria-label="Tuỳ chọn phòng"
                      className="lg lg-sheen flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none text-neutral-200"
                    >
                      ⋯
                    </button>
                    {roomMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setRoomMenuOpen(false)} />
                        <div className="lg absolute right-0 top-full z-50 mt-2 w-40 overflow-hidden rounded-2xl">
                          <button
                            onClick={() => {
                              setRoomMenuOpen(false)
                              setPendingDelete({ kind: 'scene' })
                            }}
                            className="block w-full px-4 py-3 text-left text-sm text-red-400 hover:bg-white/10"
                          >
                            Xoá phòng
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {placing && (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
                <span className="rounded-full bg-white text-neutral-900 px-4 py-2 text-sm font-medium shadow-lg">
                  Chạm vào vị trí muốn đặt lối đi
                </span>
              </div>
            )}

            {/* Dải phòng nổi trên ảnh, không có nền riêng. Trong chế độ Sửa thì
                thanh tab ở dưới đã chừa vùng an toàn; chế độ Xem thử thì không,
                nên dải tự chừa. */}
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 z-30 ${
                mode === 'edit' ? 'pb-1' : 'pb-[max(0.5rem,env(safe-area-inset-bottom))]'
              }`}
            >
              <SceneStrip
                scenes={scenes}
                currentSceneId={currentScene?.id ?? null}
                onSelect={(id) => {
                  setPlacing(false)
                  setHistory([])
                  setTravel(null)
                  setCurrentSceneId(id)
                }}
                onAdd={() => setAddSheetOpen(true)}
                editable={mode === 'edit'}
              />
            </div>

            {mode === 'preview' && history.length > 0 && (
              <button
                onClick={goBack}
                className="lg lg-sheen absolute bottom-3 left-3 z-30 rounded-full px-5 py-2.5 text-sm font-medium"
              >
                ← Quay lại
              </button>
            )}

            {mode === 'edit' && otherScenes.length === 0 && !placing && (
              <div className="pointer-events-none absolute inset-x-0 top-[5.2rem] z-30 flex justify-center px-3">
                <span className="rounded-full bg-neutral-900/90 px-4 py-2 text-center text-xs text-neutral-400">
                  Thêm phòng thứ hai để bắt đầu nối lối đi
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
            <p className="text-neutral-400">
              {tour.loading ? 'Đang mở tour đã lưu…' : 'Chưa có phòng nào. Thêm phòng đầu tiên để bắt đầu.'}
            </p>
            {!tour.loading && (
              <button
                onClick={() => setAddSheetOpen(true)}
                className="rounded-lg bg-white text-neutral-900 px-5 py-2.5 text-sm font-medium hover:bg-neutral-200"
              >
                + Thêm phòng
              </button>
            )}
          </div>
        )}
      </main>

      {scenes.length > 0 && mode === 'edit' && currentScene && (
        /* Thanh việc: biểu tượng kèm nhãn nhỏ, bề rộng cố định cho mỗi mục, nên
           thêm bớt mục không bao giờ làm vỡ hàng như dãy nút chữ trước đây. */
        <div className="relative border-t border-neutral-800 bg-neutral-950/95">
          {sharing && (
            <div className="absolute inset-x-0 top-0 h-0.5 bg-neutral-800">
              <div
                className="h-full bg-white transition-[width] duration-200"
                style={{ width: `${uploadPercent ?? 0}%` }}
              />
            </div>
          )}
          <div className="flex items-stretch justify-around px-1 pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-1.5">
            <ToolButton
              label="Lối đi"
              disabled={otherScenes.length === 0}
              title={otherScenes.length === 0 ? 'Cần ít nhất 2 phòng để nối lối đi' : undefined}
              onClick={() => {
                setToolsOpen(false)
                setPlacing(true)
              }}
              icon={
                <>
                  <circle cx="12" cy="10" r="3" />
                  <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
                </>
              }
            />
            <ToolButton
              label="Sửa ảnh"
              onClick={() => {
                setToolsOpen(false)
                setRetouching(true)
              }}
              icon={
                <>
                  <path d="M5 19 16 8" />
                  <path d="m15 5 1.4 1.4M19 9l1.4 1.4M17.5 4.5 19 3M20.5 8 22 6.5" />
                  <path d="M18 7.5 20.5 10" />
                </>
              }
            />
            <ToolButton
              label="Đổi tên"
              onClick={() => {
                setToolsOpen(false)
                setRenameValue(currentScene.name)
              }}
              icon={
                <>
                  <path d="M3 12.5V5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.4.6l6.5 6.5a2 2 0 0 1 0 2.8l-7.5 7.5a2 2 0 0 1-2.8 0l-6.5-6.5a2 2 0 0 1-.6-1.4Z" />
                  <circle cx="7.5" cy="7.5" r="1.2" />
                </>
              }
            />
            {currentScene.sources && currentScene.sources.length > 0 && (
              <div className="relative flex-1">
                <ToolButton
                  label="Công cụ"
                  active={toolsOpen}
                  onClick={() => {
                    setRoomMenuOpen(false)
                    setToolsOpen((v) => !v)
                  }}
                  icon={
                    <>
                      <circle cx="12" cy="12" r="8" />
                      <path d="M12 12V7M12 12l3.5 2" />
                    </>
                  }
                />
                {toolsOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setToolsOpen(false)} />
                    <div className="lg absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 overflow-hidden rounded-2xl">
                      {currentScene.sources.length >= 4 && (
                        <button
                          onClick={() => {
                            setToolsOpen(false)
                            void checkStandingSpot()
                          }}
                          disabled={spotBusy}
                          className="block w-full px-4 py-3 text-left text-sm hover:bg-white/10 disabled:text-neutral-500"
                        >
                          {spotBusy ? 'Đang đo…' : 'Chỗ đứng'}
                          <span className="block text-xs text-neutral-400">
                            Đo xem chỗ bạn đứng có làm nhoè ảnh không
                          </span>
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setToolsOpen(false)
                          void sendDiagnostics()
                        }}
                        disabled={diagBusy}
                        className="block w-full border-t border-white/10 px-4 py-3 text-left text-sm hover:bg-white/10 disabled:text-neutral-600"
                      >
                        {diagBusy ? 'Đang gửi…' : 'Gửi chẩn đoán'}
                        <span className="block text-xs text-neutral-400">
                          Gửi ảnh gốc kèm góc chụp để soi lỗi
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          setToolsOpen(false)
                          void shareSources(currentScene.sources!, currentScene.name)
                        }}
                        className="block w-full border-t border-white/10 px-4 py-3 text-left text-sm hover:bg-white/10"
                      >
                        Lưu {currentScene.sources.length} ảnh gốc
                        <span className="block text-xs text-neutral-400">
                          Để ghép lại hoặc soi lỗi trên máy khác
                        </span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            <ToolButton
              label={exporting ? 'Đang gói…' : 'Offline'}
              disabled={exporting}
              title="File HTML mở được không cần mạng"
              onClick={handleExportTour}
              icon={<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" />}
            />
            <ToolButton
              label={sharing ? (uploadPercent === null ? 'Đang tải…' : `${uploadPercent}%`) : 'Chia sẻ'}
              disabled={sharing}
              highlight
              onClick={handleShareTour}
              icon={<path d="M12 15V4m0 0 4 4m-4-4L8 8M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />}
            />
          </div>
        </div>
      )}


      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      {addSheetOpen && (
        <Sheet onClose={() => setAddSheetOpen(false)} title="Thêm phòng">
          <button
            onClick={() => {
              setAddSheetOpen(false)
              setScreen('capture')
            }}
            disabled={!captureSupport.supported}
            className="w-full rounded-lg bg-white text-neutral-900 px-4 py-3 text-sm font-medium hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            title={captureSupport.reason}
          >
            Chụp 360 bằng camera
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-lg bg-neutral-800 px-4 py-3 text-sm font-medium hover:bg-neutral-700"
          >
            Chọn ảnh 360 có sẵn
          </button>
          {!captureSupport.supported && (
            <p className="text-xs text-amber-400">Không chụp được tại đây: {captureSupport.reason}</p>
          )}
        </Sheet>
      )}

      {pendingImage && (
        <Sheet onClose={() => setPendingImage(null)} title="Đặt tên phòng">
          <input
            autoFocus
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmAddScene()}
            placeholder="Phòng khách, Phòng ngủ, Bếp…"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm outline-none focus:border-white"
          />
          <button
            onClick={confirmAddScene}
            className="w-full rounded-lg bg-white text-neutral-900 px-4 py-3 text-sm font-medium hover:bg-neutral-200"
          >
            Lưu phòng
          </button>
        </Sheet>
      )}

      {shared && (
        <Sheet onClose={() => setShared(null)} title="Link tour của bạn">
          <p className="text-sm text-neutral-400">
            Mở được trên mọi thiết bị. Dán vào Zalo, Facebook, hay nhúng vào website bằng thẻ
            <code className="mx-1 rounded bg-neutral-800 px-1 py-0.5 text-xs">iframe</code>.
          </p>
          <input
            readOnly
            value={shared.url}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-3 text-sm outline-none"
          />
          <button
            onClick={copyLink}
            className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
          >
            {copied ? 'Đã sao chép' : 'Sao chép link'}
          </button>
          <button
            onClick={shareLink}
            className="w-full rounded-lg bg-neutral-800 px-4 py-3 text-sm font-medium hover:bg-neutral-700"
          >
            Chia sẻ
          </button>
          <a
            href={shared.url}
            target="_blank"
            rel="noreferrer"
            className="block w-full rounded-lg px-4 py-3 text-center text-sm font-medium text-neutral-400 hover:text-white"
          >
            Mở thử
          </a>
        </Sheet>
      )}

      {spot && (
        <Sheet onClose={() => setSpot(null)} title="Chỗ đứng">
          <StandingSpotCard
            report={spot}
            onLook={(yawDeg) => {
              setMode('preview')
              setLookAt({ yawDeg, pitchDeg: -15, nonce: Date.now() })
              setSpot(null)
            }}
          />
        </Sheet>
      )}

      {diagId && (
        <Sheet onClose={() => setDiagId(null)} title="Đã gửi chẩn đoán">
          <p className="text-sm text-neutral-400">
            Ảnh gốc và góc chụp của từng khung đã lên máy chủ. Đưa mã này cho tôi:
          </p>
          <input
            readOnly
            value={diagId}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-3 text-center font-mono text-lg tracking-widest outline-none"
          />
          <button
            onClick={() => {
              void navigator.clipboard.writeText(diagId).catch(() => {})
              setCopied(true)
              setTimeout(() => setCopied(false), 1800)
            }}
            className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200"
          >
            {copied ? 'Đã sao chép' : 'Sao chép mã'}
          </button>
        </Sheet>
      )}

      {shareError && (
        <Sheet onClose={() => setShareError(null)} title="Chia sẻ không thành công">
          <p className="text-sm text-neutral-400">{shareError}</p>
          <button
            onClick={() => setShareError(null)}
            className="w-full rounded-lg bg-neutral-800 px-4 py-3 text-sm font-medium hover:bg-neutral-700"
          >
            Đóng
          </button>
        </Sheet>
      )}

      {exported && (
        <Sheet onClose={() => setExported(null)} title="Tour đã đóng gói">
          <p className="text-sm text-neutral-400">
            {scenes.length} phòng trong một file HTML, {(exported.bytes / 1024 / 1024).toFixed(1)} MB.
            Dùng khi cần xem không có mạng, hoặc để lưu trữ. Để gửi cho người khác thì nút
            "Chia sẻ" ở thanh dưới tiện hơn nhiều.
          </p>
          <button
            onClick={shareExport}
            className="w-full rounded-lg bg-white text-neutral-900 px-4 py-3 text-sm font-medium hover:bg-neutral-200"
          >
            Chia sẻ
          </button>
          <button
            onClick={downloadExport}
            className="w-full rounded-lg bg-neutral-800 px-4 py-3 text-sm font-medium hover:bg-neutral-700"
          >
            Tải file về máy
          </button>
        </Sheet>
      )}

      {renameValue !== null && (
        <Sheet onClose={() => setRenameValue(null)} title="Đổi tên phòng">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmRename()}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm outline-none focus:border-white"
          />
          <button
            onClick={confirmRename}
            className="w-full rounded-lg bg-white text-neutral-900 px-4 py-3 text-sm font-medium hover:bg-neutral-200"
          >
            Lưu
          </button>
        </Sheet>
      )}

      {pendingDelete && currentScene && (
        <Sheet
          onClose={() => setPendingDelete(null)}
          title={pendingDelete.kind === 'scene' ? 'Xoá phòng?' : 'Xoá lối đi?'}
        >
          <p className="text-sm text-neutral-400">
            {pendingDelete.kind === 'scene'
              ? `"${currentScene.name}" và mọi lối đi dẫn tới phòng này sẽ bị xoá.`
              : `Lối đi sang "${
                  sceneNames.get(pendingDelete.hotspot.targetSceneId) ?? 'phòng đã xoá'
                }" sẽ bị gỡ khỏi phòng này.`}
          </p>
          <button
            onClick={confirmDelete}
            className="w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium hover:bg-red-500"
          >
            Xoá
          </button>
          <button
            onClick={() => setPendingDelete(null)}
            className="w-full rounded-lg bg-neutral-800 px-4 py-3 text-sm font-medium hover:bg-neutral-700"
          >
            Huỷ
          </button>
        </Sheet>
      )}

      {pendingPlacement && currentScene && (
        <Sheet onClose={() => setPendingPlacement(null)} title="Lối đi này dẫn tới đâu?">
          {otherScenes.map((scene) => (
            <button
              key={scene.id}
              onClick={() => {
                tour.addHotspot(currentScene.id, {
                  yaw: pendingPlacement.yaw,
                  pitch: pendingPlacement.pitch,
                  targetSceneId: scene.id,
                })
                setPendingPlacement(null)
              }}
              className="flex w-full items-center gap-3 rounded-lg bg-neutral-800 p-2 text-left hover:bg-neutral-700"
            >
              <img src={scene.url} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />
              <span className="truncate text-sm font-medium">{scene.name}</span>
            </button>
          ))}
        </Sheet>
      )}
    </div>
  )
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md space-y-3 rounded-t-2xl border-t border-neutral-800 bg-neutral-950 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="px-2 text-lg leading-none text-neutral-500">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default App
