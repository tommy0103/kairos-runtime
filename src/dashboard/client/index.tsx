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
  const logRef = useRef<HTMLDivElement>(null);

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
        alert("Invalid Token");
      }
    } catch (e) {
      alert("Login connection failed");
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
    }
  };

  const saveFile = async () => {
    const res = await fetch('/api/memory/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ file: editingFile, content })
    });
    if (res.ok) alert("Memory Saved!");
  };

  const setupLogs = () => {
    const sse = new EventSource(`/api/logs`);
    sse.onmessage = (e) => {
      setLogs(prev => [...prev.slice(-500), e.data]);
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    };
    return () => sse.close();
  };

  if (!isLogged) {
    return (
      <div style={m3.loginPage}>
        <div style={m3.loginCard}>
          <h1 style={{fontSize: '32px', marginBottom: '8px'}}>Kairos</h1>
          <p style={{color: '#938F99', marginBottom: '32px'}}>Admin Authentication</p>
          <input 
            type="password" 
            value={token} 
            onChange={e => setToken(e.target.value)} 
            placeholder="System Token"
            style={m3.input}
          />
          <button onClick={checkLogin} style={m3.btnFilled}>Login</button>
        </div>
      </div>
    );
  }

  const NavItem = ({id, icon, label}: any) => (
    <div 
      onClick={() => setActiveTab(id)} 
      style={activeTab === id ? m3.navItemActive : m3.navItem}
    >
      <div style={m3.navIconContainer}>{icon}</div>
      <div style={{fontSize: '12px', fontWeight: '500'}}>{label}</div>
    </div>
  );

  return (
    <div style={m3.appFrame}>
      {/* 桌面端导航轨 (Navigation Rail) */}
      <nav className="desktop-only" style={m3.navRail}>
        <div style={{fontSize: '24px', marginBottom: '32px'}}>❄️</div>
        <NavItem id="status" label="Status" icon="📊" />
        <NavItem id="memory" label="Memory" icon="🧠" />
        <NavItem id="logs" label="Logs" icon="📜" />
        <div style={{flex: 1}} />
        <button onClick={() => setToken('')} style={m3.textBtn}>Exit</button>
      </nav>

      <div style={m3.contentWrapper}>
        <header style={m3.topBar}>
          <div style={{fontSize: '22px'}}>Yuki Mochi</div>
          <div style={{display: 'flex', gap: '8px'}}>
            {status?.services.map((s: any) => (
              <div key={s.name} style={s.online ? m3.chipOnline : m3.badgeOffline}>{s.name}</div>
            ))}
          </div>
        </header>

        <main className="main-content" style={m3.pageBody}>
          {activeTab === 'status' && (
            <div style={m3.viewContainer}>
              <div style={m3.card}>
                <div style={m3.cardHeader}>System Components</div>
                <div style={{padding: '16px'}}>
                  {status?.services.map((s: any) => (
                    <div key={s.name} style={m3.listItem}>
                      <span>{s.name} Runtime</span>
                      <span style={{color: s.online ? '#81C784' : '#E57373'}}>{s.online ? 'Healthy' : 'Disconnected'}</span>
                    </div>
                  ))}
                </div>
                <div style={m3.cardActions}>
                  <button onClick={() => fetch('/api/actions/restart', {method:'POST', headers:{Authorization: `Bearer ${token}`}})} style={m3.btnTonalError}>
                    Reboot Application
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'memory' && (
            <div style={m3.splitView}>
              <div style={m3.splitSidebar}>
                <div style={m3.sidebarHeader}>Identity Files</div>
                {files.map(f => (
                  <div key={f} onClick={() => loadFile(f)} style={f === editingFile ? m3.sidebarItemActive : m3.sidebarItem}>
                    {f}
                  </div>
                ))}
              </div>
              <div style={m3.splitMain}>
                {editingFile ? (
                  <>
                    <div style={m3.editorHeader}>
                      <span>{editingFile}</span>
                      <button onClick={saveFile} style={m3.btnFilledSmall}>Sync</button>
                    </div>
                    <textarea value={content} onChange={e => setContent(e.target.value)} style={m3.textarea} />
                  </>
                ) : <div style={m3.emptyState}>Open a memory file to read/write</div>}
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div style={m3.fullView}>
              <div style={m3.logControls}>
                <span>Streaming Kernel Logs</span>
                <button onClick={() => setLogs([])} style={m3.textBtn}>Clear</button>
              </div>
              <div ref={logRef} style={m3.console}>
                {logs.map((l, i) => <div key={i} style={m3.logEntry}>{l}</div>)}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* 移动端导航 (Bottom Navigation) */}
      <nav className="mobile-only" style={m3.bottomNav}>
        <NavItem id="status" label="Status" icon="📊" />
        <NavItem id="memory" label="Memory" icon="🧠" />
        <NavItem id="logs" label="Logs" icon="📜" />
      </nav>
    </div>
  );
};

const m3: any = {
  appFrame: { display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' },
  navRail: { width: '80px', background: '#2B2930', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', borderRight: '1px solid #49454F' },
  contentWrapper: { flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  topBar: { height: '64px', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #49454F' },
  pageBody: { flex: 1, overflowY: 'auto', padding: '16px', position: 'relative' },
  
  // Navigation Items
  navItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#CAC4D0', padding: '12px 0', width: '100%' },
  navItemActive: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#EADDFF', padding: '12px 0', width: '100%' },
  navIconContainer: { padding: '4px 20px', borderRadius: '16px', fontSize: '20px' },

  // Bottom Nav (Mobile)
  bottomNav: { position: 'fixed', bottom: 0, left: 0, right: 0, height: '80px', background: '#2B2930', display: 'flex', justifyContent: 'space-around', alignItems: 'center', borderTop: '1px solid #49454F', zIndex: 100 },

  // Cards & Views
  viewContainer: { maxWidth: '600px', margin: '0 auto' },
  card: { background: '#2B2930', borderRadius: '28px', overflow: 'hidden', marginBottom: '16px' },
  cardHeader: { padding: '20px 24px', fontSize: '18px', borderBottom: '1px solid #49454F' },
  cardActions: { padding: '16px 24px', background: '#25232a', textAlign: 'right' },
  listItem: { display: 'flex', justifyContent: 'space-between', padding: '16px 0', borderBottom: '1px solid #333' },

  // Split View (Memory)
  splitView: { display: 'flex', height: '100%', background: '#2B2930', borderRadius: '28px', overflow: 'hidden' },
  splitSidebar: { width: '240px', borderRight: '1px solid #49454F', padding: '12px', overflowY: 'auto' },
  splitMain: { flex: 1, display: 'flex', flexDirection: 'column' },
  sidebarHeader: { padding: '12px 16px', fontSize: '14px', color: '#938F99' },
  sidebarItem: { padding: '12px 16px', borderRadius: '20px', cursor: 'pointer', transition: 'background 0.2s' },
  sidebarItemActive: { padding: '12px 16px', borderRadius: '20px', background: '#4F378B', color: '#EADDFF' },
  editorHeader: { padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #49454F' },
  textarea: { flex: 1, background: 'transparent', color: '#fff', border: 'none', padding: '24px', resize: 'none', outline: 'none', fontFamily: 'monospace', fontSize: '14px', lineHeight: '1.6' },

  // Logs View
  fullView: { display: 'flex', flexDirection: 'column', height: '100%', background: '#141218', borderRadius: '28px', padding: '16px' },
  logControls: { display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px', color: '#938F99' },
  console: { flex: 1, overflowY: 'auto', padding: '12px', color: '#D0BCFF', fontSize: '12px', fontFamily: 'Fira Code, monospace' },
  logEntry: { padding: '2px 0', borderBottom: '1px solid #222' },

  // Status Badges
  chipOnline: { background: '#2e7d32', padding: '2px 12px', borderRadius: '16px', fontSize: '12px' },
  badgeOffline: { background: '#c62828', padding: '2px 12px', borderRadius: '16px', fontSize: '12px' },

  // Buttons & Inputs
  btnFilled: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '12px 24px', borderRadius: '20px', fontWeight: '500', cursor: 'pointer', width: '100%' },
  btnFilledSmall: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '6px 16px', borderRadius: '12px', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  btnTonalError: { background: '#8C1D18', color: '#F9DEDC', border: 'none', padding: '12px 24px', borderRadius: '20px', cursor: 'pointer' },
  textBtn: { background: 'transparent', color: '#D0BCFF', border: 'none', cursor: 'pointer', fontWeight: '500' },
  input: { background: 'transparent', border: '1px solid #938F99', borderRadius: '4px', padding: '12px', color: '#fff', width: '100%', marginBottom: '16px' },

  // Login
  loginPage: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  loginCard: { width: '320px', padding: '48px', background: '#2B2930', borderRadius: '28px', textAlign: 'center' },
  emptyState: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#938F99' }
};

createRoot(document.getElementById('root')!).render(<App />);
