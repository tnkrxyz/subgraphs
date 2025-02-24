import { Address, dataSource, log } from "@graphprotocol/graph-ts";
import { DegenBox, LogDeploy } from "../generated/bentoBox/DegenBox";
import {
  LogAddCollateral,
  LogBorrow,
  LogRemoveCollateral,
  LogRepay,
  Cauldron,
  LogExchangeRate,
  LogAccrue,
} from "../generated/templates/Cauldron/Cauldron";
import { Deposit, Borrow, Repay, Liquidate } from "../generated/schema";
import { NEG_INT_ONE, DEFAULT_DECIMALS, BIGDECIMAL_ONE, ABRA_ACCOUNTS } from "./common/constants";
import { bigIntToBigDecimal, divBigDecimal } from "./common/utils/numbers";
import {
  getOrCreateToken,
  getOrCreateLendingProtocol,
  getMarket,
  getLiquidateEvent,
  getMIMAddress,
  getOrCreateUsageMetricsHourlySnapshot,
  getOrCreateUsageMetricsDailySnapshot,
  getOrCreateMarketHourlySnapshot,
  getOrCreateMarketDailySnapshot,
  getOrCreateFinancials,
} from "./common/getters";
import { Cauldron as CauldronDataSource } from "../generated/templates";
import { updateTokenPrice } from "./common/prices/prices";
import {
  updateUsageMetrics,
  updateTVL,
  updateMarketStats,
  updateMarketMetrics,
  updateFinancials,
  updateTotalBorrows,
} from "./common/metrics";
import { createMarket, createLiquidateEvent } from "./common/setters";

export function handleLogDeploy(event: LogDeploy): void {
  const account = event.transaction.from.toHex().toLowerCase();
  if (ABRA_ACCOUNTS.indexOf(account) > NEG_INT_ONE) {
    createMarket(event.params.cloneAddress.toHexString(), event.block.number, event.block.timestamp);
    CauldronDataSource.create(event.params.cloneAddress);
  }
}

export function handleLogAddCollateral(event: LogAddCollateral): void {
  let depositEvent = new Deposit(event.transaction.hash.toHexString() + "-" + event.transactionLogIndex.toString());
  let market = getMarket(event.address.toHexString());
  if (!market) {
    return;
  }
  let CauldronContract = Cauldron.bind(event.address);
  let collateralToken = getOrCreateToken(Address.fromString(market.inputToken));
  let tokenPriceUSD = collateralToken.lastPriceUSD;
  let amountUSD = bigIntToBigDecimal(event.params.share, collateralToken.decimals).times(tokenPriceUSD!);

  depositEvent.hash = event.transaction.hash.toHexString();
  depositEvent.logIndex = event.transactionLogIndex.toI32();
  depositEvent.protocol = getOrCreateLendingProtocol().id;
  depositEvent.to = event.params.to.toHexString();
  depositEvent.from = event.params.from.toHexString();
  depositEvent.blockNumber = event.block.number;
  depositEvent.timestamp = event.block.timestamp;
  depositEvent.market = market.id;
  depositEvent.asset = collateralToken.id;
  // Amount needs to be calculated differently as bentobox deals shares and amounts in a different way.
  // usage of toAmount function converts shares to actual amount based on collateral
  depositEvent.amount = DegenBox.bind(CauldronContract.bentoBox()).toAmount(
    Address.fromString(collateralToken.id),
    event.params.share,
    false,
  );
  depositEvent.amountUSD = amountUSD;
  depositEvent.save();

  updateMarketStats(market.id, "DEPOSIT", collateralToken.id, event.params.share, event);
  updateTVL(event);
  updateMarketMetrics(event); // must run updateMarketStats first as updateMarketMetrics uses values updated in updateMarketStats
  updateUsageMetrics(event, event.params.from, event.params.to);
}

export function handleLogRemoveCollateral(event: LogRemoveCollateral): void {
  if (event.params.from.toHexString() != event.params.to.toHexString()) {
    createLiquidateEvent(event);
  }
  let withdrawalEvent = new Deposit(event.transaction.hash.toHexString() + "-" + event.transactionLogIndex.toString());
  let market = getMarket(event.address.toHexString());
  if (!market) {
    return;
  }
  let collateralToken = getOrCreateToken(Address.fromString(market.inputToken));
  let CauldronContract = Cauldron.bind(event.address);
  let tokenPriceUSD = collateralToken.lastPriceUSD;
  let amountUSD = bigIntToBigDecimal(event.params.share, collateralToken.decimals).times(tokenPriceUSD!);

  withdrawalEvent.hash = event.transaction.hash.toHexString();
  withdrawalEvent.logIndex = event.transactionLogIndex.toI32();
  withdrawalEvent.protocol = getOrCreateLendingProtocol().id;
  withdrawalEvent.to = event.params.to.toHexString();
  withdrawalEvent.from = event.params.from.toHexString();
  withdrawalEvent.blockNumber = event.block.number;
  withdrawalEvent.timestamp = event.block.timestamp;
  withdrawalEvent.market = market.id;
  withdrawalEvent.asset = collateralToken.id;
  withdrawalEvent.amount = DegenBox.bind(CauldronContract.bentoBox()).toAmount(
    Address.fromString(collateralToken.id),
    event.params.share,
    false,
  );
  withdrawalEvent.amountUSD = amountUSD;
  withdrawalEvent.save();
  updateMarketStats(market.id, "WITHDRAW", collateralToken.id, event.params.share, event);
  updateTVL(event);
  updateMarketMetrics(event); // must run updateMarketStats first as updateMarketMetrics uses values updated in updateMarketStats
  updateUsageMetrics(event, event.params.from, event.params.to);
}

export function handleLogBorrow(event: LogBorrow): void {
  let borrowEvent = new Borrow(event.transaction.hash.toHexString() + "-" + event.transactionLogIndex.toString());
  let market = getMarket(event.address.toHexString());
  if (!market) {
    return;
  }
  let mimToken = getOrCreateToken(Address.fromString(getMIMAddress(dataSource.network())));
  let mimPriceUSD = mimToken.lastPriceUSD;
  let amountUSD = bigIntToBigDecimal(event.params.amount, DEFAULT_DECIMALS).times(mimPriceUSD!);

  borrowEvent.hash = event.transaction.hash.toHexString();
  borrowEvent.logIndex = event.transactionLogIndex.toI32();
  borrowEvent.protocol = getOrCreateLendingProtocol().id;
  borrowEvent.to = event.params.to.toHexString();
  borrowEvent.from = event.params.from.toHexString();
  borrowEvent.blockNumber = event.block.number;
  borrowEvent.timestamp = event.block.timestamp;
  borrowEvent.market = market.id;
  borrowEvent.asset = mimToken.id;
  borrowEvent.amount = event.params.amount;
  borrowEvent.amountUSD = amountUSD;
  borrowEvent.save();

  updateTotalBorrows(event);
  updateMarketStats(market.id, "BORROW", getMIMAddress(dataSource.network()), event.params.amount, event);
  updateMarketMetrics(event); // must run updateMarketStats first as updateMarketMetrics uses values updated in updateMarketStats
  updateUsageMetrics(event, event.params.from, event.params.to);
}

// Liquidation steps
// - Liquidations are found in logRemoveCollateral event when from!=to, logRepay events are emitted directly after (logRemoveCollateral's log index +1)
// 1) When handling logRemoveCollateral emitted by a market contract, check if from!=to in the log receipt
// 2) If from!=to, save the collateral amount removed in Liquidate entity
// 3) In logRepay, also check if from!=to and check if we saved the tx_hash - log_index +1 in a Liquidate entity
//    - Retrieve Liquidate entity to obtain the collateral amount removed and subtract the MIM amount repayed from LogRepay to determine the profit in USD

export function handleLiquidation(event: LogRepay): void {
  // Retrieve cached liquidation that holds amount of collateral to help calculate profit usd (obtained from log remove collateral with from != to)
  let liquidateProxy = getLiquidateEvent(event); // retrieve cached liquidation by subtracting 1 from the current event log index (as we registered the liquidation in logRemoveCollateral that occurs 1 log index before this event)
  if (!liquidateProxy) {
    log.error("Liquidation {} not found in cache. Liquidation event must be registered in logRemoveCollateral event", [
      event.transaction.hash.toHexString() + "-" + event.transactionLogIndex.toString(),
    ]);
    return;
  }
  let liquidateEvent = new Liquidate(
    "liquidate" + "-" + event.transaction.hash.toHexString() + "-" + event.transactionLogIndex.toString(),
  );
  liquidateEvent.amount = liquidateProxy.amount;
  let market = getMarket(event.address.toHexString());
  if (!market) {
    return;
  }
  let usageHourlySnapshot = getOrCreateUsageMetricsHourlySnapshot(event);
  let usageDailySnapshot = getOrCreateUsageMetricsDailySnapshot(event);
  let marketHourlySnapshot = getOrCreateMarketHourlySnapshot(event, market.id);
  let marketDailySnapshot = getOrCreateMarketDailySnapshot(event, market.id);
  if (!marketHourlySnapshot || !marketDailySnapshot) {
    return;
  }
  let financialsDailySnapshot = getOrCreateFinancials(event);
  let protocol = getOrCreateLendingProtocol();
  let collateralToken = getOrCreateToken(Address.fromString(market.inputToken));
  let mimToken = getOrCreateToken(Address.fromString(getMIMAddress(dataSource.network())));
  let CauldronContract = Cauldron.bind(event.address);
  let tokenPriceUSD = collateralToken.lastPriceUSD;
  let collateralAmount = DegenBox.bind(CauldronContract.bentoBox()).toAmount(
    Address.fromString(collateralToken.id),
    liquidateEvent.amount,
    false,
  );
  let collateralAmountUSD = bigIntToBigDecimal(collateralAmount, collateralToken.decimals).times(tokenPriceUSD!);
  let mimAmountUSD = bigIntToBigDecimal(event.params.amount, DEFAULT_DECIMALS).times(
    getOrCreateToken(Address.fromString(getMIMAddress(dataSource.network()))).lastPriceUSD!,
  );

  liquidateEvent.hash = event.transaction.hash.toHexString();
  liquidateEvent.logIndex = event.transactionLogIndex.toI32();
  liquidateEvent.protocol = getOrCreateLendingProtocol().id;
  liquidateEvent.to = event.params.to.toHexString();
  liquidateEvent.from = event.params.from.toHexString();
  liquidateEvent.blockNumber = event.block.number;
  liquidateEvent.timestamp = event.block.timestamp;
  liquidateEvent.market = market.id;
  liquidateEvent.asset = mimToken.id;
  liquidateEvent.amount = collateralAmount;
  liquidateEvent.amountUSD = collateralAmountUSD;
  liquidateEvent.profitUSD = collateralAmountUSD.minus(mimAmountUSD);
  liquidateEvent.liquidatee = event.params.to.toHexString();

  usageHourlySnapshot.hourlyLiquidateCount += 1;
  usageDailySnapshot.dailyLiquidateCount += 1;
  let marketCumulativeLiquidateUSD = market.cumulativeLiquidateUSD;
  marketCumulativeLiquidateUSD = marketCumulativeLiquidateUSD.plus(collateralAmountUSD);

  let protocolCumulativeLiquidateUSD = protocol.cumulativeLiquidateUSD.plus(collateralAmountUSD);

  marketHourlySnapshot.hourlyLiquidateUSD = marketHourlySnapshot.hourlyLiquidateUSD.plus(collateralAmountUSD);
  marketDailySnapshot.dailyLiquidateUSD = marketDailySnapshot.dailyLiquidateUSD.plus(collateralAmountUSD);
  financialsDailySnapshot.dailyLiquidateUSD = financialsDailySnapshot.dailyLiquidateUSD.plus(collateralAmountUSD);

  market.cumulativeLiquidateUSD = marketCumulativeLiquidateUSD;
  marketHourlySnapshot.cumulativeLiquidateUSD = marketCumulativeLiquidateUSD;
  marketDailySnapshot.cumulativeLiquidateUSD = marketCumulativeLiquidateUSD;
  financialsDailySnapshot.cumulativeLiquidateUSD = protocolCumulativeLiquidateUSD;
  protocol.cumulativeLiquidateUSD = protocolCumulativeLiquidateUSD;

  liquidateEvent.save();
  usageHourlySnapshot.save();
  usageDailySnapshot.save();
  market.save();
  marketHourlySnapshot.save();
  marketDailySnapshot.save();
  financialsDailySnapshot.save();
  protocol.save();
}

export function handleLogRepay(event: LogRepay): void {
  const invoker = event.transaction.from.toHex().toLowerCase();
  const address = event.address.toHex().toLowerCase();
  const to = event.transaction.to ? (event.transaction.to as Address).toHex().toLowerCase() : null;
  const user = event.params.to.toHex().toLowerCase();
  if ([invoker, address, to].indexOf(user) == -1) {
    handleLiquidation(event);
  }
  let repayEvent = new Repay(event.transaction.hash.toHexString() + "-" + event.transactionLogIndex.toString());
  let market = getMarket(event.address.toHexString());
  if (!market) {
    return;
  }
  let mimToken = getOrCreateToken(Address.fromString(getMIMAddress(dataSource.network())));
  let mimPriceUSD = mimToken.lastPriceUSD;
  let amountUSD = bigIntToBigDecimal(event.params.amount, DEFAULT_DECIMALS).times(mimPriceUSD!);

  repayEvent.hash = event.transaction.hash.toHexString();
  repayEvent.logIndex = event.transactionLogIndex.toI32();
  repayEvent.protocol = getOrCreateLendingProtocol().id;
  repayEvent.to = event.params.to.toHexString();
  repayEvent.from = event.params.from.toHexString();
  repayEvent.blockNumber = event.block.number;
  repayEvent.timestamp = event.block.timestamp;
  repayEvent.market = market.id;
  repayEvent.asset = mimToken.id;
  repayEvent.amount = event.params.amount;
  repayEvent.amountUSD = amountUSD;
  repayEvent.save();

  updateTotalBorrows(event);
  updateMarketStats(market.id, "REPAY", getMIMAddress(dataSource.network()), event.params.part, event); // smart contract code subs event.params.part from totalBorrow
  updateMarketMetrics(event); // must run updateMarketStats first as updateMarketMetrics uses values updated in updateMarketStats
  updateUsageMetrics(event, event.params.from, event.params.to);
}

export function handleLogExchangeRate(event: LogExchangeRate): void {
  let market = getMarket(event.address.toHexString());
  if (!market) {
    return;
  }
  let token = getOrCreateToken(Address.fromString(market.inputToken));
  let priceUSD = divBigDecimal(BIGDECIMAL_ONE, bigIntToBigDecimal(event.params.rate, token.decimals));
  let inputTokenBalance = market.inputTokenBalance;
  let tvlUSD = bigIntToBigDecimal(inputTokenBalance, token.decimals).times(priceUSD);
  market.inputTokenPriceUSD = priceUSD;
  market.totalValueLockedUSD = tvlUSD;
  market.save();
  updateTokenPrice(token.id, priceUSD, event);
}

export function handleLogAccrue(event: LogAccrue): void {
  let mimPriceUSD = getOrCreateToken(Address.fromString(getMIMAddress(dataSource.network()))).lastPriceUSD;
  let feesUSD = bigIntToBigDecimal(event.params.accruedAmount, DEFAULT_DECIMALS).times(mimPriceUSD!);
  updateFinancials(event, feesUSD, event.address.toHexString());
}
