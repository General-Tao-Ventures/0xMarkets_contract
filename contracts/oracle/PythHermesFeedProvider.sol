// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "../data/DataStore.sol";
import "../data/Keys.sol";
import "../error/Errors.sol";
import "../utils/Precision.sol";
import "./IOracleProvider.sol";
import "./OracleUtils.sol";

// @title PythHermesFeedProvider
// @dev Stateless oracle provider that decodes Pyth Hermes price data
// passed by the keeper as ABI-encoded (uint256 price, uint256 conf, int32 expo, uint256 publishTime)
// and returns a ValidatedPrice in GMX's FLOAT_PRECISION (10^30) domain.
//
// No signature verification. The handler's onlyController modifier ensures only the keeper
// can trigger this path.
//
// GMX prices are scaled so that storedPrice * 10^tokenDecimals == realPrice * 10^30, i.e.
// storedPrice == realPrice * 10^(30 - tokenDecimals). The Hermes payload only carries
// realPrice (as price * 10^expo); without applying the per-token decimal correction the returned
// price is exactly 10^tokenDecimals too large (1e18x for an 18-decimal token), catastrophically
// mispricing positions, collateral, liquidations and swaps for any market wired to this provider.
// The sibling providers (ChainlinkPriceFeed via priceFeedMultiplier, PythLazer via
// pythLazerFeedMultiplier) both apply this correction; this provider now mirrors them and fails
// closed when no per-token multiplier is configured.
contract PythHermesFeedProvider is IOracleProvider {
    DataStore public immutable dataStore;

    constructor(DataStore _dataStore) {
        dataStore = _dataStore;
    }

    function getOraclePrice(
        address token,
        bytes memory data
    ) external view returns (OracleUtils.ValidatedPrice memory) {
        (uint256 price, uint256 conf, int32 expo, uint256 publishTime) = abi.decode(
            data,
            (uint256, uint256, int32, uint256)
        );

        // Per-token decimal multiplier = 10^(30 - tokenDecimals). The feed's own exponent is taken
        // from the live payload below, so this captures only the token-decimals correction. Fail
        // closed: an unconfigured token must never resolve to an unscaled (10^tokenDecimals too large)
        // price.
        uint256 feedMultiplier = dataStore.getUint(Keys.pythHermesFeedMultiplierKey(token));
        if (feedMultiplier == 0) {
            revert Errors.EmptyPythHermesFeedMultiplier(token);
        }

        // First convert the Pyth (price, expo) pair into the realPrice * 10^30 domain:
        //   realPrice = price * 10^expo  =>  realPrice * 10^30 = price * 10^(30 + expo)
        // expo is bounded (Pyth exponents are small, e.g. -8), so 30 + expo stays positive and the
        // exponentiation is exact with no division/precision loss.
        uint256 expoMultiplier = expo >= 0
            ? 10 ** (30 + uint32(expo))
            : 10 ** (30 - uint32(-expo));

        uint256 minRealPrice1e30 = (price - conf) * expoMultiplier;
        uint256 maxRealPrice1e30 = (price + conf) * expoMultiplier;

        // Then fold in the token-decimals correction:
        //   storedPrice = (realPrice * 10^30) * 10^(30 - tokenDecimals) / 10^30
        //               = realPrice * 10^(30 - tokenDecimals)
        uint256 minPrice = Precision.mulDiv(minRealPrice1e30, feedMultiplier, Precision.FLOAT_PRECISION);
        uint256 maxPrice = Precision.mulDiv(maxRealPrice1e30, feedMultiplier, Precision.FLOAT_PRECISION);

        return OracleUtils.ValidatedPrice({
            token: token,
            min: minPrice,
            max: maxPrice,
            timestamp: publishTime,
            provider: address(this)
        });
    }
}
