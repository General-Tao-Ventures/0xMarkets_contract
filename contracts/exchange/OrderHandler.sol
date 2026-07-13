// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "./BaseOrderHandler.sol";
import "../error/ErrorUtils.sol";
import "./IOrderHandler.sol";
import "../market/MarketUtils.sol";
import "../market/MarketStoreUtils.sol";
import "../order/OrderUtils.sol";
import "../order/ExecuteOrderUtils.sol";

// @title OrderHandler
// @dev Contract to handle creation, execution and cancellation of orders
contract OrderHandler is IOrderHandler, BaseOrderHandler {
    using SafeCast for uint256;
    using Order for Order.Props;
    using Array for uint256[];

    constructor(
        RoleStore _roleStore,
        DataStore _dataStore,
        EventEmitter _eventEmitter,
        Oracle _oracle,
        OrderVault _orderVault,
        SwapHandler _swapHandler,
        IReferralStorage _referralStorage
    ) BaseOrderHandler(
        _roleStore,
        _dataStore,
        _eventEmitter,
        _oracle,
        _orderVault,
        _swapHandler,
        _referralStorage
    ) {}

    // @dev Reversed markets (e.g. EUR/USD stored internally as USD/EUR) report inverted oracle
    //      prices, so user-supplied trigger/acceptable prices must be reciprocally inverted into the
    //      internal price domain before storage. Shared by createOrder and updateOrder so the two
    //      paths can never drift. Returns the (possibly inverted) prices plus
    //      whether the market is reversed — createOrder uses the flag to also flip isLong; updateOrder
    //      ignores it (direction is fixed at creation). No-op for the zero market or non-reversed.
    // @return the trigger price, acceptable price, and whether the market is reversed
    function _normalizeReversedPrices(
        address market,
        uint256 triggerPrice,
        uint256 acceptablePrice,
        bool requireEnabled
    ) private view returns (uint256, uint256, bool reversed) {
        if (market != address(0)) {
            // Read `reversed` WITHOUT the enabled-market gate so this never reverts on a disabled
            // market. createOrder passes requireEnabled=true to keep its long-standing "no creation
            // on a disabled market" behavior; updateOrder passes false so updates/cancels of orders
            // on a later-disabled market stay possible (it loaded no market at all before this fix).
            Market.Props memory marketProps = MarketStoreUtils.get(dataStore, market);
            if (requireEnabled) {
                MarketUtils.validateEnabledMarket(dataStore, marketProps);
            }
            reversed = marketProps.reversed;
            if (reversed) {
                if (triggerPrice != 0) {
                    triggerPrice = Precision.mulDiv(Precision.FLOAT_PRECISION, Precision.FLOAT_PRECISION, triggerPrice);
                }
                if (acceptablePrice != 0) {
                    acceptablePrice =
                        Precision.mulDiv(Precision.FLOAT_PRECISION, Precision.FLOAT_PRECISION, acceptablePrice);
                }
            }
        }
        return (triggerPrice, acceptablePrice, reversed);
    }

    // @dev creates an order in the order store
    // @param account the order's account
    // @param params BaseOrderUtils.CreateOrderParams
    function createOrder(
        address account,
        IBaseOrderUtils.CreateOrderParams memory params,
        bool shouldCapMaxExecutionFee
    ) external override globalNonReentrant onlyController returns (bytes32) {
        FeatureUtils.validateFeature(dataStore, Keys.createOrderFeatureDisabledKey(address(this), uint256(params.orderType)));

        bool reversed;
        (params.numbers.triggerPrice, params.numbers.acceptablePrice, reversed) =
            _normalizeReversedPrices(params.addresses.market, params.numbers.triggerPrice, params.numbers.acceptablePrice, true);
        // Direction is inverted at creation only; the stored order keeps it (updateOrder must not re-flip).
        if (reversed) {
            params.isLong = !params.isLong;
        }

        return OrderUtils.createOrder(
            dataStore,
            eventEmitter,
            orderVault,
            referralStorage,
            account,
            params,
            shouldCapMaxExecutionFee
        );
    }

    struct UpdateOrderCache {
        address wnt;
        uint256 receivedWnt;
        uint256 estimatedGasLimit;
        uint256 oraclePriceCount;
    }

    /**
     * @dev Updates the given order with the specified size delta, acceptable price, and trigger price.
     * The `updateOrder()` feature must be enabled for the given order type. The caller must be the owner
     * of the order, and the order must not be a market order. The size delta, trigger price, and
     * acceptable price are updated on the order, and the order is unfrozen. Any additional WNT that is
     * transferred to the contract is added to the order's execution fee. The updated order is then saved
     * in the order store, and an `OrderUpdated` event is emitted.
     *
     * A user may be able to observe exchange prices and prevent order execution by updating the order's
     * trigger price or acceptable price
     *
     * The main front-running concern is if a user knows whether the price is going to move up or down
     * then positions accordingly, e.g. if price is going to move up then the user opens a long position
     *
     * With updating of orders, a user may know that price could be lower and delays the execution of an
     * order by updating it, this should not be a significant front-running concern since it is similar
     * to observing prices then creating a market order as price is decreasing
     *
     * @param key The unique ID of the order to be updated
     * @param sizeDeltaUsd The new size delta for the order
     * @param acceptablePrice The new acceptable price for the order
     * @param triggerPrice The new trigger price for the order
     */
    function updateOrder(
        bytes32 key,
        uint256 sizeDeltaUsd,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        uint256 minOutputAmount,
        uint256 validFromTime,
        bool autoCancel,
        Order.Props memory order,
        bool shouldCapMaxExecutionFee
    ) external override globalNonReentrant onlyController {
        FeatureUtils.validateFeature(dataStore, Keys.updateOrderFeatureDisabledKey(address(this), uint256(order.orderType())));

        if (BaseOrderUtils.isMarketOrder(order.orderType())) {
            revert Errors.OrderNotUpdatable(uint256(order.orderType()));
        }

        // this could happen if the order was created in new contracts that support new order types
        // but the order is being updated in old contracts
        if (!BaseOrderUtils.isSupportedOrder(order.orderType())) {
            revert Errors.UnsupportedOrderType(uint256(order.orderType()));
        }

        if (order.autoCancel() != autoCancel) {
            OrderUtils.updateAutoCancelList(dataStore, key, order, autoCancel);
            OrderUtils.validateTotalCallbackGasLimitForAutoCancelOrders(dataStore, order);
        }
        order.setAutoCancel(autoCancel);

        // Mirror createOrder's reversed-market price normalization via the shared
        // helper so the two paths can never drift. isLong is NOT touched — the order's direction was
        // already inverted and stored at creation.
        (triggerPrice, acceptablePrice,) = _normalizeReversedPrices(order.market(), triggerPrice, acceptablePrice, false);

        order.setSizeDeltaUsd(sizeDeltaUsd);
        order.setTriggerPrice(triggerPrice);
        order.setAcceptablePrice(acceptablePrice);
        order.setMinOutputAmount(minOutputAmount);
        order.setValidFromTime(validFromTime);
        order.setIsFrozen(false);

        UpdateOrderCache memory cache;
        // allow topping up of executionFee as frozen orders
        // will have their executionFee reduced
        cache.wnt = TokenUtils.wnt(dataStore);
        cache.receivedWnt = orderVault.recordTransferIn(cache.wnt);

        // ! EXECUTION FEE EXEMPTION
        // Minimum-fee validation waived (keepers subsidised out-of-band), so validateAndCapExecutionFee is
        // not used. The MAX cap is still enforced for subaccount / relay updates carrying a callbackContract
        // (shouldCapMaxExecutionFee): otherwise a malicious subaccount could raise the executionFee on an
        // existing order with the victim's topped-up WNT and reclaim it to an attacker callbackContract on
        // cancel. Excess over the cap is returned to the holding address.
        uint256 executionFee = order.executionFee() + cache.receivedWnt;
        uint256 executionFeeDiff = 0;
        if (shouldCapMaxExecutionFee) {
            (executionFee, executionFeeDiff) = GasUtils.capExecutionFee(
                dataStore,
                GasUtils.estimateExecuteOrderGasLimit(dataStore, order),
                order.executionFee() + cache.receivedWnt,
                GasUtils.estimateOrderOraclePriceCount(order.swapPath().length)
            );
        }
        order.setExecutionFee(executionFee);

        if (executionFeeDiff != 0) {
            GasUtils.transferExcessiveExecutionFee(dataStore, eventEmitter, orderVault, order.account(), executionFeeDiff);
        }

        order.touch();

        BaseOrderUtils.validateNonEmptyOrder(order);

        OrderStoreUtils.set(dataStore, key, order);

        OrderEventUtils.emitOrderUpdated(
            eventEmitter,
            key,
            order
        );
    }

    /**
     * @dev Cancels the given order. The `cancelOrder()` feature must be enabled for the given order
     * type. The caller must be the owner of the order. The order is cancelled by calling the `cancelOrder()`
     * function in the `OrderUtils` contract. This function also records the starting gas amount and the
     * reason for cancellation, which is passed to the `cancelOrder()` function.
     *
     * @param key The unique ID of the order to be cancelled
     */
    function cancelOrder(bytes32 key) external override globalNonReentrant onlyController {
        uint256 startingGas = gasleft();

        DataStore _dataStore = dataStore;
        Order.Props memory order = OrderStoreUtils.get(_dataStore, key);

        FeatureUtils.validateFeature(_dataStore, Keys.cancelOrderFeatureDisabledKey(address(this), uint256(order.orderType())));

        if (BaseOrderUtils.isMarketOrder(order.orderType())) {
            validateRequestCancellation(
                order.updatedAtTime(),
                "Order"
            );
        }

        OrderUtils.cancelOrder(
            OrderUtils.CancelOrderParams(
                dataStore,
                eventEmitter,
                orderVault,
                key,
                order.account(),
                startingGas,
                true, // isExternalCall
                Keys.USER_INITIATED_CANCEL,
                "",
                false // skipCallback: user cancellations keep their callback
            )
        );
    }

    // @dev simulate execution of an order to check for any errors
    // @param key the order key
    // @param params OracleUtils.SimulatePricesParams
    function simulateExecuteOrder(
        bytes32 key,
        OracleUtils.SimulatePricesParams memory params
    ) external
        override
        onlyController
        withSimulatedOraclePrices(params)
        globalNonReentrant
    {
        Order.Props memory order = OrderStoreUtils.get(dataStore, key);

        this._executeOrder(
            key,
            order,
            msg.sender
        );
    }

    // @dev executes an order
    // @param key the key of the order to execute
    // @param oracleParams OracleUtils.SetPricesParams
    function executeOrder(
        bytes32 key,
        OracleUtils.SetPricesParams calldata oracleParams
    ) external
        globalNonReentrant
        onlyOrderKeeper
        withOraclePrices(oracleParams)
    {
        uint256 startingGas = gasleft();

        Order.Props memory order = OrderStoreUtils.get(dataStore, key);
        uint256 estimatedGasLimit = GasUtils.estimateExecuteOrderGasLimit(dataStore, order);
        GasUtils.validateExecutionGas(dataStore, startingGas, estimatedGasLimit);

        uint256 executionGas = GasUtils.getExecutionGas(dataStore, startingGas);

        try this._executeOrder{ gas: executionGas }(
            key,
            order,
            msg.sender
        ) {
        } catch (bytes memory reasonBytes) {
            _handleOrderError(key, startingGas, reasonBytes);
        }
    }

    // @dev executes an order
    // @param key the key of the order to execute
    // @param oracleParams OracleUtils.SetPricesParams
    // @param keeper the keeper executing the order
    // @param startingGas the starting gas
    function _executeOrder(
        bytes32 key,
        Order.Props memory order,
        address keeper
    ) external onlySelf {
        uint256 startingGas = gasleft();

        BaseOrderUtils.ExecuteOrderParams memory params = _getExecuteOrderParams(
            key,
            order,
            keeper,
            startingGas,
            Order.SecondaryOrderType.None
        );
        // limit swaps require frozen order keeper for execution since on creation it can fail due to output amount
        // which would automatically cause the order to be frozen
        // limit increase and limit / trigger decrease orders may fail due to output amount as well and become frozen
        // but only if their acceptablePrice is reached
        if (params.order.isFrozen() || params.order.orderType() == Order.OrderType.LimitSwap) {
            _validateFrozenOrderKeeper(keeper);
        }

        FeatureUtils.validateFeature(params.contracts.dataStore, Keys.executeOrderFeatureDisabledKey(address(this), uint256(params.order.orderType())));

        ExecuteOrderUtils.executeOrder(params);
    }

    // @dev handle a caught order error
    // @param key the order's key
    // @param startingGas the starting gas
    // @param reason the error reason
    // @param reasonKey the hash or the error reason
    function _handleOrderError(
        bytes32 key,
        uint256 startingGas,
        bytes memory reasonBytes
    ) internal {
        GasUtils.validateExecutionErrorGas(dataStore, reasonBytes);

        bytes4 errorSelector = ErrorUtils.getErrorSelectorFromData(reasonBytes);

        validateNonKeeperError(errorSelector, reasonBytes);

        Order.Props memory order = OrderStoreUtils.get(dataStore, key);
        bool isMarketOrder = BaseOrderUtils.isMarketOrder(order.orderType());

        if (
            // if the order is already frozen, revert with the custom error to provide more information
            // on why the order cannot be executed
            order.isFrozen() ||
            // for market orders, the EmptyPosition error should still lead to the
            // order being cancelled
            // for limit, trigger orders, the EmptyPosition error should lead to the transaction
            // being reverted instead
            // if the position is created or increased later, the oracle prices used to fulfill the order
            // must be after the position was last increased, this is validated in DecreaseOrderUtils
            (!isMarketOrder && errorSelector == Errors.EmptyPosition.selector) ||
            errorSelector == Errors.EmptyOrder.selector ||
            // if the order execution feature is disabled, it may be possible
            // for a user to cancel their orders after the feature is re-enabled
            // or they may be able to execute the order at an outdated price
            // depending on the order keeper
            // disabling of features should be a rare occurrence, it may be
            // preferrable to still execute the orders when the feature is re-enabled
            // instead of cancelling / freezing the orders
            // if features are not frequently disabled, the amount of front-running
            // from this should not be significant
            // based on this it may also be advisable to disable the cancelling of orders
            // if the execution of orders is disabled
            errorSelector == Errors.InvalidKeeperForFrozenOrder.selector ||
            errorSelector == Errors.UnsupportedOrderType.selector ||
            // the transaction is reverted for InvalidOrderPrices since the oracle prices
            // do not fulfill the specified trigger price
            errorSelector == Errors.InvalidOrderPrices.selector ||
            // order should not be cancelled or frozen in this case
            // otherwise malicious keepers can cancel orders before valid from time is reached
            errorSelector == Errors.OrderValidFromTimeNotReached.selector
        ) {
            ErrorUtils.revertWithCustomError(reasonBytes);
        }

        (string memory reason, /* bool hasRevertMessage */) = ErrorUtils.getRevertMessage(reasonBytes);

        if (
            isMarketOrder ||
            errorSelector == Errors.InvalidPositionMarket.selector ||
            errorSelector == Errors.InvalidCollateralTokenForMarket.selector ||
            errorSelector == Errors.InvalidPositionSizeValues.selector
        ) {
            OrderUtils.cancelOrder(
                OrderUtils.CancelOrderParams(
                    dataStore,
                    eventEmitter,
                    orderVault,
                    key,
                    msg.sender,
                    startingGas,
                    true, // isExternalCall
                    reason,
                    reasonBytes,
                    false // skipCallback: normal cancellations keep their callback
                )
            );

            return;
        }

        // freeze unfulfillable orders to prevent the order system from being gamed
        // an example of gaming would be if a user creates a limit order
        // with size greater than the available amount in the pool
        // the user waits for their limit price to be hit, and if price
        // moves in their favour after, they can deposit into the pool
        // to allow the order to be executed then close the order for a profit
        //
        // frozen order keepers are expected to execute orders only if the
        // latest prices match the trigger price
        //
        // a user can also call updateOrder to unfreeze an order
        OrderUtils.freezeOrder(
            dataStore,
            eventEmitter,
            orderVault,
            key,
            msg.sender,
            startingGas,
            reason,
            reasonBytes
        );
    }

    // @dev validate that the keeper is a frozen order keeper
    // @param keeper address of the keeper
    function _validateFrozenOrderKeeper(address keeper) internal view {
        if (!roleStore.hasRole(keeper, Role.FROZEN_ORDER_KEEPER)) {
            revert Errors.InvalidKeeperForFrozenOrder(keeper);
        }
    }
}
