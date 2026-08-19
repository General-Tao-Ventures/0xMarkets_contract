import { createDeployFunction } from "../utils/deploy";

const func = createDeployFunction({
  contractName: "DecreasePositionCollateralUtils",
  libraryNames: [
    "FeeUtils",
    "InsuranceFundUtils",
    "MarketEventUtils",
    "OrderEventUtils",
    "DecreasePositionSwapUtils",
    "PositionEventUtils",
    "PositionExecutionPriceUtils",
    "PositionUtils",
    // Required since _distributeInsolventShares now calls
    // ReferralUtils.incrementAffiliateReward (which emits via ReferralEventUtils).
    "ReferralEventUtils",
  ],
});

export default func;
