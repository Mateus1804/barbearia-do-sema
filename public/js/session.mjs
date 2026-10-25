const TOKEN_KEY = 'sema_admin_token';

// A sessão continua nesta página quando o navegador nega acesso ao armazenamento.
export function createAdminSession(getStorage = () => globalThis.sessionStorage) {
  let token = '';
  let storageUnavailable = false;
  return {
    read() {
      if (!storageUnavailable) {
        try { token = getStorage().getItem(TOKEN_KEY) || ''; }
        catch { storageUnavailable = true; }
      }
      return token;
    },
    write(value) {
      token = value;
      if (storageUnavailable) return false;
      try { getStorage().setItem(TOKEN_KEY, token); return true; }
      catch { storageUnavailable = true; return false; }
    },
    clear() {
      token = '';
      try { getStorage().removeItem(TOKEN_KEY); return true; }
      catch { storageUnavailable = true; return false; }
    }
  };
}

export const adminSession = createAdminSession();
