// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "../data/DataStore.sol";
import "../event/EventEmitter.sol";
import "../market/MarketCollateralUtils.sol";
import "../oracle/Oracle.sol";
import "../pricing/PositionPricingUtils.sol";

import "./Position.sol";
import "./PositionEventUtils.sol";
import "./PositionUtils.sol";
import "./PositionExecutionPriceUtils.sol";
import "../order/BaseOrderUtils.sol";
import "../order/OrderEventUtils.sol";

import "./DecreasePositionSwapUtils.sol";

import "../insurance/InsuranceFundUtils.sol";
import "../insurance/InsuranceVault.sol";

// @title DecreasePositionCollateralUtils
// @dev Library for functions to help with the calculations when decreasing a position
library DecreasePositionCollateralUtils {
    using SafeCast for uint256;
    using SafeCast for int256;

    using Position for Position.Props;
    using Order for Order.Props;
    using Price for Price.Props;

    using EventUtils for EventUtils.AddressItems;
    using EventUtils for EventUtils.UintItems;
    using EventUtils for EventUtils.IntItems;
    using EventUtils for EventUtils.BoolItems;
    using EventUtils for EventUtils.Bytes32Items;
    using EventUtils for EventUtils.BytesItems;
    using EventUtils for EventUtils.StringItems;

    struct ProcessCollateralCache {
        bool isInsolventCloseAllowed;
        bool wasSwapped;
        uint256 swapOutputAmount;
        PayForCostResult result;
    }

    struct PayForCostResult {
        uint256 amountPaidInCollateralToken;
        uint256 amountPaidInSecondaryOutputToken;
        uint256 remainingCostUsd;
    }

    // @dev handle the collateral changes of the position
    // @param params PositionUtils.UpdatePositionParams
    // @param cache DecreasePositionCache
    // @return (PositionUtils.DecreasePositionCollateralValues, PositionPricingUtils.PositionFees)
    function processCollateral(
        PositionUtils.UpdatePositionParams memory params,
        PositionUtils.DecreasePositionCache memory cache
    ) external returns (
        PositionUtils.DecreasePositionCollateralValues memory,
        PositionPricingUtils.PositionFees memory
    ) {
        ProcessCollateralCache memory collateralCache;
        PositionUtils.DecreasePositionCollateralValues memory values;

        values.output.outputToken = params.position.collateralToken();
        values.output.secondaryOutputToken = cache.pnlToken;

        // only allow insolvent closing if it is a liquidation or ADL order
        // isInsolventCloseAllowed is used in handleEarlyReturn to determine
        // whether the txn should revert if the remainingCostUsd is below zero
        //
        // for isInsolventCloseAllowed to be true, the sizeDeltaUsd must equal
        // the position size, otherwise there may be pending positive pnl that
        // could be used to pay for fees and the position would be undercharged
        // if the position is not fully closed
        //
        // for ADLs it may be possible that a position needs to be closed by a larger
        // size to fully pay for fees, but closing by that larger size could cause a PnlOvercorrected
        // error to be thrown in AdlHandler, this case should be rare
        collateralCache.isInsolventCloseAllowed =
            params.order.sizeDeltaUsd() == params.position.sizeInUsd() &&
            (
                BaseOrderUtils.isLiquidationOrder(params.order.orderType()) ||
                params.secondaryOrderType == Order.SecondaryOrderType.Adl
            );

        // in case price impact is too high it is capped and the difference is made to be claimable
        // the execution price is based on the capped price impact so it may be a better price than what it should be
        // priceImpactDiffUsd is the difference between the maximum price impact and the originally calculated price impact
        // e.g. if the originally calculated price impact is -$100, but the capped price impact is -$80
        // then priceImpactDiffUsd would be $20
        (values.priceImpactUsd, values.priceImpactDiffUsd, values.executionPrice) = PositionExecutionPriceUtils.getExecutionPriceForDecrease(params, cache.prices.indexTokenPrice);

        // the totalPositionPnl is calculated based on the current indexTokenPrice instead of the executionPrice
        // since the executionPrice factors in price impact which should be accounted for separately
        // the sizeDeltaInTokens is calculated as position.sizeInTokens() * sizeDeltaUsd / position.sizeInUsd()
        // the basePnlUsd is the pnl to be realized, and is calculated as:
        // totalPositionPnl * sizeDeltaInTokens / position.sizeInTokens()
        (values.basePnlUsd, values.uncappedBasePnlUsd, values.sizeDeltaInTokens) = PositionUtils.getPositionPnlUsd(
            params.contracts.dataStore,
            params.market,
            cache.prices,
            params.position,
            params.order.sizeDeltaUsd()
        );

        PositionPricingUtils.GetPositionFeesParams memory getPositionFeesParams = PositionPricingUtils.GetPositionFeesParams(
            params.contracts.dataStore, // dataStore
            params.contracts.referralStorage, // referralStorage
            params.position, // position
            cache.collateralTokenPrice, // collateralTokenPrice
            values.priceImpactUsd > 0, // forPositiveImpact
            params.market.longToken, // longToken
            params.market.shortToken, // shortToken
            params.order.sizeDeltaUsd(), // sizeDeltaUsd
            0, // remainingCollateralUsd, fills in the code below
            params.order.uiFeeReceiver(), // uiFeeReceiver
            BaseOrderUtils.isLiquidationOrder(params.order.orderType()) // isLiquidation
        );

        // if the pnl is positive, deduct the pnl amount from the pool
        if (values.basePnlUsd > 0) {
            // use pnlTokenPrice.max to minimize the tokens paid out
            uint256 deductionAmountForPool = values.basePnlUsd.toUint256() / cache.pnlTokenPrice.max;

            MarketUtils.applyDeltaToPoolAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.market,
                cache.pnlToken,
                -deductionAmountForPool.toInt256()
            );

            if (values.output.outputToken == cache.pnlToken) {
                values.output.outputAmount += deductionAmountForPool;
            } else {
                values.output.secondaryOutputAmount += deductionAmountForPool;
            }
        }

        if (values.priceImpactUsd > 0) {
            // use indexTokenPrice.min to maximize the position impact pool reduction
            uint256 deductionAmountForImpactPool = Calc.roundUpDivision(values.priceImpactUsd.toUint256(), cache.prices.indexTokenPrice.min);

            MarketUtils.applyDeltaToPositionImpactPool(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.market.marketToken,
                -deductionAmountForImpactPool.toInt256()
            );

            // use pnlTokenPrice.max to minimize the payout from the pool
            // some impact pool value may be transferred to the market token pool if there is a
            // large spread between min and max prices
            // since if there is a positive priceImpactUsd, the impact pool would be reduced using indexTokenPrice.min to
            // maximize the deduction value, while the market token pool is reduced using the pnlTokenPrice.max to minimize
            // the deduction value
            // the pool value is calculated by subtracting the worth of the tokens in the position impact pool
            // so this transfer of value would increase the price of the market token
            uint256 deductionAmountForPool = values.priceImpactUsd.toUint256() / cache.pnlTokenPrice.max;

            MarketUtils.applyDeltaToPoolAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.market,
                cache.pnlToken,
                -deductionAmountForPool.toInt256()
            );

            if (values.output.outputToken == cache.pnlToken) {
                values.output.outputAmount += deductionAmountForPool;
            } else {
                values.output.secondaryOutputAmount += deductionAmountForPool;
            }
        }

        // swap profit to the collateral token
        // if the decreasePositionSwapType was set to NoSwap or if the swap fails due
        // to insufficient liquidity or other reasons then it is possible that
        // the profit remains in a different token from the collateral token
        (collateralCache.wasSwapped, collateralCache.swapOutputAmount) = DecreasePositionSwapUtils.swapProfitToCollateralToken(
            params,
            cache.pnlToken,
            values.output.secondaryOutputAmount
        );

        // if the swap was successful the profit should have been swapped
        // to the collateral token
        if (collateralCache.wasSwapped) {
            values.output.outputAmount += collateralCache.swapOutputAmount;
            values.output.secondaryOutputAmount = 0;
        }

        values.remainingCollateralAmount = params.position.collateralAmount();
        getPositionFeesParams.remainingCollateralUsd = values.remainingCollateralAmount * cache.collateralTokenPrice.min;

        PositionPricingUtils.PositionFees memory fees = PositionPricingUtils.getPositionFees(
            getPositionFeesParams
        );

        // pay for funding fees
        (values, collateralCache.result) = payForCost(
            params,
            values,
            cache.prices,
            cache.collateralTokenPrice,
            // use collateralTokenPrice.min because the payForCost
            // will divide the USD value by the price.min as well
            fees.funding.fundingFeeAmount * cache.collateralTokenPrice.min
        );

        if (collateralCache.result.amountPaidInSecondaryOutputToken > 0) {
            address holdingAddress = params.contracts.dataStore.getAddress(Keys.HOLDING_ADDRESS);
            if (holdingAddress == address(0)) {
                revert Errors.EmptyHoldingAddress();
            }

            // send the funding fee amount to the holding address
            // this funding fee amount should be swapped to the required token
            // and the resulting tokens should be deposited back into the pool
            MarketCollateralUtils.incrementClaimableCollateralAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.market.marketToken,
                values.output.secondaryOutputToken,
                holdingAddress,
                collateralCache.result.amountPaidInSecondaryOutputToken
            );
        }

        if (collateralCache.result.amountPaidInCollateralToken < fees.funding.fundingFeeAmount) {
            // the case where this is insufficient collateral to pay funding fees
            // should be rare, and the difference should be small
            // in case it happens, the pool should be topped up with the required amount using
            // the claimable amount sent to the holding address, an insurance fund, or similar mechanism
            PositionEventUtils.emitInsufficientFundingFeePayment(
                params.contracts.eventEmitter,
                params.market.marketToken,
                params.position.collateralToken(),
                fees.funding.fundingFeeAmount,
                collateralCache.result.amountPaidInCollateralToken,
                collateralCache.result.amountPaidInSecondaryOutputToken
            );
        }

        if (collateralCache.result.remainingCostUsd > 0) {
            return handleEarlyReturn(
                params,
                values,
                fees,
                collateralCache,
                "funding"
            );
        }

        // pay for negative pnl
        if (values.basePnlUsd < 0) {
            (values, collateralCache.result) = payForCost(
                params,
                values,
                cache.prices,
                cache.collateralTokenPrice,
                (-values.basePnlUsd).toUint256()
            );

            if (collateralCache.result.amountPaidInCollateralToken > 0) {
                MarketUtils.applyDeltaToPoolAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market,
                    params.position.collateralToken(),
                    collateralCache.result.amountPaidInCollateralToken.toInt256()
                );
            }

            if (collateralCache.result.amountPaidInSecondaryOutputToken > 0) {
                MarketUtils.applyDeltaToPoolAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market,
                    values.output.secondaryOutputToken,
                    collateralCache.result.amountPaidInSecondaryOutputToken.toInt256()
                );
            }

            if (collateralCache.result.remainingCostUsd > 0) {
                return handleEarlyReturn(
                    params,
                    values,
                    fees,
                    collateralCache,
                    "pnl"
                );
            }
        }

        // pay for fees
        (values, collateralCache.result) = payForCost(
            params,
            values,
            cache.prices,
            cache.collateralTokenPrice,
            // use collateralTokenPrice.min because the payForCost
            // will divide the USD value by the price.min as well
            fees.totalCostAmountExcludingFunding * cache.collateralTokenPrice.min
        );

        // if fees were fully paid in the collateral token, update the pool and claimable fee amounts
        if (collateralCache.result.remainingCostUsd == 0 && collateralCache.result.amountPaidInSecondaryOutputToken == 0) {
            // there may be a large amount of borrowing fees that could have been accumulated
            // these fees could cause the pool to become unbalanced, price impact is not paid for causing
            // this imbalance
            // the swap impact pool should be built up so that it can be used to pay for positive price impact
            // for re-balancing to help handle this case
            //
            // Skip the pool delta when feeAmountForPool is zero — avoids an empty
            // PoolAmountUpdated event and matches the guard in
            // _distributeInsolventShares. (Cannot be negative; type is uint256.)
            if (fees.feeAmountForPool > 0) {
                MarketUtils.applyDeltaToPoolAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market,
                    params.position.collateralToken(),
                    fees.feeAmountForPool.toInt256()
                );
            }

            address collateralToken = params.position.collateralToken();

            _distributeTransactionShares(params, fees, collateralToken);
            _distributeLiquidationShares(params, fees, collateralToken);

            FeeUtils.incrementClaimableUiFeeAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.order.uiFeeReceiver(),
                params.market.marketToken,
                collateralToken,
                fees.ui.uiFeeAmount,
                Keys.UI_POSITION_FEE_TYPE
            );
        } else if (collateralCache.result.remainingCostUsd > 0) {
            _distributeInsolventShares(params, fees, collateralCache.result.amountPaidInCollateralToken);

            if (collateralCache.result.amountPaidInSecondaryOutputToken > 0) {
                MarketUtils.applyDeltaToPoolAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market,
                    values.output.secondaryOutputToken,
                    collateralCache.result.amountPaidInSecondaryOutputToken.toInt256()
                );
            }
        } else {
            // Fully paid, but part (or all) of the fee came from the secondary output token. Distribute
            // the configured fee shares across BOTH payment tokens, in proportion to how much of the fee
            // each token covered — instead of crediting the whole amount to the pool and zeroing the fees,
            // which silently bypassed the configured receivers (veAlpha / treasury / buyback / validator /
            // insurance / UI / affiliate). Mirrors _distributeInsolventShares, applied per payment token.
            _distributeSecondaryPaidShares(
                params,
                fees,
                collateralCache.result.amountPaidInCollateralToken,
                collateralCache.result.amountPaidInSecondaryOutputToken,
                values.output.secondaryOutputToken
            );
        }

        if (collateralCache.result.remainingCostUsd > 0) {
            return handleEarlyReturn(
                params,
                values,
                fees,
                collateralCache,
                "fees"
            );
        }

        // pay for negative price impact
        if (values.priceImpactUsd < 0) {
            (values, collateralCache.result) = payForCost(
                params,
                values,
                cache.prices,
                cache.collateralTokenPrice,
                (-values.priceImpactUsd).toUint256()
            );

            if (collateralCache.result.amountPaidInCollateralToken > 0) {
                MarketUtils.applyDeltaToPoolAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market,
                    params.position.collateralToken(),
                    collateralCache.result.amountPaidInCollateralToken.toInt256()
                );

                MarketUtils.applyDeltaToPositionImpactPool(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market.marketToken,
                    (collateralCache.result.amountPaidInCollateralToken * cache.collateralTokenPrice.min / cache.prices.indexTokenPrice.max).toInt256()
                );
            }

            if (collateralCache.result.amountPaidInSecondaryOutputToken > 0) {
                MarketUtils.applyDeltaToPoolAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market,
                    values.output.secondaryOutputToken,
                    collateralCache.result.amountPaidInSecondaryOutputToken.toInt256()
                );

                MarketUtils.applyDeltaToPositionImpactPool(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market.marketToken,
                    (collateralCache.result.amountPaidInSecondaryOutputToken * cache.pnlTokenPrice.min / cache.prices.indexTokenPrice.max).toInt256()
                );
            }

            if (collateralCache.result.remainingCostUsd > 0) {
                return handleEarlyReturn(
                    params,
                    values,
                    fees,
                    collateralCache,
                    "impact"
                );
            }
        }

        // pay for price impact diff
        if (values.priceImpactDiffUsd > 0) {
            (values, collateralCache.result) = payForCost(
                params,
                values,
                cache.prices,
                cache.collateralTokenPrice,
                values.priceImpactDiffUsd
            );

            if (collateralCache.result.amountPaidInCollateralToken > 0) {
                MarketCollateralUtils.incrementClaimableCollateralAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market.marketToken,
                    params.position.collateralToken(),
                    params.order.account(),
                    collateralCache.result.amountPaidInCollateralToken
                );
            }

            if (collateralCache.result.amountPaidInSecondaryOutputToken > 0) {
                MarketCollateralUtils.incrementClaimableCollateralAmount(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    params.market.marketToken,
                    values.output.secondaryOutputToken,
                    params.order.account(),
                    collateralCache.result.amountPaidInSecondaryOutputToken
                );
            }

            if (collateralCache.result.remainingCostUsd > 0) {
                return handleEarlyReturn(
                    params,
                    values,
                    fees,
                    collateralCache,
                    "diff"
                );
            }
        }

        // the priceImpactDiffUsd has been deducted from the output amount or the position's collateral
        // to reduce the chance that the position's collateral is reduced by an unexpected amount, adjust the
        // initialCollateralDeltaAmount by the priceImpactDiffAmount
        // this would also help to prevent the position's leverage from being unexpectedly increased
        //
        // note that this calculation may not be entirely accurate since it is possible that the priceImpactDiffUsd
        // could have been paid with one of or a combination of collateral / outputAmount / secondaryOutputAmount
        if (params.order.initialCollateralDeltaAmount() > 0 && values.priceImpactDiffUsd > 0) {
            uint256 initialCollateralDeltaAmount = params.order.initialCollateralDeltaAmount();

            uint256 priceImpactDiffAmount = values.priceImpactDiffUsd / cache.collateralTokenPrice.min;
            if (initialCollateralDeltaAmount > priceImpactDiffAmount) {
                params.order.setInitialCollateralDeltaAmount(initialCollateralDeltaAmount - priceImpactDiffAmount);
            } else {
                params.order.setInitialCollateralDeltaAmount(0);
            }

            OrderEventUtils.emitOrderCollateralDeltaAmountAutoUpdated(
                params.contracts.eventEmitter,
                params.orderKey,
                initialCollateralDeltaAmount, // collateralDeltaAmount
                params.order.initialCollateralDeltaAmount() // nextCollateralDeltaAmount
            );
        }

        // cap the withdrawable amount to the remainingCollateralAmount
        if (params.order.initialCollateralDeltaAmount() > values.remainingCollateralAmount) {
            OrderEventUtils.emitOrderCollateralDeltaAmountAutoUpdated(
                params.contracts.eventEmitter,
                params.orderKey,
                params.order.initialCollateralDeltaAmount(), // collateralDeltaAmount
                values.remainingCollateralAmount // nextCollateralDeltaAmount
            );

            params.order.setInitialCollateralDeltaAmount(values.remainingCollateralAmount);
        }

        if (params.order.initialCollateralDeltaAmount() > 0) {
            values.remainingCollateralAmount -= params.order.initialCollateralDeltaAmount();
            values.output.outputAmount += params.order.initialCollateralDeltaAmount();
        }

        // Insurance injection deliberately does NOT run here. It is invoked from
        // DecreasePositionUtils AFTER updateTotalBorrowing, because the drawdown
        // metric reads pool value that includes pending borrowing fees: at this
        // point the realized borrowing fee has been credited to poolAmount but
        // the pending-borrowing aggregate has not yet been reduced, so valuing
        // here double-counts the fee, inflates pool value, and suppresses an
        // otherwise-required injection. Running it post-borrowing
        // also makes insolvent liquidations / ADL — which exit via
        // handleEarlyReturn but still flow through DecreasePositionUtils — reach
        // the injection check

        return (values, fees);
    }

    // @dev If realized drawdown exceeds the per-market trigger factor, move
    // reserves from the InsuranceVault back into the pool. No-ops cleanly when
    // the trigger is the off-sentinel (type(uint256).max), drawdown is at or
    // below the threshold, the epoch snapshot is stale/uninitialized, or
    // INSURANCE_FUND_ADDRESS is unset. Called from DecreasePositionUtils after
    // updateTotalBorrowing so solvent decreases, insolvent liquidations and ADL
    // all reach it at the correct settlement point.
    function maybeInjectInsurancePool(
        PositionUtils.UpdatePositionParams memory params,
        PositionUtils.DecreasePositionCache memory cache
    ) internal {
        address vaultAddress = params.contracts.dataStore.getAddress(Keys.INSURANCE_FUND_ADDRESS);
        if (vaultAddress == address(0)) {
            return;
        }
        InsuranceFundUtils.attemptInjectPool(
            params.contracts.dataStore,
            params.contracts.eventEmitter,
            InsuranceVault(payable(vaultAddress)),
            params.market,
            cache.prices,
            cache.pnlToken,
            params.orderKey
        );
    }

    function payForCost(
        PositionUtils.UpdatePositionParams memory params,
        PositionUtils.DecreasePositionCollateralValues memory values,
        MarketUtils.MarketPrices memory prices,
        Price.Props memory collateralTokenPrice,
        uint256 costUsd
    ) internal pure returns (PositionUtils.DecreasePositionCollateralValues memory, PayForCostResult memory) {
        PayForCostResult memory result;

        if (costUsd == 0) { return (values, result); }

        uint256 remainingCostInOutputToken = Calc.roundUpDivision(costUsd, collateralTokenPrice.min);

        if (values.output.outputAmount > 0) {
            if (values.output.outputAmount > remainingCostInOutputToken) {
                result.amountPaidInCollateralToken += remainingCostInOutputToken;
                values.output.outputAmount -= remainingCostInOutputToken;
                remainingCostInOutputToken = 0;
            } else {
                result.amountPaidInCollateralToken += values.output.outputAmount;
                remainingCostInOutputToken -= values.output.outputAmount;
                values.output.outputAmount = 0;
            }
        }

        if (remainingCostInOutputToken == 0) { return (values, result); }

        if (values.remainingCollateralAmount > 0) {
            if (values.remainingCollateralAmount > remainingCostInOutputToken) {
                result.amountPaidInCollateralToken += remainingCostInOutputToken;
                values.remainingCollateralAmount -= remainingCostInOutputToken;
                remainingCostInOutputToken = 0;
            } else {
                result.amountPaidInCollateralToken += values.remainingCollateralAmount;
                remainingCostInOutputToken -= values.remainingCollateralAmount;
                values.remainingCollateralAmount = 0;
            }
        }

        if (remainingCostInOutputToken == 0) { return (values, result); }

        Price.Props memory secondaryOutputTokenPrice = MarketUtils.getCachedTokenPrice(values.output.secondaryOutputToken, params.market, prices);

        uint256 remainingCostInSecondaryOutputToken = remainingCostInOutputToken * collateralTokenPrice.min / secondaryOutputTokenPrice.min;

        if (values.output.secondaryOutputAmount > 0) {
            if (values.output.secondaryOutputAmount > remainingCostInSecondaryOutputToken) {
                result.amountPaidInSecondaryOutputToken += remainingCostInSecondaryOutputToken;
                values.output.secondaryOutputAmount -= remainingCostInSecondaryOutputToken;
                remainingCostInSecondaryOutputToken = 0;
            } else {
                result.amountPaidInSecondaryOutputToken += values.output.secondaryOutputAmount;
                remainingCostInSecondaryOutputToken -= values.output.secondaryOutputAmount;
                values.output.secondaryOutputAmount = 0;
            }
        }

        result.remainingCostUsd = remainingCostInSecondaryOutputToken * secondaryOutputTokenPrice.min;

        return (values, result);
    }

    function handleEarlyReturn(
        PositionUtils.UpdatePositionParams memory params,
        PositionUtils.DecreasePositionCollateralValues memory values,
        PositionPricingUtils.PositionFees memory fees,
        ProcessCollateralCache memory collateralCache,
        string memory step
    ) internal returns (PositionUtils.DecreasePositionCollateralValues memory, PositionPricingUtils.PositionFees memory) {
        if (!collateralCache.isInsolventCloseAllowed) {
            revert Errors.InsufficientFundsToPayForCosts(collateralCache.result.remainingCostUsd, step);
        }

        PositionEventUtils.emitPositionFeesInfo(
            params.contracts.eventEmitter,
            params.orderKey,
            params.positionKey,
            params.market.marketToken,
            params.position.collateralToken(),
            params.order.sizeDeltaUsd(),
            false, // isIncrease
            fees
        );

        PositionEventUtils.emitInsolventClose(
            params.contracts.eventEmitter,
            params.orderKey,
            params.position.collateralAmount(),
            values.basePnlUsd,
            collateralCache.result.remainingCostUsd,
            step
        );

        // Note: insolvent liquidations / ADL return cleanly here (they do not
        // revert), so they still flow back through DecreasePositionUtils, where
        // the insurance injection now runs after updateTotalBorrowing — covering
        // these bad-debt events (ZEROMARK-131) at the correct settlement point.
        return (values, getEmptyFees(fees));
    }

    // @dev zeroed fees for an early return. Only the funding values and the collateral price
    //      carry over: the funding values may still be needed to update a partially closed
    //      position, everything else is deliberately dropped.
    function getEmptyFees(
        PositionPricingUtils.PositionFees memory fees
    ) internal pure returns (PositionPricingUtils.PositionFees memory) {
        PositionPricingUtils.PositionFees memory _fees;

        _fees.funding.claimableLongTokenAmount = fees.funding.claimableLongTokenAmount;
        _fees.funding.claimableShortTokenAmount = fees.funding.claimableShortTokenAmount;
        _fees.funding.latestFundingFeeAmountPerSize = fees.funding.latestFundingFeeAmountPerSize;
        _fees.funding.latestLongTokenClaimableFundingAmountPerSize = fees.funding.latestLongTokenClaimableFundingAmountPerSize;
        _fees.funding.latestShortTokenClaimableFundingAmountPerSize = fees.funding.latestShortTokenClaimableFundingAmountPerSize;

        _fees.collateralTokenPrice = fees.collateralTokenPrice;

        return _fees;
    }

    function _distributeTransactionShares(
        PositionUtils.UpdatePositionParams memory params,
        PositionPricingUtils.PositionFees memory fees,
        address collateralToken
    ) internal {
        address veAlphaFeeReceiver = params.contracts.dataStore.getAddress(Keys.VEALPHA_FEE_RECEIVER);
        if (veAlphaFeeReceiver != address(0)) {
            FeeUtils.incrementClaimableFeeAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                veAlphaFeeReceiver,
                params.market.marketToken,
                collateralToken,
                fees.veAlphaFeeAmount,
                Keys.POSITION_FEE_TYPE
            );
        }

        address treasuryFeeReceiver = params.contracts.dataStore.getAddress(Keys.TREASURY_FEE_RECEIVER);
        if (treasuryFeeReceiver != address(0)) {
            FeeUtils.incrementClaimableFeeAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                treasuryFeeReceiver,
                params.market.marketToken,
                collateralToken,
                fees.treasuryFeeAmount,
                Keys.POSITION_FEE_TYPE
            );
        }

        address buybackFeeReceiver = params.contracts.dataStore.getAddress(Keys.BUYBACK_FEE_RECEIVER);
        if (buybackFeeReceiver != address(0)) {
            FeeUtils.incrementClaimableFeeAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                buybackFeeReceiver,
                params.market.marketToken,
                collateralToken,
                fees.buybackFeeAmount,
                Keys.POSITION_FEE_TYPE
            );
        }
    }

    function _distributeLiquidationShares(
        PositionUtils.UpdatePositionParams memory params,
        PositionPricingUtils.PositionFees memory fees,
        address collateralToken
    ) internal {
        address validatorFeeReceiver = params.contracts.dataStore.getAddress(Keys.VALIDATOR_FEE_RECEIVER);
        if (validatorFeeReceiver != address(0)) {
            FeeUtils.incrementClaimableFeeAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                validatorFeeReceiver,
                params.market.marketToken,
                collateralToken,
                fees.validatorFeeAmount,
                Keys.POSITION_FEE_TYPE
            );
        }

        // Insurance fund: route the configured slice into the InsuranceVault.
        // INSURANCE_FUND_ADDRESS holds the vault contract; InsuranceFundUtils.deposit
        // transfers the slice from MarketToken into the vault and increments the
        // per (market, token) reserve bucket so attemptInjectPool can draw from it
        // when realized drawdown crosses the trigger. fees.feeAmountForPool already
        // excludes this slice (see PositionPricingUtils.getPositionFees) — no
        // double counting against the pool delta.
        if (fees.insuranceFeeAmount > 0) {
            InsuranceVault insuranceVault = InsuranceVault(payable(params.contracts.dataStore.getAddress(Keys.INSURANCE_FUND_ADDRESS)));
            if (address(insuranceVault) != address(0)) {
                InsuranceFundUtils.deposit(
                    params.contracts.dataStore,
                    params.contracts.eventEmitter,
                    insuranceVault,
                    params.market.marketToken,
                    collateralToken,
                    params.orderKey,
                    fees.insuranceFeeAmount
                );
            }
        }
    }

    // @dev Insolvent / partial-payment fee distribution for the collateral-
    // token portion of the recovered amount. Scales each receiver share by
    //   scale = amountPaidInCollateralToken / totalCostAmountExcludingFunding
    // (capped at 1.0) so the sum of distributed shares stays ≤ recovered.
    //
    // Mutates `fees` in place — handleEarlyReturn's PositionFeesInfo emit
    // downstream will reflect the scaled values that were actually written.
    function _distributeInsolventShares(
        PositionUtils.UpdatePositionParams memory params,
        PositionPricingUtils.PositionFees memory fees,
        uint256 amountPaidInCollateralToken
    ) internal {
        if (amountPaidInCollateralToken == 0 || fees.totalCostAmountExcludingFunding == 0) {
            // Nothing recovered or nothing owed — no scaled distribution.
            // handleEarlyReturn will return getEmptyFees(fees) downstream.
            return;
        }

        uint256 scale = Precision.toFactor(
            amountPaidInCollateralToken,
            fees.totalCostAmountExcludingFunding
        );
        if (scale > Precision.FLOAT_PRECISION) {
            scale = Precision.FLOAT_PRECISION;
        }

        fees.feeAmountForPool = Precision.applyFactor(fees.feeAmountForPool, scale);
        fees.veAlphaFeeAmount = Precision.applyFactor(fees.veAlphaFeeAmount, scale);
        fees.treasuryFeeAmount = Precision.applyFactor(fees.treasuryFeeAmount, scale);
        fees.buybackFeeAmount = Precision.applyFactor(fees.buybackFeeAmount, scale);
        fees.validatorFeeAmount = Precision.applyFactor(fees.validatorFeeAmount, scale);
        fees.insuranceFeeAmount = Precision.applyFactor(fees.insuranceFeeAmount, scale);
        fees.ui.uiFeeAmount = Precision.applyFactor(fees.ui.uiFeeAmount, scale);
        // Affiliate reward is part of totalCostAmountExcludingFunding too. Without
        // scaling + crediting it here, the proportional portion of the recovered
        // tokens that "belongs" to the affiliate would sit in the contract as
        // orphan tokens (handleEarlyReturn zeros fees downstream, so handleReferral
        // writes 0 to the affiliate). Pay it inside this function instead.
        fees.referral.affiliateRewardAmount = Precision.applyFactor(fees.referral.affiliateRewardAmount, scale);

        _payFeeShares(params, fees, params.position.collateralToken());
    }

    // @dev Fully-paid decrease where part (or all) of the fee was paid from the secondary output
    // token. Distribute the configured fee shares across BOTH payment tokens in proportion to how much
    // of the total fee each token covered, so the fee split no longer depends on which token paid.
    // `fees` is restored to its original amounts on return so the downstream PositionFeesInfo emit still
    // reports the full fee.
    function _distributeSecondaryPaidShares(
        PositionUtils.UpdatePositionParams memory params,
        PositionPricingUtils.PositionFees memory fees,
        uint256 amountPaidInCollateralToken,
        uint256 amountPaidInSecondaryOutputToken,
        address secondaryOutputToken
    ) internal {
        uint256 totalCost = fees.totalCostAmountExcludingFunding;
        // This branch is only reached when the secondary token paid part of a fully-covered fee, so a fee
        // was owed (totalCost > 0). Guard defensively anyway.
        if (totalCost == 0) {
            return;
        }

        // Snapshot originals; the struct is scaled per payment token below, then restored (scale = 1.0).
        DecreasePositionCollateralUtilsCache.OriginalFees memory orig = DecreasePositionCollateralUtilsCache.OriginalFees(
            fees.feeAmountForPool,
            fees.veAlphaFeeAmount,
            fees.treasuryFeeAmount,
            fees.buybackFeeAmount,
            fees.validatorFeeAmount,
            fees.insuranceFeeAmount,
            fees.ui.uiFeeAmount,
            fees.referral.affiliateRewardAmount
        );

        address[2] memory tokens = [params.position.collateralToken(), secondaryOutputToken];
        uint256[2] memory amounts = [amountPaidInCollateralToken, amountPaidInSecondaryOutputToken];

        for (uint256 i; i < 2; i++) {
            if (amounts[i] == 0) {
                continue;
            }
            // Collateral (i==0): a true fraction, capped at 1.0. Secondary (i==1): also converts the
            // collateral-denominated buckets into secondary-token units, so it is not capped.
            uint256 scale = Precision.toFactor(amounts[i], totalCost);
            if (i == 0 && scale > Precision.FLOAT_PRECISION) {
                scale = Precision.FLOAT_PRECISION;
            }
            _scaleFees(fees, orig, scale);
            _payFeeShares(params, fees, tokens[i]);
        }

        // Restore originals (scale by 1.0) so the downstream fee event reports the full fee.
        _scaleFees(fees, orig, Precision.FLOAT_PRECISION);

        // The affiliate reward was already paid inline above (across both payment tokens). Unlike the
        // other buckets, the affiliate is otherwise paid downstream by PositionUtils.handleReferral,
        // which runs after this branch (this branch does not early-return). Zero it here so the
        // affiliate is not credited a second time.
        fees.referral.affiliateRewardAmount = 0;
    }

    function _scaleFees(
        PositionPricingUtils.PositionFees memory fees,
        DecreasePositionCollateralUtilsCache.OriginalFees memory orig,
        uint256 scale
    ) private pure {
        fees.feeAmountForPool = Precision.applyFactor(orig.feeAmountForPool, scale);
        fees.veAlphaFeeAmount = Precision.applyFactor(orig.veAlphaFeeAmount, scale);
        fees.treasuryFeeAmount = Precision.applyFactor(orig.treasuryFeeAmount, scale);
        fees.buybackFeeAmount = Precision.applyFactor(orig.buybackFeeAmount, scale);
        fees.validatorFeeAmount = Precision.applyFactor(orig.validatorFeeAmount, scale);
        fees.insuranceFeeAmount = Precision.applyFactor(orig.insuranceFeeAmount, scale);
        fees.ui.uiFeeAmount = Precision.applyFactor(orig.uiFeeAmount, scale);
        fees.referral.affiliateRewardAmount = Precision.applyFactor(orig.affiliateRewardAmount, scale);
    }

    function _payFeeShares(
        PositionUtils.UpdatePositionParams memory params,
        PositionPricingUtils.PositionFees memory fees,
        address token
    ) internal {
        if (fees.feeAmountForPool > 0) {
            MarketUtils.applyDeltaToPoolAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.market,
                token,
                fees.feeAmountForPool.toInt256()
            );
        }
        _distributeTransactionShares(params, fees, token);
        _distributeLiquidationShares(params, fees, token);
        if (fees.ui.uiFeeAmount > 0) {
            FeeUtils.incrementClaimableUiFeeAmount(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.order.uiFeeReceiver(),
                params.market.marketToken,
                token,
                fees.ui.uiFeeAmount,
                Keys.UI_POSITION_FEE_TYPE
            );
        }
        if (fees.referral.affiliateRewardAmount > 0 && fees.referral.affiliate != address(0)) {
            ReferralUtils.incrementAffiliateReward(
                params.contracts.dataStore,
                params.contracts.eventEmitter,
                params.market.marketToken,
                token,
                fees.referral.affiliate,
                fees.referral.affiliateRewardAmount
            );
        }
    }
}

library DecreasePositionCollateralUtilsCache {
    struct OriginalFees {
        uint256 feeAmountForPool;
        uint256 veAlphaFeeAmount;
        uint256 treasuryFeeAmount;
        uint256 buybackFeeAmount;
        uint256 validatorFeeAmount;
        uint256 insuranceFeeAmount;
        uint256 uiFeeAmount;
        uint256 affiliateRewardAmount;
    }
}
