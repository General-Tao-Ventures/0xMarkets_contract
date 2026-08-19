import { HardhatRuntimeEnvironment } from "hardhat/types";
import { TokenConfig } from "../config/tokens";
import { setBoolIfDifferent, setIntIfDifferent, setUintIfDifferent } from "../utils/dataStore";
import * as keys from "../utils/keys";
import { expandDecimals } from "../utils/math";

const func = async ({ gmx }: HardhatRuntimeEnvironment) => {
  const { getTokens } = gmx;
  const tokens: Record<string, TokenConfig> = await getTokens();

  for (const [tokenSymbol, token] of Object.entries(tokens)) {
    if (!token.pythLazerFeedId) {
      continue;
    }

    if (!token.address) {
      throw new Error(`token ${tokenSymbol} has no address`);
    }

    if (!token.decimals) {
      throw new Error(`token ${tokenSymbol} has no decimals`);
    }

    if (!token.pythLazerFeedDecimals) {
      throw new Error(`token ${tokenSymbol} has no pythLazerFeedDecimals`);
    }

    await setUintIfDifferent(
      keys.pythLazerFeedIdKey(token.address),
      token.pythLazerFeedId,
      `Pyth Lazer feed id for ${tokenSymbol} ${token.address}`
    );

    if (token.pythLazerFeedInverted) {
      await setBoolIfDifferent(
        keys.pythLazerFeedInvertedKey(token.address),
        token.pythLazerFeedInverted,
        `Pyth Lazer feed inverted flag for ${tokenSymbol} ${token.address}`
      );
    }

    // Inverted feeds flip the token-decimal term: 10^(60 + tokenDec - feedDec).
    // Using the non-inverted formula here would re-break JPY on every deploy
    // (e.g. write 10^39 over the correct 10^75 after the mainnet multiplier fix).
    const pythLazerFeedMultiplier = token.pythLazerFeedInverted
      ? expandDecimals(1, 60 + token.decimals - token.pythLazerFeedDecimals)
      : expandDecimals(1, 60 - token.decimals - token.pythLazerFeedDecimals);

    await setUintIfDifferent(
      keys.pythLazerFeedMultiplierKey(token.address),
      pythLazerFeedMultiplier,
      `Pyth Lazer feed multiplier for ${tokenSymbol} ${token.address}`
    );

    // Record the exponent the multiplier above was derived from. The provider compares it against
    // the exponent carried in each signed update, so a decimals entry that does not match the live
    // feed reverts instead of mis-scaling the price by a power of ten.
    await setIntIfDifferent(
      keys.pythLazerFeedExponentKey(token.address),
      -token.pythLazerFeedDecimals,
      `Pyth Lazer feed exponent for ${tokenSymbol} ${token.address}`
    );

    // default to FLOAT_PRECISION (1e30) so the confidence band is used as-is;
    // factor of 0 would collapse the band to the midpoint
    const spreadFactor = token.pythLazerFeedSpreadFactor ?? expandDecimals(1, 30);
    await setUintIfDifferent(
      keys.pythLazerFeedSpreadFactorKey(token.address),
      spreadFactor,
      `Pyth Lazer feed spread factor for ${tokenSymbol} ${token.address}`
    );
  }
};

func.dependencies = ["Tokens"];
func.tags = ["PythLazerFeedProvider"];

export default func;
