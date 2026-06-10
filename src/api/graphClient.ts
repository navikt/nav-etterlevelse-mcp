/**
 * Minimal Microsoft Graph API client for team membership verification.
 *
 * Used by lock_document to check whether the authenticated user is a member
 * of any Entra ID group that corresponds to the document's owning NAIS team.
 *
 * The user's Entra ID group UUIDs are stored in McpTokenData.userGroups at
 * login time (from the groups claim in the Azure AD token). This client maps
 * NAIS team names (e.g. "dab") to their Entra ID group UUIDs so the two sets
 * can be compared without an additional API call per write operation.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface EntraGroup {
  id: string;
  displayName: string;
}

export class GraphClient {
  constructor(private readonly accessToken: string) {}

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${GRAPH_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Microsoft Graph svarte ${response.status}: ${bodyText}`);
    }

    try {
      return JSON.parse(bodyText);
    } catch {
      return bodyText;
    }
  }

  /**
   * Returns all Entra ID groups (id + displayName) the authenticated user is
   * a direct member of. Handles paging automatically (Graph returns max 100
   * per page by default).
   */
  async getMemberOf(): Promise<EntraGroup[]> {
    const groups: EntraGroup[] = [];
    let url: string | null = '/me/memberOf?$select=id,displayName&$top=100';

    while (url) {
      const data = this.asRecord(await this.get(url));
      const value = data?.['value'];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (this.isRecord(item) && typeof item['id'] === 'string') {
            groups.push({
              id: item['id'],
              displayName: typeof item['displayName'] === 'string' ? item['displayName'] : '',
            });
          }
        }
      }
      const nextLink = data?.['@odata.nextLink'];
      url = typeof nextLink === 'string' ? nextLink.replace(GRAPH_BASE, '') : null;
    }

    return groups;
  }

  /**
   * Given a list of NAIS team names, returns the first team name that matches
   * a group the user is a direct member of (via Microsoft Graph /me/memberOf).
   *
   * userGroupIds (fra JWT groups-claim) brukes som en optional innsnevring:
   * hvis claimet er populert, hopper vi over grupper som ikke er i settet.
   * Hvis claimet er tomt (f.eks. fordi NAIS-appen ikke er konfigurert med
   * spesifikke groups i azure.application.claims), matches mot alle grupper
   * fra Graph API direkte.
   */
  async findMatchingTeam(
    teamNames: string[],
    userGroupIds: string[],
  ): Promise<{ teamName: string; groupId: string } | null> {
    if (teamNames.length === 0) {
      return null;
    }

    const memberOf = await this.getMemberOf();
    const candidateIds = userGroupIds.length > 0 ? new Set(userGroupIds) : null;

    for (const group of memberOf) {
      if (candidateIds && !candidateIds.has(group.id)) {
        continue;
      }
      const matchingTeam = teamNames.find(
        (name) => name.toLowerCase() === group.displayName.toLowerCase(),
      );
      if (matchingTeam) {
        return { teamName: matchingTeam, groupId: group.id };
      }
    }

    return null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return this.isRecord(value) ? value : null;
  }
}
