import { createHash } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/express";

const X402_REPLAY_KEY_PREFIX = "x402:payment-claim:";

interface X402ReplayStore {
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

interface X402ReplayRedis {
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    ttlSeconds: number,
    condition: "NX",
  ): Promise<unknown>;
}

export function createRedisX402ReplayStore(
  redis: X402ReplayRedis,
): X402ReplayStore {
  return {
    async claim(key, ttlSeconds) {
      return (await redis.set(key, "claimed", "EX", ttlSeconds, "NX")) === "OK";
    },
  };
}

interface X402VerifiedPaymentContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
  result: { isValid: boolean };
}

type ReplayClaimHookOptions = {
  store: X402ReplayStore;
  nowSeconds?: () => number;
};

export class X402PaymentReplayError extends Error {
  constructor() {
    super("Payment authorization has already been used");
    this.name = "X402PaymentReplayError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`Verified x402 authorization has invalid ${key}`);
  }
  return field;
}

function canonicalUint(value: Record<string, unknown>, key: string): string {
  return BigInt(stringField(value, key)).toString();
}

function canonicalHex(value: Record<string, unknown>, key: string): string {
  return stringField(value, key).toLowerCase();
}

function authorizationIdentity(paymentPayload: PaymentPayload): {
  kind: "eip3009" | "permit2";
  authorization: Record<string, unknown>;
  expiresAt: bigint;
} {
  const payload = record(paymentPayload.payload);
  const authorization = record(payload?.authorization);
  if (authorization) {
    const validBefore = canonicalUint(authorization, "validBefore");
    return {
      kind: "eip3009",
      authorization: {
        from: canonicalHex(authorization, "from"),
        to: canonicalHex(authorization, "to"),
        value: canonicalUint(authorization, "value"),
        validAfter: canonicalUint(authorization, "validAfter"),
        validBefore,
        nonce: canonicalHex(authorization, "nonce"),
      },
      expiresAt: BigInt(validBefore),
    };
  }

  const permit2Authorization = record(payload?.permit2Authorization);
  if (permit2Authorization) {
    const permitted = record(permit2Authorization.permitted);
    const witness = record(permit2Authorization.witness);
    if (!permitted || !witness) {
      throw new TypeError("Verified x402 Permit2 authorization is malformed");
    }
    const deadline = canonicalUint(permit2Authorization, "deadline");
    return {
      kind: "permit2",
      authorization: {
        permitted: {
          token: canonicalHex(permitted, "token"),
          amount: canonicalUint(permitted, "amount"),
        },
        spender: canonicalHex(permit2Authorization, "spender"),
        nonce: canonicalUint(permit2Authorization, "nonce"),
        deadline,
        witness: {
          to: canonicalHex(witness, "to"),
          validAfter: canonicalUint(witness, "validAfter"),
          extra: canonicalHex(witness, "extra"),
        },
        from: canonicalHex(permit2Authorization, "from"),
      },
      expiresAt: BigInt(deadline),
    };
  }

  throw new TypeError("Verified x402 payment has no supported authorization");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const valueRecord = record(value);
  if (valueRecord) {
    return `{${Object.keys(valueRecord)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(valueRecord[key])}`)
      .join(",")}}`;
  }

  throw new TypeError("x402 authorization contains a non-canonical value");
}

export function x402ReplayClaim(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  nowSeconds: number,
): { key: string; ttlSeconds: number } {
  const identity = authorizationIdentity(paymentPayload);
  const now = BigInt(Math.floor(nowSeconds));
  const ttl = identity.expiresAt - now;
  const maxTtlSeconds = Math.ceil(requirements.maxTimeoutSeconds);
  if (
    !Number.isSafeInteger(maxTtlSeconds) ||
    maxTtlSeconds <= 0 ||
    ttl <= 0n ||
    ttl > BigInt(maxTtlSeconds)
  ) {
    throw new TypeError("Verified x402 payment has an invalid expiry");
  }

  const digest = createHash("sha256")
    .update(
      canonicalJson({
        scheme: requirements.scheme.trim().toLowerCase(),
        network: requirements.network.trim().toLowerCase(),
        asset: requirements.asset.trim().toLowerCase(),
        kind: identity.kind,
        authorization: identity.authorization,
      }),
    )
    .digest("hex");

  return {
    key: `${X402_REPLAY_KEY_PREFIX}${digest}`,
    ttlSeconds: Number(ttl),
  };
}

// @lat: [[api/trust-and-operations#Trust, Billing, and Operations#x402 paid search]]
export function createX402ReplayClaimHook({
  store,
  nowSeconds = () => Date.now() / 1000,
}: ReplayClaimHookOptions) {
  return async ({
    paymentPayload,
    requirements,
    result,
  }: X402VerifiedPaymentContext): Promise<void> => {
    if (!result.isValid) return;

    const claim = x402ReplayClaim(paymentPayload, requirements, nowSeconds());
    if (!(await store.claim(claim.key, claim.ttlSeconds))) {
      throw new X402PaymentReplayError();
    }
  };
}
