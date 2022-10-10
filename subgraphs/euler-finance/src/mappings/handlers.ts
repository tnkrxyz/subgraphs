import { Address, ethereum, BigInt, BigDecimal } from "@graphprotocol/graph-ts";
import {
  AssetStatus,
  Borrow,
  Deposit,
  GovSetAssetConfig,
  Liquidation,
  MarketActivated,
  Repay,
  Withdraw,
} from "../../generated/euler/Euler";
import {
  EulerGeneralView,
  EulerGeneralView__doQueryInputQStruct,
  EulerGeneralView__doQueryResultRStruct,
} from "../../generated/euler/EulerGeneralView";
import {
  getOrCreateLendingProtocol,
  getOrCreateMarket,
  getOrCreateProtocolUtility,
  getOrCreateToken,
} from "../common/getters";
import {
  EULER_ADDRESS,
  EULER_GENERAL_VIEW_ADDRESS,
  ZERO_ADDRESS,
  TransactionType,
  EULER_GENERAL_VIEW_V2_ADDRESS,
  VIEW_V2_START_BLOCK_NUMBER,
} from "../common/constants";
import {
  updateFinancials,
  updateMarketDailyMetrics,
  updateMarketHourlyMetrics,
  updateUsageMetrics,
} from "../common/metrics";
import {
  createBorrow,
  createDeposit,
  createLiquidation,
  createMarket,
  createRepay,
  createWithdraw,
  syncWithEulerGeneralView,
  updateAsset,
  updateLendingFactors,
  updateSnapshotRevenues,
} from "./helpers";
import { _AssetStatus } from "../../generated/schema";

export function handleAssetStatus(event: AssetStatus): void {
  updateAsset(event);

  const marketId = event.params.underlying.toHexString();
  const block = event.block;
  const totalBorrows = event.params.totalBorrows;
  const reserveBalance = event.params.reserveBalance;
  const timestamp = event.params.timestamp;

  let assetStatus = _AssetStatus.load(marketId);
  if (!assetStatus) {
    // should only happen when market first initiated
    assetStatus = new _AssetStatus(marketId);
    assetStatus.totalBorrows = totalBorrows;
    assetStatus.reserveBalance = reserveBalance;
    assetStatus.timestamp = timestamp;
    assetStatus.save();
    return;
  }

  assert(
    timestamp.gt(assetStatus.timestamp),
    `event timestamp ${timestamp} <= assetStatus.timestamp ${assetStatus.timestamp}`,
  );

  const token = getOrCreateToken(Address.fromString(marketId));
  const tokenPrecision = new BigDecimal(BigInt.fromI32(10).pow(<u8>token.decimals));

  const deltaTotalRevenue = totalBorrows
    .minus(assetStatus.totalBorrows)
    .divDecimal(tokenPrecision)
    .times(token.lastPriceUSD!);
  const deltaProtocolSideRevenue = reserveBalance
    .minus(assetStatus.reserveBalance)
    .divDecimal(tokenPrecision)
    .times(token.lastPriceUSD!);
  const deltaSupplySideRevenue = deltaTotalRevenue.minus(deltaProtocolSideRevenue);

  const protocol = getOrCreateLendingProtocol();
  // update protocol revenue
  protocol.cumulativeSupplySideRevenueUSD = protocol.cumulativeSupplySideRevenueUSD.plus(deltaSupplySideRevenue);
  protocol.cumulativeProtocolSideRevenueUSD = protocol.cumulativeProtocolSideRevenueUSD.plus(deltaProtocolSideRevenue);
  protocol.cumulativeTotalRevenueUSD = protocol.cumulativeTotalRevenueUSD.plus(deltaTotalRevenue);
  protocol.save();

  const market = getOrCreateMarket(marketId);
  // update market's revenue
  market.cumulativeSupplySideRevenueUSD = market.cumulativeSupplySideRevenueUSD.plus(deltaSupplySideRevenue);
  market.cumulativeProtocolSideRevenueUSD = market.cumulativeProtocolSideRevenueUSD.plus(deltaProtocolSideRevenue);
  market.cumulativeTotalRevenueUSD = market.cumulativeTotalRevenueUSD.plus(deltaTotalRevenue);
  market.save();

  updateSnapshotRevenues(marketId, block, deltaSupplySideRevenue, deltaProtocolSideRevenue, deltaTotalRevenue);
}

export function handleBorrow(event: Borrow): void {
  let borrowUSD = createBorrow(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.BORROW);
  updateFinancials(event.block, borrowUSD, TransactionType.BORROW);
  updateMarketDailyMetrics(event.block, marketId, borrowUSD, TransactionType.BORROW);
  updateMarketHourlyMetrics(event.block, marketId, borrowUSD, TransactionType.BORROW);
  updateProtocolAndMarkets(event.block, marketId);
}

export function handleDeposit(event: Deposit): void {
  let depositUSD = createDeposit(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.DEPOSIT);
  updateFinancials(event.block, depositUSD, TransactionType.DEPOSIT);
  updateMarketDailyMetrics(event.block, marketId, depositUSD, TransactionType.DEPOSIT);
  updateMarketHourlyMetrics(event.block, marketId, depositUSD, TransactionType.DEPOSIT);
  updateProtocolAndMarkets(event.block, marketId);
}

export function handleRepay(event: Repay): void {
  let repayUSD = createRepay(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.REPAY);
  updateFinancials(event.block, repayUSD, TransactionType.REPAY);
  updateMarketDailyMetrics(event.block, marketId, repayUSD, TransactionType.REPAY);
  updateMarketHourlyMetrics(event.block, marketId, repayUSD, TransactionType.REPAY);
  updateProtocolAndMarkets(event.block, marketId);
}

export function handleWithdraw(event: Withdraw): void {
  let withdrawUSD = createWithdraw(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.WITHDRAW);
  updateFinancials(event.block, withdrawUSD, TransactionType.WITHDRAW);
  updateMarketDailyMetrics(event.block, marketId, withdrawUSD, TransactionType.WITHDRAW);
  updateMarketHourlyMetrics(event.block, marketId, withdrawUSD, TransactionType.WITHDRAW);
  updateProtocolAndMarkets(event.block, marketId);
}

export function handleLiquidation(event: Liquidation): void {
  let liquidateUSD = createLiquidation(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.liquidator, TransactionType.LIQUIDATE);
  updateFinancials(event.block, liquidateUSD, TransactionType.LIQUIDATE);
  updateMarketDailyMetrics(event.block, marketId, liquidateUSD, TransactionType.LIQUIDATE);
  updateMarketHourlyMetrics(event.block, marketId, liquidateUSD, TransactionType.LIQUIDATE);
  updateProtocolAndMarkets(event.block, marketId);
}

export function handleGovSetAssetConfig(event: GovSetAssetConfig): void {
  updateLendingFactors(event);
}

export function handleMarketActivated(event: MarketActivated): void {
  createMarket(event);
}

function getEulerViewContract(block: ethereum.Block): EulerGeneralView {
  const viewAddress = block.number.gt(VIEW_V2_START_BLOCK_NUMBER)
    ? EULER_GENERAL_VIEW_V2_ADDRESS
    : EULER_GENERAL_VIEW_ADDRESS;
  return EulerGeneralView.bind(Address.fromString(viewAddress));
}

/**
 * Query Euler General View contract in order to get markets current status.
 *
 * @param marketIds List of markets to query
 * @param block current block
 * @returns query resul or null if nothing could be queried.
 */
function queryEulerGeneralView(
  marketIds: string[],
  block: ethereum.Block,
): EulerGeneralView__doQueryResultRStruct | null {
  if (marketIds.length === 0) {
    return null; // No market is initialized, nothing to do.
  }

  const marketAddresses: Array<Address> = marketIds.map<Address>((market: string) => Address.fromString(market));

  const queryParameters: Array<ethereum.Value> = [
    ethereum.Value.fromAddress(Address.fromString(EULER_ADDRESS)),
    ethereum.Value.fromAddress(Address.fromString(ZERO_ADDRESS)),
    ethereum.Value.fromAddressArray(marketAddresses),
  ];

  const queryParametersTuple = changetype<EulerGeneralView__doQueryInputQStruct>(queryParameters);
  const eulerGeneralView = getEulerViewContract(block);
  const result = eulerGeneralView.try_doQuery(queryParametersTuple);

  if (result.reverted) {
    return null;
  }

  return result.value;
}

// initiates market / protocol updates in syncWithEulerGeneralView()
function updateProtocolAndMarkets(block: ethereum.Block, marketId: string): void {
  let blockNumber = block.number.toI32();
  let protocolUtility = getOrCreateProtocolUtility(blockNumber);
  let markets = protocolUtility.markets;
  const marketIndex = markets.indexOf(marketId);
  assert(marketIndex >= 0, `[updateProtocolAndMarkets]marketId=${marketId} not in protocolUtility.markets`);
  markets = [marketId];

  /* 
  if (protocolUtility.lastBlockNumber >= blockNumber - 120) {
    // Do this update every 120 blocks
    // this equates to about 30 minutes on ethereum mainnet
    // this is done since the following logic slows down the indexer
    return;
  }
  */

  let eulerViewQueryResult = queryEulerGeneralView(markets, block);
  if (!eulerViewQueryResult) {
    return;
  }

  // update block number
  protocolUtility.lastBlockNumber = blockNumber;
  protocolUtility.save();

  syncWithEulerGeneralView(eulerViewQueryResult, block);
}
