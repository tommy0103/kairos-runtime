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
  const [toast, setToast] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    if (token) checkLogin();
  }, []);

  const checkLogin = async () => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (res.ok) {
        setIsLogged(true);
        localStorage.setItem('kairos-token', token);
        initDashboard();
      } else {
        showToast("Invalid Token", "error");
      }
    } catch (e) {
      showToast("Server unreachable", "error");
    }
  };

  const initDashboard = () => {
    fetchStatus();
    fetchFiles();
    setupLogs();
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

  const loadFile = async (name: string) => {
    const res = await fetch(`/api/memory/content?file=${name}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      setEditingFile(name);
      setContent(data.content);
      showToast(`Loaded ${name}`);
    }
  };

  const saveFile = async () => {
    try {
      const res = await fetch('/api/memory/content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ file: editingFile, content })
      });
      if (res.ok) showToast("Memory Synced Successfully!");
    } catch (e) {
      showToast("Failed to save", "error");
    }
  };

  const setupLogs = () => {
    const sse = new EventSource(`/api/logs`);
    sse.onmessage = (e) => {
      setLogs(prev => [...prev.slice(-1000), e.data]);
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    };
    sse.onerror = () => {
      console.warn("Log stream error, retrying...");
    };
    return () => sse.close();
  };

  const shutdown = async () => {
    if (confirm("Shutdown Dashboard container?")) {
      await fetch('/api/actions/shutdown', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      showToast("Dashboard stopping...");
      setTimeout(() => window.close(), 2000);
    }
  };

  if (!isLogged) {
    return (
      <div style={m3.loginPage}>
        <div style={m3.loginCard}>
          <span className="material-symbols-outlined" style={{fontSize: '48px', color: '#D0BCFF', marginBottom: '16px'}}>lock</span>
          <h1 style={{fontSize: '28px', marginBottom: '8px', fontWeight: '400'}}>Kairos Admin</h1>
          <p style={{color: '#938F99', marginBottom: '32px', fontSize: '14px'}}>Authenticate to manage Yuki</p>
          <input 
            type="password" 
            value={token} 
            onChange={e => setToken(e.target.value)} 
            placeholder="System Token"
            style={m3.input}
          />
          <button onClick={checkLogin} style={m3.btnFilled}>Login</button>
        </div>
        {toast && <div style={m3.snackbar}>{toast.msg}</div>}
      </div>
    );
  }

  const NavItem = ({id, icon, label}: any) => (
    <div 
      onClick={() => setActiveTab(id)} 
      style={activeTab === id ? m3.navItemActive : m3.navItem}
    >
      <div style={activeTab === id ? m3.navIconContainerActive : m3.navIconContainer}>
        <span className="material-symbols-outlined">{icon}</span>
      </div>
      <div style={{fontSize: '12px', fontWeight: '500', marginTop: '4px'}}>{label}</div>
    </div>
  );

  return (
    <div style={m3.appFrame}>
      {/* Sidebar (Desktop) */}
      <nav className="desktop-only" style={m3.navRail}>
        <div style={{height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          <span className="material-symbols-outlined" style={{color: '#D0BCFF'}}>smart_toy</span>
        </div>
        <NavItem id="status" label="Status" icon="analytics" />
        <NavItem id="memory" label="Memory" icon="psychology" />
        <NavItem id="logs" label="Logs" icon="terminal" />
        <div style={{flex: 1}} />
        <button onClick={() => setToken('')} style={m3.textBtn} title="Logout">
          <span className="material-symbols-outlined">logout</span>
        </button>
      </nav>

      <div style={m3.contentWrapper}>
        <header style={m3.topBar}>
          <div style={{fontSize: '20px', fontWeight: '400'}}>Yuki Mochi Dashboard</div>
          <div style={{display: 'flex', gap: '8px'}}>
            {status?.services.map((s: any) => (
              <div key={s.name} style={s.online ? m3.chipOnline : m3.chipOffline}>
                <span className="material-symbols-outlined" style={{fontSize: '14px', marginRight: '4px'}}>
                  {s.online ? 'check_circle' : 'error'}
                </span>
                {s.name}
              </div>
            ))}
          </div>
        </header>

        <main className="main-content" style={m3.pageBody}>
          {activeTab === 'status' && (
            <div style={m3.viewContainer}>
              <div style={m3.card}>
                <div style={m3.cardHeader}>System Components</div>
                <div style={{padding: '16px 24px'}}>
                  {status?.services.map((s: any) => (
                    <div key={s.name} style={m3.listItem}>
                      <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
                        <span className="material-symbols-outlined" style={{color: s.online ? '#D0BCFF' : '#F2B8B5'}}>{s.name === 'VFS' ? 'database' : 'memory'}</span>
                        <span style={{fontSize: '16px'}}>{s.name} Service</span>
                      </div>
                      <span style={{fontSize: '14px', color: s.online ? '#81C784' : '#E57373'}}>{s.online ? 'Running' : 'Disconnected'}</span>
                    </div>
                  ))}
                </div>
                <div style={m3.cardActions}>
                  <button onClick={shutdown} style={m3.textBtnError}>Shutdown Panel</button>
                  <button onClick={() => fetch('/api/actions/restart', {method:'POST', headers:{Authorization: `Bearer ${token}`}})} style={m3.btnTonalError}>
                    Reboot All
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'memory' && (
            <div style={m3.splitView}>
              <div style={m3.splitSidebar}>
                <div style={m3.sidebarHeader}>Core Files</div>
                {files.map(f => (
                  <div key={f} onClick={() => loadFile(f)} style={f === editingFile ? m3.sidebarItemActive : m3.sidebarItem}>
                    <span className="material-symbols-outlined" style={{fontSize: '18px', marginRight: '12px'}}>description</span>
                    {f}
                  </div>
                ))}
              </div>
              <div style={m3.splitMain}>
                {editingFile ? (
                  <>
                    <div style={m3.editorHeader}>
                      <span style={{fontWeight: '500'}}>{editingFile}</span>
                      <button onClick={saveFile} style={m3.btnFilledSmall}>Save Changes</button>
                    </div>
                    <textarea value={content} onChange={e => setContent(e.target.value)} style={m3.textarea} />
                  </>
                ) : (
                  <div style={m3.emptyState}>
                    <span className="material-symbols-outlined" style={{fontSize: '64px', marginBottom: '16px'}}>edit_note</span>
                    <span>Select a file to edit Yuki's memory</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div style={m3.fullView}>
              <div style={m3.logControls}>
                <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                  <span className="material-symbols-outlined" style={{fontSize: '18px'}}>reorder</span>
                  Kernel Stream
                </div>
                <button onClick={() => setLogs([])} style={m3.textBtnSmall}>Clear Logs</button>
              </div>
              <div ref={logRef} style={m3.console}>
                {logs.length > 0 ? logs.map((l, i) => <div key={i} style={m3.logEntry}>{l}</div>) : <div style={{color: '#49454F'}}>Waiting for logs...</div>}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Bottom Nav (Mobile) */}
      <nav className="mobile-only" style={m3.bottomNav}>
        <NavItem id="status" label="Status" icon="analytics" />
        <NavItem id="memory" label="Memory" icon="psychology" />
        <NavItem id="logs" label="Logs" icon="terminal" />
      </nav>

      {/* Feedback Toast */}
      {toast && <div style={m3.snackbar}>{toast.msg}</div>}
    </div>
  );
};

const m3: any = {
  appFrame: { display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' },
  navRail: { width: '80px', background: '#2B2930', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0', borderRight: '1px solid #49454F' },
  contentWrapper: { flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  topBar: { height: '64px', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #49454F' },
  pageBody: { flex: 1, overflowY: 'hidden', padding: '16px', position: 'relative' },
  
  navItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: '#CAC4D0', padding: '12px 0', width: '100%' },
  navItemActive: { display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', color: '#EADDFF', padding: '12px 0', width: '100%' },
  navIconContainer: { padding: '4px 20px', borderRadius: '16px', transition: 'background 0.2s' },
  navIconContainerActive: { padding: '4px 20px', borderRadius: '16px', background: '#4F378B', color: '#EADDFF' },

  bottomNav: { position: 'fixed', bottom: 0, left: 0, right: 0, height: '80px', background: '#2B2930', display: 'flex', justifyContent: 'space-around', alignItems: 'center', borderTop: '1px solid #49454F', zIndex: 100 },

  viewContainer: { maxWidth: '600px', margin: '0 auto', height: '100%' },
  card: { background: '#2B2930', borderRadius: '28px', overflow: 'hidden', border: '1px solid #49454F' },
  cardHeader: { padding: '24px 24px 16px 24px', fontSize: '20px', fontWeight: '400' },
  cardActions: { padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#25232a' },
  listItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 0', borderBottom: '1px solid #333' },

  splitView: { display: 'flex', height: '100%', background: '#2B2930', borderRadius: '28px', overflow: 'hidden', border: '1px solid #49454F' },
  splitSidebar: { width: '260px', borderRight: '1px solid #49454F', padding: '12px', overflowY: 'auto' },
  splitMain: { flex: 1, display: 'flex', flexDirection: 'column', background: '#1C1B1F' },
  sidebarHeader: { padding: '12px 16px', fontSize: '12px', color: '#938F99', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '1px' },
  sidebarItem: { display: 'flex', alignItems: 'center', padding: '12px 16px', borderRadius: '24px', cursor: 'pointer', marginBottom: '4px', fontSize: '14px', transition: 'all 0.2s' },
  sidebarItemActive: { display: 'flex', alignItems: 'center', padding: '12px 16px', borderRadius: '24px', background: '#4F378B', color: '#EADDFF', marginBottom: '4px', fontSize: '14px' },
  editorHeader: { padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#2B2930', borderBottom: '1px solid #49454F' },
  textarea: { flex: 1, background: 'transparent', color: '#E6E1E5', border: 'none', padding: '24px', resize: 'none', outline: 'none', fontFamily: '"Fira Code", monospace', fontSize: '14px', lineHeight: '1.6' },

  fullView: { display: 'flex', flexDirection: 'column', height: '100%', background: '#141218', borderRadius: '28px', padding: '16px', border: '1px solid #49454F' },
  logControls: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', padding: '0 8px', color: '#938F99' },
  console: { flex: 1, overflowY: 'auto', padding: '16px', color: '#D0BCFF', fontSize: '12px', fontFamily: '"Fira Code", monospace', background: '#000', borderRadius: '16px' },
  logEntry: { padding: '2px 0', borderBottom: '1px solid #1a1a1a', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },

  chipOnline: { background: '#1B3921', color: '#81C784', padding: '4px 12px', borderRadius: '8px', fontSize: '12px', display: 'flex', alignItems: 'center', fontWeight: '500' },
  chipOffline: { background: '#370B0B', color: '#F2B8B5', padding: '4px 12px', borderRadius: '8px', fontSize: '12px', display: 'flex', alignItems: 'center', fontWeight: '500' },

  btnFilled: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '12px 24px', borderRadius: '20px', fontWeight: '500', cursor: 'pointer', width: '100%' },
  btnFilledSmall: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '8px 20px', borderRadius: '100px', fontSize: '14px', fontWeight: '500', cursor: 'pointer' },
  btnTonalError: { background: '#8C1D18', color: '#F9DEDC', border: 'none', padding: '10px 20px', borderRadius: '100px', fontWeight: '500', cursor: 'pointer' },
  textBtn: { background: 'transparent', color: '#D0BCFF', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' },
  textBtnSmall: { background: 'transparent', color: '#D0BCFF', border: 'none', cursor: 'pointer', fontSize: '12px' },
  textBtnError: { background: 'transparent', color: '#F2B8B5', border: 'none', cursor: 'pointer', fontSize: '14px' },
  input: { background: 'transparent', border: '1px solid #938F99', borderRadius: '4px', padding: '12px', color: '#fff', width: '100%', marginBottom: '16px', fontSize: '16px' },

  snackbar: { position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)', background: '#333', color: '#fff', padding: '12px 24px', borderRadius: '12px', fontSize: '14px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', zIndex: 1000 },
  loginPage: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  loginCard: { width: '320px', padding: '48px', background: '#2B2930', borderRadius: '28px', textAlign: 'center', border: '1px solid #49454F' },
  emptyState: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#938F99', gap: '16px' }
};

createRoot(document.getElementById('root')!).render(<App />);
