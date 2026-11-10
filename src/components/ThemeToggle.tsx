import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
function initial(): Theme {
  const saved = localStorage.getItem('wb.theme');
  return saved === 'dark' || saved === 'light' ? saved : 'light';
}
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem('wb.theme', theme); } catch { /* 外观记忆不可用不影响当前切换 */ }
  }, [theme]);
  return <button className="theme-toggle" aria-label={`切换到${theme === 'light' ? '深色' : '浅色'}模式`} title={`切换到${theme === 'light' ? '深色' : '浅色'}模式`} onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}><span aria-hidden="true">{theme === 'light' ? '☾' : '☀'}</span></button>;
}
