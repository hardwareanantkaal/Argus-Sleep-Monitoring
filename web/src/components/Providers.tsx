'use client';

// App-wide state: who is logged in (auth), small toast messages, and the theme.
// The login lives in httpOnly cookies, so the browser JS never sees a token: we only ask
// GET /me "who am I?" and keep the answer here. api.ts handles the one-time refresh on
// TOKEN_EXPIRED; if that refresh fails it calls the logged-out handler set below.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, get, post, setLoggedOutHandler } from '@/lib/api';
import { isLive } from '@/lib/config';
import { mockAdopt } from '@/lib/mock/handler';
import { closeSocket } from '@/lib/socket';
import type { StaffPerm, User } from '@/lib/types';

/* ---------------- auth ---------------- */

interface AuthState {
  /** undefined = still checking, null = logged out */
  user: User | null | undefined;
  login(phone: string, password: string): Promise<User>;
  register(b: { fullName: string; phone: string; country: string; password: string }): Promise<User>;
  logout(): Promise<void>;
  reload(): Promise<User | null>;
  setUser(u: User | null): void;
  can(p: StaffPerm): boolean;
}

const AuthCtx = createContext<AuthState | null>(null);

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth outside <Providers>');
  return c;
}

/** "auth" may be live while other areas are still mock: tell the mock who logged in. */
function syncMock(u: User | null) {
  if (isLive('auth')) mockAdopt(u);
}

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<User | null | undefined>(undefined);
  const setUser = useCallback((u: User | null) => { syncMock(u); setUserState(u); }, []);

  const reload = useCallback(async () => {
    try {
      const u = await get<User>('/me');
      setUser(u);
      return u;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setUser(null); return null; }
      // Server unreachable etc.: treat as logged out so the login page shows, with its own error on submit.
      setUser(null);
      return null;
    }
  }, [setUser]);

  useEffect(() => {
    setLoggedOutHandler(() => { closeSocket(); setUser(null); });
    reload();
  }, [reload, setUser]);

  const login = useCallback(async (phone: string, password: string) => {
    const r = await post<{ user: User }>('/auth/login', { phone, password });
    setUser(r.user);
    return r.user;
  }, [setUser]);

  const register = useCallback(async (b: { fullName: string; phone: string; country: string; password: string }) => {
    const r = await post<{ user: User }>('/auth/register', b);
    setUser(r.user);
    return r.user;
  }, [setUser]);

  const logout = useCallback(async () => {
    try { await post('/auth/logout'); } catch { /* cookie may already be gone */ }
    closeSocket();
    setUser(null);
  }, [setUser]);

  const can = useCallback((p: StaffPerm) => !!user && user.permissions.includes(p), [user]);

  const value = useMemo(() => ({ user, login, register, logout, reload, setUser, can }), [user, login, register, logout, reload, setUser, can]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/* ---------------- toast ---------------- */

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((m: string) => {
    setMsg(m);
    setShow(true);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setShow(false), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div id="toast" role="status" aria-live="polite" className={show ? 'show' : ''}>{msg}</div>
    </ToastCtx.Provider>
  );
}

/* ---------------- theme ---------------- */

type Theme = 'dark' | 'light';
const ThemeCtx = createContext<{ theme: Theme; setTheme(t: Theme): void }>({ theme: 'dark', setTheme: () => {} });
export const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');
  useEffect(() => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') setThemeState(t);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('argus-theme', t); } catch { /* storage blocked */ }
  }, []);
  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>{children}</AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
