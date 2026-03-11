import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import type { FileAttachment } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface ChatInputProps {
  onSend: (content: string, attachments?: FileAttachment[]) => void;
  onStop?: () => void;
  isGenerating?: boolean;
  disabled?: boolean;
}

/**
 * 聊天输入组件 - 支持文本输入、文件上传、相机拍照
 */
export default function ChatInput({ onSend, onStop, isGenerating, disabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText('');
    setAttachments([]);

    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, attachments, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      // 自适应高度
      const textarea = e.target;
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    },
    []
  );

  // 相机拍照
  const handleCamera = useCallback(async () => {
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
        quality: 80,
        allowEditing: false,
      });

      if (photo.base64String) {
        const att: FileAttachment = {
          id: uuidv4(),
          name: `photo_${Date.now()}.${photo.format}`,
          type: `image/${photo.format}`,
          size: photo.base64String.length,
          base64: photo.base64String,
          url: `data:image/${photo.format};base64,${photo.base64String}`,
        };
        setAttachments((prev) => [...prev, att]);
      }
    } catch (e) {
      console.log('Camera cancelled or error:', e);
    }
    setShowAttachMenu(false);
  }, []);

  // 相册选择
  const handleGallery = useCallback(async () => {
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Base64,
        source: CameraSource.Photos,
        quality: 80,
      });

      if (photo.base64String) {
        const att: FileAttachment = {
          id: uuidv4(),
          name: `image_${Date.now()}.${photo.format}`,
          type: `image/${photo.format}`,
          size: photo.base64String.length,
          base64: photo.base64String,
          url: `data:image/${photo.format};base64,${photo.base64String}`,
        };
        setAttachments((prev) => [...prev, att]);
      }
    } catch (e) {
      console.log('Gallery cancelled or error:', e);
    }
    setShowAttachMenu(false);
  }, []);

  // 文件选择
  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
    setShowAttachMenu(false);
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const att: FileAttachment = {
          id: uuidv4(),
          name: file.name,
          type: file.type,
          size: file.size,
          base64,
          url: URL.createObjectURL(file),
        };
        setAttachments((prev) => [...prev, att]);
      };
      reader.readAsDataURL(file);
    });

    // 清除 input 让同一文件可重复选
    e.target.value = '';
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 px-3 py-3 safe-area-bottom">
      {/* 附件预览 */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 overflow-x-auto pb-1">
          {attachments.map((att) => (
            <div key={att.id} className="relative shrink-0 group">
              {att.type.startsWith('image/') ? (
                <img
                  src={att.url}
                  alt={att.name}
                  className="h-16 w-16 rounded-lg object-cover border border-neutral-700"
                />
              ) : (
                <div className="h-16 w-16 rounded-lg bg-neutral-800 border border-neutral-700 flex flex-col items-center justify-center p-1">
                  <svg className="w-5 h-5 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-[10px] text-neutral-400 truncate w-full text-center">{att.name}</span>
                </div>
              )}
              {/* 删除按钮 */}
              <button
                onClick={() => removeAttachment(att.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* 附件按钮 */}
        <div className="relative">
          <button
            onClick={() => setShowAttachMenu(!showAttachMenu)}
            disabled={disabled}
            className="w-9 h-9 flex items-center justify-center text-neutral-400 hover:text-white transition-colors rounded-full hover:bg-neutral-800 disabled:opacity-50"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>

          {/* 附件菜单 */}
          {showAttachMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowAttachMenu(false)} />
              <div className="absolute bottom-full left-0 mb-2 bg-neutral-800 rounded-xl shadow-xl border border-neutral-700 overflow-hidden z-20 min-w-[160px]">
                <button
                  onClick={handleCamera}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
                >
                  <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  拍照
                </button>
                <button
                  onClick={handleGallery}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
                >
                  <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  相册
                </button>
                <button
                  onClick={handleFileSelect}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm text-neutral-200 hover:bg-neutral-700 transition-colors"
                >
                  <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  文件
                </button>
              </div>
            </>
          )}
        </div>

        {/* 文本输入框 */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          disabled={disabled}
          rows={1}
          className="flex-1 bg-neutral-800 border border-neutral-700 rounded-2xl px-4 py-2.5 text-sm text-white placeholder-neutral-500 resize-none outline-none focus:border-neutral-600 transition-colors max-h-[160px] disabled:opacity-50"
        />

        {/* 发送/停止按钮 */}
        {isGenerating ? (
          <button
            onClick={onStop}
            className="w-9 h-9 flex items-center justify-center bg-red-500 hover:bg-red-600 rounded-full transition-colors shrink-0"
          >
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={disabled || (!text.trim() && attachments.length === 0)}
            className="w-9 h-9 flex items-center justify-center bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 rounded-full transition-colors shrink-0"
          >
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {/* 隐藏的文件 input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.txt,.csv,.json,.md"
        onChange={handleFileChange}
        className="hidden"
      />
    </div>
  );
}
