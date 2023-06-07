import {
  Address,
  BigInt,
  BigDecimal,
  ethereum,
  store,
  log,
} from "@graphprotocol/graph-ts";
import {
  CallableLoan,
  PoolToken,
  ScheduledRepayment,
} from "../../../generated/schema";
import { CallableLoan as CallableLoanContract } from "../../../generated/templates/CallableLoan/CallableLoan";
import { Schedule as ScheduleContract } from "../../../generated/templates/CallableLoan/Schedule";

const INTEREST_DECIMALS = BigDecimal.fromString("1000000000000000000");

export function initCallableLoan(
  address: Address,
  block: ethereum.Block
): CallableLoan {
  const id = address.toHexString();
  const callableLoan = new CallableLoan(id);
  const callableLoanContract = CallableLoanContract.bind(address);
  callableLoan.address = address;
  callableLoan.creditLineAddress = callableLoanContract.creditLine();
  callableLoan.fundingLimit = callableLoanContract.limit();
  callableLoan.principalAmount = BigInt.zero();
  callableLoan.initialInterestOwed = BigInt.zero(); // This gets set on drawdown
  callableLoan.rawGfiApy = BigDecimal.zero();
  callableLoan.totalDeposited = BigInt.zero();
  callableLoan.remainingCapacity = callableLoan.fundingLimit;
  callableLoan.createdAt = block.timestamp.toI32();
  callableLoan.fundableAt = callableLoanContract.getFundableAt().toI32();
  callableLoan.availableForDrawdown = callableLoanContract.totalPrincipalPaid();
  if (callableLoan.fundableAt == 0) {
    callableLoan.fundableAt = callableLoan.createdAt;
  }
  callableLoan.allowedUidTypes = [];
  const allowedUidTypes = callableLoanContract.getAllowedUIDTypes();
  for (let i = 0; i < allowedUidTypes.length; i++) {
    const uidType = allowedUidTypes[i];
    if (uidType.equals(BigInt.fromI32(0))) {
      callableLoan.allowedUidTypes = callableLoan.allowedUidTypes.concat([
        "NON_US_INDIVIDUAL",
      ]);
    } else if (uidType.equals(BigInt.fromI32(1))) {
      callableLoan.allowedUidTypes = callableLoan.allowedUidTypes.concat([
        "US_ACCREDITED_INDIVIDUAL",
      ]);
    } else if (uidType.equals(BigInt.fromI32(2))) {
      callableLoan.allowedUidTypes = callableLoan.allowedUidTypes.concat([
        "US_NON_ACCREDITED_INDIVIDUAL",
      ]);
    } else if (uidType.equals(BigInt.fromI32(3))) {
      callableLoan.allowedUidTypes = callableLoan.allowedUidTypes.concat([
        "US_ENTITY",
      ]);
    } else if (uidType.equals(BigInt.fromI32(4))) {
      callableLoan.allowedUidTypes = callableLoan.allowedUidTypes.concat([
        "NON_US_ENTITY",
      ]);
    }
  }
  callableLoan.backers = [];
  callableLoan.numBackers = 0;
  callableLoan.isPaused = callableLoanContract.paused();
  callableLoan.drawdownsPaused = callableLoanContract.drawdownsPaused();
  callableLoan.tokens = [];

  callableLoan.balance = callableLoanContract.balance();
  callableLoan.termEndTime = callableLoanContract.termEndTime();
  callableLoan.termStartTime = callableLoanContract.termStartTime();
  callableLoan.interestRateBigInt = callableLoanContract.interestApr();
  callableLoan.interestRate =
    callableLoan.interestRateBigInt.divDecimal(INTEREST_DECIMALS);
  callableLoan.usdcApy = callableLoan.interestRate.times(
    BigDecimal.fromString("0.9")
  ); // TODO could fetch the protocol fee from GoldfinchConfig, but this is OK for now
  callableLoan.lateFeeRate = callableLoanContract
    .lateFeeApr()
    .divDecimal(INTEREST_DECIMALS);
  callableLoan.lastFullPaymentTime = callableLoanContract
    .lastFullPaymentTime()
    .toI32();
  callableLoan.borrowerContract = callableLoanContract.borrower().toHexString();

  const schedulingResult =
    generateRepaymentScheduleForCallableLoan(callableLoan);
  callableLoan.repaymentSchedule = schedulingResult.repaymentIds;
  callableLoan.numRepayments = schedulingResult.repaymentIds.length;
  callableLoan.termInSeconds = schedulingResult.termInSeconds;
  callableLoan.repaymentFrequency = schedulingResult.repaymentFrequency;

  callableLoan.principalAmountRepaid = BigInt.zero();
  callableLoan.interestAmountRepaid = BigInt.zero();

  return callableLoan;
}

const secondsPerDay = 86400;
const twoWeeksSeconds = secondsPerDay * 14;

class SchedulingResult {
  repaymentIds: string[];
  termInSeconds: i32;
  repaymentFrequency: string;
  constructor(r: string[], t: i32, f: string) {
    this.repaymentIds = r;
    this.termInSeconds = t;
    this.repaymentFrequency = f;
  }
}

export function generateRepaymentScheduleForCallableLoan(
  callableLoan: CallableLoan
): SchedulingResult {
  const repayments: ScheduledRepayment[] = [];
  let termInSeconds = 0;
  const callableLoanContract = CallableLoanContract.bind(
    Address.fromBytes(callableLoan.address)
  );
  const scheduleContract = ScheduleContract.bind(
    callableLoanContract.schedule()
  );

  const isBeforeClose = callableLoanContract.termStartTime().isZero();

  if (isBeforeClose) {
    // Assume termStartTime will be 2 weeks after funding opens if it's not already known
    // Also have to decrement by 1 or else the first period will accidentally be 1 further in the future
    const startTime = scheduleContract
      .termStartTime(BigInt.fromI32(callableLoan.fundableAt + twoWeeksSeconds))
      .minus(BigInt.fromI32(1));
    termInSeconds = scheduleContract
      .termEndTime(startTime)
      .minus(scheduleContract.termStartTime(startTime))
      .toI32();
    const periodsInTerm = scheduleContract.periodsInTerm();

    let prevInterest = BigInt.zero();
    for (let period = 0; period < periodsInTerm.toI32(); period++) {
      const estimatedPaymentDate = scheduleContract.periodEndTime(
        startTime,
        BigInt.fromI32(period)
      );
      const interestOwedAt = callableLoanContract.estimateOwedInterestAt1(
        callableLoan.fundingLimit,
        estimatedPaymentDate
      );
      const interest = interestOwedAt.minus(prevInterest);
      prevInterest = interestOwedAt;
      // TODO need estimateOwedPrincipalAt
      const principal =
        period == periodsInTerm.toI32() - 1
          ? callableLoan.fundingLimit
          : BigInt.zero();

      if (interest.isZero() && principal.isZero()) {
        continue;
      }

      const scheduledRepayment = new ScheduledRepayment(
        `${callableLoan.id}-${period.toString()}`
      );
      scheduledRepayment.loan = callableLoan.id;
      scheduledRepayment.estimatedPaymentDate = estimatedPaymentDate.toI32();
      scheduledRepayment.paymentPeriod = period;
      scheduledRepayment.interest = interest;
      scheduledRepayment.principal = principal;
      scheduledRepayment.save();
      repayments.push(scheduledRepayment);
    }
  } else {
    const startTime = callableLoan.termStartTime.minus(BigInt.fromI32(1));
    const lastFullPaymentTime = callableLoanContract.lastFullPaymentTime();
    termInSeconds = callableLoanContract
      .termEndTime()
      .minus(callableLoanContract.termStartTime())
      .toI32();
    const periodsInTerm = scheduleContract.periodsInTerm();
    let prevInterest = BigInt.zero();
    let prevPrincipal = BigInt.zero();
    for (let period = 0; period < periodsInTerm.toI32(); period++) {
      const estimatedPaymentDate = scheduleContract.periodEndTime(
        startTime,
        BigInt.fromI32(period)
      );
      // Can't call estimateOwedInterestAt on timestamps in the past
      if (estimatedPaymentDate.lt(lastFullPaymentTime)) {
        continue;
      }
      const interestOwedAt_result =
        callableLoanContract.try_estimateOwedInterestAt(estimatedPaymentDate);
      // Just being cautious, in case the timestamp check above isn't good enought
      if (interestOwedAt_result.reverted) {
        continue;
      }
      const interestOwedAt = interestOwedAt_result.value;
      const interest = interestOwedAt.minus(prevInterest);
      prevInterest = interestOwedAt;
      const principalOwedAt =
        callableLoanContract.principalOwedAt(estimatedPaymentDate);
      const principal = principalOwedAt.minus(prevPrincipal);
      prevPrincipal = principalOwedAt;

      if (principal.isZero() && interest.isZero()) {
        continue;
      }

      const scheduledRepayment = new ScheduledRepayment(
        `${callableLoan.id}-${period.toString()}`
      );
      scheduledRepayment.loan = callableLoan.id;
      scheduledRepayment.estimatedPaymentDate = estimatedPaymentDate.toI32();
      scheduledRepayment.paymentPeriod = period;
      scheduledRepayment.interest = interest;
      scheduledRepayment.principal = principal;
      scheduledRepayment.save();
      repayments.push(scheduledRepayment);
    }
  }

  let repaymentFrequency = "MONTHLY"; // Assume monthly just because it's safe
  // Note that repayments.length only falls below 2 if the loan is close to being fully paid off. The mapping code only sets repaymentFrequency on drawdown, so thankfully this is inconsequential
  // Just need to guard against an out-of-bounds error
  if (repayments.length >= 2) {
    const approximateSecondsPerPeriod =
      repayments[1].estimatedPaymentDate - repayments[0].estimatedPaymentDate;
    if (approximateSecondsPerPeriod <= secondsPerDay) {
      repaymentFrequency = "DAILY";
    } else if (approximateSecondsPerPeriod <= secondsPerDay * 7) {
      repaymentFrequency = "WEEKLY";
    } else if (approximateSecondsPerPeriod <= secondsPerDay * 14) {
      repaymentFrequency = "BIWEEKLY";
    } else if (approximateSecondsPerPeriod <= secondsPerDay * 31) {
      repaymentFrequency = "MONTHLY";
    } else if (approximateSecondsPerPeriod <= secondsPerDay * 31 * 3) {
      repaymentFrequency = "QUARTERLY";
    } else if (approximateSecondsPerPeriod <= secondsPerDay * 31 * 6) {
      repaymentFrequency = "HALFLY";
    } else {
      repaymentFrequency = "ANNUALLY";
    }
  }

  return new SchedulingResult(
    repayments.map<string>((repayment) => repayment.id),
    termInSeconds,
    repaymentFrequency
  );
}

/**
 * Deletes all of the ScheduledRepayment entities attached to a callable loan
 */
export function deleteCallableLoanRepaymentSchedule(
  callableLoan: CallableLoan
): void {
  const repaymentIds = callableLoan.repaymentSchedule;
  for (let i = 0; i < repaymentIds.length; i++) {
    store.remove("ScheduledRepayment", repaymentIds[i]);
  }
  callableLoan.repaymentSchedule = [];
}

// TODO this function exists for tranched pools too. Try to consolidate them?
export function updatePoolTokensRedeemable(callableLoan: CallableLoan): void {
  const callableLoanContract = CallableLoanContract.bind(
    Address.fromBytes(callableLoan.address)
  );
  const poolTokenIds = callableLoan.tokens;
  for (let i = 0; i < poolTokenIds.length; i++) {
    const poolToken = assert(PoolToken.load(poolTokenIds[i]));
    const availableToWithdrawResult =
      callableLoanContract.try_availableToWithdraw(
        BigInt.fromString(poolToken.id)
      );
    if (!availableToWithdrawResult.reverted) {
      poolToken.interestRedeemable = availableToWithdrawResult.value.value0;
    } else {
      log.warning(
        "availableToWithdraw reverted for pool token {} on CallableLoan {}",
        [poolToken.id, callableLoan.id]
      );
    }
    poolToken.save();
  }
}
