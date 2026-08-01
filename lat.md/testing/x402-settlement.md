---
lat:
  require-code-mention: true
---

# x402 Settlement Ordering Tests

Counter tests exercise the real replay hook inside the frozen payment order so rejected work cannot consume provider capacity and successful work cannot escape or duplicate settlement.

## Unauthorized requests

Authentication failure stops before rate limiting, payment verification, provider execution, controller mapping, or settlement.

## Unpaid requests

Missing payment reaches verification after request policy but stops before provider execution, controller mapping, or settlement.

## Invalid signatures

Cryptographically invalid payment stops at verification and cannot spend provider capacity or reach settlement.

## Replayed payments

An atomic replay claim rejects an already reserved authorization after facilitator verification but before provider execution.

## Concurrent replay claims

Two concurrent requests carrying one verified authorization produce one replay claim, one provider execution, and one settlement attempt.

## Rate-limited requests

An authenticated request over its search limit stops before payment verification, protecting facilitator and provider capacity from denial-of-service pressure.

## Provider 502 failures

A verified request executes the provider once, maps a bad response to 502, and performs no settlement.

## Provider 503 failures

A verified request executes the provider once, maps unavailability to 503, and performs no settlement.

## Valid empty responses

A structurally valid empty result is a successful controller response and settles exactly once without provider retry.

## Partial success responses

A usable partial result is a successful controller response and settles exactly once without provider retry.

## Ordinary success responses

An ordinary successful result executes the provider once and settles exactly once before response delivery.

## Unexpected provider failures

An unexpected provider exception bubbles unchanged and cannot trigger controller mapping or settlement.

## Settlement failures

A failed settlement attempt propagates without repeating provider execution, controller mapping, or settlement.
