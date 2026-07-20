import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must come before imports
// ---------------------------------------------------------------------------

const mockMarkSessionPromptUsed = vi.fn<(id: string) => Promise<void>>();
const mockDidSessionUsePrompt = vi.fn<(id: string) => Promise<boolean>>();

vi.mock("../../../lib/browser-state/store", () => ({
  markSessionPromptUsed: (id: string) => mockMarkSessionPromptUsed(id),
  didSessionUsePrompt: (id: string) => mockDidSessionUsePrompt(id),
}));

vi.mock("../../../services/redis", () => ({
  deleteKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import {
  calculateBrowserSessionCredits,
  BROWSER_CREDITS_PER_HOUR,
  INTERACT_CREDITS_PER_HOUR,
} from "../../../lib/browser-billing";

import {
  markBrowserSessionUsedPrompt,
  didBrowserSessionUsePrompt,
  clearBrowserSessionPromptFlag,
} from "../../../lib/browser-sessions";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkSessionPromptUsed.mockResolvedValue(undefined);
  mockDidSessionUsePrompt.mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("billing constants", () => {
  it("browser rate is 120 credits/hour", () => {
    expect(BROWSER_CREDITS_PER_HOUR).toBe(120);
  });

  it("interact rate is 420 credits/hour (7 credits/min)", () => {
    expect(INTERACT_CREDITS_PER_HOUR).toBe(420);
  });
});

// ---------------------------------------------------------------------------
// calculateBrowserSessionCredits
// ---------------------------------------------------------------------------

describe("calculateBrowserSessionCredits", () => {
  describe("with default browser rate (120/hr)", () => {
    it("returns minimum 2 credits for very short sessions", () => {
      expect(calculateBrowserSessionCredits(0)).toBe(2);
      expect(calculateBrowserSessionCredits(1000)).toBe(2);
      expect(calculateBrowserSessionCredits(10_000)).toBe(2);
    });

    it("calculates correctly for 1 minute", () => {
      expect(calculateBrowserSessionCredits(60_000)).toBe(2);
    });

    it("calculates correctly for 5 minutes", () => {
      expect(calculateBrowserSessionCredits(5 * 60_000)).toBe(10);
    });

    it("calculates correctly for 10 minutes", () => {
      expect(calculateBrowserSessionCredits(10 * 60_000)).toBe(20);
    });

    it("calculates correctly for 1 hour", () => {
      expect(calculateBrowserSessionCredits(3_600_000)).toBe(120);
    });

    it("rounds up to next integer", () => {
      // 61s / 3600s * 120 = 2.033... → ceil = 3
      expect(calculateBrowserSessionCredits(61_000)).toBe(3);
    });
  });

  describe("with interact rate (420/hr)", () => {
    it("returns the one-minute minimum for very short sessions", () => {
      expect(calculateBrowserSessionCredits(0, INTERACT_CREDITS_PER_HOUR)).toBe(
        7,
      );
      expect(
        calculateBrowserSessionCredits(1000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(7);
    });

    it("calculates 7 credits per minute", () => {
      expect(
        calculateBrowserSessionCredits(60_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(7);
    });

    it("calculates 35 credits for 5 minutes", () => {
      expect(
        calculateBrowserSessionCredits(5 * 60_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(35);
    });

    it("calculates 70 credits for 10 minutes", () => {
      expect(
        calculateBrowserSessionCredits(10 * 60_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(70);
    });

    it("calculates 420 credits for 1 hour", () => {
      expect(
        calculateBrowserSessionCredits(3_600_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(420);
    });

    it("keeps the one-minute minimum below 60 seconds", () => {
      expect(
        calculateBrowserSessionCredits(31_000, INTERACT_CREDITS_PER_HOUR),
      ).toBe(7);
    });
  });

  describe("rate comparison", () => {
    it("interact rate is always >= browser rate for same duration", () => {
      const durations = [0, 1000, 30_000, 60_000, 300_000, 600_000, 3_600_000];
      for (const ms of durations) {
        const browserCredits = calculateBrowserSessionCredits(
          ms,
          BROWSER_CREDITS_PER_HOUR,
        );
        const interactCredits = calculateBrowserSessionCredits(
          ms,
          INTERACT_CREDITS_PER_HOUR,
        );
        expect(interactCredits).toBeGreaterThanOrEqual(browserCredits);
      }
    });

    it("interact rate is 3.5x browser rate for non-trivial durations", () => {
      const browser = calculateBrowserSessionCredits(
        5 * 60_000,
        BROWSER_CREDITS_PER_HOUR,
      );
      const interact = calculateBrowserSessionCredits(
        5 * 60_000,
        INTERACT_CREDITS_PER_HOUR,
      );
      expect(interact / browser).toBe(3.5);
    });
  });
});

// ---------------------------------------------------------------------------
// Durable prompt-accounting facade
// ---------------------------------------------------------------------------

describe("prompt usage tracking", () => {
  describe("markBrowserSessionUsedPrompt", () => {
    it("persists prompt use through the durable store", async () => {
      await markBrowserSessionUsedPrompt("session-123");

      expect(mockMarkSessionPromptUsed).toHaveBeenCalledWith("session-123");
    });

    it("does not hide PostgreSQL failures", async () => {
      const failure = new Error("PostgreSQL down");
      mockMarkSessionPromptUsed.mockRejectedValueOnce(failure);

      await expect(markBrowserSessionUsedPrompt("session-123")).rejects.toBe(
        failure,
      );
    });
  });

  describe("didBrowserSessionUsePrompt", () => {
    it("returns true when durable prompt use is set", async () => {
      mockDidSessionUsePrompt.mockResolvedValueOnce(true);

      const result = await didBrowserSessionUsePrompt("session-123");
      expect(result).toBe(true);
      expect(mockDidSessionUsePrompt).toHaveBeenCalledWith("session-123");
    });

    it("returns false when flag is not set", async () => {
      mockDidSessionUsePrompt.mockResolvedValueOnce(false);

      const result = await didBrowserSessionUsePrompt("session-123");
      expect(result).toBe(false);
    });

    it("does not downgrade billing on PostgreSQL failure", async () => {
      const failure = new Error("PostgreSQL down");
      mockDidSessionUsePrompt.mockRejectedValueOnce(failure);

      await expect(didBrowserSessionUsePrompt("session-123")).rejects.toBe(
        failure,
      );
    });
  });

  describe("clearBrowserSessionPromptFlag", () => {
    it("keeps durable prompt use monotonic", async () => {
      await expect(
        clearBrowserSessionPromptFlag("session-123"),
      ).resolves.not.toThrow();
      expect(mockMarkSessionPromptUsed).not.toHaveBeenCalled();
      expect(mockDidSessionUsePrompt).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Billing rate selection (integration of flag + rate)
// ---------------------------------------------------------------------------

describe("billing rate selection", () => {
  it("uses 420/hr when prompt flag is set", async () => {
    mockDidSessionUsePrompt.mockResolvedValueOnce(true);

    const usedPrompt = await didBrowserSessionUsePrompt("session-123");
    const rate = usedPrompt
      ? INTERACT_CREDITS_PER_HOUR
      : BROWSER_CREDITS_PER_HOUR;
    const credits = calculateBrowserSessionCredits(5 * 60_000, rate);

    expect(usedPrompt).toBe(true);
    expect(rate).toBe(420);
    expect(credits).toBe(35);
  });

  it("uses 120/hr when no prompt was used", async () => {
    mockDidSessionUsePrompt.mockResolvedValueOnce(false);

    const usedPrompt = await didBrowserSessionUsePrompt("session-123");
    const rate = usedPrompt
      ? INTERACT_CREDITS_PER_HOUR
      : BROWSER_CREDITS_PER_HOUR;
    const credits = calculateBrowserSessionCredits(5 * 60_000, rate);

    expect(usedPrompt).toBe(false);
    expect(rate).toBe(120);
    expect(credits).toBe(10);
  });

  it("full flow: mark → durable check → bill", async () => {
    await markBrowserSessionUsedPrompt("session-456");
    expect(mockMarkSessionPromptUsed).toHaveBeenCalledTimes(1);

    mockDidSessionUsePrompt.mockResolvedValueOnce(true);
    const usedPrompt = await didBrowserSessionUsePrompt("session-456");
    expect(usedPrompt).toBe(true);

    const credits = calculateBrowserSessionCredits(
      3 * 60_000,
      INTERACT_CREDITS_PER_HOUR,
    );
    expect(credits).toBe(21); // 3 min * 7 credits/min

    await clearBrowserSessionPromptFlag("session-456");
    expect(mockDidSessionUsePrompt).toHaveBeenCalledTimes(1);
  });
});
