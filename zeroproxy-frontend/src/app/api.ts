// Small fetch wrapper for the zeroproxy-backend API (proxied to /api by the dev server).

const TOKEN_KEY = 'zeroproxy-token';
const USER_KEY = 'zeroproxy-user';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Login token and user id, kept for this browser tab. */
export const session = {
  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  get userId(): string | null {
    try {
      return sessionStorage.getItem(USER_KEY);
    } catch {
      return null;
    }
  },
  save(token: string, userId: string) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(USER_KEY, userId);
    } catch {
      // Session just won't survive a refresh.
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USER_KEY);
    } catch {
      // Nothing stored.
    }
  },
};

export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = session.token;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is zeroproxy-backend running?');
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = res.status >= 500 && !data.error ? 'Cannot reach the server. Is zeroproxy-backend running?' : data.error;
    throw new ApiError(res.status, message ?? `Request failed (${res.status}).`);
  }
  return data as T;
}
