import { useState, useCallback, useRef } from 'react';

interface ImageViewerProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

/**
 * 全屏图片查看器（Lightbox）
 * 支持点击关闭、双击缩放、拖拽平移
 */
export default function ImageViewer({ src, alt, onClose }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; lastX: number; lastY: number } | null>(null);

  const handleDoubleClick = useCallback(() => {
    if (scale > 1) {
      setScale(1);
      setTranslate({ x: 0, y: 0 });
    } else {
      setScale(2.5);
    }
  }, [scale]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      dragRef.current = {
        startX: e.touches[0].clientX - translate.x,
        startY: e.touches[0].clientY - translate.y,
        lastX: translate.x,
        lastY: translate.y,
      };
    }
  }, [translate]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1 && dragRef.current && scale > 1) {
      e.preventDefault();
      const newX = e.touches[0].clientX - dragRef.current.startX;
      const newY = e.touches[0].clientY - dragRef.current.startY;
      setTranslate({ x: newX, y: newY });
    }
  }, [scale]);

  const handleTouchEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
      onClick={onClose}
    >
      {/* 关闭按钮 */}
      <button
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors z-10 safe-area-top"
        onClick={onClose}
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* 缩放提示 */}
      {scale === 1 && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/50 text-xs safe-area-bottom">
          双击放大 · 点击关闭
        </div>
      )}

      {/* 图片 */}
      <img
        src={src}
        alt={alt || '图片预览'}
        className="max-w-full max-h-full object-contain select-none"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transition: scale === 1 ? 'transform 0.2s ease' : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        draggable={false}
      />
    </div>
  );
}
