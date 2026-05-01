const API_VERSION = "v62.0";

/**
 * Handles Salesforce authentication and all HTTP communication.
 * Exposes methods for standard REST queries, binary downloads,
 * and Tooling API queries/record fetches.
 */
export class SalesforceClient {
  private accessToken: string | null = null;
  private instanceUrl: string | null = null;

  private readonly loginUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;

  constructor() {
    const clientId = process.env.SALESFORCE_CID;
    const clientSecret = process.env.SALESFORCE_CS;
    const refreshToken = process.env.SALESFORCE_REFRESH_TOKEN;
    const loginUrl =
      process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com";

    if (!clientId || !clientSecret || !refreshToken) {
      console.error(
        "Error: SALESFORCE_CID, SALESFORCE_CS, and SALESFORCE_REFRESH_TOKEN environment variables are required"
      );
      process.exit(1);
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.loginUrl = loginUrl;
  }

  private async refreshAccessToken(): Promise<void> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(`${this.loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${errorBody}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.instanceUrl = data.instance_url;
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || !this.instanceUrl) {
      await this.refreshAccessToken();
    }
  }

  /**
   * Makes a JSON request to the Salesforce data or Tooling API.
   * Pass paths relative to /services/data/vXX.0/, e.g.:
   *   /query?q=...              → standard data API
   *   /tooling/query?q=...      → Tooling API
   *   /tooling/sobjects/Foo/id  → Tooling API record fetch
   */
  async request(path: string): Promise<any> {
    await this.ensureToken();
    const url = `${this.instanceUrl}/services/data/${API_VERSION}${path}`;

    let res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (res.status === 401) {
      await this.refreshAccessToken();
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    }

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Salesforce API error (${res.status}): ${errorBody}`);
    }

    return res.json();
  }

  /** Downloads binary content (e.g. ContentVersion file data) and returns a Buffer. */
  async requestBinary(path: string): Promise<Buffer> {
    await this.ensureToken();
    const url = `${this.instanceUrl}/services/data/${API_VERSION}${path}`;

    let res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (res.status === 401) {
      await this.refreshAccessToken();
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    }

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Salesforce API error (${res.status}): ${errorBody}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /** Runs a standard REST SOQL query and follows nextRecordsUrl until done. */
  async queryPaginated(soql: string): Promise<any[]> {
    const allRecords: any[] = [];
    let nextPath: string | null = `/query?q=${encodeURIComponent(soql)}`;

    while (nextPath) {
      const data = await this.request(nextPath);
      if (data.records) allRecords.push(...data.records);
      if (data.done) {
        nextPath = null;
      } else if (data.nextRecordsUrl) {
        nextPath = data.nextRecordsUrl.replace(
          `/services/data/${API_VERSION}`,
          ""
        );
      } else {
        nextPath = null;
      }
    }

    return allRecords;
  }

  /** Runs a Tooling API SOQL query and follows nextRecordsUrl until done. */
  async toolingQueryPaginated(soql: string): Promise<any[]> {
    const allRecords: any[] = [];
    let nextPath: string | null = `/tooling/query?q=${encodeURIComponent(soql)}`;

    while (nextPath) {
      const data = await this.request(nextPath);
      if (data.records) allRecords.push(...data.records);
      if (data.done) {
        nextPath = null;
      } else if (data.nextRecordsUrl) {
        nextPath = data.nextRecordsUrl.replace(
          `/services/data/${API_VERSION}`,
          ""
        );
      } else {
        nextPath = null;
      }
    }

    return allRecords;
  }

  /** Fetches a single Tooling API record by type and ID (includes Metadata field). */
  async toolingRecord(type: string, id: string): Promise<any> {
    return this.request(`/tooling/sobjects/${type}/${id}`);
  }

  /**
   * Resolves the EntityDefinition DurableId for a given object API name.
   * Used as EntityDefinitionId when querying ValidationRule and similar Tooling objects.
   */
  async resolveEntityDefinitionId(objectApiName: string): Promise<string> {
    const records = await this.toolingQueryPaginated(
      `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${objectApiName}'`
    );
    if (!records.length) {
      throw new Error(
        `Object "${objectApiName}" not found in EntityDefinition. Verify the API name is correct.`
      );
    }
    return records[0].DurableId;
  }
}
