import { useEffect, useMemo, useRef, useState } from 'react';

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 剪贴板截图没有有意义的文件名（image.png），补上时间戳避免同名覆盖 */
export function namePasted(f: File, now = new Date()): File {
  // 浏览器/系统给剪贴板图片的通用名（image.png、clipboard.png、Pasted image 等）
  if (f.name && !/^(image|clipboard|pasted[ _-]?image|screenshot|blob)(\.\w+)?$/i.test(f.name)) return f;
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const name = `截图_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}_${Math.random().toString(36).slice(2, 5)}.${ext}`;
  return new File([f], name, { type: f.type });
}

export function filesFromClipboard(e: ClipboardEvent | React.ClipboardEvent): File[] {
  const items = [...(e.clipboardData?.items ?? [])];
  return items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f).map((f) => namePasted(f));
}

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /** 立即上传模式（详情页）：显示上传中状态 */
  busy?: boolean;
  hint?: string;
}

/** 附件区：拖拽、点击选择、粘贴（粘贴由外层表单监听后调用 onChange） */
export function AttachmentDrop({ files, onChange, disabled, busy, hint }: Props) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const accept = (list: File[]) => {
    const big = list.filter((f) => f.size > MAX_FILE_BYTES);
    setError(big.length ? `${big.map((f) => f.name).join('、')} 超过 100MB，已忽略` : '');
    const ok = list.filter((f) => f.size <= MAX_FILE_BYTES);
    if (ok.length) onChange([...files, ...ok]);
  };

  return (
    <div
      className={`dropzone${over ? ' over' : ''}${disabled ? ' disabled' : ''}`}
      onDragEnter={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        accept([...e.dataTransfer.files]);
      }}
    >
      <button type="button" className="drop-hint" disabled={disabled} onClick={() => input.current?.click()}>
        <span className="drop-icon" aria-hidden="true">⇪</span>
        {busy ? '上传中…' : hint ?? '拖拽文件到这里、Ctrl/⌘+V 粘贴截图，或点击选择'}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          accept([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {error && <span className="err">{error}</span>}
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <FileChip key={`${f.name}-${f.size}-${i}`} file={f} onRemove={disabled ? undefined : () => onChange(files.filter((_, j) => j !== i))} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileChip({ file, onRemove }: { file: File; onRemove?: () => void }) {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <li className="file-chip">
      {url ? <img src={url} alt="" /> : <span className="file-ext">{(file.name.split('.').pop() || '?').slice(0, 4)}</span>}
      <span className="file-name" title={file.name}>
        {file.name}
      </span>
      <span className="muted">{formatSize(file.size)}</span>
      {onRemove && (
        <button type="button" className="x-btn" aria-label={`移除 ${file.name}`} onClick={onRemove}>
          ✕
        </button>
      )}
    </li>
  );
}
