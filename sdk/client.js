const DEFAULT_BASE_URL = "/api/game-state";

/** Ошибка REST API с HTTP-статусом и машинным кодом сервера. */
export class GameStateApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message || `Ошибка Game State API (${status ?? "unknown"})`);
    this.name = "GameStateApiError";
    this.status = status ?? null;
    this.code = code ?? null;
    this.details = details;
  }
}

/** Минимальный клиент REST API Game State. Токен хранится только в памяти. */
export class GameStateClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Нужен fetch API");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.token = null;
  }

  setToken(token) {
    this.token = token || null;
  }

  async request(path, { method = "GET", body, auth = true } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (response.ok) {
            throw new GameStateApiError("Сервер вернул некорректный JSON", {
              status: response.status,
            });
          }
        }
      }
    }
    if (!response.ok) {
      const error = payload?.error;
      throw new GameStateApiError(error?.message || `Ошибка HTTP ${response.status}`, {
        status: response.status,
        code: error?.code,
        details: error,
      });
    }
    return payload;
  }

  async register({ login, password, displayName } = {}) {
    const body = { login, password };
    if (displayName !== undefined) body.displayName = displayName;
    const result = await this.request("/auth/register", { method: "POST", body, auth: false });
    this.setToken(result.token);
    return result;
  }

  async login({ login, password } = {}) {
    const result = await this.request("/auth/login", {
      method: "POST", body: { login, password }, auth: false,
    });
    this.setToken(result.token);
    return result;
  }

  async logout() {
    try {
      return await this.request("/auth/logout", { method: "POST" });
    } finally {
      this.setToken(null);
    }
  }

  me() {
    return this.request("/me");
  }

  listStates(app) {
    return this.request(`/apps/${encodeURIComponent(app)}/states`);
  }

  getState(app, zone) {
    return this.request(`/apps/${encodeURIComponent(app)}/zones/${encodeURIComponent(zone)}/state`);
  }

  saveState(app, zone, { data, score, version } = {}) {
    const body = { data, version };
    if (score !== undefined) body.score = score;
    return this.request(
      `/apps/${encodeURIComponent(app)}/zones/${encodeURIComponent(zone)}/state`,
      { method: "PUT", body },
    );
  }

  leaderboard(app, zone, { limit = 10 } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.request(`/apps/${encodeURIComponent(app)}/zones/${encodeURIComponent(zone)}/leaderboard?${query}`, { auth: false });
  }

  rank(app, zone) {
    return this.request(`/apps/${encodeURIComponent(app)}/zones/${encodeURIComponent(zone)}/rank`);
  }
}
