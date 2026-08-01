export interface X402PrototypeResponse<TBody = unknown> {
  statusCode: number;
  body: TBody;
}

export type X402GateDecision<TBody = unknown> =
  | { allowed: true }
  | { allowed: false; response: X402PrototypeResponse<TBody> };

export type X402PaymentDecision<TPayment, TBody = unknown> =
  | { verified: true; payment: TPayment }
  | { verified: false; response: X402PrototypeResponse<TBody> };

export type X402ReplayDecision<TSettlement, TBody = unknown> =
  | { claimed: true; settlement: TSettlement }
  | { claimed: false; response: X402PrototypeResponse<TBody> };

interface X402SettlementPrototype<
  TPayment,
  TProviderResult,
  TSettlement,
  TBody = unknown,
> {
  authorize(): Promise<X402GateDecision<TBody>>;
  consumeRateLimit(): Promise<X402GateDecision<TBody>>;
  verifyPayment(): Promise<X402PaymentDecision<TPayment, TBody>>;
  claimPayment(
    payment: TPayment,
  ): Promise<X402ReplayDecision<TSettlement, TBody>>;
  executeProvider(): Promise<TProviderResult>;
  executeController(
    providerResult: TProviderResult,
  ): Promise<X402PrototypeResponse<TBody>>;
  settlePayment(settlement: TSettlement): Promise<void>;
}

/**
 * Executable model for the frozen x402 ordering contract.
 *
 * Route policy that is not represented here (country and blocklist checks)
 * remains before this payment lifecycle. claimPayment must atomically reserve
 * a facilitator-verified payment in a shared replay store and keep the claim
 * terminal on every outcome until its authorization expires. The real route
 * installs that claim at the resource server's post-verification hook; this
 * model keeps the complete boundary order visible and counter-testable.
 */
// @lat: [[api/trust-and-operations#Trust, Billing, and Operations#x402 paid search]]
export async function executeX402SettlementPrototype<
  TPayment,
  TProviderResult,
  TSettlement,
  TBody = unknown,
>(
  stages: X402SettlementPrototype<
    TPayment,
    TProviderResult,
    TSettlement,
    TBody
  >,
): Promise<X402PrototypeResponse<TBody>> {
  const authorization = await stages.authorize();
  if (!authorization.allowed) {
    return authorization.response;
  }

  const rateLimit = await stages.consumeRateLimit();
  if (!rateLimit.allowed) {
    return rateLimit.response;
  }

  const payment = await stages.verifyPayment();
  if (!payment.verified) {
    return payment.response;
  }

  const replay = await stages.claimPayment(payment.payment);
  if (!replay.claimed) {
    return replay.response;
  }

  const providerResult = await stages.executeProvider();
  const controllerResponse = await stages.executeController(providerResult);

  if (
    controllerResponse.statusCode >= 200 &&
    controllerResponse.statusCode < 300
  ) {
    await stages.settlePayment(replay.settlement);
  }

  return controllerResponse;
}
