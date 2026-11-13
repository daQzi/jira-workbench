import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type ConnSettings } from '../lib/api';
import { OrbitScene } from '../features/scene/OrbitScene';
import { SceneSettings } from '../features/scene/SceneSettings';

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<ConnSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      if (!s.jiraBaseUrl) setShowSettings(true);
    }, () => setSettings(null));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      onDone();
    } catch (err) {
      if (!(err instanceof ApiError)) setError('无法连接本地代理，请确认 npm run dev 已启动');
      // 5xx 多半是 Jira 地址不通
      else setError(err.status >= 500 ? `${err.message}。请检查「连接设置」里的 Jira 地址` : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap"><OrbitScene><div className="login-scene-copy"><span>WORK IN FLOW</span><strong>需求、任务与工时<br/>在同一条轨道上。</strong></div></OrbitScene>
      <div className="login-stack">
        <form className="login" onSubmit={submit}>
          <h1>研发工作台</h1>
          <p>使用 Jira 账号登录，权限与 Jira 一致</p>
          <label>
            用户名
            <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label>
            密码
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="btn primary" disabled={busy || !settings?.jiraBaseUrl}>
            {busy ? '登录中…' : '登录'}
          </button>
          <div className="err" role="alert">
            {error}
          </div>
          <div className="login-conn">
            <span className="mono" title="当前 Jira 地址">
              {settings ? settings.jiraBaseUrl || '请先配置 Jira 地址' : '…'}
            </span>
            {settings && (
              <button type="button" className="link-btn" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>
                {showSettings ? '收起连接设置' : '连接设置'}
              </button>
            )}
          </div>
        </form>
        {showSettings && settings && (
          <SettingsForm
            current={settings}
            onSaved={(s) => {
              setSettings(s);
              setShowSettings(false);
              setError('');
            }}
          />
        )}
      </div>
      <SceneSettings compact/>
    </div>
  );
}

function SettingsForm({ current, onSaved }: { current: ConnSettings; onSaved: (s: ConnSettings) => void }) {
  const [jiraBaseUrl, setJira] = useState(current.jiraBaseUrl);
  const [llmBaseUrl, setLlmUrl] = useState(current.llmBaseUrl);
  const [llmModel, setModel] = useState(current.llmModel);
  const [llmApiKey, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const s = await api.saveSettings({ jiraBaseUrl, llmBaseUrl, llmModel, llmApiKey });
      setKey('');
      onSaved(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，无法连接本地代理');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login login-settings" onSubmit={save}>
      <h2>连接设置</h2>
      <p>{current.saved ? '保存到本机配置文件，重启后仍然有效' : '只在本次运行生效'}。修改 Jira 地址后需要重新登录。大模型配置可选；请求地址和模型 ID 均留空时使用规则解析。</p>
      <label>
        Jira 地址
        <input className="input mono" type="url" value={jiraBaseUrl} onChange={(e) => setJira(e.target.value)} placeholder="https://jira.example.com" required />
      </label>
      <label>
        大模型请求地址（OpenAI 兼容）
        <input className="input mono" type="url" value={llmBaseUrl} onChange={(e) => setLlmUrl(e.target.value)} placeholder="https://host/v1（可选）" required={!!llmModel.trim()} />
      </label>
      <label>
        大模型 Key
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          value={llmApiKey}
          onChange={(e) => setKey(e.target.value)}
          placeholder={current.llmKeySet ? `已配置 ${current.llmKeyMask}，留空不修改` : '未配置，填写后启用日报拆分'}
        />
      </label>
      <label>
        模型 ID
        <input className="input mono" value={llmModel} onChange={(e) => setModel(e.target.value)} placeholder="服务商提供的模型 ID（可选）" required={!!llmBaseUrl.trim()} />
      </label>
      <button className="btn primary" disabled={busy}>
        {busy ? '保存中…' : '保存设置'}
      </button>
      <div className="err" role="alert">
        {error}
      </div>
    </form>
  );
}
