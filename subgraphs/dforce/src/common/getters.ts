import { Address, ethereum, BigInt, BigDecimal, log } from "@graphprotocol/graph-ts";
import { Factory } from "../../generated/Factory/Factory";
import { PriceOracle } from "../../generated/Factory/PriceOracle";
import { iToken as IiToken } from "../../generated/templates/iToken/iToken";
import { decimalsToBigDecimal, prefixID } from "./utils";
import { iETH_ADDRESS } from "./constants";
import {
  Token,
  LendingProtocol,
  Market,
  MarketDailySnapshot,
  MarketHourlySnapshot,
  UsageMetricsDailySnapshot,
  UsageMetricsHourlySnapshot,
  FinancialsDailySnapshot,
  InterestRate,
  _MarketStatus,
} from "../../generated/schema";
import {
  Network,
  BIGDECIMAL_ZERO,
  BIGINT_ZERO,
  INT_ZERO,
  FACTORY_ADDRESS,
  DF_ADDRESS,
  ZERO_ADDRESS,
  ProtocolType,
  LendingType,
  RiskType,
  RewardTokenType,
  InterestRateType,
  InterestRateSide,
  SECONDS_PER_HOUR,
  SECONDS_PER_DAY,
} from "../common/constants";

export function getOrCreateToken(iToken: Address): Token {
  let tokenId: string = iToken.toHexString();
  let token = Token.load(tokenId);

  if (token == null) {
    token = new Token(tokenId);

    let contract = IiToken.bind(iToken);
    token.name = contract.name();
    token.symbol = contract.symbol();
    token.decimals = contract.decimals();

    token.save();
  }
  return token;
}

export function getOrCreateUnderlyingToken(iToken: Address): Token {
  let tokenId = ZERO_ADDRESS;
  let name = "";
  let symbol = "";
  let decimals = 0;

  // underlying for iETH -> ETH
  if (iToken.toHexString() == iETH_ADDRESS) {
    name = "Ether";
    symbol = "ETH";
    decimals = 18;
  } else {
    // even if an underlying token is likely not an iToken,
    // it should work for the purpose of getting name, symbol, & decimals
    let iTokenContract = IiToken.bind(iToken);
    let tryUnderlyingTokenAddr = iTokenContract.try_underlying();
    if (!tryUnderlyingTokenAddr.reverted) {
      tokenId = tryUnderlyingTokenAddr.value.toHexString();
      let underlyingTokenContract = IiToken.bind(tryUnderlyingTokenAddr.value);
      name = underlyingTokenContract.name();
      symbol = underlyingTokenContract.symbol();
      decimals = underlyingTokenContract.decimals();
    } else {
      log.warning("Failed to get underlying for market {}", [iToken.toHexString()]);
    }
  }

  let token = Token.load(tokenId);

  if (token == null) {
    token = new Token(tokenId);
    token.name = name;
    token.symbol = symbol;
    token.decimals = decimals;

    token.save();
  }
  return token;
}

export function getUnderlyingTokenPrice(iToken: Address): BigDecimal {
  let factoryContract = Factory.bind(Address.fromString(FACTORY_ADDRESS));
  let oracleAddress = factoryContract.priceOracle();
  let oracleContract = PriceOracle.bind(oracleAddress);
  let underlyingDecimals = getOrCreateUnderlyingToken(iToken).decimals;
  // TODO verify that this is correct
  let mantissaDecimalFactor = 18 - underlyingDecimals + 18;

  let underlyingPrice = oracleContract
    .getUnderlyingPrice(iToken)
    .toBigDecimal()
    .div(decimalsToBigDecimal(mantissaDecimalFactor));

  return underlyingPrice;
}

export function getUnderlyingTokenPricePerAmount(iToken: Address): BigDecimal {
  //return price of 1 underlying token amount
  let underlyingPrice = getUnderlyingTokenPrice(iToken);
  let decimals = getOrCreateUnderlyingToken(iToken).decimals;
  let denominator = decimalsToBigDecimal(decimals);
  return underlyingPrice.div(denominator);
}

export function getOrCreateProtocol(): LendingProtocol {
  let protocol = LendingProtocol.load(FACTORY_ADDRESS);

  if (!protocol) {
    protocol = new LendingProtocol(FACTORY_ADDRESS);
    protocol.name = "dForce v2";
    protocol.slug = "dforce-v2";
    protocol.schemaVersion = "1.2.1";
    protocol.subgraphVersion = "0.1.0";
    protocol.methodologyVersion = "1.0.0";
    protocol.network = Network.ETHEREUM;
    protocol.type = ProtocolType.LENDING;
    protocol.lendingType = LendingType.CDP;
    protocol.riskType = RiskType.GLOBAL;
    protocol.mintedTokens = [];
    protocol.mintedTokenSupplies = [];
    ////// quantitative data //////
    protocol.cumulativeUniqueUsers = INT_ZERO;
    protocol.totalValueLockedUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeSupplySideRevenueUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeTotalRevenueUSD = BIGDECIMAL_ZERO;
    protocol.totalDepositBalanceUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeDepositUSD = BIGDECIMAL_ZERO;
    protocol.totalBorrowBalanceUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeBorrowUSD = BIGDECIMAL_ZERO;
    protocol.cumulativeLiquidateUSD = BIGDECIMAL_ZERO;

    // metrics/markets - derived and don't need to be initialized
    //protocol.usageMetrics
    //protocol.financialMetrics
    //protocol.markets

    protocol.save();
  }
  return protocol;
}

export function getOrCreateMarket(marketId: string, event: ethereum.Event): Market {
  let market = Market.load(marketId);

  if (market == null) {
    let contract = IiToken.bind(Address.fromString(marketId));

    let asset = ZERO_ADDRESS; //default
    let tryAsset = contract.try_underlying();
    if (!tryAsset.reverted) {
      asset = tryAsset.value.toHexString();
    }

    market = new Market(marketId);
    market.protocol = FACTORY_ADDRESS;
    market.name = contract.name();
    // isActive toggled in factory.ts according to Pause status
    market.isActive = true;
    market.canUseAsCollateral = false;
    market.canBorrowFrom = true; //default, reset by handleBorrowPaused
    market.maximumLTV = BIGDECIMAL_ZERO;
    market.liquidationThreshold = BIGDECIMAL_ZERO;
    market.liquidationPenalty = BIGDECIMAL_ZERO;

    market.inputToken = asset;
    market.outputToken = marketId;
    // populated in rewards.ts/handleNewRewardToken
    market.rewardTokens = [];

    market.rates = [
      prefixID(marketId, InterestRateSide.LENDER, InterestRateType.VARIABLE),
      prefixID(marketId, InterestRateSide.BORROWER, InterestRateType.VARIABLE),
    ];
    //inverse finance does not have stable borrow rate - default to null
    //market.stableBorrowRate

    market.totalValueLockedUSD = BIGDECIMAL_ZERO;
    market.cumulativeBorrowUSD = BIGDECIMAL_ZERO;
    market.totalDepositBalanceUSD = BIGDECIMAL_ZERO;
    market.cumulativeDepositUSD = BIGDECIMAL_ZERO;
    market.totalBorrowBalanceUSD = BIGDECIMAL_ZERO;
    market.cumulativeBorrowUSD = BIGDECIMAL_ZERO;
    market.cumulativeLiquidateUSD = BIGDECIMAL_ZERO;
    market.inputTokenBalance = BIGINT_ZERO;
    market.inputTokenPriceUSD = BIGDECIMAL_ZERO;
    market.outputTokenSupply = BIGINT_ZERO;
    market.outputTokenPriceUSD = BIGDECIMAL_ZERO;
    market.exchangeRate = BIGDECIMAL_ZERO;
    market.rewardTokenEmissionsAmount = [BIGINT_ZERO, BIGINT_ZERO];
    market.rewardTokenEmissionsUSD = [BIGDECIMAL_ZERO, BIGDECIMAL_ZERO];

    //market.snapshots - derived and don't need to be initialized
    //market.deposits
    //market.withdraws
    //market.borrows
    //market.repays
    //market.liquidates

    market.createdTimestamp = event.block.timestamp;
    market.createdBlockNumber = event.block.number;
    market.save();
  }
  return market;
}

export function getOrCreateMarketDailySnapshot(event: ethereum.Event): MarketDailySnapshot {
  let days = event.block.timestamp.toI64() / SECONDS_PER_DAY;
  let daysStr: string = days.toString();
  let marketId = event.address.toHexString();
  let snapshotId = prefixID(marketId, daysStr);

  let market = getOrCreateMarket(marketId, event);
  let marketMetrics = MarketDailySnapshot.load(snapshotId);
  if (marketMetrics == null) {
    marketMetrics = new MarketDailySnapshot(snapshotId);

    marketMetrics.protocol = FACTORY_ADDRESS;
    marketMetrics.market = marketId;
    marketMetrics.blockNumber = event.block.number;
    marketMetrics.timestamp = event.block.timestamp;
    marketMetrics.rates = [
      prefixID(marketId, InterestRateSide.BORROWER, InterestRateType.VARIABLE),
      prefixID(marketId, InterestRateSide.LENDER, InterestRateType.VARIABLE),
    ];
    marketMetrics.totalValueLockedUSD = market.totalValueLockedUSD;
    marketMetrics.totalDepositBalanceUSD = market.totalDepositBalanceUSD;
    marketMetrics.dailyDepositUSD = BIGDECIMAL_ZERO;
    marketMetrics.cumulativeDepositUSD = market.cumulativeDepositUSD;
    marketMetrics.totalBorrowBalanceUSD = market.totalBorrowBalanceUSD;
    marketMetrics.dailyBorrowUSD = BIGDECIMAL_ZERO;
    marketMetrics.cumulativeBorrowUSD = market.cumulativeBorrowUSD;
    marketMetrics.dailyLiquidateUSD = BIGDECIMAL_ZERO;
    marketMetrics.cumulativeLiquidateUSD = market.cumulativeLiquidateUSD;

    marketMetrics.inputTokenBalance = market.inputTokenBalance;
    marketMetrics.inputTokenPriceUSD = market.inputTokenPriceUSD;
    marketMetrics.outputTokenSupply = market.outputTokenSupply;
    marketMetrics.outputTokenPriceUSD = market.outputTokenPriceUSD;
    marketMetrics.exchangeRate = market.exchangeRate;

    marketMetrics.rewardTokenEmissionsAmount = [BIGINT_ZERO, BIGINT_ZERO];
    marketMetrics.rewardTokenEmissionsUSD = [BIGDECIMAL_ZERO, BIGDECIMAL_ZERO];

    marketMetrics.save();
  }

  return marketMetrics;
}

export function getOrCreateMarketHourlySnapshot(event: ethereum.Event): MarketHourlySnapshot {
  // Hours since Unix epoch time
  let hours = event.block.timestamp.toI64() / SECONDS_PER_HOUR;
  let hoursStr = hours.toString();

  let marketId = event.address.toHexString();
  let snapshotId = prefixID(marketId, hoursStr);

  let market = getOrCreateMarket(marketId, event);
  let marketMetrics = MarketHourlySnapshot.load(snapshotId);
  if (marketMetrics == null) {
    marketMetrics = new MarketHourlySnapshot(snapshotId);

    marketMetrics.protocol = FACTORY_ADDRESS;
    marketMetrics.market = marketId;
    marketMetrics.blockNumber = event.block.number;
    marketMetrics.timestamp = event.block.timestamp;
    marketMetrics.rates = [
      prefixID(marketId, InterestRateSide.BORROWER, InterestRateType.VARIABLE),
      prefixID(marketId, InterestRateSide.LENDER, InterestRateType.VARIABLE),
    ];
    marketMetrics.totalValueLockedUSD = market.totalValueLockedUSD;
    marketMetrics.totalDepositBalanceUSD = market.totalDepositBalanceUSD;
    marketMetrics.hourlyDepositUSD = BIGDECIMAL_ZERO;
    marketMetrics.cumulativeDepositUSD = market.cumulativeDepositUSD;
    marketMetrics.totalBorrowBalanceUSD = market.totalBorrowBalanceUSD;
    marketMetrics.hourlyBorrowUSD = BIGDECIMAL_ZERO;
    marketMetrics.cumulativeBorrowUSD = market.cumulativeBorrowUSD;
    marketMetrics.hourlyLiquidateUSD = BIGDECIMAL_ZERO;
    marketMetrics.cumulativeLiquidateUSD = market.cumulativeLiquidateUSD;

    marketMetrics.inputTokenBalance = market.inputTokenBalance;
    marketMetrics.inputTokenPriceUSD = market.inputTokenPriceUSD;
    marketMetrics.outputTokenSupply = market.outputTokenSupply;
    marketMetrics.outputTokenPriceUSD = market.outputTokenPriceUSD;
    marketMetrics.exchangeRate = market.exchangeRate;

    marketMetrics.rewardTokenEmissionsAmount = [BIGINT_ZERO, BIGINT_ZERO];
    marketMetrics.rewardTokenEmissionsUSD = [BIGDECIMAL_ZERO, BIGDECIMAL_ZERO];

    marketMetrics.save();
  }

  return marketMetrics;
}

export function getOrCreateUsageMetricsDailySnapshot(event: ethereum.Event): UsageMetricsDailySnapshot {
  // Number of days since Unix epoch
  let days = event.block.timestamp.toI64() / SECONDS_PER_DAY;
  let daysStr: string = days.toString();

  let protocol = getOrCreateProtocol();
  let usageMetrics = UsageMetricsDailySnapshot.load(daysStr);
  if (usageMetrics == null) {
    usageMetrics = new UsageMetricsDailySnapshot(daysStr);

    usageMetrics.protocol = FACTORY_ADDRESS;
    usageMetrics.dailyActiveUsers = INT_ZERO;
    usageMetrics.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
    usageMetrics.dailyTransactionCount = INT_ZERO;
    usageMetrics.dailyDepositCount = INT_ZERO;
    usageMetrics.dailyWithdrawCount = INT_ZERO;
    usageMetrics.dailyBorrowCount = INT_ZERO;
    usageMetrics.dailyRepayCount = INT_ZERO;
    usageMetrics.dailyLiquidateCount = INT_ZERO;
    usageMetrics.save();
  }
  return usageMetrics;
}

export function getOrCreateUsageMetricsHourlySnapshot(event: ethereum.Event): UsageMetricsHourlySnapshot {
  // Number of hours since Unix epoch
  let hours = event.block.timestamp.toI64() / SECONDS_PER_HOUR;

  let hoursStr: string = hours.toString();
  let protocol = getOrCreateProtocol();
  let usageMetrics = UsageMetricsHourlySnapshot.load(hoursStr);
  if (usageMetrics == null) {
    usageMetrics = new UsageMetricsHourlySnapshot(hoursStr);

    usageMetrics.protocol = FACTORY_ADDRESS;
    usageMetrics.hourlyActiveUsers = INT_ZERO;
    usageMetrics.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
    usageMetrics.hourlyTransactionCount = INT_ZERO;
    usageMetrics.hourlyDepositCount = INT_ZERO;
    usageMetrics.hourlyWithdrawCount = INT_ZERO;
    usageMetrics.hourlyBorrowCount = INT_ZERO;
    usageMetrics.hourlyRepayCount = INT_ZERO;
    usageMetrics.hourlyLiquidateCount = INT_ZERO;
    usageMetrics.save();
  }
  return usageMetrics;
}

export function getOrCreateFinancialsDailySnapshot(event: ethereum.Event): FinancialsDailySnapshot {
  let daysStr: string = (event.block.timestamp.toI64() / SECONDS_PER_DAY).toString();
  let protocol = getOrCreateProtocol();
  let financialMetrics = FinancialsDailySnapshot.load(daysStr);
  if (financialMetrics == null) {
    financialMetrics = new FinancialsDailySnapshot(daysStr);

    financialMetrics.protocol = FACTORY_ADDRESS;
    financialMetrics.totalValueLockedUSD = protocol.totalValueLockedUSD;
    financialMetrics.mintedTokenSupplies = protocol.mintedTokenSupplies;
    financialMetrics.dailySupplySideRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeSupplySideRevenueUSD = protocol.cumulativeSupplySideRevenueUSD;
    financialMetrics.dailyProtocolSideRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeProtocolSideRevenueUSD = protocol.cumulativeProtocolSideRevenueUSD;
    financialMetrics.dailyTotalRevenueUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeTotalRevenueUSD = protocol.cumulativeTotalRevenueUSD;
    financialMetrics.totalDepositBalanceUSD = protocol.totalDepositBalanceUSD;
    financialMetrics.dailyDepositUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeDepositUSD = protocol.cumulativeDepositUSD;
    financialMetrics.totalBorrowBalanceUSD = protocol.totalBorrowBalanceUSD;
    financialMetrics.dailyBorrowUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeBorrowUSD = protocol.cumulativeBorrowUSD;
    financialMetrics.dailyLiquidateUSD = BIGDECIMAL_ZERO;
    financialMetrics.cumulativeLiquidateUSD = protocol.cumulativeLiquidateUSD;
    financialMetrics.save();
  }
  return financialMetrics;
}

export function getOrCreateInterestRate(
  id: string | null = null,
  side: string = InterestRateSide.BORROWER,
  type: string = InterestRateType.VARIABLE,
  marketId: string = ZERO_ADDRESS,
): InterestRate {
  if (id == null) {
    assert(marketId != ZERO_ADDRESS, "The marketId must be specified when InterestRate id is null");
    id = prefixID(marketId, side, type);
  }

  let interestRate = InterestRate.load(id!);
  if (interestRate == null) {
    interestRate = new InterestRate(id!);
    interestRate.rate = BIGDECIMAL_ZERO;
    interestRate.side = side;
    interestRate.type = type;
  }
  return interestRate;
}

// helper entity to determine market status
export function getOrCreateMarketStatus(marketId: string): _MarketStatus {
  let marketStatus = _MarketStatus.load(marketId);

  if (marketStatus == null) {
    marketStatus = new _MarketStatus(marketId);

    marketStatus.mintPaused = false;
    marketStatus.redeemPaused = false;
    marketStatus.transferPaused = false;

    marketStatus.save();
  }
  return marketStatus;
}
