// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "../pricing/PositionPricingUtils.sol";

// @dev Thin external wrapper over PositionPricingUtils.getNextOpenInterestParams so the single-token
// open-interest clamp (ZEROMARK-483) can be unit-tested directly. The function only reads
// params.usdDelta and params.isLong, so dataStore/market are left default-initialized.
contract PositionPricingUtilsTest {
    function getNextOpenInterestParams(
        int256 usdDelta,
        bool isLong,
        uint256 longOpenInterest,
        uint256 shortOpenInterest
    ) external pure returns (uint256 nextLongOpenInterest, uint256 nextShortOpenInterest) {
        PositionPricingUtils.GetPriceImpactUsdParams memory params;
        params.usdDelta = usdDelta;
        params.isLong = isLong;

        PositionPricingUtils.OpenInterestParams memory result =
            PositionPricingUtils.getNextOpenInterestParams(params, longOpenInterest, shortOpenInterest);

        return (result.nextLongOpenInterest, result.nextShortOpenInterest);
    }
}
