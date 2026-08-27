import { useEffect, useRef } from 'react'
import type { PannellumViewerInstance } from '../types/pannellum'

interface PanoramaViewerProps {
  imageUrl: string
  className?: string
}

export default function PanoramaViewer({ imageUrl, className }: PanoramaViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PannellumViewerInstance | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    viewerRef.current = window.pannellum.viewer(containerRef.current, {
      type: 'equirectangular',
      panorama: imageUrl,
      autoLoad: true,
      showControls: true,
      compass: false,
    })

    return () => {
      viewerRef.current?.destroy()
      viewerRef.current = null
    }
  }, [imageUrl])

  return <div ref={containerRef} className={className ?? 'h-full w-full'} />
}
