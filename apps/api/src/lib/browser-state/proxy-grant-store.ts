import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { runtimeUuidSchema } from "../browser-runtime/protocol";
import { tokenSchema } from "../scrape-interact/browser-service-contracts";
import type {
  BrowserStartupGate,
  BrowserStateMutationLease,
} from "../browser-runtime/startup-gate";

const GRANT_LIFETIME_MS = 5 * 60 * 1_000;
const permissionSchema = z.enum(["passive", "interactive", "cdp"]);
const issueSchema = z.strictObject({
  ownerId: runtimeUuidSchema,
  sessionId: runtimeUuidSchema,
  permission: permissionSchema,
});

/** @public */
export type BrowserProxyPermission = z.infer<typeof permissionSchema>;

/** @public */
export type BrowserProxyGrant = {
  id: string;
  ownerId: string;
  sessionId: string;
  permission: BrowserProxyPermission;
  useLimit: number;
  uses: number;
  issuedAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
};

/** @public Raw token is returned once and never persisted. */
export type IssuedBrowserProxyGrant = BrowserProxyGrant & { token: string };

/** @public */
export type IssueBrowserProxyGrantInput = {
  ownerId: string;
  sessionId: string;
  permission: BrowserProxyPermission;
};

/** @public */
export type IssuedBrowserProxyGrantSet = {
  passive: IssuedBrowserProxyGrant;
  interactive: IssuedBrowserProxyGrant;
  cdp: IssuedBrowserProxyGrant;
};

type ProxyGrantRow = {
  id: string;
  owner_id: string;
  session_id: string;
  permission: string;
  use_limit: number;
  uses: number;
  issued_at: string | Date;
  redeemed_at: string | Date | null;
  revoked_at: string | Date | null;
  expires_at: string | Date;
};

function mapGrant(row: ProxyGrantRow): BrowserProxyGrant {
  return {
    id: runtimeUuidSchema.parse(row.id),
    ownerId: runtimeUuidSchema.parse(row.owner_id),
    sessionId: runtimeUuidSchema.parse(row.session_id),
    permission: permissionSchema.parse(row.permission),
    useLimit: Number(row.use_limit),
    uses: Number(row.uses),
    issuedAt: new Date(row.issued_at),
    redeemedAt: row.redeemed_at === null ? null : new Date(row.redeemed_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    expiresAt: new Date(row.expires_at),
  };
}

/** @public */
export function hashBrowserProxyGrantToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function issueWithLease(
  lease: BrowserStateMutationLease,
  input: IssueBrowserProxyGrantInput,
  now: Date,
  randomId: () => string,
  randomToken: () => string,
): Promise<IssuedBrowserProxyGrant> {
  const parsed = issueSchema.parse(input);
  const token = tokenSchema.parse(randomToken());
  const id = runtimeUuidSchema.parse(randomId());
  const expiresAt = new Date(now.getTime() + GRANT_LIFETIME_MS);
  const result = await lease.transaction.query<ProxyGrantRow>(
    `WITH locked_session AS MATERIALIZED (
       SELECT s.id, s.owner_id, s.absolute_deadline_at
         FROM browser_sessions s
        WHERE s.id = $3
          AND s.owner_id = $7
          AND s.state IN ('ready', 'executing')
          AND s.absolute_deadline_at > $5
        FOR UPDATE
     )
     INSERT INTO browser_proxy_grants (
       id, token_hash, owner_id, session_id, permission, use_limit,
       uses, issued_at, expires_at
     )
     SELECT $1, $2, s.owner_id, s.id, $4, 1, 0, $5,
            LEAST($6::timestamptz, s.absolute_deadline_at)
       FROM locked_session s
     RETURNING id, owner_id, session_id, permission, use_limit, uses,
               issued_at, redeemed_at, revoked_at, expires_at`,
    [
      id,
      hashBrowserProxyGrantToken(token),
      parsed.sessionId,
      parsed.permission,
      now.toISOString(),
      expiresAt.toISOString(),
      parsed.ownerId,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw Object.assign(new Error("Browser proxy grant was denied"), {
      category: "browser_state_unavailable",
    });
  }
  return { ...mapGrant(row), token };
}

async function redeemWithLease(
  lease: BrowserStateMutationLease,
  token: string,
  permission: BrowserProxyPermission,
  now: Date,
): Promise<BrowserProxyGrant | null> {
  const parsedToken = tokenSchema.safeParse(token);
  const parsedPermission = permissionSchema.safeParse(permission);
  if (!parsedToken.success || !parsedPermission.success) return null;
  const result = await lease.transaction.query<ProxyGrantRow>(
    `UPDATE browser_proxy_grants g
        SET uses = g.uses + 1,
            redeemed_at = COALESCE(g.redeemed_at, $3)
       FROM browser_sessions s
      WHERE g.token_hash = $1
        AND g.permission = $2
        AND g.revoked_at IS NULL
        AND g.expires_at > $3
        AND g.uses < g.use_limit
        AND s.id = g.session_id
        AND s.owner_id = g.owner_id
        AND s.state IN ('ready', 'executing')
        AND s.absolute_deadline_at > $3
     RETURNING g.id, g.owner_id, g.session_id, g.permission, g.use_limit,
               g.uses, g.issued_at, g.redeemed_at, g.revoked_at, g.expires_at`,
    [
      hashBrowserProxyGrantToken(parsedToken.data),
      parsedPermission.data,
      now.toISOString(),
    ],
  );
  return result.rows[0] ? mapGrant(result.rows[0]) : null;
}

/** @public Hash-only, leased browser proxy grant persistence. */
export function createBrowserProxyGrantStore(deps: {
  gate: BrowserStartupGate;
  now?: () => Date;
  randomId?: () => string;
  randomToken?: () => string;
}) {
  const now = deps.now ?? (() => new Date());
  const randomId = deps.randomId ?? randomUUID;
  const randomToken =
    deps.randomToken ?? (() => randomBytes(32).toString("base64url"));
  return {
    issue(input: IssueBrowserProxyGrantInput) {
      const issuedAt = now();
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => issueWithLease(lease, input, issuedAt, randomId, randomToken),
      );
    },

    issueSet(input: Omit<IssueBrowserProxyGrantInput, "permission">) {
      const issuedAt = now();
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          const issue = (permission: BrowserProxyPermission) =>
            issueWithLease(
              lease,
              { ...input, permission },
              issuedAt,
              randomId,
              randomToken,
            );
          const passive = await issue("passive");
          const interactive = await issue("interactive");
          const cdp = await issue("cdp");
          return {
            passive,
            interactive,
            cdp,
          } satisfies IssuedBrowserProxyGrantSet;
        },
      );
    },

    redeem(
      token: string,
      permission: BrowserProxyPermission,
    ): Promise<BrowserProxyGrant | null> {
      const redeemedAt = now();
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        lease => redeemWithLease(lease, token, permission, redeemedAt),
      );
    },

    revokeSession(sessionId: string): Promise<number> {
      const parsedSessionId = runtimeUuidSchema.parse(sessionId);
      const revokedAt = now();
      return deps.gate.withBrowserStateMutationLease(
        "filesystem_and_database",
        async lease => {
          await lease.transaction.query(
            `SELECT id
               FROM browser_sessions
              WHERE id = $1
              FOR UPDATE`,
            [parsedSessionId],
          );
          const result = await lease.transaction.query(
            `UPDATE browser_proxy_grants
                SET revoked_at = COALESCE(revoked_at, $2)
              WHERE session_id = $1
                AND revoked_at IS NULL
              RETURNING id`,
            [parsedSessionId, revokedAt.toISOString()],
          );
          return result.rows.length;
        },
      );
    },
  };
}
