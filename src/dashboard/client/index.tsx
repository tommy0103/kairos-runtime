import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('kairos-token') || '');
  const [isLogged, setIsLogged] = useState(false);
  const [activeTab, setActiveTab] = useState('status'); 
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [editingFile, setEditingFile] = useState('');
  const [content, setContent] = useState('');
  const [envContent, setEnvContent] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list');
  const logRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => { if (token) checkLogin(); }, []);

  const checkLogin = async () => {
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    if (res.ok) { setIsLogged(true); localStorage.setItem('kairos-token', token); initDashboard(); }
    else showToast("Auth Failed");
  };

  const initDashboard = () => {
    fetchStatus(); fetchFiles(); setupLogs(); fetchEnv();
    setInterval(fetchStatus, 10000);
  };

  const fetchStatus = async () => {
    const res = await fetch('/api/status', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setStatus(await res.json());
  };

  const fetchFiles = async () => {
    const res = await fetch('/api/memory/files', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setFiles(await res.json());
  };

  const fetchEnv = async () => {
    const res = await fetch('/api/config/env', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) { const data = await res.json(); setEnvContent(data.content); }
  };

  const loadFile = async (name: string) => {
    const res = await fetch(`/api/memory/content?file=${name}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      setEditingFile(name);
      setContent(data.content);
      if (window.innerWidth <= 600) setMobileView('editor');
    }
  };

  const saveFile = async () => {
    const res = await fetch('/api/memory/content', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ file: editingFile, content }) });
    if (res.ok) showToast("Memory Synced");
  };

  const saveEnv = async () => {
    const res = await fetch('/api/config/env', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ content: envContent }) });
    if (res.ok) showToast("Env Configuration Updated");
  };

  const setupLogs = () => {
    const sse = new EventSource(`/api/logs`);
    sse.onmessage = (e) => {
      setLogs(prev => [...prev.slice(-1000), e.data]);
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    };
    return () => sse.close();
  };

  const coreControl = async (action: 'restart' | 'shutdown') => {
    if (confirm(`Action: core/${action}?`)) {
      await fetch(`/api/actions/core/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      showToast(`Core ${action} signal sent`);
    }
  };

  if (!isLogged) {
    return (
      <div style={m3.loginPage}>
        <div style={m3.loginCard}>
          <span className="material-symbols-outlined" style={{fontSize: '48px', color: '#D0BCFF'}}>terminal</span>
          <h1 style={{margin: '16px 0 8px'}}>Kairos Manager</h1>
          <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Access Token" style={m3.input} />
          <button onClick={checkLogin} style={m3.btnFilled}>Enter Console</button>
        </div>
      </div>
    );
  }

  const NavItem = ({id, icon, label}: any) => (
    <div onClick={() => setActiveTab(id)} style={activeTab === id ? m3.navItemActive : m3.navItem}>
      <div style={activeTab === id ? m3.navIconActive : m3.navIcon}><span className="material-symbols-outlined">{icon}</span></div>
      <div style={m3.navLabel}>{label}</div>
    </div>
  );

  return (
    <div style={m3.appFrame}>
      {/* Navigation Rail (Desktop) */}
      <nav className="desktop-only" style={m3.navRail}>
        <div style={{margin: '24px 0'}}><span className="material-symbols-outlined" style={{color: '#D0BCFF'}}>settings_input_component</span></div>
        <NavItem id="status" label="System" icon="dashboard" />
        <NavItem id="memory" label="Memory" icon="database" />
        <NavItem id="config" label="Config" icon="settings" />
        <NavItem id="logs" label="Logs" icon="terminal" />
        <div style={{flex: 1}} />
        <button onClick={() => setToken('')} style={m3.textBtn}><span className="material-symbols-outlined">logout</span></button>
      </nav>

      <div style={m3.contentWrapper}>
        <header style={m3.topBar}>
          <div style={{fontSize: '20px', fontWeight: '500'}}>Kairos Runtime</div>
          <div style={{display: 'flex', gap: '8px'}}>
            {status?.services.map((s: any) => (
              <div key={s.name} style={s.online ? m3.chipOnline : m3.chipOffline}>{s.name}</div>
            ))}
          </div>
        </header>

        <main style={m3.pageBody}>
          {activeTab === 'status' && (
            <div style={m3.gridTwo}>
              <div style={m3.card}>
                <div style={m3.cardHeader}>Kernel Overview</div>
                <div style={m3.cardBody}>
                  {status?.services.map((s: any) => (
                    <div key={s.name} style={m3.listItem}>
                      <span>{s.name} RPC Socket</span>
                      <span style={{color: s.online ? '#81C784' : '#F2B8B5'}}>{s.online ? 'Healthy' : 'Error'}</span>
                    </div>
                  ))}
                </div>
                <div style={m3.cardActions}>
                  <button onClick={() => coreControl('shutdown')} style={m3.btnTextError}>Kill Core</button>
                  <button onClick={() => coreControl('restart')} style={m3.btnFilledSmall}>Restart Core</button>
                </div>
              </div>
              <div style={m3.card}>
                <div style={m3.cardHeader}>Adapter: UserBot</div>
                <div style={m3.cardBody}>
                  <div style={m3.listItem}><span>Session Status</span><b>{status?.adapter.status}</b></div>
                  {status?.adapter.bot && (
                    <>
                      <div style={m3.listItem}><span>Identity</span><span>{status.adapter.bot.name}</span></div>
                      <div style={m3.listItem}><span>Username</span><span>@{status.adapter.bot.username}</span></div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'memory' && (
            <div style={m3.fullContainer}>
              {(mobileView === 'list' || window.innerWidth > 600) && (
                <div style={window.innerWidth <= 600 ? m3.mobileFull : m3.sidebar}>
                  <div style={m3.sidebarHeader}>Core Knowledge</div>
                  {files.map(f => (
                    <div key={f} onClick={() => loadFile(f)} style={f === editingFile ? m3.itemActive : m3.item}>
                      <span className="material-symbols-outlined" style={{marginRight: '12px'}}>article</span>{f}
                    </div>
                  ))}
                </div>
              )}
              {(mobileView === 'editor' || window.innerWidth > 600) && editingFile && (
                <div style={m3.editorMain}>
                  <div style={m3.editorHeader}>
                    {window.innerWidth <= 600 && <button onClick={() => setMobileView('list')} style={m3.textBtn}><span className="material-symbols-outlined">arrow_back</span></button>}
                    <span>{editingFile}</span>
                    <button onClick={saveFile} style={m3.btnFilledSmall}>Save</button>
                  </div>
                  <textarea value={content} onChange={e => setContent(e.target.value)} style={m3.textarea} />
                </div>
              )}
            </div>
          )}

          {activeTab === 'config' && (
            <div style={m3.fullContainer}>
              <div style={m3.editorMain}>
                <div style={m3.editorHeader}><span>Environment Variables (.env)</span><button onClick={saveEnv} style={m3.btnFilledSmall}>Apply</button></div>
                <textarea value={envContent} onChange={e => setEnvContent(e.target.value)} style={{...m3.textarea, color: '#FFB4AB'}} />
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div style={m3.logView}>
              <div style={m3.logHeader}><span>Core Real-time Logs</span><button onClick={() => setLogs([])} style={m3.textBtnSmall}>Clear</button></div>
              <div ref={logRef} style={m3.terminal}>
                {logs.map((l, i) => <div key={i} style={m3.logLine}>{l}</div>)}
              </div>
            </div>
          )}
        </main>
      </div>

      <nav className="mobile-only" style={m3.bottomNav}>
        <NavItem id="status" label="System" icon="dashboard" />
        <NavItem id="memory" label="Memory" icon="database" />
        <NavItem id="config" label="Config" icon="settings" />
        <NavItem id="logs" label="Logs" icon="terminal" />
      </nav>

      {toast && <div style={m3.toast}>{toast}</div>}
    </div>
  );
};

const m3: any = {
  appFrame: { display: 'flex', height: '100vh', background: '#1C1B1F', color: '#E6E1E5', fontFamily: 'Roboto, sans-serif' },
  navRail: { width: '80px', background: '#2B2930', display: 'flex', flexDirection: 'column', alignItems: 'center', borderRight: '1px solid #49454F' },
  contentWrapper: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: { height: '64px', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #49454F' },
  pageBody: { flex: 1, padding: '16px', overflow: 'auto' },
  
  navItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: '#CAC4D0', padding: '16px 0', width: '100%' },
  navItemActive: { display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: '#EADDFF', padding: '16px 0', width: '100%' },
  navIcon: { padding: '4px 20px', borderRadius: '16px' },
  navIconActive: { padding: '4px 20px', borderRadius: '16px', background: '#4F378B' },
  navLabel: { fontSize: '11px', fontWeight: '500', marginTop: '4px' },

  bottomNav: { position: 'fixed', bottom: 0, left: 0, right: 0, height: '80px', background: '#2B2930', display: 'flex', justifyContent: 'space-around', alignItems: 'center', borderTop: '1px solid #49454F' },

  gridTwo: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px' },
  card: { background: '#2B2930', borderRadius: '28px', border: '1px solid #49454F', display: 'flex', flexDirection: 'column' },
  cardHeader: { padding: '20px 24px', fontSize: '18px' },
  cardBody: { padding: '0 24px 24px' },
  cardActions: { padding: '12px 24px', background: '#25232a', display: 'flex', justifyContent: 'space-between' },
  listItem: { display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #333', fontSize: '14px' },

  fullContainer: { display: 'flex', height: '100%', gap: '16px' },
  sidebar: { width: '260px', background: '#2B2930', borderRadius: '28px', padding: '12px', overflowY: 'auto' },
  mobileFull: { width: '100%', background: '#2B2930', borderRadius: '28px', padding: '12px' },
  editorMain: { flex: 1, display: 'flex', flexDirection: 'column', background: '#2B2930', borderRadius: '28px', overflow: 'hidden' },
  sidebarHeader: { padding: '12px 16px', fontSize: '12px', color: '#938F99', fontWeight: '500' },
  item: { display: 'flex', alignItems: 'center', padding: '12px 16px', borderRadius: '20px', cursor: 'pointer', fontSize: '14px' },
  itemActive: { display: 'flex', alignItems: 'center', padding: '12px 16px', borderRadius: '20px', background: '#4F378B', fontSize: '14px' },
  editorHeader: { padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#333' },
  textarea: { flex: 1, background: '#1C1B1F', color: '#E6E1E5', border: 'none', padding: '20px', resize: 'none', outline: 'none', fontFamily: 'monospace', fontSize: '14px', lineHeight: '1.6' },

  logView: { height: '100%', display: 'flex', flexDirection: 'column', background: '#000', borderRadius: '28px', padding: '16px', border: '1px solid #49454F' },
  logHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '12px', color: '#938F99', fontSize: '14px' },
  terminal: { flex: 1, overflowY: 'auto', padding: '8px', color: '#D0BCFF', fontSize: '11px', fontFamily: 'monospace' },
  logLine: { padding: '2px 0', borderBottom: '1px solid #111', whiteSpace: 'pre-wrap' },

  chipOnline: { background: '#1B3921', color: '#81C784', padding: '2px 12px', borderRadius: '12px', fontSize: '11px' },
  chipOffline: { background: '#370B0B', color: '#F2B8B5', padding: '2px 12px', borderRadius: '12px', fontSize: '11px' },
  btnFilled: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '12px 24px', borderRadius: '20px', fontWeight: '500', cursor: 'pointer' },
  btnFilledSmall: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '6px 16px', borderRadius: '12px', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  btnTonalError: { background: '#8C1D18', color: '#F9DEDC', border: 'none', padding: '8px 16px', borderRadius: '12px', cursor: 'pointer', fontSize: '13px' },
  btnTextError: { background: 'transparent', color: '#F2B8B5', border: 'none', cursor: 'pointer' },
  textBtn: { background: 'transparent', color: '#D0BCFF', border: 'none', cursor: 'pointer' },
  textBtnSmall: { background: 'transparent', color: '#D0BCFF', border: 'none', cursor: 'pointer', fontSize: '12px' },
  input: { background: 'transparent', border: '1px solid #938F99', borderRadius: '4px', padding: '12px', color: '#fff', width: '100%', marginBottom: '16px' },
  toast: { position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#fff', padding: '12px 24px', borderRadius: '12px', fontSize: '14px', zIndex: 1000 },
  loginPage: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  loginCard: { width: '320px', padding: '48px', background: '#2B2930', borderRadius: '28px', textAlign: 'center', border: '1px solid #49454F' },
};

createRoot(document.getElementById('root')!).render(<App />);
