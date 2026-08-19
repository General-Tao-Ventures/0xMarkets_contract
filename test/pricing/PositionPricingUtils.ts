import { expect } from "chai";

import { deployContract } from "../../utils/deploy";
import { expandDecimals } from "../../utils/math";

describe("PositionPricingUtils.getNextOpenInterestParams (ZEROMARK-483)", () => {
  let wrapper;

  beforeEach(async () => {
    wrapper = await deployContract("PositionPricingUtilsTest", []);
  });

  // Single-token markets (longToken == shortToken) round getOpenInterest down (pool divisor == 2), so on
  // a full close usdDelta (the true position size) can be up to 1 wei above the rounded-down open
  // interest passed in. Upstream GMX clamps nextOpenInterest to 0 for this case; an interim GMX commit
  // reverted instead (UsdDeltaExceeds*OpenInterest), which bricked full close / liquidation / ADL on our
  // single-token USDC markets. This restores the clamp.

  it("clamps nextLongOpenInterest to 0 when |usdDelta| exceeds longOpenInterest (no revert)", async () => {
    const longOI = expandDecimals(1_000_000, 30);
    const usdDelta = longOI.add(1).mul(-1); // one wei beyond the rounded-down OI
    const [nextLong, nextShort] = await wrapper.getNextOpenInterestParams(usdDelta, true, longOI, 0);
    expect(nextLong).to.eq(0);
    expect(nextShort).to.eq(0);
  });

  it("clamps nextShortOpenInterest to 0 when |usdDelta| exceeds shortOpenInterest (no revert)", async () => {
    const shortOI = expandDecimals(1_000_000, 30);
    const usdDelta = shortOI.add(1).mul(-1);
    const [, nextShort] = await wrapper.getNextOpenInterestParams(usdDelta, false, 0, shortOI);
    expect(nextShort).to.eq(0);
  });

  it("boundary: |usdDelta| == openInterest returns 0 (the value upstream clamps to)", async () => {
    const longOI = expandDecimals(500_000, 30);
    const [nextLong] = await wrapper.getNextOpenInterestParams(longOI.mul(-1), true, longOI, 0);
    expect(nextLong).to.eq(0); // sum(longOI, -longOI) == 0
  });

  it("normal decrease (|usdDelta| < openInterest) reduces OI without clamping", async () => {
    const longOI = expandDecimals(1_000_000, 30);
    const usdDelta = expandDecimals(400_000, 30).mul(-1);
    const [nextLong] = await wrapper.getNextOpenInterestParams(usdDelta, true, longOI, 0);
    expect(nextLong).to.eq(expandDecimals(600_000, 30));
  });
});
