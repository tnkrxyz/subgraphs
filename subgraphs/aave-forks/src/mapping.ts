// generic aave-v2 handlers
import {
  Address,
  BigDecimal,
  BigInt,
  ethereum,
  log,
} from "@graphprotocol/graph-ts";
import {
  Account,
  Market,
  RewardToken,
  _DefaultOracle,
  _FlashLoanPremium,
  _MarketList,
} from "../generated/schema";
import { AToken } from "../generated/LendingPool/AToken";
import { StableDebtToken } from "../generated/LendingPool/StableDebtToken";
import { VariableDebtToken } from "../generated/LendingPool/VariableDebtToken";
import {
  BIGDECIMAL_HUNDRED,
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  DEFAULT_DECIMALS,
  IavsTokenType,
  INT_TWO,
  INT_FOUR,
  RAY_OFFSET,
  ZERO_ADDRESS,
  BIGINT_ONE,
  BIGDECIMAL_ONE,
} from "./constants";
import {
  InterestRateSide,
  InterestRateType,
  OracleSource,
  PositionSide,
  RewardTokenType,
  SECONDS_PER_DAY,
  bigDecimalToBigInt,
} from "./sdk/constants";
import {
  getBorrowBalance,
  getCollateralBalance,
  getMarketByAuxillaryToken,
  restorePrePauseState,
  storePrePauseState,
  exponentToBigDecimal,
  rayToWad,
  getMarketFromToken,
} from "./helpers";
import {
  AToken as ATokenTemplate,
  VariableDebtToken as VTokenTemplate,
  StableDebtToken as STokenTemplate,
} from "../generated/templates";
import { ERC20 } from "../generated/LendingPool/ERC20";
import { DataManager, ProtocolData, RewardData } from "./sdk/manager";
import { FeeType, TokenType } from "./sdk/constants";
import { TokenManager } from "./sdk/token";
import { AccountManager } from "./sdk/account";
import { PositionManager } from "./sdk/position";

//////////////////////////////////
///// Configuration Handlers /////
//////////////////////////////////

export function _handlePriceOracleUpdated(
  newPriceOracle: Address,
  protocolData: ProtocolData,
  event: ethereum.Event
): void {
  log.info("[_handlePriceOracleUpdated] New oracleAddress: {}", [
    newPriceOracle.toHexString(),
  ]);

  // since all aave markets share the same oracle
  // we will use _DefaultOracle entity for markets whose oracle is not set
  let defaultOracle = _DefaultOracle.load(protocolData.protocolID);
  if (!defaultOracle) {
    defaultOracle = new _DefaultOracle(protocolData.protocolID);
  }
  defaultOracle.oracle = newPriceOracle;
  defaultOracle.save();

  const marketList = _MarketList.load(protocolData.protocolID);
  if (!marketList) {
    log.warning("[_handlePriceOracleUpdated]marketList for {} does not exist", [
      protocolData.protocolID.toHexString(),
    ]);
    return;
  }

  const markets = marketList.markets;
  for (let i = 0; i < markets.length; i++) {
    const _market = Market.load(markets[i]);
    if (!_market) {
      log.warning("[_handlePriceOracleUpdated] Market not found: {}", [
        markets[i].toHexString(),
      ]);
      continue;
    }
    const manager = new DataManager(
      markets[i],
      _market.inputToken,
      event,
      protocolData
    );
    _market.oracle = manager.getOrCreateOracle(
      newPriceOracle,
      true,
      OracleSource.CHAINLINK
    ).id;
    _market.save();
  }
}

export function _handleReserveInitialized(
  event: ethereum.Event,
  underlyingToken: Address,
  outputToken: Address,
  variableDebtToken: Address,
  protocolData: ProtocolData,
  stableDebtToken: Address = Address.fromString(ZERO_ADDRESS)
): void {
  // create VToken template
  VTokenTemplate.create(variableDebtToken);
  // create AToken template to watch Transfer
  ATokenTemplate.create(outputToken);

  const manager = new DataManager(
    outputToken,
    underlyingToken,
    event,
    protocolData
  );
  const market = manager.getMarket();
  const outputTokenManager = new TokenManager(outputToken, event);
  const vDebtTokenManager = new TokenManager(
    variableDebtToken,
    event,
    TokenType.NON_REBASING
  );
  market.outputToken = outputTokenManager.getToken().id;
  market._vToken = vDebtTokenManager.getToken().id;

  // map tokens to market
  const inputToken = manager.getInputToken();
  inputToken._market = market.id;
  inputToken._iavsTokenType = IavsTokenType.INPUTTOKEN;
  inputToken.save();

  const aToken = outputTokenManager.getToken();
  aToken._market = market.id;
  aToken._iavsTokenType = IavsTokenType.ATOKEN;
  aToken.save();

  const vToken = vDebtTokenManager.getToken();
  vToken._market = market.id;
  vToken._iavsTokenType = IavsTokenType.VTOKEN;
  vToken.save();

  if (stableDebtToken != Address.zero()) {
    const sDebtTokenManager = new TokenManager(stableDebtToken, event);
    const sToken = sDebtTokenManager.getToken();
    sToken._market = market.id;
    sToken._iavsTokenType = IavsTokenType.STOKEN;
    sToken.save();

    market._sToken = sToken.id;

    STokenTemplate.create(stableDebtToken);
  }

  const defaultOracle = _DefaultOracle.load(protocolData.protocolID);
  if (!market.oracle && defaultOracle) {
    market.oracle = manager.getOrCreateOracle(
      Address.fromBytes(defaultOracle.oracle),
      true,
      OracleSource.CHAINLINK
    ).id;
  }

  market.save();
}

export function _handleCollateralConfigurationChanged(
  asset: Address,
  liquidationPenalty: BigInt,
  liquidationThreshold: BigInt,
  maximumLTV: BigInt,
  protocolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning(
      "[_handleCollateralConfigurationChanged] Market for asset {} not found",
      [asset.toHexString()]
    );
    return;
  }

  market.maximumLTV = maximumLTV.toBigDecimal().div(BIGDECIMAL_HUNDRED);
  market.liquidationThreshold = liquidationThreshold
    .toBigDecimal()
    .div(BIGDECIMAL_HUNDRED);

  // The liquidation bonus value is equal to the liquidation penalty, the naming is a matter of which side of the liquidation a user is on
  // The liquidationBonus parameter comes out as above 100%, represented by a 5 digit integer over 10000 (100%).
  // To extract the expected value in the liquidationPenalty field: convert to BigDecimal, subtract by 10000 and divide by 100
  const bdLiquidationPenalty = liquidationPenalty.toBigDecimal();
  if (bdLiquidationPenalty.gt(exponentToBigDecimal(INT_FOUR))) {
    market.liquidationPenalty = bdLiquidationPenalty
      .minus(exponentToBigDecimal(INT_FOUR))
      .div(BIGDECIMAL_HUNDRED);
  }

  market.save();
}

export function _handleBorrowingEnabledOnReserve(
  asset: Address,
  procotolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning("[_handleBorrowingEnabledOnReserve] Market not found {}", [
      asset.toHexString(),
    ]);
    return;
  }

  market.canBorrowFrom = true;
  market.save();
  storePrePauseState(market);
}

export function _handleBorrowingDisabledOnReserve(
  asset: Address,
  procotolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning(
      "[_handleBorrowingDisabledOnReserve] Market for token {} not found",
      [asset.toHexString()]
    );
    return;
  }

  market.canBorrowFrom = false;
  market.save();
  storePrePauseState(market);
}

export function _handleReserveActivated(
  asset: Address,
  protocolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleReserveActivated] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }

  market.isActive = true;
  market.save();
  storePrePauseState(market);
}

export function _handleReserveDeactivated(
  asset: Address,
  procotolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning("[_handleReserveDeactivated] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }

  market.isActive = false;
  market.save();
  storePrePauseState(market);
}

export function _handleReserveFactorChanged(
  asset: Address,
  reserveFactor: BigInt,
  procotolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning("[_handleReserveFactorChanged] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }

  market.reserveFactor = reserveFactor
    .toBigDecimal()
    .div(exponentToBigDecimal(INT_TWO));
  market.save();
}

export function _handleLiquidationProtocolFeeChanged(
  asset: Address,
  liquidationProtocolFee: BigInt,
  procotolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning(
      "[_handleLiquidationProtocolFeeChanged] Market for token {} not found",
      [asset.toHexString()]
    );
    return;
  }

  market._liquidationProtocolFee = liquidationProtocolFee
    .toBigDecimal()
    .div(exponentToBigDecimal(INT_FOUR));
  log.info(
    "[LiquidationProtocolFeeChanged]market {} _liquidationProtocolFee={}",
    [asset.toHexString(), liquidationProtocolFee.toString()]
  );
  market.save();
}

export function _handleReserveUsedAsCollateralEnabled(
  asset: Address,
  accountID: Address,
  procotolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning(
      "[_handleReserveUsedAsCollateralEnabled] Market for token {} not found",
      [asset.toHexString()]
    );
    return;
  }
  const accountManager = new AccountManager(accountID);
  const account = accountManager.getAccount();

  const markets = account._enabledCollaterals
    ? account._enabledCollaterals!
    : [];
  markets.push(market.id);
  account._enabledCollaterals = markets;
  account.save();
}

export function _handleReserveUsedAsCollateralDisabled(
  asset: Address,
  accountID: Address,
  procotolData: ProtocolData
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning(
      "[_handleReserveUsedAsCollateralEnabled] Market for token {} not found",
      [asset.toHexString()]
    );
    return;
  }
  const accountManager = new AccountManager(accountID);
  const account = accountManager.getAccount();

  const markets = account._enabledCollaterals
    ? account._enabledCollaterals!
    : [];

  const index = markets.indexOf(market.id);
  if (index >= 0) {
    // drop 1 element at given index
    markets.splice(index, 1);
  }
  account._enabledCollaterals = markets;
  account.save();
}

export function _handleFlashloanPremiumTotalUpdated(
  rate: BigDecimal,
  procotolData: ProtocolData
): void {
  let premiumRate = _FlashLoanPremium.load(procotolData.protocolID);
  if (!premiumRate) {
    premiumRate = new _FlashLoanPremium(procotolData.protocolID);
    premiumRate.premiumRateToProtocol = BIGDECIMAL_ZERO;
  }
  premiumRate.premiumRateTotal = rate;
  premiumRate.save();
}

export function _handleFlashloanPremiumToProtocolUpdated(
  rate: BigDecimal,
  procotolData: ProtocolData
): void {
  let premiumRate = _FlashLoanPremium.load(procotolData.protocolID);
  if (!premiumRate) {
    premiumRate = new _FlashLoanPremium(procotolData.protocolID);
    premiumRate.premiumRateTotal = rate; // premiumRateTotal >= premiumRateToProtocol
  }
  premiumRate.premiumRateToProtocol = rate;
  premiumRate.save();
}

export function _handlePaused(protocolData: ProtocolData): void {
  const marketList = _MarketList.load(protocolData.protocolID);
  if (!marketList) {
    log.warning("[_handlePaused]marketList for {} does not exist", [
      protocolData.protocolID.toHexString(),
    ]);
    return;
  }

  const markets = marketList.markets;
  for (let i = 0; i < markets.length; i++) {
    const market = Market.load(markets[i]);
    if (!market) {
      log.warning("[Paused] Market not found: {}", [markets[i].toHexString()]);
      continue;
    }

    storePrePauseState(market);
    market.isActive = false;
    market.canUseAsCollateral = false;
    market.canBorrowFrom = false;
    market.save();
  }
}

export function _handleUnpaused(protocolData: ProtocolData): void {
  const marketList = _MarketList.load(protocolData.protocolID);
  if (!marketList) {
    log.warning("[_handleUnpaused]marketList for {} does not exist", [
      protocolData.protocolID.toHexString(),
    ]);
    return;
  }

  const markets = marketList.markets;
  for (let i = 0; i < markets.length; i++) {
    const market = Market.load(markets[i]);
    if (!market) {
      log.warning("[_handleUnpaused] Market not found: {}", [
        markets[i].toHexString(),
      ]);
      continue;
    }

    restorePrePauseState(market);
  }
}

////////////////////////////////
///// Transaction Handlers /////
////////////////////////////////

export function _handleReserveDataUpdated(
  event: ethereum.Event,
  liquidityRate: BigInt, // deposit rate in ray
  liquidityIndex: BigInt,
  variableBorrowRate: BigInt,
  stableBorrowRate: BigInt,
  protocolData: ProtocolData,
  asset: Address,
  assetPriceUSD: BigDecimal = BIGDECIMAL_ZERO,
  updateRewards: bool = false
): void {
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handlReserveDataUpdated] Market for asset {} not found", [
      asset.toHexString(),
    ]);
    return;
  }

  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const inputToken = manager.getInputToken();
  // get current borrow balance
  let trySBorrowBalance: ethereum.CallResult<BigInt> | null = null;
  if (market._sToken) {
    const stableDebtContract = StableDebtToken.bind(
      Address.fromBytes(market._sToken!)
    );
    trySBorrowBalance = stableDebtContract.try_totalSupply();
  }

  const variableDebtContract = VariableDebtToken.bind(
    Address.fromBytes(market._vToken!)
  );
  const tryVBorrowBalance = variableDebtContract.try_totalSupply();
  let sBorrowBalance = BIGINT_ZERO;
  let vBorrowBalance = BIGINT_ZERO;

  if (trySBorrowBalance != null && !trySBorrowBalance.reverted) {
    sBorrowBalance = trySBorrowBalance.value;
  }
  if (!tryVBorrowBalance.reverted) {
    vBorrowBalance = tryVBorrowBalance.value;
  }

  // broken if both revert
  if (
    trySBorrowBalance != null &&
    trySBorrowBalance.reverted &&
    tryVBorrowBalance.reverted
  ) {
    log.warning("[ReserveDataUpdated] No borrow balance found", []);
    return;
  }

  // update total supply balance
  const aTokenContract = AToken.bind(Address.fromBytes(market.outputToken!));
  const tryTotalSupply = aTokenContract.try_totalSupply();
  if (tryTotalSupply.reverted) {
    log.warning(
      "[ReserveDataUpdated] Error getting total supply on market: {}",
      [market.id.toHexString()]
    );
    return;
  }

  if (assetPriceUSD.equals(BIGDECIMAL_ZERO)) {
    assetPriceUSD = market.inputTokenPriceUSD;
  }
  manager.updateMarketAndProtocolData(
    assetPriceUSD,
    tryTotalSupply.value,
    vBorrowBalance,
    sBorrowBalance
  );

  const tryScaledSupply = aTokenContract.try_scaledTotalSupply();
  if (tryScaledSupply.reverted) {
    log.warning(
      "[ReserveDataUpdated] Error getting scaled total supply on market: {}",
      [asset.toHexString()]
    );
    return;
  }

  // calculate new revenue
  // New Interest = totalScaledSupply * (difference in liquidity index)
  if (!market._liquidityIndex) {
    market._liquidityIndex = BIGINT_ONE;
  }

  const liquidityIndexDiff = liquidityIndex
    .minus(market._liquidityIndex!)
    .toBigDecimal()
    .div(exponentToBigDecimal(RAY_OFFSET));
  market._liquidityIndex = liquidityIndex; // must update to current liquidity index
  const newRevenueBD = tryScaledSupply.value
    .toBigDecimal()
    .div(exponentToBigDecimal(inputToken.decimals))
    .times(liquidityIndexDiff);
  const totalRevenueDeltaUSD = newRevenueBD.times(assetPriceUSD);
  let reserveFactor = market.reserveFactor;
  if (!reserveFactor) {
    log.warning(
      "[_handleReserveDataUpdated]reserveFactor = null for market {}, default to 0.0",
      [asset.toHexString()]
    );
    reserveFactor = BIGDECIMAL_ZERO;
  }
  const protocolSideRevenueDeltaUSD = totalRevenueDeltaUSD.times(
    reserveFactor.div(exponentToBigDecimal(INT_TWO))
  );
  const supplySideRevenueDeltaUSD = totalRevenueDeltaUSD.minus(
    protocolSideRevenueDeltaUSD
  );

  const fee = manager.getOrUpdateFee(
    FeeType.PROTOCOL_FEE,
    null,
    market.reserveFactor
  );
  manager.addProtocolRevenue(protocolSideRevenueDeltaUSD, fee);
  manager.addSupplyRevenue(supplySideRevenueDeltaUSD, fee);

  manager.getOrUpdateRate(
    InterestRateSide.BORROWER,
    InterestRateType.VARIABLE,
    rayToWad(variableBorrowRate)
      .toBigDecimal()
      .div(exponentToBigDecimal(DEFAULT_DECIMALS - 2))
  );

  if (market._sToken) {
    // geist does not have stable borrow rates
    manager.getOrUpdateRate(
      InterestRateSide.BORROWER,
      InterestRateType.STABLE,
      rayToWad(stableBorrowRate)
        .toBigDecimal()
        .div(exponentToBigDecimal(DEFAULT_DECIMALS - 2))
    );
  }

  manager.getOrUpdateRate(
    InterestRateSide.LENDER,
    InterestRateType.VARIABLE,
    rayToWad(liquidityRate)
      .toBigDecimal()
      .div(exponentToBigDecimal(DEFAULT_DECIMALS - 2))
  );

  // if updateRewards is true:
  // - check if reward distribution ends,
  // - refresh rewardEmissionAmountUSD with current token price
  // this is here because _handleReserveDataUpdated is called most frequently
  // if data freshness is a priority (at the cost of indexing speed)
  // we can iterate through all markets in _MarketList and get latest
  // token price from oracle (to be implemented)
  if (updateRewards && market.rewardTokens) {
    for (let i = 0; i < market.rewardTokens!.length; i++) {
      const rewardToken = RewardToken.load(market.rewardTokens![i]);
      if (!rewardToken) {
        continue;
      }
      const rewardTokenManager = new TokenManager(
        Address.fromBytes(rewardToken.token),
        event
      );
      let emission = market.rewardTokenEmissionsAmount![i];
      if (
        rewardToken._distributionEnd &&
        rewardToken._distributionEnd!.lt(event.block.timestamp)
      ) {
        emission = BIGINT_ZERO;
      }
      const emissionUSD = rewardTokenManager.getAmountUSD(emission);
      const rewardData = new RewardData(rewardToken, emission, emissionUSD);
      manager.updateRewards(rewardData);
    }
  }
}

export function _handleDeposit(
  event: ethereum.Event,
  amount: BigInt,
  asset: Address,
  protocolData: ProtocolData,
  accountID: Address
): void {
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleDeposit] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const amountUSD = amount.toBigDecimal().times(market.inputTokenPriceUSD);
  const newCollateralBalance = getCollateralBalance(market, accountID);
  manager.createDeposit(
    asset,
    accountID,
    amount,
    amountUSD,
    newCollateralBalance
  );
  const account = Account.load(accountID);
  if (!account) {
    log.warning("[_handleDeposit]account {} not found", [
      accountID.toHexString(),
    ]);
    return;
  }
  if (
    !account._enabledCollaterals ||
    account._enabledCollaterals!.indexOf(asset) == -1
  ) {
    return;
  }
  const positionManager = new PositionManager(
    account,
    market,
    PositionSide.COLLATERAL
  );
  positionManager.setCollateral(true);
}

export function _handleWithdraw(
  event: ethereum.Event,
  amount: BigInt,
  asset: Address,
  protocolData: ProtocolData,
  accountID: Address
): void {
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleWithdraw] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const amountUSD = amount.toBigDecimal().times(market.inputTokenPriceUSD);
  const newCollateralBalance = getCollateralBalance(market, accountID);
  manager.createWithdraw(
    asset,
    accountID,
    amount,
    amountUSD,
    newCollateralBalance
  );
}

export function _handleBorrow(
  event: ethereum.Event,
  amount: BigInt,
  asset: Address,
  protocolData: ProtocolData,
  accountID: Address
): void {
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleBorrow] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const amountUSD = amount.toBigDecimal().times(market.inputTokenPriceUSD);
  const newBorrowBalance = getBorrowBalance(market, accountID);
  manager.createBorrow(
    asset,
    accountID,
    amount,
    amountUSD,
    newBorrowBalance,
    market.inputTokenPriceUSD
  );
}

export function _handleRepay(
  event: ethereum.Event,
  amount: BigInt,
  asset: Address,
  protocolData: ProtocolData,
  accountID: Address
): void {
  const market = getMarketFromToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleRepay] Market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const amountUSD = amount.toBigDecimal().times(market.inputTokenPriceUSD);
  const newBorrowBalance = getBorrowBalance(market, accountID);
  manager.createRepay(
    asset,
    accountID,
    amount,
    amountUSD,
    newBorrowBalance,
    market.inputTokenPriceUSD
  );
}

export function _handleLiquidate(
  event: ethereum.Event,
  amount: BigInt, // amount of collateral liquidated
  collateralAsset: Address, // collateral market
  protocolData: ProtocolData,
  liquidator: Address,
  liquidatee: Address, // account liquidated
  debtAsset: Address, // token repaid to cover debt,
  debtToCover: BigInt, // the amount of debt repaid by liquidator
  createLiquidatorPosition: bool = false
): void {
  const market = getMarketFromToken(collateralAsset, protocolData);
  if (!market) {
    log.warning("[_handleLiquidate] Market for token {} not found", [
      collateralAsset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const inputToken = manager.getInputToken();
  let inputTokenPriceUSD = market.inputTokenPriceUSD;
  if (!inputTokenPriceUSD) {
    log.warning(
      "[_handleLiquidate] Price of input token {} is not set, default to 0.0",
      [inputToken.id.toHexString()]
    );
    inputTokenPriceUSD = BIGDECIMAL_ZERO;
  }
  const amountUSD = amount
    .toBigDecimal()
    .div(exponentToBigDecimal(inputToken.decimals))
    .times(inputTokenPriceUSD);

  const debtTokenMarket = getMarketFromToken(debtAsset, protocolData);
  if (!debtTokenMarket) {
    log.warning("[_handleLiquidate] market for Debt token  {} not found", [
      debtAsset.toHexString(),
    ]);
    return;
  }
  let debtTokenPriceUSD = debtTokenMarket.inputTokenPriceUSD;
  if (!debtTokenPriceUSD) {
    log.warning(
      "[_handleLiquidate] Price of token {} is not set, default to 0.0",
      [debtAsset.toHexString()]
    );
    debtTokenPriceUSD = BIGDECIMAL_ZERO;
  }

  const profitUSD = amountUSD.minus(
    debtToCover.toBigDecimal().times(debtTokenPriceUSD)
  );
  const collateralBalance = getCollateralBalance(market, liquidatee);
  const debtBalance = getBorrowBalance(debtTokenMarket, liquidatee);

  manager.createLiquidate(
    collateralAsset,
    debtAsset,
    liquidator,
    liquidatee,
    amount,
    amountUSD,
    profitUSD,
    collateralBalance,
    debtBalance,
    null, //TODO - interestType is tricky
    createLiquidatorPosition
  );

  // according to logic in _calculateAvailableCollateralToLiquidate()
  // liquidatedCollateralAmount = collateralAmount - liquidationProtocolFee
  // liquidationProtocolFee = bonusCollateral * liquidationProtocolFeePercentage
  // bonusCollateral = collateralAmount - collateralAmount / liquidationBonus
  // liquidationBonus = 1 + liquidationPenalty
  // => liquidationProtocolFee = liquidationPenalty * liquidationProtocolFeePercentage * liquidatedCollateralAmount / (1 + liquidationPenalty - liquidationPenalty*liquidationProtocolFeePercentage)
  if (!market._liquidationProtocolFee) {
    log.warning("[_handleLiquidate]market {} _liquidationProtocolFee = null ", [
      collateralAsset.toHexString(),
    ]);
    return;
  }
  const liquidationProtocolFeeUSD = amountUSD
    .times(market.liquidationPenalty)
    .times(market._liquidationProtocolFee!)
    .div(
      BIGDECIMAL_ONE.plus(market.liquidationPenalty).minus(
        market.liquidationPenalty.times(market._liquidationProtocolFee!)
      )
    );
  const fee = manager.getOrUpdateFee(
    FeeType.LIQUIDATION_FEE,
    null,
    market._liquidationProtocolFee
  );
  manager.addProtocolRevenue(liquidationProtocolFeeUSD, fee);
}

export function _handleFlashLoan(
  asset: Address,
  amount: BigInt,
  account: Address,
  procotolData: ProtocolData,
  event: ethereum.Event,
  premium: BigInt,
  premiumRate: BigDecimal,
  premiumRateToProtocol: BigDecimal | null = null //premium collected by the protocol
): void {
  const market = getMarketFromToken(asset, procotolData);
  if (!market) {
    log.warning("[_handleFlashLoan] market for token {} not found", [
      asset.toHexString(),
    ]);
    return;
  }
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    procotolData
  );
  const tokenManager = new TokenManager(asset, event);
  const amountUSD = tokenManager.getAmountUSD(amount);
  manager.createFlashloan(asset, account, amount, amountUSD);

  const premiumUSD = tokenManager.getAmountUSD(premium);
  if (premiumRateToProtocol && premiumRateToProtocol.gt(BIGDECIMAL_ZERO)) {
    const premiumAmountToProtocol = bigDecimalToBigInt(
      premium.toBigDecimal().div(premiumRate).times(premiumRateToProtocol)
    );
    const premiumAmountUSDToProtocol = tokenManager.getAmountUSD(
      premiumAmountToProtocol
    );
    const fee = manager.getOrUpdateFee(
      FeeType.OTHER,
      null,
      premiumRateToProtocol
    );
    manager.addSupplyRevenue(premiumAmountUSDToProtocol, fee);
    // premium rate to LP
    premiumRate = premiumRate.minus(premiumRateToProtocol);
  }
  const fee = manager.getOrUpdateFee(FeeType.OTHER, null, premiumRate);
  manager.addSupplyRevenue(premiumUSD, fee);
}

/////////////////////////
//// Transfer Events ////
/////////////////////////
export function _handleTransfer(
  event: ethereum.Event,
  protocolData: ProtocolData,
  positionSide: string,
  to: Address,
  from: Address,
  amount: BigInt
): void {
  const asset = event.address;
  const market = getMarketByAuxillaryToken(asset, protocolData);
  if (!market) {
    log.warning("[_handleTransfer] market not found: {}", [
      asset.toHexString(),
    ]);
    return;
  }

  // if the to / from addresses are the same as the asset
  // then this transfer is emitted as part of another event
  // ie, a deposit, withdraw, borrow, repay, etc
  // we want to let that handler take care of position updates
  // and zero addresses mean it is apart of a burn / mint
  if (
    to == Address.fromString(ZERO_ADDRESS) ||
    from == Address.fromString(ZERO_ADDRESS) ||
    to == asset ||
    from == asset
  ) {
    return;
  }

  const tokenContract = ERC20.bind(asset);
  const senderBalanceResult = tokenContract.try_balanceOf(from);
  const receiverBalanceResult = tokenContract.try_balanceOf(to);
  if (senderBalanceResult.reverted) {
    log.warning(
      "[_handleTransfer]token {} balanceOf() call for account {} reverted",
      [asset.toHexString(), from.toHexString()]
    );
    return;
  }
  if (receiverBalanceResult.reverted) {
    log.warning(
      "[_handleTransfer]token {} balanceOf() call for account {} reverted",
      [asset.toHexString(), to.toHexString()]
    );
    return;
  }
  const tokenManager = new TokenManager(asset, event);
  const amountUSD = tokenManager.getAmountUSD(amount);
  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  manager.createTransfer(
    asset,
    from,
    to,
    amount,
    amountUSD,
    senderBalanceResult.value,
    receiverBalanceResult.value
  );
}

export function _handleAssetConfigUpdated(
  event: ethereum.Event,
  assetAddress: Address,
  rewardTokenAddress: Address,
  rewardTokenPriceUSD: BigDecimal,
  emissionPerSecond: BigInt, // amount/second
  distributionEnd: BigInt, // timestamp when emission ends
  protocolData: ProtocolData
): void {
  const market = getMarketFromToken(assetAddress, protocolData);
  if (!market) {
    log.error("[_handleAssetConfigUpdated]Market for token {} not found", [
      assetAddress.toHexString(),
    ]);
    return;
  }

  const manager = new DataManager(
    market.id,
    market.inputToken,
    event,
    protocolData
  );
  const assetToken = new TokenManager(assetAddress, event).getToken();

  if (!assetToken._iavsTokenType) {
    log.error(
      "[_handleAssetConfigUpdated]_iavsTokenType field for token {} is not set",
      [assetAddress.toHexString()]
    );
    return;
  }
  // There can be more than one reward tokens for a side,
  // e.g. one reward token for variable borrowing
  // and another for stable borrowing
  let rewardTokenType: string;
  let interestRateType: string;
  if (assetToken._iavsTokenType! == IavsTokenType.ATOKEN) {
    rewardTokenType = RewardTokenType.DEPOSIT;
    interestRateType = InterestRateType.VARIABLE;
  } else if (assetToken._iavsTokenType! == IavsTokenType.STOKEN) {
    rewardTokenType = RewardTokenType.STABLE_BORROW;
    interestRateType = InterestRateType.STABLE;
  } else if (assetToken._iavsTokenType! == IavsTokenType.VTOKEN) {
    rewardTokenType = RewardTokenType.VARIABLE_BORROW;
    interestRateType = InterestRateType.VARIABLE;
  } else {
    log.error(
      "[_handleAssetConfigUpdated] _iavsTokenType field for token {} is not one of ATOKEN, STOKEN, or VTOKEN",
      [assetAddress.toHexString()]
    );
    return;
  }

  const rewardTokenManager = new TokenManager(rewardTokenAddress, event);
  const rewardToken = rewardTokenManager.getOrCreateRewardToken(
    rewardTokenType,
    interestRateType
  );
  rewardToken._distributionEnd = distributionEnd;
  rewardToken.save();

  let emission = emissionPerSecond.times(BigInt.fromI32(SECONDS_PER_DAY));
  if (
    rewardToken._distributionEnd &&
    rewardToken._distributionEnd!.lt(event.block.timestamp)
  ) {
    log.info(
      "[_handleAssetConfigUpdated]distributionEnd {} < block timestamp {}; emission set to 0",
      [event.block.timestamp.toString(), distributionEnd.toString()]
    );
    emission = BIGINT_ZERO;
  }

  if (rewardTokenPriceUSD.gt(BIGDECIMAL_ZERO)) {
    rewardTokenManager.updatePrice(rewardTokenPriceUSD);
  }

  const emissionUSD = rewardTokenManager.getAmountUSD(emission);
  const rewardData = new RewardData(rewardToken, emission, emissionUSD);
  manager.updateRewards(rewardData);
}
