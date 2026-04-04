import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('kairos-token') || '');
  const [isLogged, setIsLogged] = useState(false);
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
      }
    } catch (e) {
      alert("Login failed");
    }
  };

  const initDashboard = () => {
    fetchStatus();
    fetchFiles();
    setupLogs();
    setInterval(fetchStatus, 5000);
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
    if (res.ok) alert("Memory Synced!");
  };

  const setupLogs = () => {
    const sse = new EventSource(`/api/logs`);
    sse.onmessage = (e) => {
      setLogs(prev => [...prev.slice(-300), e.data]);
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    };
    return () => sse.close();
  };

  if (!isLogged) {
    return (
      <div style={m3.loginPage}>
        <div style={m3.loginCard}>
          <h1 style={m3.headlineLarge}>Kairos Admin</h1>
          <p style={m3.bodyMedium}>Please authenticate to access Yuki's heart.</p>
          <input 
            type="password" 
            value={token} 
            onChange={e => setToken(e.target.value)} 
            placeholder="Admin Token"
            style={m3.textField}
          />
          <button onClick={checkLogin} style={m3.filledButton}>Authenticate</button>
        </div>
      </div>
    );
  }

  return (
    <div style={m3.appContainer}>
      {/* M3 Top App Bar */}
      <header style={m3.topAppBar}>
        <div style={m3.titleContainer}>
          <span style={m3.headlineSmall}>Yuki Dashboard</span>
          <div style={m3.badgeRow}>
            {status?.services.map((s: any) => (
              <div key={s.name} style={s.online ? m3.badgeOnline : m3.badgeOffline}>
                {s.name}
              </div>
            ))}
          </div>
        </div>
        <button onClick={() => setToken('')} style={m3.textButton}>Logout</button>
      </header>

      <div style={m3.mainContent}>
        {/* M3 Navigation Drawer */}
        <nav style={m3.navigationDrawer}>
          <div style={m3.drawerHeader}>Memory Storage</div>
          {files.map(f => (
            <div 
              key={f} 
              onClick={() => loadFile(f)} 
              style={f === editingFile ? m3.drawerItemActive : m3.drawerItem}
            >
              <span style={{marginRight: '12px'}}>📄</span> {f}
            </div>
          ))}
          <div style={{flex: 1}} />
          <button 
            onClick={() => fetch('/api/actions/restart', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })} 
            style={m3.tonalButtonDanger}
          >
            Restart System
          </button>
        </nav>

        {/* M3 Main Body */}
        <main style={m3.bodyGrid}>
          {/* Editor Section */}
          <section style={m3.card}>
            <div style={m3.cardHeader}>
              <h3 style={m3.titleMedium}>{editingFile ? `Editing: ${editingFile}` : 'Memory Editor'}</h3>
              {editingFile && <button onClick={saveFile} style={m3.filledButtonSmall}>Save</button>}
            </div>
            {editingFile ? (
              <textarea 
                value={content} 
                onChange={e => setContent(e.target.value)} 
                style={m3.editorArea}
              />
            ) : (
              <div style={m3.emptyState}>Select a memory file from the left to start.</div>
            )}
          </section>

          {/* Logs Section */}
          <section style={m3.card}>
            <div style={m3.cardHeader}>
              <h3 style={m3.titleMedium}>Live System Logs</h3>
            </div>
            <div ref={logRef} style={m3.logViewport}>
              {logs.map((line, i) => (
                <div key={i} style={m3.logLine}>{line}</div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
};

// Material 3 Design System (Dark Theme)
const m3: any = {
  // Colors (M3 Dark Palette)
  colors: {
    primary: '#D0BCFF',
    onPrimary: '#381E72',
    primaryContainer: '#4F378B',
    surface: '#1C1B1F',
    onSurface: '#E6E1E5',
    surfaceVariant: '#49454F',
    onSurfaceVariant: '#CAC4D0',
    outline: '#938F99',
    error: '#F2B8B5',
    onError: '#601410',
  },

  appContainer: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#1C1B1F',
    color: '#E6E1E5',
    fontFamily: '"Roboto", "Segoe UI", sans-serif',
  },

  topAppBar: {
    height: '64px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
    background: '#1C1B1F',
  },

  titleContainer: { display: 'flex', alignItems: 'center', gap: '24px' },
  badgeRow: { display: 'flex', gap: '8px' },

  badgeOnline: {
    background: '#2e7d32', color: '#fff', padding: '2px 12px', borderRadius: '16px', fontSize: '12px', fontWeight: '500'
  },
  badgeOffline: {
    background: '#c62828', color: '#fff', padding: '2px 12px', borderRadius: '16px', fontSize: '12px', fontWeight: '500'
  },

  mainContent: { display: 'flex', flex: 1, overflow: 'hidden', padding: '0 16px 16px 16px' },

  navigationDrawer: {
    width: '280px',
    background: '#2B2930',
    borderRadius: '28px',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    marginRight: '16px',
  },

  drawerHeader: { padding: '18px 16px', fontSize: '14px', fontWeight: '500', color: '#CAC4D0' },
  drawerItem: {
    padding: '16px', borderRadius: '28px', cursor: 'pointer', fontSize: '14px', transition: 'background 0.2s'
  },
  drawerItemActive: {
    padding: '16px', borderRadius: '28px', cursor: 'pointer', fontSize: '14px', background: '#4F378B', color: '#EADDFF', fontWeight: '500'
  },

  bodyGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', flex: 1 },

  card: {
    background: '#2B2930',
    borderRadius: '24px',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },

  cardHeader: {
    padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
  },

  editorArea: {
    flex: 1, background: 'transparent', color: '#E6E1E5', padding: '0 24px 24px 24px', border: 'none', resize: 'none', 
    fontSize: '14px', lineHeight: '1.6', outline: 'none', fontFamily: 'monospace'
  },

  logViewport: {
    flex: 1, background: '#141218', margin: '0 16px 16px 16px', borderRadius: '16px', padding: '12px', 
    overflowY: 'auto', fontSize: '11px', fontFamily: '"Fira Code", monospace'
  },
  logLine: { padding: '2px 0', borderBottom: '1px solid #211F26', color: '#D0BCFF' },

  emptyState: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', color: '#938F99' },

  // Buttons
  filledButton: {
    background: '#D0BCFF', color: '#381E72', border: 'none', padding: '12px 24px', borderRadius: '20px', 
    fontWeight: '500', cursor: 'pointer', marginTop: '16px'
  },
  filledButtonSmall: {
    background: '#D0BCFF', color: '#381E72', border: 'none', padding: '6px 16px', borderRadius: '16px', 
    fontWeight: '500', cursor: 'pointer', fontSize: '12px'
  },
  tonalButtonDanger: {
    background: '#8C1D18', color: '#F9DEDC', border: 'none', padding: '12px', borderRadius: '20px', 
    fontWeight: '500', cursor: 'pointer'
  },
  textButton: { background: 'transparent', color: '#D0BCFF', border: 'none', cursor: 'pointer', fontWeight: '500' },

  // Typography & Inputs
  headlineLarge: { fontSize: '32px', fontWeight: '400', marginBottom: '8px' },
  headlineSmall: { fontSize: '24px', fontWeight: '400' },
  titleMedium: { fontSize: '16px', fontWeight: '500' },
  bodyMedium: { fontSize: '14px', color: '#CAC4D0', marginBottom: '24px' },

  textField: {
    background: 'transparent', border: '1px solid #938F99', borderRadius: '4px', padding: '12px', 
    color: '#fff', width: '100%', boxSizing: 'border-box'
  },

  loginPage: {
    height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1C1B1F'
  },
  loginCard: {
    width: '320px', padding: '48px', background: '#2B2930', borderRadius: '28px', textAlign: 'center'
  }
};

createRoot(document.getElementById('root')!).render(<App />);
