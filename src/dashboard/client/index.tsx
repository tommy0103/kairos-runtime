import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

const App = () => {
  const [token, setToken] = useState(localStorage.getItem('kairos-token') || '');
  const [isLogged, setIsLogged] = useState(false);
  const [activeTab, setActiveTab] = useState('status'); // 'status', 'memory', 'logs'
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
    if (res.ok) alert("Memory Synced!");
  };

  const setupLogs = () => {
    const sse = new EventSource(`/api/logs`);
    sse.onmessage = (e) => {
      setLogs(prev => [...prev.slice(-1000), e.data]);
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    };
    return () => sse.close();
  };

  if (!isLogged) {
    return (
      <div style={m3.loginPage}>
        <div style={m3.loginCard}>
          <h1 style={m3.headlineLarge}>Kairos Admin</h1>
          <p style={m3.bodyMedium}>Yuki is waiting for her master...</p>
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

  const renderContent = () => {
    switch(activeTab) {
      case 'status': return (
        <div style={m3.pageContainer}>
          <div style={m3.card}>
            <div style={m3.cardHeader}><h2 style={m3.titleLarge}>System Health</h2></div>
            <div style={m3.cardBody}>
              {status?.services.map((s: any) => (
                <div key={s.name} style={m3.statusListItem}>
                  <div style={m3.statusName}>{s.name}</div>
                  <div style={s.online ? m3.badgeOnline : m3.badgeOffline}>{s.online ? 'Running' : 'Offline'}</div>
                </div>
              ))}
            </div>
            <div style={m3.cardFooter}>
              <button onClick={() => fetch('/api/actions/restart', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })} style={m3.tonalButtonDanger}>
                Restart Application
              </button>
            </div>
          </div>
        </div>
      );
      case 'memory': return (
        <div style={m3.pageContainerMemory}>
          <aside style={m3.drawer}>
            <div style={m3.drawerHeader}>Memory Files</div>
            {files.map(f => (
              <div key={f} onClick={() => loadFile(f)} style={f === editingFile ? m3.drawerItemActive : m3.drawerItem}>
                {f}
              </div>
            ))}
          </aside>
          <div style={m3.editorCard}>
            {editingFile ? (
              <>
                <div style={m3.cardHeader}>
                  <h3 style={m3.titleMedium}>{editingFile}</h3>
                  <button onClick={saveFile} style={m3.filledButtonSmall}>Sync Memory</button>
                </div>
                <textarea value={content} onChange={e => setContent(e.target.value)} style={m3.editorArea} />
              </>
            ) : <div style={m3.emptyState}>Select a file to edit</div>}
          </div>
        </div>
      );
      case 'logs': return (
        <div style={m3.logPageContainer}>
          <div style={m3.logHeader}>
            <h3 style={m3.titleMedium}>Live Stream Output</h3>
            <button onClick={() => setLogs([])} style={m3.textButton}>Clear</button>
          </div>
          <div ref={logRef} style={m3.terminal}>
            {logs.map((line, i) => <div key={i} style={m3.logLine}>{line}</div>)}
          </div>
        </div>
      );
      default: return null;
    }
  };

  return (
    <div style={m3.appContainer}>
      <header style={m3.topAppBar}>
        <div style={m3.headlineSmall}>Yuki Dashboard</div>
        <button onClick={() => setToken('')} style={m3.textButton}>Logout</button>
      </header>
      
      <main style={m3.mainBody}>{renderContent()}</main>

      <nav style={m3.bottomNav}>
        {[
          { id: 'status', label: 'Status', icon: '📈' },
          { id: 'memory', label: 'Memory', icon: '🧠' },
          { id: 'logs', label: 'Logs', icon: '📜' }
        ].map(tab => (
          <div key={tab.id} onClick={() => setActiveTab(tab.id)} style={activeTab === tab.id ? m3.navItemActive : m3.navItem}>
            <div style={m3.navIcon}>{tab.icon}</div>
            <div style={m3.navLabel}>{tab.label}</div>
          </div>
        ))}
      </nav>
    </div>
  );
};

const m3: any = {
  appContainer: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#1C1B1F', color: '#E6E1E5', fontFamily: 'Roboto, sans-serif' },
  topAppBar: { height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', background: '#1C1B1F' },
  mainBody: { flex: 1, overflow: 'hidden', padding: '16px' },
  bottomNav: { height: '80px', background: '#2B2930', display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '0 8px' },
  
  navItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#CAC4D0' },
  navItemActive: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#EADDFF' },
  navIcon: { fontSize: '24px', padding: '4px 20px', borderRadius: '16px', transition: 'background 0.2s' },
  navLabel: { fontSize: '12px', fontWeight: '500' },

  pageContainer: { maxWidth: '800px', margin: '0 auto', width: '100%' },
  pageContainerMemory: { display: 'flex', gap: '16px', height: '100%' },
  logPageContainer: { display: 'flex', flexDirection: 'column', height: '100%', background: '#141218', borderRadius: '24px', padding: '16px', overflow: 'hidden' },

  card: { background: '#2B2930', borderRadius: '24px', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  cardHeader: { padding: '16px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #49454F' },
  cardBody: { padding: '24px' },
  cardFooter: { padding: '16px 24px', background: '#25232a', display: 'flex', justifyContent: 'flex-end' },

  statusListItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #333' },
  statusName: { fontSize: '16px', fontWeight: '500' },

  drawer: { width: '240px', background: '#2B2930', borderRadius: '24px', padding: '12px', overflowY: 'auto' },
  drawerHeader: { padding: '12px 16px', fontSize: '14px', color: '#938F99' },
  drawerItem: { padding: '12px 16px', borderRadius: '24px', cursor: 'pointer', fontSize: '14px' },
  drawerItemActive: { padding: '12px 16px', borderRadius: '24px', cursor: 'pointer', fontSize: '14px', background: '#4F378B', color: '#EADDFF' },

  editorCard: { flex: 1, background: '#2B2930', borderRadius: '24px', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  editorArea: { flex: 1, background: 'transparent', color: '#E6E1E5', padding: '24px', border: 'none', resize: 'none', outline: 'none', fontFamily: 'Fira Code, monospace', lineHeight: '1.6' },

  terminal: { flex: 1, overflowY: 'auto', background: '#000', borderRadius: '16px', padding: '12px', fontSize: '12px', color: '#D0BCFF', fontFamily: 'monospace' },
  logHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  logLine: { padding: '2px 0', borderBottom: '1px solid #222' },

  filledButton: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '12px 24px', borderRadius: '20px', fontWeight: '500', cursor: 'pointer' },
  filledButtonSmall: { background: '#D0BCFF', color: '#381E72', border: 'none', padding: '6px 16px', borderRadius: '12px', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  tonalButtonDanger: { background: '#8C1D18', color: '#F9DEDC', border: 'none', padding: '12px 24px', borderRadius: '20px', cursor: 'pointer' },
  textButton: { background: 'transparent', color: '#D0BCFF', border: 'none', cursor: 'pointer', fontWeight: '500' },

  textField: { background: 'transparent', border: '1px solid #938F99', borderRadius: '4px', padding: '12px', color: '#fff', width: '100%', boxSizing: 'border-box', marginBottom: '16px' },
  loginPage: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1C1B1F' },
  loginCard: { width: '300px', padding: '48px', background: '#2B2930', borderRadius: '28px', textAlign: 'center' },
  headlineLarge: { fontSize: '32px', marginBottom: '8px' },
  headlineSmall: { fontSize: '24px' },
  titleLarge: { fontSize: '22px' },
  titleMedium: { fontSize: '16px' },
  bodyMedium: { fontSize: '14px', color: '#938F99', marginBottom: '32px' },
  emptyState: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', color: '#938F99' },
  badgeOnline: { background: '#2e7d32', color: '#fff', padding: '2px 12px', borderRadius: '16px', fontSize: '12px' },
  badgeOffline: { background: '#c62828', color: '#fff', padding: '2px 12px', borderRadius: '16px', fontSize: '12px' },
};

createRoot(document.getElementById('root')!).render(<App />);
