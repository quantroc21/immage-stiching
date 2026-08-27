import { useMemo, useState } from 'react'
import PanoramaViewer from './components/PanoramaViewer'
import CaptureView from './capture/CaptureView'
import { checkCaptureSupport } from './capture/support'
import InstallBanner from './pwa/InstallBanner'

function App() {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'capture'>('view')
  const captureSupport = useMemo(() => checkCaptureSupport(), [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    setImageUrl(url)
  }

  if (mode === 'capture') {
    return (
      <CaptureView
        onAccept={(url) => {
          setImageUrl(url)
          setMode('view')
        }}
        onCancel={() => setMode('view')}
      />
    )
  }

  const handleExport = () => {
    if (!imageUrl) return
    const a = document.createElement('a')
    a.href = imageUrl
    a.download = `panorama_360_${Date.now()}.jpg`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-white">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">Virtual Tour 360</h1>
        <div className="flex items-center gap-2">
          {imageUrl && (
            <button
              className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-500"
              onClick={handleExport}
              title="Tải ảnh 360 về máy"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path
                  fillRule="evenodd"
                  d="M10 3a.75.75 0 01.75.75v10.638l3.96-4.158a.75.75 0 111.08 1.04l-5.25 5.5a.75.75 0 01-1.08 0l-5.25-5.5a.75.75 0 111.08-1.04l3.96 4.158V3.75A.75.75 0 0110 3z"
                  clipRule="evenodd"
                />
              </svg>
              Xuất ảnh 360
            </button>
          )}
          <label className="cursor-pointer rounded-md bg-neutral-800 px-4 py-2 text-sm font-medium hover:bg-neutral-700">
            Upload ảnh có sẵn
            <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          </label>
          <button
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => setMode('capture')}
            disabled={!captureSupport.supported}
            title={captureSupport.reason}
          >
            Chụp mới (thử nghiệm)
          </button>
        </div>
      </header>

      <InstallBanner />

      {!captureSupport.supported && (
        <div className="border-b border-amber-900 bg-amber-950/60 px-4 py-2 text-xs text-amber-300">
          Tính năng "Chụp mới" bị ẩn: {captureSupport.reason}
        </div>
      )}

      <main className="relative flex-1">
        {imageUrl ? (
          <PanoramaViewer imageUrl={imageUrl} className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-neutral-400">
            Chưa có ảnh nào. Nhấn "Upload ảnh có sẵn" hoặc "Chụp mới" để bắt đầu.
          </div>
        )}
      </main>
    </div>
  )
}

export default App
