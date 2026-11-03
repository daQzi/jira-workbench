export function Loading({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} style={{ opacity: 1 - i * 0.08 }} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <p>{error.message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="state">{text}</div>;
}
