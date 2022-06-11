import {
  Address,
  dataSource,
  log,
  BigDecimal,
  BigInt,
} from "@graphprotocol/graph-ts";
import {
  AVALANCHE_BLOCKS_PER_YEAR,
  ETHEREUM_BLOCKS_PER_YEAR,
  BSC_BLOCKS_PER_YEAR,
  ARBITRUM_BLOCKS_PER_YEAR,
  FANTOM_BLOCKS_PER_YEAR,
  Network,
} from "../../src/constants";

const ETHEREUM_BLOCKS_PER_DAY = ETHEREUM_BLOCKS_PER_YEAR / 365;
const BSC_BLOCKS_PER_DAY = BSC_BLOCKS_PER_YEAR / 365;
const ARBITRUM_BLOCKS_PER_DAY = ARBITRUM_BLOCKS_PER_YEAR / 365;

export class NetworkSpecificConstant {
  comptrollerAddr: Address;
  network: string;
  unitPerDay: i32;
  unitPerYear: i32;
  constructor(
    comptrollerAddr: Address,
    network: string,
    unitPerDay: i32,
    unitPerYear: i32
  ) {
    this.comptrollerAddr = comptrollerAddr;
    this.network = network;
    this.unitPerDay = unitPerDay;
    this.unitPerYear = unitPerYear;
  }
}

export function getNetworkSpecificConstant(): NetworkSpecificConstant {
  let network = dataSource.network();
  if (equalsIgnoreCase(network, Network.MAINNET)) {
    return new NetworkSpecificConstant(
      Address.fromString("0x8B53Ab2c0Df3230EA327017C91Eb909f815Ad113"),
      Network.MAINNET,
      ETHEREUM_BLOCKS_PER_DAY,
      ETHEREUM_BLOCKS_PER_YEAR
    );
  } else if (equalsIgnoreCase(network, Network.BSC)) {
    return new NetworkSpecificConstant(
      Address.fromString("0x0b53E608bD058Bb54748C35148484fD627E6dc0A"),
      Network.BSC,
      BSC_BLOCKS_PER_DAY,
      BSC_BLOCKS_PER_YEAR
    );
  } else if (equalsIgnoreCase(network, Network.ARBITRUM_ONE)) {
    return new NetworkSpecificConstant(
      Address.fromString("0x8E7e9eA9023B81457Ae7E6D2a51b003D421E5408"),
      Network.ARBITRUM_ONE,
      ARBITRUM_BLOCKS_PER_DAY,
      ARBITRUM_BLOCKS_PER_YEAR
    );
  } /* else if (equalsIgnoreCase(network, Network.OPTIMISM)) {
    return new NetworkSpecificConstant(
      Address.fromString("0xA300A84D8970718Dac32f54F61Bd568142d8BCF4"),
      Network.OPTIMISM,
      OPTIMISM_BLOCKS_PER_DAY,
      OPTIMISM_BLOCKS_PER_YEAR
    );
  }*/ else {
    log.error("[getNetworkSpecificConstant] Unsupported network {}", [network]);
    return new NetworkSpecificConstant(
      Address.fromString("0x0000000000000000000000000000000000000000"),
      "",
      0,
      0
    );
  }
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() == b.toLowerCase();
}

// whether any element of the input array is true
export function anyTrue(inputArray: bool[]): bool {
  return inputArray.some((element) => element == true);
}

// Converts snake case to kebab case and appends a hyphen.
// (e.g. "TRADING_FEE" to "trading-fee-"), mainly used to create entity IDs
export function enumToPrefix(snake: string): string {
  return snake.replace("_", "-") + "-";
}

// Prefix an ID with a enum string in order to differentiate IDs
// e.g. combine XPOOL, TRADING_FEE and 0x1234 into xpool-trading-fee-0x1234
export function prefixID(
  ID: string,
  enumString1: string,
  enumString2: string | null = null
): string {
  let prefix = enumToPrefix(enumString1);
  if (enumString2 != null) {
    prefix += enumToPrefix(enumString2!);
  }
  return prefix + ID;
}

//convert BigDecimal to BigInt by truncating the decimal places
export function BigDecimalTruncateToBigInt(x: BigDecimal): BigInt {
  //let intStr = x.toString().split(".")[0];
  let intStr = x.truncate(0).toString();
  return BigInt.fromString(intStr);
}

export const iETH_ADDRESS = "0x5ACD75f21659a59fFaB9AEBAf350351a8bfaAbc0";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const PRICE_BASE = 18;
export const DISTRIBUTIONFACTOR_BASE = 18;
