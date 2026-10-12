// A small client for a scratch Dezfil instance's documented API: sign in
// (or set up a fresh store), mint a token, then call the API with it.
//
// Scratch instances only: the client refuses any address that is not this
// machine, so a template is never authored or validated against someone's
// real server.

const AUTHOR = {
  name: "Dezfil templates",
  email: "templates@example.test",
  password: "open data makes good maps",
};

export class ApiError extends Error {
  constructor(method, path, status, body) {
    const code = body?.error?.code ?? "";
    super(`${method} ${path} answered ${status}${code ? ` ${code}` : ""}: ${body?.error?.message ?? JSON.stringify(body)}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function loopback(base) {
  const { hostname } = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
    throw new Error(`${base} is not a scratch instance on this machine; the tools refuse it.`);
  }
}

/**
 * Connect to the instance at `base`: set up its first account when the store
 * is fresh, else sign in as that account, then create an API token for the
 * calls that follow.
 */
export async function connect(base, account = AUTHOR) {
  loopback(base);
  const origin = new URL(base).origin;
  const entry = await (await fetch(`${origin}/api/auth/entry`)).json();
  const signed = await fetch(`${origin}/api/auth/${entry.setupRequired ? "setup" : "sign-in"}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(entry.setupRequired ? account : { email: account.email, password: account.password }),
  });
  if (signed.status !== 200) throw new ApiError("POST", "/api/auth/sign-in", signed.status, await signed.json().catch(() => null));
  const cookie = signed.headers.getSetCookie().find((c) => c.startsWith("dezfil_session="))?.split(";")[0];
  if (!cookie) throw new Error("Signing in issued no session.");
  const issued = await fetch(`${origin}/api/account/tokens`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: `templates ${new Date().toISOString()}` }),
  });
  if (issued.status !== 201) throw new ApiError("POST", "/api/account/tokens", issued.status, await issued.json().catch(() => null));
  const { secret } = await issued.json();
  return client(origin, secret);
}

function client(origin, token) {
  const auth = { authorization: `Bearer ${token}` };

  async function request(method, path, { body, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...auth, ...headers } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
    const response = await fetch(`${origin}${path}`, init);
    if (!response.ok) {
      const text = await response.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      throw new ApiError(method, path, response.status, parsed);
    }
    if (raw) return response;
    if (response.status === 204) return null;
    return response.json();
  }

  return {
    origin,
    get: (path) => request("GET", path),
    post: (path, body, headers) => request("POST", path, { body, headers }),
    patch: (path, body, headers) => request("PATCH", path, { body, headers }),
    put: (path, body, headers) => request("PUT", path, { body, headers }),
    delete: (path, headers) => request("DELETE", path, { headers }),
    /** The response itself, for bytes (archives, pictures). */
    raw: (method, path, body, headers) => request(method, path, { body, headers, raw: true }),
    /** Upload one file as a dataset, optionally filed in a project. */
    async upload(file, bytes, project) {
      const form = new FormData();
      form.append("file", new Blob([bytes]), file);
      return request("POST", `/api/tables${project ? `?project=${encodeURIComponent(project)}` : ""}`, { body: form });
    },
    /** A map write under the map's current edit revision, read first. */
    async mapWrite(mapId, method, path, body) {
      const { editRevision } = await request("GET", `/api/maps/${mapId}`);
      return request(method, path, { body, headers: { "x-edit-revision": editRevision } });
    },
  };
}
