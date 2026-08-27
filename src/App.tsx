import { useMemo, useState } from 'react'
import PanoramaViewer from './components/PanoramaViewer'
import CaptureView from './capture/CaptureView'
import { checkCaptureSupport } from './capture/support'

function App() {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'capture'>('view')
  const captureSupport = useMemo(checkCaptureSupport, [])

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

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-white">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h1 className="text-lg font-semibold">Virtual Tour 360</h1>
        <div className="flex gap-2">
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
