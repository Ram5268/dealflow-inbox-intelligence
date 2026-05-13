'use client'

import { useRef, useEffect, useState } from 'react'
import { Paperclip, ArrowUp, Square, X } from 'lucide-react'

interface ChatInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit: (files: File[]) => void  // now passes files to parent
  isLoading?: boolean
  placeholder?: string
}

export default function ChatInput({
  value,
  onChange,
  onSubmit,
  isLoading = false,
  placeholder = 'Ask about deals, buyers, listings...',
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])

  function submit() {
    const canSend = value.trim().length > 0 || files.length > 0
    if (!canSend || isLoading) return
    onSubmit(files)      // pass files to parent
    setFiles([])         // clear files after submit
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return
    setFiles(prev => [...prev, ...Array.from(e.target.files!)])
  }

  function removeFile(i: number) {
    setFiles(prev => prev.filter((_, idx) => idx !== i))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const canSend = value.trim().length > 0 || files.length > 0

  return (
    <div style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 24, padding: '6px 6px 6px 14px', backdropFilter: 'blur(12px)' }}>

      {/* Attached files */}
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingBottom: 8 }}>
          {files.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: '4px 8px', fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
              <Paperclip size={12} />
              <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.45)' }}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder}
        rows={1}
        style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none', fontSize: 14, lineHeight: 1.5, color: '#fff', fontFamily: 'inherit', padding: '6px 0', minHeight: 36, maxHeight: 160 }}
      />

      {/* Actions row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4 }}>
        <label htmlFor="chat-file-upload" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 12, cursor: 'pointer', color: 'rgba(255,255,255,0.45)', transition: 'all 0.15s' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <input ref={fileInputRef} id="chat-file-upload" type="file" multiple onChange={handleFiles} style={{ display: 'none' }} />
          <Paperclip size={17} />
        </label>

        <button
          onClick={submit}
          disabled={!canSend && !isLoading}
          style={{ width: 34, height: 34, borderRadius: 12, border: 'none', background: canSend || isLoading ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: canSend || isLoading ? 'pointer' : 'default', transition: 'all 0.2s', flexShrink: 0 }}
        >
          {isLoading
            ? <Square size={14} style={{ color: '#1c3d4f', fill: '#1c3d4f' }} />
            : <ArrowUp size={16} style={{ color: canSend ? '#1c3d4f' : 'rgba(255,255,255,0.35)' }} strokeWidth={2.5} />
          }
        </button>
      </div>
    </div>
  )
}
