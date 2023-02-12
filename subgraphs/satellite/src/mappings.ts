import {
  BigDecimal,
  BigInt,
  Address,
  ethereum,
  Bytes,
  log,
} from "@graphprotocol/graph-ts";
import {
  TokenSent,
  AxelarGateway as AxelarGatewayContract,
  TokenDeployed,
  ContractCallWithToken,
  ContractCall,
  ContractCallApprovedWithMint,
  ContractCallApproved,
  MintTokenCall,
  BurnTokenCall,
  DeployTokenCall,
} from "../generated/AxelarGateway/AxelarGateway";
import { BurnableMintableCappedERC20 as TokenContract } from "../generated/AxelarGateway/BurnableMintableCappedERC20";
import { BurnableMintableCappedERC20 as ERC20Template } from "../generated/templates";
import { Transfer } from "../generated/templates/BurnableMintableCappedERC20/BurnableMintableCappedERC20";
import { CustomEventType, SDK } from "./sdk/protocols/bridge";
import { TokenPricer } from "./sdk/protocols/config";
import { TokenInitializer, TokenParams } from "./sdk/protocols/bridge/tokens";
import {
  BridgePermissionType,
  BridgePoolType,
  CrosschainTokenType,
} from "./sdk/protocols/bridge/enums";
import { BridgeConfig } from "./sdk/protocols/bridge/config";
import { _ERC20 } from "../generated/AxelarGateway/_ERC20";
import { ERC20NameBytes } from "../generated/AxelarGateway/ERC20NameBytes";
import { ERC20SymbolBytes } from "../generated/AxelarGateway/ERC20SymbolBytes";
import { Versions } from "./versions";
import { Token, _Refund, _TokenSymbol } from "../generated/schema";
import { bigIntToBigDecimal } from "./sdk/util/numbers";
import { getUsdPricePerToken, getUsdPrice } from "./prices";
import { networkToChainID } from "./sdk/protocols/bridge/chainIds";
import {
  BIGINT_ZERO,
  getNetworkSpecificConstant,
  Network,
  TokenType,
} from "./sdk/util/constants";

// empty handler for prices library
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
export function handlePairCreated(event: ethereum.Event): void {}

// Implement TokenPricer to pass it to the SDK constructor
class Pricer implements TokenPricer {
  getTokenPrice(token: Token): BigDecimal {
    const price = getUsdPricePerToken(Address.fromBytes(token.id));
    return price.usdPrice;
  }

  getAmountValueUSD(token: Token, amount: BigInt): BigDecimal {
    const _amount = bigIntToBigDecimal(amount, token.decimals);
    return getUsdPrice(Address.fromBytes(token.id), _amount);
  }
}

// Implement TokenInitializer
class TokenInit implements TokenInitializer {
  getTokenParams(address: Address): TokenParams {
    const erc20 = _ERC20.bind(address);
    const decimals = erc20.decimals().toI32();

    let name = "Unknown Token";
    const nameResult = erc20.try_name();
    if (!nameResult.reverted) {
      name = nameResult.value;
    } else {
      const erc20name = ERC20NameBytes.bind(address);
      const nameResult = erc20name.try_name();
      if (!nameResult.reverted) {
        name = nameResult.value.toString();
      } else {
        log.warning("[getTokenParams]Fail to get name for token {}", [
          address.toHexString(),
        ]);
      }
    }

    let symbol = "Unknown";
    const symbolResult = erc20.try_symbol();
    if (!symbolResult.reverted) {
      symbol = symbolResult.value;
    } else {
      const erc20symbol = ERC20SymbolBytes.bind(address);
      const symbolResult = erc20symbol.try_symbol();
      if (!symbolResult.reverted) {
        symbol = symbolResult.value.toString();
      } else {
        log.warning("[getTokenParams]Fail to get symbol for token {}", [
          address.toHexString(),
        ]);
      }
    }

    return {
      name,
      symbol,
      decimals,
    };
  }
}

function _getSDK(
  event: ethereum.Event | null = null,
  call: ethereum.Call | null = null
): SDK | null {
  let customEvent: CustomEventType;
  if (event) {
    customEvent = CustomEventType.initialize(
      event.block,
      event.transaction,
      event.transactionLogIndex,
      event
    );
  } else if (call) {
    customEvent = CustomEventType.initialize(
      call.block,
      call.transaction,
      call.transaction.index
    );
  } else {
    log.error("[_getSDK]either event or call needs to be specified", []);
    return null;
  }

  const protocolId = getNetworkSpecificConstant()
    //.getProtocolId() //TODO necessary?
    .getPoolAddress()
    .toHexString();
  const conf = new BridgeConfig(
    protocolId,
    "Axelar Satellite",
    "satellite",
    BridgePermissionType.PERMISSIONLESS,
    Versions
  );
  return new SDK(conf, new Pricer(), new TokenInit(), customEvent);
}

export function handleDeployToken(call: DeployTokenCall): void {
  const decimals = bytesToUnsignedBigInt(
    Bytes.fromUint8Array(call.inputs.params.subarray(64, 96))
  );
  const cap = bytesToUnsignedBigInt(
    Bytes.fromUint8Array(call.inputs.params.subarray(96, 128))
  );
  const tokenAddress = bytes32ToAddress(
    Bytes.fromUint8Array(call.inputs.params.subarray(128, 160))
  );
  const mintLimit = bytesToUnsignedBigInt(
    Bytes.fromUint8Array(call.inputs.params.subarray(160, 192))
  );
  const name = Bytes.fromUint8Array(
    call.inputs.params.subarray(192, 224)
  ).toString();
  const symbol = Bytes.fromUint8Array(
    call.inputs.params.subarray(256, 288)
  ).toString();

  log.info(
    "[handleMintToken]decode call.inputs.params {}: name={}, symbol={}, decimals={}, cap={}, tokenAddress={}, mintLimit={}",
    [
      call.inputs.params.toHexString(),
      name,
      symbol,
      decimals.toString(),
      cap.toString(),
      tokenAddress.toHexString(),
      mintLimit.toString(),
    ]
  );
  // derived tokenType from tokenAddress param
  let tokenType: string;
  if (tokenAddress != Address.zero()) {
    tokenType = TokenType.EXTERNAL;
  } else {
    tokenType = TokenType.INTERNAL_BURNABLEFROM;

    //TokenType.InternalBurnable is never assigned
  }

  getOrCreateTokenSymbol(symbol, null, tokenType);
}

export function handleTokenDeployed(event: TokenDeployed): void {
  const tokenSymbol = getOrCreateTokenSymbol(event.params.symbol);
  // it may be possible to calculate tokenAddress, but the logic is complicated
  // get it from the TokenDeployed event
  tokenSymbol.tokenAddress = event.params.tokenAddresses.toHexString();
  tokenSymbol.save();

  ERC20Template.create(event.params.tokenAddresses);
}

export function handleTokenSent(event: TokenSent): void {
  // the token should have already been deployed
  const tokenSymbol = getOrCreateTokenSymbol(event.params.symbol);
  const tokenAddress = tokenSymbol.tokenAddress!;
  const poolId = event.address.concat(Address.fromString(tokenAddress));
  const dstChainId = BigInt.fromString(event.params.destinationChain);
  const dstNetworkConstants = getNetworkSpecificConstant(dstChainId);
  const dstPoolId = dstNetworkConstants.getPoolAddress();
  _handleTransferOut(
    Address.fromString(tokenAddress),
    event.params.sender,
    Address.fromString(event.params.destinationAddress),
    event.params.amount,
    dstChainId,
    poolId,
    dstPoolId,
    BridgePoolType.BURN_MINT,
    CrosschainTokenType.WRAPPED,
    event,
    null
  );
}

export function handleContractCallWithToken(
  event: ContractCallWithToken
): void {
  const tokenSymbol = getOrCreateTokenSymbol(event.params.symbol);
  const tokenAddress = tokenSymbol.tokenAddress!;
  const poolId = event.address.concat(Address.fromString(tokenAddress));
  const dstChainId = BigInt.fromString(event.params.destinationChain);
  const dstNetworkConstants = getNetworkSpecificConstant(dstChainId);
  const dstPoolId = dstNetworkConstants.getPoolAddress();
  const dstAccount = Address.fromString(
    event.params.destinationContractAddress
  );
  _handleTransferOut(
    Address.fromString(tokenAddress),
    event.params.sender,
    dstAccount,
    event.params.amount,
    dstChainId,
    poolId,
    dstPoolId,
    BridgePoolType.BURN_MINT,
    CrosschainTokenType.WRAPPED,
    event,
    null
  );

  // contract call
  const sdk = _getSDK(event)!;
  const acc = sdk.Accounts.loadAccount(event.params.sender);
  acc.messageOut(dstChainId, dstAccount, event.params.payload);
}

export function handleContractCall(event: ContractCall): void {
  // contract call
  const dstChainId = BigInt.fromString(event.params.destinationChain);
  const dstAccount = Address.fromString(
    event.params.destinationContractAddress
  );

  const sdk = _getSDK(event)!;
  const acc = sdk.Accounts.loadAccount(event.params.sender);
  acc.messageOut(dstChainId, dstAccount, event.params.payload);
}

export function handleTokenTransfer(event: Transfer): void {}

export function handleContractCallApproved(event: ContractCallApproved): void {
  // contract call
  const srcChainId = BigInt.fromString(event.params.sourceChain);
  const srcAccount = Address.fromString(event.params.sourceAddress);

  const sdk = _getSDK(event)!;
  const acc = sdk.Accounts.loadAccount(event.params.contractAddress);
  acc.messageIn(srcChainId, srcAccount, event.params.payloadHash);
}

export function handleContractCallApprovedWithMint(
  event: ContractCallApprovedWithMint
): void {
  // contract call
  const srcChainId = BigInt.fromString(event.params.sourceChain);
  const srcAccount = Address.fromString(event.params.sourceAddress);

  const sdk = _getSDK(event)!;
  const acc = sdk.Accounts.loadAccount(event.params.contractAddress);
  acc.messageIn(srcChainId, srcAccount, event.params.payloadHash);

  const tokenSymbol = getOrCreateTokenSymbol(event.params.symbol);
  const tokenAddress = tokenSymbol.tokenAddress!;
  const poolId = event.address.concat(Address.fromString(tokenAddress));
  const srcNetworkConstants = getNetworkSpecificConstant(srcChainId);
  const srcPoolId = srcNetworkConstants.getPoolAddress();

  _handleTransferIn(
    Address.fromString(tokenAddress),
    Address.fromString(event.params.sourceAddress),
    event.params.contractAddress,
    event.params.amount,
    srcChainId,
    srcPoolId,
    poolId,
    BridgePoolType.BURN_MINT,
    CrosschainTokenType.WRAPPED,
    event.params.commandId,
    event.transaction.hash.concatI32(event.transactionLogIndex.toI32()),
    event,
    null
  );
}

export function handleMintToken(call: MintTokenCall): void {
  // decode symbol, account, amount
  const account = bytes32ToAddress(
    Bytes.fromUint8Array(call.inputs.params.subarray(32, 64))
  );
  const amount = bytesToUnsignedBigInt(
    Bytes.fromUint8Array(call.inputs.params.subarray(64, 96))
  );
  const symbol = Bytes.fromUint8Array(
    call.inputs.params.subarray(128, 160)
  ).toString();

  log.info(
    "[handleMintToken]decode call.inputs.params {}: symbol={}, account={}, amount={}",
    [
      call.inputs.params.toHexString(),
      symbol,
      account.toHexString(),
      amount.toString(),
    ]
  );

  const tokenSymbol = getOrCreateTokenSymbol(symbol);
  const tokenAddress = tokenSymbol.tokenAddress!;
  //const tokenType = tokenSymbol.tokenType!;
  const receiver = account;
  const poolId = call.to;
  const srcChainId = networkToChainID(Network.UNKNOWN_NETWORK);
  const srcPoolId = Address.zero(); // Not available
  const srcAccount = account; //Not available, assumed to be the same as receiver
  _handleTransferIn(
    Address.fromString(tokenAddress),
    srcAccount,
    receiver,
    amount,
    srcChainId,
    srcPoolId,
    poolId,
    BridgePoolType.BURN_MINT,
    CrosschainTokenType.WRAPPED,
    call.inputs.value1, //commandId
    call.transaction.hash.concatI32(call.transaction.index.toI32()),
    null,
    call
  );
}

export function handleBurnToken(call: BurnTokenCall): void {
  log.info("[handleBurnToken]call.inputs.params {}", [
    call.inputs.params.toHexString(),
  ]);

  // decode salt, symbol
  const salt = Bytes.fromUint8Array(call.inputs.params.subarray(32, 64));
  const symbol = Bytes.fromUint8Array(
    call.inputs.params.subarray(96, 128)
  ).toString();

  // (symbol, salt)
  //const params = ethereum.decode("string,bytes32", call.inputs.params)!;

  log.info("[handleBurnToken]decoded: symbol={} salt={}", [
    symbol,
    salt.toHexString(),
  ]);

  /* //TODO: needed?

  const tokenSymbol = getOrCreateTokenSymbol(symbol)!;
  const tokenAddress = tokenSymbol.tokenAddress;
  const tokenContract = TokenContract.bind(Address.fromString(tokenAddress));
  const depositAddressResult = tokenContract.try_depositAddress(salt);
  if (depositAddressResult.reverted) {
    // TODO this  an external token
    log.error(
      "[handleBurnToken]Unable to get depositAddress for token {} at tx {}",
      [tokenAddress, call.transaction.hash.toHexString()]
    );
    return;
  }
  //balanceOf
  const amount = BIGINT_ZERO;

  //this actually is the depositHandler contract address
  const sender = depositAddressResult.value;
  const poolId = call.to;
  const dstChainId = networkToChainID(Network.UNKNOWN_NETWORK);
  const dstPoolId = Address.zero(); // Not available
  const dstAccount = sender; //Not available, assumed to be the same as sender
  _handleTransferOut(
    Address.fromString(tokenAddress),
    sender,
    sender,
    amount,
    dstChainId,
    dstPoolId,
    poolId,
    BridgePoolType.BURN_MINT,
    CrosschainTokenType.WRAPPED,
    null,
    call,
    call.inputs.value1
  );
  */
}

//////////////////////////////// HELPER FUNCTIONS //////////////////////////////
/**
 * get or create an TokenSymbol entity; if the entry is new, either `tokenAddress`
 * or `contractAddress` param needs to be provided
 *
 * @param symbol token symbol
 * @param tokenAddress token address
 * @param contractAddress address of AxelarGatewayMultiSig contract
 *
 */
function getOrCreateTokenSymbol(
  symbol: string,
  tokenAddress: string | null = null,
  tokenType: string | null = null
): _TokenSymbol {
  let tokenSymbol = _TokenSymbol.load(symbol);
  if (!tokenSymbol) {
    tokenSymbol = new _TokenSymbol(symbol);
    tokenSymbol.tokenAddress = tokenAddress;
    tokenSymbol.tokenType = tokenType;
    tokenSymbol.save();
  }
  return tokenSymbol;
}

function _handleTransferOut(
  token: Address,
  sender: Address,
  receiver: Address,
  amount: BigInt,
  dstChainId: BigInt,
  poolId: Bytes,
  dstPoolId: Address,
  bridgePoolType: BridgePoolType,
  crosschainTokenType: CrosschainTokenType,
  event: ethereum.Event | null,
  call: ethereum.Call | null,
  refId: Bytes | null = null
): void {
  const sdk = _getSDK(event)!;
  const inputToken = sdk.Tokens.getOrCreateToken(token);

  const pool = sdk.Pools.loadPool(
    poolId,
    null,
    bridgePoolType,
    inputToken.id.toHexString()
  );
  const crossToken = sdk.Tokens.getOrCreateCrosschainToken(
    dstChainId,
    dstPoolId,
    crosschainTokenType,
    token
  );
  pool.addDestinationToken(crossToken);
  const txHash = event ? event.transaction.hash : call!.transaction.hash;
  const acc = sdk.Accounts.loadAccount(sender);
  const transfer = acc.transferOut(
    pool,
    pool.getDestinationTokenRoute(crossToken)!,
    receiver,
    amount,
    txHash
  );

  if (refId) {
    transfer._refId = refId;
    transfer.save();
  }
}

function _handleTransferIn(
  token: Address,
  sender: Address,
  receiver: Address,
  amount: BigInt,
  srcChainId: BigInt,
  srcPoolId: Address,
  poolId: Bytes,
  bridgePoolType: BridgePoolType,
  crosschainTokenType: CrosschainTokenType,
  refId: Bytes | null = null,
  transactionID: Bytes | null = null,
  event: ethereum.Event | null = null,
  call: ethereum.Call | null = null
): void {
  const sdk = _getSDK(event, call)!;

  const pool = sdk.Pools.loadPool(
    poolId,
    null,
    bridgePoolType,
    token.toHexString()
  );
  const crossToken = sdk.Tokens.getOrCreateCrosschainToken(
    srcChainId,
    srcPoolId,
    crosschainTokenType,
    token
  );
  pool.addDestinationToken(crossToken);

  const acc = sdk.Accounts.loadAccount(receiver);
  const transfer = acc.transferIn(
    pool,
    pool.getDestinationTokenRoute(crossToken)!,
    sender,
    amount,
    transactionID
  );

  if (refId) {
    transfer._refId = refId;
    transfer.save();
  }
}

function _handleMessageOut(
  dstChainId: BigInt,
  sender: Address,
  receiver: Address,
  data: Bytes,
  fee: BigInt,
  event: ethereum.Event | null = null,
  call: ethereum.Call | null = null
): void {
  const sdk = _getSDK(event, call)!;
  const acc = sdk.Accounts.loadAccount(sender);
  acc.messageOut(dstChainId, receiver, data);
}

function _handleMessageIn(
  srcChainId: BigInt,
  sender: Address,
  receiver: Address,
  data: Bytes,
  event: ethereum.Event | null = null,
  call: ethereum.Call | null = null
): void {
  // see doc in _handleMessageOut
  const sdk = _getSDK(event, call)!;
  const acc = sdk.Accounts.loadAccount(receiver);
  acc.messageIn(srcChainId, sender, data);
}

export function bytesToUnsignedBigInt(
  bytes: Bytes,
  bigEndian: boolean = true
): BigInt {
  // Caution: this function changes the input bytes for bigEndian
  return BigInt.fromUnsignedBytes(
    bigEndian ? Bytes.fromUint8Array(bytes.reverse()) : bytes
  );
}

export function bytes32ToAddress(bytes: Bytes): Address {
  //take the last 40 hexstring & convert it to address (20 bytes)
  const address = bytes32ToAddressHexString(bytes);
  return Address.fromString(address);
}

export function bytes32ToAddressHexString(bytes: Bytes): string {
  //take the last 40 hexstring: 0x + 32 bytes/64 hex characters
  return `0x${bytes.toHexString().slice(26).toLowerCase()}`;
}
