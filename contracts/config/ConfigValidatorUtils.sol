// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "../data/DataStore.sol";
import "../data/Keys.sol";
import "../error/Errors.sol";
import "../utils/Precision.sol";

// @title ConfigValidatorUtils
// @dev Library that range-checks values being written through Config's generic
// uint setter. Lifted from Config to keep Config under the EVM 24,576-byte
// contract size limit. Pure validation — no behavior change.
library ConfigValidatorUtils {
    // 0.00001% per second, ~315% per year
    uint256 internal constant MAX_ALLOWED_MAX_FUNDING_FACTOR_PER_SECOND = 100000000000000000000000;
    // at this rate max allowed funding rate will be reached in 1 hour at 100% imbalance if max funding rate is 315%
    uint256 internal constant MAX_ALLOWED_FUNDING_INCREASE_FACTOR_PER_SECOND =
        MAX_ALLOWED_MAX_FUNDING_FACTOR_PER_SECOND / 1 hours;
    // at this rate zero funding rate will be reached in 24 hours if max funding rate is 315%
    uint256 internal constant MAX_ALLOWED_FUNDING_DECREASE_FACTOR_PER_SECOND =
        MAX_ALLOWED_MAX_FUNDING_FACTOR_PER_SECOND / 24 hours;

    // @dev validate that the value being set is within the allowed range for
    //      the given baseKey. Reverts with ConfigValueExceedsAllowedRange on
    //      out-of-bounds values. Reads dataStore for cross-parameter checks
    //      (e.g. min/max funding factor pair).
    function validateRange(
        DataStore dataStore,
        bytes32 baseKey,
        bytes memory data,
        uint256 value
    ) external view {
        if (baseKey == Keys.SEQUENCER_GRACE_DURATION) {
            // 2 hours
            if (value > 7200) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.MAX_FUNDING_FACTOR_PER_SECOND) {
            if (value > MAX_ALLOWED_MAX_FUNDING_FACTOR_PER_SECOND) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }

            bytes32 minFundingFactorPerSecondKey = Keys.getFullKey(Keys.MIN_FUNDING_FACTOR_PER_SECOND, data);
            uint256 minFundingFactorPerSecond = dataStore.getUint(minFundingFactorPerSecondKey);
            if (value < minFundingFactorPerSecond) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.MIN_FUNDING_FACTOR_PER_SECOND) {
            bytes32 maxFundingFactorPerSecondKey = Keys.getFullKey(Keys.MAX_FUNDING_FACTOR_PER_SECOND, data);
            uint256 maxFundingFactorPerSecond = dataStore.getUint(maxFundingFactorPerSecondKey);
            if (value > maxFundingFactorPerSecond) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.FUNDING_INCREASE_FACTOR_PER_SECOND) {
            if (value > MAX_ALLOWED_FUNDING_INCREASE_FACTOR_PER_SECOND) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.FUNDING_DECREASE_FACTOR_PER_SECOND) {
            if (value > MAX_ALLOWED_FUNDING_DECREASE_FACTOR_PER_SECOND) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.BORROWING_FACTOR || baseKey == Keys.BASE_BORROWING_FACTOR) {
            // 0.000005% per second, ~157% per year at 100% utilization
            if (value > 50000000000000000000000) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.ABOVE_OPTIMAL_USAGE_BORROWING_FACTOR) {
            // 0.00001% per second, ~315% per year at 100% utilization
            if (value > 100000000000000000000000) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.FUNDING_EXPONENT_FACTOR || baseKey == Keys.BORROWING_EXPONENT_FACTOR) {
            // revert if value > 2
            if (value > 2 * Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.POSITION_IMPACT_EXPONENT_FACTOR || baseKey == Keys.SWAP_IMPACT_EXPONENT_FACTOR) {
            // revert if value > 3
            if (value > 3 * Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (
            baseKey == Keys.FUNDING_FACTOR ||
            baseKey == Keys.BORROWING_FACTOR ||
            baseKey == Keys.FUNDING_INCREASE_FACTOR_PER_SECOND ||
            baseKey == Keys.FUNDING_DECREASE_FACTOR_PER_SECOND
        ) {
            // revert if value > 1%
            if (value > (1 * Precision.FLOAT_PRECISION) / 100) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (
            baseKey == Keys.SWAP_FEE_FACTOR ||
            baseKey == Keys.DEPOSIT_FEE_FACTOR ||
            baseKey == Keys.WITHDRAWAL_FEE_FACTOR ||
            baseKey == Keys.POSITION_FEE_FACTOR ||
            baseKey == Keys.MAX_UI_FEE_FACTOR ||
            baseKey == Keys.ATOMIC_SWAP_FEE_FACTOR ||
            baseKey == Keys.ATOMIC_WITHDRAWAL_FEE_FACTOR ||
            baseKey == Keys.BUYBACK_MAX_PRICE_IMPACT_FACTOR
        ) {
            // revert if value > 5%
            if (value > (5 * Precision.FLOAT_PRECISION) / 100) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        // The liquidation fee is charged on the collateral remaining at liquidation, not on
        // position size, so 100% is a coherent setting: the liquidated position keeps nothing.
        // Bound it there — above 100% the fee would exceed the collateral it is taken from.
        if (baseKey == Keys.LIQUIDATION_FEE_FACTOR) {
            if (value > Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        // Dynamic-MMR risk params : these were writable to any uint with no bounds.
        // MMR factors are maintenance ratios (<= 100%); minMmr must not exceed maxMmr (else the
        // clamp could otherwise return above the ceiling). Leverage is FLOAT_PRECISION-scaled
        // (1x == FLOAT_PRECISION); minLeverage must not exceed maxLeverage. Cross-checks read the
        // paired key and skip when it is still unset (0) so first-time configuration is unordered.
        if (baseKey == Keys.MAX_MMR) {
            // a 100%+ maintenance ratio force-liquidates even solvent positions
            if (value >= Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
            uint256 minMmr = dataStore.getUint(Keys.getFullKey(Keys.MIN_MMR, data));
            if (value < minMmr) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.MIN_MMR) {
            // ZEROMARK-149 guardrail: minMmr is the absolute floor of the maintenance buffer
            // (requiredCollateralUsd = collateralUsd × mmr, clamped to >= minMmr). A value of 0 would
            // let a low-leverage position's mmr clamp to 0 → zero maintenance buffer → the position is
            // only liquidatable once already insolvent, pushing the loss onto LPs. Require a non-zero
            // floor so every market always keeps some buffer.
            if (value == 0) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
            // same 100% ceiling as maxMmr; a 100% floor force-liquidates every position
            if (value >= Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
            uint256 maxMmr = dataStore.getUint(Keys.getFullKey(Keys.MAX_MMR, data));
            if (maxMmr != 0 && value > maxMmr) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.MMR_TUNING) {
            if (value > Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.MAX_LEVERAGE) {
            if (value < Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
            uint256 minLeverage = dataStore.getUint(Keys.getFullKey(Keys.MIN_LEVERAGE, data));
            if (value < minLeverage) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.MIN_LEVERAGE) {
            // minLeverage is opt-in: 0 means "no lower bound" (the deployed default for most markets).
            // Only enforce the >= 1x floor and the <= maxLeverage ordering when a non-zero bound is set.
            if (value != 0) {
                if (value < Precision.FLOAT_PRECISION) {
                    revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
                }
                uint256 maxLeverage = dataStore.getUint(Keys.getFullKey(Keys.MAX_LEVERAGE, data));
                if (maxLeverage != 0 && value > maxLeverage) {
                    revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
                }
            }
        }

        if (baseKey == Keys.MIN_COLLATERAL_USD) {
            // revert if value > 10 USD
            if (value > 10 * Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (
            baseKey == Keys.POSITION_FEE_VEALPHA_FACTOR ||
            baseKey == Keys.POSITION_FEE_TREASURY_FACTOR ||
            baseKey == Keys.POSITION_FEE_BUYBACK_FACTOR ||
            baseKey == Keys.LIQUIDATION_FEE_VALIDATOR_FACTOR ||
            baseKey == Keys.LIQUIDATION_FEE_INSURANCE_FACTOR ||
            baseKey == Keys.LIQUIDATION_FEE_BUYBACK_FACTOR ||
            baseKey == Keys.MAX_PNL_FACTOR ||
            baseKey == Keys.MIN_PNL_FACTOR_AFTER_ADL ||
            baseKey == Keys.OPTIMAL_USAGE_FACTOR ||
            baseKey == Keys.PRO_DISCOUNT_FACTOR ||
            baseKey == Keys.BUYBACK_GMX_FACTOR ||
            baseKey == Keys.DATA_STREAM_SPREAD_REDUCTION_FACTOR
        ) {
            // revert if value > 100%
            if (value > Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        if (baseKey == Keys.MAX_EXECUTION_FEE_MULTIPLIER_FACTOR) {
            if (value < Precision.FLOAT_PRECISION * 10 || value > Precision.FLOAT_PRECISION * 100_000) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        // ---------------------------------------------------------------
        // Insurance fund — sum-of-shares + drawdown trigger bounds
        // ---------------------------------------------------------------
        //
        // The liquidation fee is split between validator + insurance + pool.
        // PositionPricingUtils.getPositionFees computes the pool share as
        // residual: liquidationFeeAmount - liquidationFeeAmountForValidator -
        // liquidationFeeAmountForInsurance. Validator + insurance > 1e30
        // would underflow that subtraction, so enforce the sum here.
        // Both factors are global, so this check is exact (no per-market scope
        // ambiguity).
        if (
            baseKey == Keys.LIQUIDATION_FEE_VALIDATOR_FACTOR ||
            baseKey == Keys.LIQUIDATION_FEE_INSURANCE_FACTOR ||
            baseKey == Keys.LIQUIDATION_FEE_BUYBACK_FACTOR
        ) {
            uint256 total = value;
            if (baseKey != Keys.LIQUIDATION_FEE_VALIDATOR_FACTOR) {
                total += dataStore.getUint(Keys.LIQUIDATION_FEE_VALIDATOR_FACTOR);
            }
            if (baseKey != Keys.LIQUIDATION_FEE_INSURANCE_FACTOR) {
                total += dataStore.getUint(Keys.LIQUIDATION_FEE_INSURANCE_FACTOR);
            }
            if (baseKey != Keys.LIQUIDATION_FEE_BUYBACK_FACTOR) {
                total += dataStore.getUint(Keys.LIQUIDATION_FEE_BUYBACK_FACTOR);
            }
            if (total > Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        // Position fee receivers (veAlpha + treasury + buyback) have the
        // same underflow surface as the liquidation pair above:
        //   fees.positionFeeAmountForPool =
        //       fees.protocolFeeAmount
        //       - fees.veAlphaFeeAmount
        //       - fees.treasuryFeeAmount
        //       - fees.buybackFeeAmount;
        // If the three factors sum to > 1e30 the uint256 subtraction underflows.
        // Enforce the sum here on whichever of the three is being set.
        if (
            baseKey == Keys.POSITION_FEE_VEALPHA_FACTOR ||
            baseKey == Keys.POSITION_FEE_TREASURY_FACTOR ||
            baseKey == Keys.POSITION_FEE_BUYBACK_FACTOR
        ) {
            uint256 vealpha = baseKey == Keys.POSITION_FEE_VEALPHA_FACTOR
                ? value
                : dataStore.getUint(Keys.POSITION_FEE_VEALPHA_FACTOR);
            uint256 treasury = baseKey == Keys.POSITION_FEE_TREASURY_FACTOR
                ? value
                : dataStore.getUint(Keys.POSITION_FEE_TREASURY_FACTOR);
            uint256 buyback = baseKey == Keys.POSITION_FEE_BUYBACK_FACTOR
                ? value
                : dataStore.getUint(Keys.POSITION_FEE_BUYBACK_FACTOR);
            if (vealpha + treasury + buyback > Precision.FLOAT_PRECISION) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }

        // Drawdown trigger factor: type(uint256).max is the off-sentinel
        // (operators set this to disable the fund on a market). Otherwise the
        // value must sit in [1%, 100%] of pool USD: the ceiling keeps it a
        // fraction, the floor stops a dust trigger firing on any drawdown.
        if (baseKey == Keys.INSURANCE_FUND_DRAWDOWN_TRIGGER_FACTOR) {
            if (value != type(uint256).max) {
                if (value > Precision.FLOAT_PRECISION || value < Precision.FLOAT_PRECISION / 100) {
                    revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
                }
            }
        }

        if (baseKey == Keys.PYTH_LAZER_FEED_SPREAD_FACTOR) {
            // factor is a multiplier on confidence: 1e30 = identity, >1e30 widens band, 0 collapses band
            // cap at 100x as a fat-finger guard; provider also reverts if scaledConfidence >= price
            if (value > Precision.FLOAT_PRECISION * 100) {
                revert Errors.ConfigValueExceedsAllowedRange(baseKey, value);
            }
        }
    }
}
