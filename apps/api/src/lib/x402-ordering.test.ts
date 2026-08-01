import {
  executeX402SettlementPrototype,
  type X402GateDecision,
  type X402PaymentDecision,
  type X402PrototypeResponse,
  type X402ReplayDecision,
} from "./x402-ordering";
import type { PaymentPayload, PaymentRequirements } from "@x402/express";
import {
  X402PaymentReplayError,
  createX402ReplayClaimHook,
} from "./x402-replay";

type Stage =
  | "authorize"
  | "rateLimit"
  | "verifyPayment"
  | "claimPayment"
  | "provider"
  | "controller"
  | "settlement";

type ProviderOutcome =
  | "provider-502"
  | "provider-503"
  | "valid-empty"
  | "partial-success"
  | "ordinary-success";

type PaymentOutcome = "verified" | "unpaid" | "invalid-signature";

interface Scenario {
  authorized?: boolean;
  rateLimited?: boolean;
  payment?: PaymentOutcome;
  replayed?: boolean;
  provider?: ProviderOutcome;
  providerError?: Error;
  settlementError?: Error;
}

const paymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0xasset",
  amount: "10000",
  payTo: "0xrecipient",
  maxTimeoutSeconds: 120,
  extra: {},
} as PaymentRequirements;

const verifiedPayment = {
  x402Version: 2,
  accepted: paymentRequirements,
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
  },
} as PaymentPayload;

function response(statusCode: number, outcome: string): X402PrototypeResponse {
  return { statusCode, body: { outcome } };
}

function createHarness(scenario: Scenario = {}) {
  const calls: Record<Stage, number> = {
    authorize: 0,
    rateLimit: 0,
    verifyPayment: 0,
    claimPayment: 0,
    provider: 0,
    controller: 0,
    settlement: 0,
  };
  const claimedPayments = new Set<string>();
  const replayClaim = createX402ReplayClaimHook({
    store: {
      async claim(key) {
        if (scenario.replayed || claimedPayments.has(key)) return false;
        claimedPayments.add(key);
        return true;
      },
    },
    nowSeconds: () => 1000,
  });
  const order: Stage[] = [];
  const count = (stage: Stage) => {
    calls[stage] += 1;
    order.push(stage);
  };

  const provider = scenario.provider ?? "ordinary-success";

  return {
    calls,
    order,
    run: () =>
      executeX402SettlementPrototype({
        async authorize(): Promise<X402GateDecision> {
          count("authorize");
          return scenario.authorized === false
            ? { allowed: false, response: response(401, "unauthorized") }
            : { allowed: true };
        },
        async consumeRateLimit(): Promise<X402GateDecision> {
          count("rateLimit");
          return scenario.rateLimited === true
            ? { allowed: false, response: response(429, "rate-limited") }
            : { allowed: true };
        },
        async verifyPayment(): Promise<X402PaymentDecision<PaymentPayload>> {
          count("verifyPayment");
          const payment = scenario.payment ?? "verified";
          return payment === "verified"
            ? { verified: true, payment: verifiedPayment }
            : { verified: false, response: response(402, payment) };
        },
        async claimPayment(
          payment,
        ): Promise<X402ReplayDecision<PaymentPayload>> {
          count("claimPayment");
          try {
            await replayClaim({
              paymentPayload: payment,
              requirements: paymentRequirements,
              result: { isValid: true },
            });
          } catch (error) {
            if (error instanceof X402PaymentReplayError) {
              return { claimed: false, response: response(402, "replay") };
            }
            throw error;
          }
          return { claimed: true, settlement: payment };
        },
        async executeProvider(): Promise<ProviderOutcome> {
          count("provider");
          if (scenario.providerError) {
            throw scenario.providerError;
          }
          return provider;
        },
        async executeController(result): Promise<X402PrototypeResponse> {
          count("controller");
          if (result === "provider-502") {
            return response(502, result);
          }
          if (result === "provider-503") {
            return response(503, result);
          }
          return response(200, result);
        },
        async settlePayment(settlement): Promise<void> {
          expect(settlement).toBe(verifiedPayment);
          count("settlement");
          if (scenario.settlementError) {
            throw scenario.settlementError;
          }
        },
      }),
  };
}

function expectRejectedBeforeProvider(
  harness: ReturnType<typeof createHarness>,
  expectedOrder: Stage[],
) {
  expect(harness.order).toEqual(expectedOrder);
  expect(harness.calls.provider).toBe(0);
  expect(harness.calls.controller).toBe(0);
  expect(harness.calls.settlement).toBe(0);
}

function expectProviderFailure(harness: ReturnType<typeof createHarness>) {
  expect(harness.order).toEqual([
    "authorize",
    "rateLimit",
    "verifyPayment",
    "claimPayment",
    "provider",
    "controller",
  ]);
  expect(harness.calls.provider).toBe(1);
  expect(harness.calls.controller).toBe(1);
  expect(harness.calls.settlement).toBe(0);
}

function expectSettledSuccess(harness: ReturnType<typeof createHarness>) {
  expect(harness.order).toEqual([
    "authorize",
    "rateLimit",
    "verifyPayment",
    "claimPayment",
    "provider",
    "controller",
    "settlement",
  ]);
  expect(harness.calls.provider).toBe(1);
  expect(harness.calls.controller).toBe(1);
  expect(harness.calls.settlement).toBe(1);
}

describe("x402 paid search boundary", () => {
  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Unauthorized requests]]
  it("rejects unauthorized requests before rate limit and payment work", async () => {
    const harness = createHarness({ authorized: false });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 401 });
    expectRejectedBeforeProvider(harness, ["authorize"]);
    expect(harness.calls.rateLimit).toBe(0);
    expect(harness.calls.verifyPayment).toBe(0);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Unpaid requests]]
  it("rejects unpaid requests before provider execution", async () => {
    const harness = createHarness({ payment: "unpaid" });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 402 });
    expectRejectedBeforeProvider(harness, [
      "authorize",
      "rateLimit",
      "verifyPayment",
    ]);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Invalid signatures]]
  it("rejects invalid signatures before provider execution", async () => {
    const harness = createHarness({ payment: "invalid-signature" });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 402 });
    expectRejectedBeforeProvider(harness, [
      "authorize",
      "rateLimit",
      "verifyPayment",
    ]);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Replayed payments]]
  it("rejects replayed payments before provider execution", async () => {
    const harness = createHarness({ replayed: true });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 402 });
    expectRejectedBeforeProvider(harness, [
      "authorize",
      "rateLimit",
      "verifyPayment",
      "claimPayment",
    ]);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Concurrent replay claims]]
  it("admits one of two concurrent uses of the same payment", async () => {
    const harness = createHarness();

    const results = await Promise.all([harness.run(), harness.run()]);

    expect(results.map(result => result.statusCode).sort()).toEqual([200, 402]);
    expect(harness.calls).toEqual({
      authorize: 2,
      rateLimit: 2,
      verifyPayment: 2,
      claimPayment: 2,
      provider: 1,
      controller: 1,
      settlement: 1,
    });
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Rate-limited requests]]
  it("rejects rate-limited requests before payment verification", async () => {
    const harness = createHarness({ rateLimited: true });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 429 });
    expectRejectedBeforeProvider(harness, ["authorize", "rateLimit"]);
    expect(harness.calls.verifyPayment).toBe(0);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Provider 502 failures]]
  it("does not settle provider 502 responses", async () => {
    const harness = createHarness({ provider: "provider-502" });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 502 });
    expectProviderFailure(harness);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Provider 503 failures]]
  it("does not settle provider 503 responses", async () => {
    const harness = createHarness({ provider: "provider-503" });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 503 });
    expectProviderFailure(harness);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Valid empty responses]]
  it("settles a valid empty response exactly once", async () => {
    const harness = createHarness({ provider: "valid-empty" });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 200 });
    expectSettledSuccess(harness);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Partial success responses]]
  it("settles a partial success exactly once", async () => {
    const harness = createHarness({ provider: "partial-success" });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 200 });
    expectSettledSuccess(harness);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Ordinary success responses]]
  it("settles an ordinary success exactly once", async () => {
    const harness = createHarness({ provider: "ordinary-success" });

    await expect(harness.run()).resolves.toMatchObject({ statusCode: 200 });
    expectSettledSuccess(harness);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Unexpected provider failures]]
  it("bubbles unexpected provider failures without settlement", async () => {
    const unexpected = new Error("unexpected provider failure");
    const harness = createHarness({ providerError: unexpected });

    await expect(harness.run()).rejects.toBe(unexpected);
    expect(harness.order).toEqual([
      "authorize",
      "rateLimit",
      "verifyPayment",
      "claimPayment",
      "provider",
    ]);
    expect(harness.calls.provider).toBe(1);
    expect(harness.calls.controller).toBe(0);
    expect(harness.calls.settlement).toBe(0);
  });

  // @lat: [[testing/x402-settlement#x402 Settlement Ordering Tests#Settlement failures]]
  it("attempts settlement once without repeating provider work", async () => {
    const settlementError = new Error("settlement failed");
    const harness = createHarness({ settlementError });

    await expect(harness.run()).rejects.toBe(settlementError);
    expectSettledSuccess(harness);
  });
});
