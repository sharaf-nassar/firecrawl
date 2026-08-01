import type { PaymentPayload, PaymentRequirements } from "@x402/express";
import {
  X402PaymentReplayError,
  createRedisX402ReplayStore,
  createX402ReplayClaimHook,
  x402ReplayClaim,
} from "./x402-replay";

const requirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0xasset",
  amount: "10000",
  payTo: "0xrecipient",
  maxTimeoutSeconds: 120,
  extra: {},
} as PaymentRequirements;

function payment(overrides: Record<string, unknown> = {}): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    resource: {
      url: "https://api.example/v2/x402/search",
      description: "Paid search",
      mimeType: "application/json",
    },
    payload: {
      signature: "0xsignature",
      authorization: {
        from: "0xpayer",
        to: "0xrecipient",
        value: "10000",
        validAfter: "900",
        validBefore: "1120",
        nonce: "0xnonce",
      },
      ...overrides,
    },
  } as PaymentPayload;
}

describe("x402 replay claims", () => {
  it("uses one atomic Redis SET with bounded retention", async () => {
    const redis = {
      set: vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null),
    };
    const store = createRedisX402ReplayStore(redis);

    await expect(store.claim("claim-key", 120)).resolves.toBe(true);
    await expect(store.claim("claim-key", 120)).resolves.toBe(false);
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      "claim-key",
      "claimed",
      "EX",
      120,
      "NX",
    );
  });

  it("uses canonical authorization identity through its exact expiry", () => {
    const first = x402ReplayClaim(payment(), requirements, 1000);
    const sameAuthorization = payment({
      authorization: {
        nonce: "0xNONCE",
        validBefore: "01120",
        validAfter: "0900",
        value: "010000",
        to: "0xRECIPIENT",
        from: "0xPAYER",
      },
      signature: "0xdifferent-signature",
    });

    expect(x402ReplayClaim(sameAuthorization, requirements, 1000)).toEqual(
      first,
    );
    expect(first.ttlSeconds).toBe(120);
    expect(first.key).toMatch(/^x402:payment-claim:[a-f0-9]{64}$/);
  });

  it("uses Permit2 deadline retention and rejects invalid expiry", () => {
    const permit2 = payment({
      authorization: undefined,
      permit2Authorization: {
        permitted: { token: "0xasset", amount: "10000" },
        spender: "0xspender",
        nonce: "42",
        deadline: "1060",
        witness: {
          to: "0xrecipient",
          validAfter: "900",
          extra: "0x",
        },
        from: "0xpayer",
      },
    });

    expect(x402ReplayClaim(permit2, requirements, 1000).ttlSeconds).toBe(60);
    expect(() => x402ReplayClaim(payment(), requirements, 1120)).toThrow(
      "invalid expiry",
    );
    expect(() =>
      x402ReplayClaim(
        payment({
          authorization: {
            from: "0xpayer",
            to: "0xrecipient",
            value: "10000",
            validAfter: "900",
            validBefore: "1121",
            nonce: "0xnonce",
          },
        }),
        requirements,
        1000,
      ),
    ).toThrow("invalid expiry");
  });

  it("claims only verified payments and rejects sequential replay", async () => {
    const claimed = new Set<string>();
    const store = {
      claim: vi.fn(async (key: string) => {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      }),
    };
    const hook = createX402ReplayClaimHook({
      store,
      nowSeconds: () => 1000,
    });
    const context = {
      paymentPayload: payment(),
      requirements,
      result: { isValid: true },
    };

    await hook({ ...context, result: { isValid: false } });
    expect(store.claim).not.toHaveBeenCalled();
    await expect(hook(context)).resolves.toBeUndefined();
    await expect(hook(context)).rejects.toBeInstanceOf(X402PaymentReplayError);
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(store.claim).toHaveBeenCalledWith(expect.any(String), 120);
  });

  it("atomically admits one concurrent use of an authorization", async () => {
    const claimed = new Set<string>();
    const hook = createX402ReplayClaimHook({
      store: {
        async claim(key) {
          if (claimed.has(key)) return false;
          claimed.add(key);
          return true;
        },
      },
      nowSeconds: () => 1000,
    });
    const context = {
      paymentPayload: payment(),
      requirements,
      result: { isValid: true },
    };

    const outcomes = await Promise.allSettled([hook(context), hook(context)]);

    expect(
      outcomes.filter(outcome => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = outcomes.find(outcome => outcome.status === "rejected");
    expect(rejection).toMatchObject({ reason: new X402PaymentReplayError() });
  });
});
