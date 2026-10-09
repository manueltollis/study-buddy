/**
 * Client for an Obsidian vault exposed by the "Local REST API" community
 * plugin (github.com/coddingtonbear/obsidian-local-rest-api).
 * ES module - used by the service worker and by the test with a fake fetch.
 */

/** The plugin's plain-HTTP port. Its HTTPS port uses a self-signed certificate Chrome won't trust. */
export const DEFAULT_VAULT_URL = 'http://127.0.0.1:27123';

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export class VaultError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createVault({ url, key, fetchImpl }) {
  const base = String(url || DEFAULT_VAULT_URL).trim().replace(/\/+$/, '');
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  async function call(method, path, { body, headers, accept } = {}) {
    let response;
    try {
      response = await doFetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(accept ? { accept } : {}),
          ...(body !== undefined ? { 'content-type': 'text/markdown' } : {}),
          ...headers
        },
        body
      });
    } catch (error) {
      throw new VaultError(
        `Could not reach Obsidian at ${base} (${error.message}). Is Obsidian open with the Local REST API plugin running?`,
        0
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new VaultError('Obsidian rejected the API key. Copy it again from the Local REST API plugin settings.', response.status);
    }
    return response;
  }

  async function fail(response, what) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data.message || '';
    } catch {
      /* empty body */
    }
    throw new VaultError(`${what} failed (${response.status}${detail ? `: ${detail}` : ''}).`, response.status);
  }

  return {
    base,

    /** Checks the plugin answers and accepts the key. */
    async ping() {
      const response = await call('GET', '/');
      if (!response.ok) await fail(response, 'Connecting');
      const data = await response.json();
      if (!data.authenticated) throw new VaultError('Obsidian answered, but the API key was not accepted.', 401);
      return data;
    },

    /** Lists one folder: entries ending in "/" are folders. */
    async list(folder) {
      const path = folder ? `/vault/${encodePath(folder.replace(/\/+$/, ''))}/` : '/vault/';
      const response = await call('GET', path);
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, 'Listing');
      return (await response.json()).files || [];
    },

    /** A note's text, or null if it does not exist. */
    async read(path) {
      const response = await call('GET', `/vault/${encodePath(path)}`, { accept: 'text/markdown' });
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, 'Reading');
      return response.text();
    },

    async search(query) {
      const params = new URLSearchParams({ query, contextLength: '80' });
      const response = await call('POST', `/search/simple/?${params}`);
      if (!response.ok) await fail(response, 'Searching');
      return response.json();
    },

    /** Creates or replaces a note. */
    async write(path, content) {
      const response = await call('PUT', `/vault/${encodePath(path)}`, { body: content });
      if (!response.ok) await fail(response, 'Writing');
    },

    async remove(path) {
      const response = await call('DELETE', `/vault/${encodePath(path)}`);
      if (!response.ok && response.status !== 404) await fail(response, 'Deleting');
    }
  };
}
