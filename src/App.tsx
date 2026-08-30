import { useEffect, useMemo, useRef, useState } from 'react'
import CaptureView from './capture/CaptureView'
import { checkCaptureSupport } from './capture/support'
import InstallBanner from './pwa/InstallBanner'
import { buildTourHtml, type TourExport } from './tour/exportTour'
import { uploadTour, type SharedTour } from './tour/shareTour'
import SceneStrip from './tour/SceneStrip'
import TourStage, { type Travel } from './tour/TourStage'
import type { Hotspot } from './tour/types'
import { useTour } from './tour/useTour'

type Screen = 'tour' | 'capture'
type Mode = 'edit' | 'preview'

function App() {
  const tour = useTour()
  const { scenes } = tour
  const [screen, setScreen] = useState<Screen>('tour')
  const [mode, setMode] = useState<Mode>('edit')
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null)
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const [pendingImage, setPendingImage] = useState<Blob | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [placing, setPlacing] = useState(false)
  const [pendingPlacement, setPendingPlacement] = useState<{ yaw: number; pitch: number } | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [travel, setTravel] = useState<Travel | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<TourExport | null>(null)
  const [sharing, setSharing] = useState(false)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [uploadNote, setUploadNote] = useState('')
  const [shared, setShared] = useState<SharedTour | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
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

  const openNamePrompt = (image: Blob) => {
    setPendingImage(image)
    setPendingName(`Phòng ${scenes.length + 1}`)
  }

  const confirmAddScene = () => {
    if (!pendingImage) return
    const scene = tour.addScene(pendingImage, pendingName.trim() || `Phòng ${scenes.length + 1}`)
    setCurrentSceneId(scene.id)
    setPendingImage(null)
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
        await uploadTour(scenes, 'Virtual Tour 360', ({ fraction, totalBytes, skipped }) => {
          setUploadPercent(fraction === null ? null : Math.round(fraction * 100))
          setUploadNote(
            totalBytes === 0
              ? 'Ảnh đã có sẵn trên máy chủ'
              : `Đang gửi ${(totalBytes / 1024 / 1024).toFixed(1)} MB` +
                  (skipped > 0 ? `, bỏ qua ${skipped} phòng không đổi` : ''),
          )
        }),
      )
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Không tải lên được')
    } finally {
      setSharing(false)
      setUploadPercent(null)
      setUploadNote('')
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
        onAccept={async (url) => {
          setScreen('tour')
          try {
            const blob = await fetch(url).then((res) => res.blob())
            openNamePrompt(blob)
          } catch (err) {
            console.error('Không đọc được ảnh vừa chụp:', err)
          }
        }}
        onCancel={() => setScreen('tour')}
      />
    )
  }

  const otherScenes = scenes.filter((scene) => scene.id !== currentScene?.id)

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-white">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">
            {currentScene ? currentScene.name : 'Virtual Tour 360'}
          </h1>
          {currentScene && (
            <p className="text-xs text-neutral-500">
              {currentScene.hotspots.length} lối đi · {scenes.length} phòng
            </p>
          )}
        </div>

        {scenes.length > 0 && (
          <div className="flex shrink-0 rounded-lg bg-neutral-800 p-0.5 text-sm">
            {(['edit', 'preview'] as Mode[]).map((value) => (
              <button
                key={value}
                onClick={() => {
                  setMode(value)
                  setPlacing(false)
                  setHistory([])
                }}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  mode === value ? 'bg-white text-neutral-900' : 'text-neutral-400'
                }`}
              >
                {value === 'edit' ? 'Sửa' : 'Xem thử'}
              </button>
            ))}
          </div>
        )}
      </header>

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
              className="h-full w-full"
            />

            {placing && (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
                <span className="rounded-full bg-white text-neutral-900 px-4 py-2 text-sm font-medium shadow-lg">
                  Chạm vào vị trí muốn đặt lối đi
                </span>
              </div>
            )}

            {mode === 'edit' && !placing && (
              <div className="absolute inset-x-0 bottom-3 z-30 flex flex-wrap justify-center gap-2 px-3">
                <button
                  onClick={() => setPlacing(true)}
                  disabled={otherScenes.length === 0}
                  className="rounded-full bg-white text-neutral-900 px-4 py-2.5 text-sm font-medium shadow-lg hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                  title={
                    otherScenes.length === 0 ? 'Cần ít nhất 2 phòng để nối lối đi' : undefined
                  }
                >
                  + Gắn lối đi
                </button>
                <button
                  onClick={() => setRenameValue(currentScene.name)}
                  className="rounded-full bg-neutral-800/90 px-4 py-2.5 text-sm font-medium shadow-lg hover:bg-neutral-700"
                >
                  Đổi tên
                </button>
                <button
                  onClick={() => setPendingDelete({ kind: 'scene' })}
                  className="rounded-full bg-neutral-800/90 px-4 py-2.5 text-sm font-medium text-red-400 shadow-lg hover:bg-neutral-700"
                >
                  Xoá phòng
                </button>
              </div>
            )}

            {mode === 'preview' && history.length > 0 && (
              <button
                onClick={goBack}
                className="absolute bottom-3 left-3 z-30 rounded-full bg-neutral-900/90 px-4 py-2.5 text-sm font-medium shadow-lg hover:bg-neutral-800"
              >
                ← Quay lại
              </button>
            )}

            {mode === 'edit' && otherScenes.length === 0 && !placing && (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-3">
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

      {scenes.length > 0 && mode === 'edit' && (
        <div className="relative flex items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-950 px-3 py-2.5">
          {sharing && (
            <div className="absolute inset-x-0 top-0 h-0.5 bg-neutral-800">
              <div
                className="h-full bg-white transition-[width] duration-200"
                style={{ width: `${uploadPercent ?? 0}%` }}
              />
            </div>
          )}
          <span className="truncate text-xs text-neutral-500">
            {sharing && uploadNote
              ? uploadNote
              : `${scenes.length} phòng · ${scenes.reduce((sum, scene) => sum + scene.hotspots.length, 0)} lối đi`}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={handleExportTour}
              disabled={exporting}
              className="whitespace-nowrap rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700 disabled:text-neutral-500"
              title="File HTML mở được không cần mạng"
            >
              {exporting ? 'Đang gói…' : 'Tải offline'}
            </button>
            <button
              onClick={handleShareTour}
              disabled={sharing}
              className="whitespace-nowrap rounded-lg bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-200 disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              {sharing
                ? uploadPercent === null
                  ? 'Đang tải lên…'
                  : `Đang tải ${uploadPercent}%`
                : 'Chia sẻ link'}
            </button>
          </div>
        </div>
      )}

      {scenes.length > 0 && (
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
            Dùng khi cần xem không có mạng, hoặc để lưu trữ. Để gửi cho người khác thì dùng
            "Chia sẻ link" tiện hơn nhiều.
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
