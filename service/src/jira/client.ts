import { ServiceError } from '../errors.ts';

/**
 * All Jira I/O goes through here - one auth path, one retry policy, one place
 * the audit trail can point at. The Atlassian MCP server stays an optional
 * convenience for a human browsing tickets; the pipeline never depends on it,
 * because two credential paths would double the failure modes and split the
 * trail for no gain.
 */

export class JiraError extends ServiceError {
  readonly jiraStatus: number;

  constructor(event: string, message: string, jiraStatus: number) {
    super(event, message, jiraStatus === 404 ? 404 : 502);
    this.jiraStatus = jiraStatus;
  }
}

export interface JiraConfig {
  /** Site URL, e.g. https://acme.atlassian.net - also used for human links. */
  siteUrl: string;
  email: string;
  token: string;
  /** Present when the token is scoped; forces the api.atlassian.com gateway. */
  cloudId?: string;
}

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JiraConfig {
  const siteUrl = (env.JIRA_BASE_URL ?? '').replace(/\/+$/, '');
  const email = env.JIRA_EMAIL ?? '';
  const token = env.JIRA_API_TOKEN ?? '';
  if (!siteUrl || !email || !token) {
    throw new ServiceError(
      'jira_not_configured',
      'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must all be set',
    );
  }
  return { siteUrl, email, token, cloudId: env.JIRA_CLOUD_ID || undefined };
}

export class JiraClient {
  readonly config: JiraConfig;
  private readonly authHeader: string;
  private apiBase: string;
  private baseResolved = false;

  constructor(config: JiraConfig) {
    this.config = config;
    this.authHeader =
      'Basic ' + Buffer.from(`${config.email}:${config.token}`, 'utf8').toString('base64');
    this.apiBase = config.siteUrl;
  }

  /** Gateway base, the only host a scoped token authenticates against. */
  private get gatewayBase(): string {
    return `https://api.atlassian.com/ex/jira/${this.config.cloudId}`;
  }

  /**
   * Atlassian has two token kinds and they do not share a base URL: a classic
   * token authenticates against the site, a scoped one only against
   * api.atlassian.com/ex/jira/<cloudId> and 401s on the site. Which one we hold
   * is not discoverable from the token string, so resolve it once by trying.
   */
  private async resolveBase(): Promise<void> {
    if (this.baseResolved) return;

    const candidates = [this.config.siteUrl];
    if (this.config.cloudId) candidates.push(this.gatewayBase);

    for (const base of candidates) {
      const res = await fetch(`${base}/rest/api/3/myself`, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => undefined);
      if (res?.ok) {
        this.apiBase = base;
        this.baseResolved = true;
        return;
      }
    }

    throw new ServiceError(
      'jira_auth_failed',
      `token authenticated against neither ${this.config.siteUrl} nor the ` +
        (this.config.cloudId ? 'api.atlassian.com gateway' : 'gateway (no JIRA_CLOUD_ID set)') +
        ' - check JIRA_EMAIL and JIRA_API_TOKEN',
      502,
    );
  }

  /** Which host we ended up talking to. Recorded in the audit trail. */
  get resolvedBase(): string {
    return this.apiBase;
  }

  /** Human-clickable ticket link. Always the site URL, never the gateway. */
  browseUrl(issueKey: string): string {
    return `${this.config.siteUrl}/browse/${issueKey}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.resolveBase();
    let lastError: JiraError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const detail = (await res.text()).slice(0, 400);

      // 429 and 5xx are the only retryable classes. A 400/403 will fail the
      // same way four times and just delays a clear error by two seconds.
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new JiraError(
        res.status === 429 ? 'jira_rate_limited' : 'jira_request_failed',
        `${method} ${path} -> ${res.status}: ${detail}`,
        res.status,
      );
      if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

      // Honour Retry-After when Jira sends it; it knows its own window better
      // than our backoff curve does.
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    throw lastError;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /**
   * Preflight. Probes a real endpoint rather than asking Jira what we may do:
   * /mypermissions reports the *user's* permissions, not the token's scopes,
   * and happily returned ADMINISTER=true for a token that could not create a
   * field. Trusting it would build the write path on a meaningless signal.
   */
  async preflight(): Promise<{ accountId: string; displayName: string; base: string }> {
    const me = await this.get<{ accountId: string; displayName: string }>(
      '/rest/api/3/myself',
    );
    return { accountId: me.accountId, displayName: me.displayName, base: this.apiBase };
  }
}

export function jiraClient(env: NodeJS.ProcessEnv = process.env): JiraClient {
  return new JiraClient(loadConfig(env));
}
