// Forrás: pons-sdk 0.1.4 (npm) ABI-k; címek keresztellenőrizve: docs.ponsfamily.com/v2#contracts (keresőkivonat), Bitquery Robinhood/PONS doksi, ponscli.
export const ponsFactoryAbi = [
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   }
  ],
  "name": "getLaunchedToken",
  "outputs": [
   {
    "components": [
     {
      "internalType": "address",
      "name": "token",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "curve",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "deployer",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "creatorFeeRecipient",
      "type": "address"
     },
     {
      "internalType": "address",
      "name": "pairToken",
      "type": "address"
     },
     {
      "internalType": "uint256",
      "name": "graduationThreshold",
      "type": "uint256"
     },
     {
      "internalType": "uint24",
      "name": "poolFee",
      "type": "uint24"
     },
     {
      "internalType": "int24",
      "name": "tickSpacing",
      "type": "int24"
     },
     {
      "internalType": "uint16",
      "name": "creatorTaxBps",
      "type": "uint16"
     },
     {
      "internalType": "bool",
      "name": "buybackEnabled",
      "type": "bool"
     },
     {
      "internalType": "uint8",
      "name": "phase",
      "type": "uint8"
     },
     {
      "internalType": "uint256",
      "name": "sweptQuote",
      "type": "uint256"
     },
     {
      "internalType": "uint256",
      "name": "sweptTokens",
      "type": "uint256"
     },
     {
      "internalType": "uint256",
      "name": "sweptAt",
      "type": "uint256"
     },
     {
      "internalType": "bool",
      "name": "exists",
      "type": "bool"
     }
    ],
    "internalType": "struct PonsV2LaunchFactory.TokenLaunchRecord",
    "name": "",
    "type": "tuple"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "curve",
    "type": "address"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "deployer",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "address",
    "name": "pairToken",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "launchConfigId",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "graduationThreshold",
    "type": "uint256"
   }
  ],
  "name": "TokenLaunched",
  "type": "event"
 }
] as const;
export const ponsCurveAbi = [
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "quoteIn",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minTokensOut",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "recipient",
    "type": "address"
   }
  ],
  "name": "buy",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "tokensOut",
    "type": "uint256"
   }
  ],
  "stateMutability": "payable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "tokensIn",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minQuoteOut",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "recipient",
    "type": "address"
   }
  ],
  "name": "sell",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "quoteOut",
    "type": "uint256"
   }
  ],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "quoteReserve",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "tokenReserve",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "reservedTokens",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "feeBps",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "creatorTaxBps",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "wallet",
    "type": "address"
   }
  ],
  "name": "currentSnipeTaxBps",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "isNativeQuote",
  "outputs": [
   {
    "internalType": "bool",
    "name": "",
    "type": "bool"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [],
  "name": "graduated",
  "outputs": [
   {
    "internalType": "bool",
    "name": "",
    "type": "bool"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "buyer",
    "type": "address"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "recipient",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "quoteIn",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "tokensOut",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "fee",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "tax",
    "type": "uint256"
   }
  ],
  "name": "CurveBuy",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "address",
    "name": "seller",
    "type": "address"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "recipient",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "tokensIn",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "quoteOut",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "fee",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "tax",
    "type": "uint256"
   }
  ],
  "name": "CurveSell",
  "type": "event"
 }
] as const;
export const ponsHookAbi = [
 {
  "inputs": [
   {
    "internalType": "bytes32",
    "name": "poolId",
    "type": "bytes32"
   }
  ],
  "name": "launches",
  "outputs": [
   {
    "internalType": "bool",
    "name": "registered",
    "type": "bool"
   },
   {
    "internalType": "bool",
    "name": "memecoinIsCurrency0",
    "type": "bool"
   },
   {
    "internalType": "address",
    "name": "memecoin",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "quoteToken",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "creator",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "buybackCreatorRecipient",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "protocolFeeRecipient",
    "type": "address"
   },
   {
    "internalType": "uint16",
    "name": "creatorTaxBps",
    "type": "uint16"
   },
   {
    "internalType": "uint16",
    "name": "protocolFeeShareBps",
    "type": "uint16"
   },
   {
    "internalType": "uint16",
    "name": "buybackBurnBps",
    "type": "uint16"
   },
   {
    "internalType": "uint16",
    "name": "hookFeeBps",
    "type": "uint16"
   },
   {
    "internalType": "uint16",
    "name": "maxInternalPriceImpactBps",
    "type": "uint16"
   },
   {
    "internalType": "bool",
    "name": "buybackEnabled",
    "type": "bool"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": true,
    "internalType": "PoolId",
    "name": "id",
    "type": "bytes32"
   },
   {
    "indexed": true,
    "internalType": "address",
    "name": "sender",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "int128",
    "name": "amount0",
    "type": "int128"
   },
   {
    "indexed": false,
    "internalType": "int128",
    "name": "amount1",
    "type": "int128"
   },
   {
    "indexed": false,
    "internalType": "uint160",
    "name": "sqrtPriceX96",
    "type": "uint160"
   },
   {
    "indexed": false,
    "internalType": "uint128",
    "name": "liquidity",
    "type": "uint128"
   },
   {
    "indexed": false,
    "internalType": "int24",
    "name": "tick",
    "type": "int24"
   },
   {
    "indexed": false,
    "internalType": "uint24",
    "name": "fee",
    "type": "uint24"
   }
  ],
  "name": "Swap",
  "type": "event"
 }
] as const;
