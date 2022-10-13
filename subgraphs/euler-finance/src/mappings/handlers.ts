import { Address, ethereum, BigInt, BigDecimal, log } from "@graphprotocol/graph-ts";
import {
  AssetStatus,
  Borrow,
  Deposit,
  Euler,
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
import { RiskManager } from "../../generated/euler/RiskManager";
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
  INTERNAL_DEBT_PRECISION,
  MODULEID__EXEC,
  MODULEID__RISK_MANAGER,
  BIGINT_ZERO,
  DECIMAL_PRECISION,
  INITIAL_INTEREST_ACCUMULATOR,
  BIGDECIMAL_ONE,
  USDC_ERC20_ADDRESS,
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
import { Exec } from "../../generated/euler/Exec";

export function handleAssetStatus(event: AssetStatus): void {
  updateAsset(event);

  const marketId = event.params.underlying.toHexString();
  const block = event.block;
  const totalBorrows = event.params.totalBorrows;
  const reserveBalance = event.params.reserveBalance;
  const interestAccumulator = event.params.interestAccumulator;
  const timestamp = event.params.timestamp;

  /*  
  const eulerContract = Euler.bind(Address.fromString(EULER_ADDRESS));
  const execAddress = eulerContract.moduleIdToImplementation(MODULEID__EXEC);
  const execContract = Exec.bind(execAddress);
  const twapPrice = execContract.getPriceFull(event.params.underlying).getCurrPrice();

  const RiskMgrAddress = eulerContract.moduleIdToImplementation(MODULEID__RISK_MANAGER);
  log.info("[handleAssetStatus]riskMgrAddress={}", [RiskMgrAddress.toHexString()]);

  const riskMgrContract = RiskManager.bind(RiskMgrAddress);
  //const twapPrice = riskMgrContract.getPrice(event.params.underlying).getTwap();
  const twapPrice = riskMgrContract.getPriceFull(event.params.underlying).getCurrPrice();
  */

  const assetStatus = getOrCreateAssetStatus(marketId);

  assert(
    !assetStatus.timestamp || timestamp.ge(assetStatus.timestamp!),
    `event timestamp ${timestamp} < assetStatus.timestamp`,
  );

  assert(
    interestAccumulator.ge(assetStatus.interestAccumulator!),
    `event interestAccumulator(${interestAccumulator}) < assetStatus.interestAccumulator(${assetStatus.interestAccumulator!})`,
  );

  const token = getOrCreateToken(Address.fromString(marketId));
  const tokenPrecision = new BigDecimal(BigInt.fromI32(10).pow(<u8>token.decimals));
  log.info("[handleAssetStatus]underlying={},blk={},tx={},token.id={},token.lastPriceUSD={}", [
    marketId,
    block.number.toString(),
    event.transaction.hash.toHexString(),
    token.id,
    token.lastPriceUSD!.toString(),
  ]);

  const deltaTotalRevenue = totalBorrows
    .toBigDecimal()
    .times(BIGDECIMAL_ONE.minus(assetStatus.interestAccumulator!.divDecimal(interestAccumulator.toBigDecimal())))
    .div(DECIMAL_PRECISION)
    .times(token.lastPriceUSD!);
  const deltaProtocolSideRevenue = reserveBalance
    .minus(assetStatus.reserveBalance)
    .divDecimal(DECIMAL_PRECISION)
    .times(token.lastPriceUSD!);
  const deltaSupplySideRevenue = deltaTotalRevenue.minus(deltaProtocolSideRevenue);

  log.info(
    "[handleAssetStatus]totalBorrows={},prev totalBorrows={},totalRev={},reserveBalance={},prev reserveBal={},protocolSideRev={},price={},precision={}",
    [
      //block.number.toString(),
      //event.transaction.hash.toHexString(),
      totalBorrows.toString(),
      assetStatus.totalBorrows.toString(),
      deltaTotalRevenue.toString(),
      reserveBalance.toString(),
      assetStatus.reserveBalance.toString(),
      deltaProtocolSideRevenue.toString(),
      token.lastPriceUSD!.toString(),
      tokenPrecision.toString(),
    ],
  );

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

  assetStatus.totalBorrows = totalBorrows;
  assetStatus.reserveBalance = reserveBalance;
  assetStatus.interestAccumulator = interestAccumulator;
  assetStatus.timestamp = timestamp;
  assetStatus.save();
}

function getOrCreateAssetStatus(id: string): _AssetStatus {
  let assetStatus = _AssetStatus.load(id);
  if (!assetStatus) {
    assetStatus = new _AssetStatus(id);
    assetStatus.totalBorrows = BIGINT_ZERO;
    assetStatus.reserveBalance = BIGINT_ZERO;
    assetStatus.interestAccumulator = INITIAL_INTEREST_ACCUMULATOR;
    assetStatus.save();
  }
  return assetStatus;
}

export function handleBorrow(event: Borrow): void {
  let borrowUSD = createBorrow(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.BORROW);
  updateFinancials(event.block, borrowUSD, TransactionType.BORROW);
  updateMarketDailyMetrics(event.block, marketId, borrowUSD, TransactionType.BORROW);
  updateMarketHourlyMetrics(event.block, marketId, borrowUSD, TransactionType.BORROW);
  updateProtocolAndMarkets(event, marketId);
}

export function handleDeposit(event: Deposit): void {
  let depositUSD = createDeposit(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.DEPOSIT);
  updateFinancials(event.block, depositUSD, TransactionType.DEPOSIT);
  updateMarketDailyMetrics(event.block, marketId, depositUSD, TransactionType.DEPOSIT);
  updateMarketHourlyMetrics(event.block, marketId, depositUSD, TransactionType.DEPOSIT);
  updateProtocolAndMarkets(event, marketId);
}

export function handleRepay(event: Repay): void {
  let repayUSD = createRepay(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.REPAY);
  updateFinancials(event.block, repayUSD, TransactionType.REPAY);
  updateMarketDailyMetrics(event.block, marketId, repayUSD, TransactionType.REPAY);
  updateMarketHourlyMetrics(event.block, marketId, repayUSD, TransactionType.REPAY);
  updateProtocolAndMarkets(event, marketId);
}

export function handleWithdraw(event: Withdraw): void {
  let withdrawUSD = createWithdraw(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.account, TransactionType.WITHDRAW);
  updateFinancials(event.block, withdrawUSD, TransactionType.WITHDRAW);
  updateMarketDailyMetrics(event.block, marketId, withdrawUSD, TransactionType.WITHDRAW);
  updateMarketHourlyMetrics(event.block, marketId, withdrawUSD, TransactionType.WITHDRAW);
  updateProtocolAndMarkets(event, marketId);
}

export function handleLiquidation(event: Liquidation): void {
  let liquidateUSD = createLiquidation(event);
  const marketId = event.params.underlying.toHexString();
  updateUsageMetrics(event, event.params.liquidator, TransactionType.LIQUIDATE);
  updateFinancials(event.block, liquidateUSD, TransactionType.LIQUIDATE);
  updateMarketDailyMetrics(event.block, marketId, liquidateUSD, TransactionType.LIQUIDATE);
  updateMarketHourlyMetrics(event.block, marketId, liquidateUSD, TransactionType.LIQUIDATE);
  updateProtocolAndMarkets(event, marketId);
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
function updateProtocolAndMarkets(event: ethereum.Event, marketId: string): void {
  let blockNumber = event.block.number.toI32();
  let protocolUtility = getOrCreateProtocolUtility(blockNumber);
  let markets = protocolUtility.markets;
  const marketIndex = markets.indexOf(marketId);
  assert(marketIndex >= 0, `[updateProtocolAndMarkets]marketId=${marketId} not in protocolUtility.markets`);
  markets = [marketId, USDC_ERC20_ADDRESS];

  /* 
  if (protocolUtility.lastBlockNumber >= blockNumber - 120) {
    // Do this update every 120 blocks
    // this equates to about 30 minutes on ethereum mainnet
    // this is done since the following logic slows down the indexer
    return;
  }
  */

  let eulerViewQueryResult = queryEulerGeneralView(markets, event.block);
  if (!eulerViewQueryResult) {
    return;
  }

  // update block number
  protocolUtility.lastBlockNumber = blockNumber;
  protocolUtility.save();

  syncWithEulerGeneralView(eulerViewQueryResult, event);
}
