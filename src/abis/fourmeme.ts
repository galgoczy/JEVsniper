// Forrás: Four.Meme hivatalos integrációs dokumentáció – github.com/four-meme-community/fourmeme-docs
// (commit 5f7f589, 2026-08-18): abi/TokenManager2.lite.json, abi/TokenManagerHelper3.lite.json; címek: docs/integration-guide.md 2.1.
// Csak a használt elemek (események, olvasó és kereskedő függvények), változtatás nélkül.
export const fourMemeTokenManager2Abi = [
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "address",
    "name": "base",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "offers",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "address",
    "name": "quote",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   }
  ],
  "name": "LiquidityAdded",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "address",
    "name": "creator",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "requestId",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "name",
    "type": "string"
   },
   {
    "indexed": false,
    "internalType": "string",
    "name": "symbol",
    "type": "string"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "totalSupply",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "launchTime",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "launchFee",
    "type": "uint256"
   }
  ],
  "name": "TokenCreate",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "address",
    "name": "account",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "cost",
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
    "name": "offers",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   }
  ],
  "name": "TokenPurchase",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "address",
    "name": "account",
    "type": "address"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "price",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "cost",
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
    "name": "offers",
    "type": "uint256"
   },
   {
    "indexed": false,
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   }
  ],
  "name": "TokenSale",
  "type": "event"
 },
 {
  "anonymous": false,
  "inputs": [
   {
    "indexed": false,
    "internalType": "address",
    "name": "token",
    "type": "address"
   }
  ],
  "name": "TradeStop",
  "type": "event"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "",
    "type": "address"
   }
  ],
  "name": "_tokenInfoEx1s",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "launchFee",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "pcFee",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "feeSetting",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "blockNumber",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "extraFee",
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
    "name": "",
    "type": "address"
   }
  ],
  "name": "_tokenInfos",
  "outputs": [
   {
    "internalType": "address",
    "name": "base",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "quote",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "template",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "totalSupply",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "maxOffers",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "maxRaising",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "launchTime",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "offers",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "lastPrice",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "K",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "T",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "status",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "origin",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "to",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minAmount",
    "type": "uint256"
   }
  ],
  "name": "buyTokenAMAP",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "to",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minAmount",
    "type": "uint256"
   }
  ],
  "name": "buyTokenAMAP",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minAmount",
    "type": "uint256"
   }
  ],
  "name": "buyTokenAMAP",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "origin",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minAmount",
    "type": "uint256"
   }
  ],
  "name": "buyTokenAMAP",
  "outputs": [],
  "stateMutability": "payable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "origin",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minFunds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "feeRate",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "feeRecipient",
    "type": "address"
   }
  ],
  "name": "sellToken",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "origin",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minFunds",
    "type": "uint256"
   }
  ],
  "name": "sellToken",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "origin",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "sellToken",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minFunds",
    "type": "uint256"
   }
  ],
  "name": "sellToken",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "origin",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "from",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "to",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minFunds",
    "type": "uint256"
   }
  ],
  "name": "sellToken",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "uint256",
    "name": "origin",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "from",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minFunds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "feeRate",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "feeRecipient",
    "type": "address"
   }
  ],
  "name": "sellToken",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "sellToken",
  "outputs": [],
  "stateMutability": "nonpayable",
  "type": "function"
 }
] as const;

export const fourMemeHelper3Abi = [
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   }
  ],
  "name": "getTokenInfo",
  "outputs": [
   {
    "internalType": "uint256",
    "name": "version",
    "type": "uint256"
   },
   {
    "internalType": "address",
    "name": "tokenManager",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "quote",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "lastPrice",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "tradingFeeRate",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "minTradingFee",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "launchTime",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "offers",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "maxOffers",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "maxFunds",
    "type": "uint256"
   },
   {
    "internalType": "bool",
    "name": "liquidityAdded",
    "type": "bool"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 },
 {
  "inputs": [
   {
    "internalType": "address",
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   }
  ],
  "name": "tryBuy",
  "outputs": [
   {
    "internalType": "address",
    "name": "tokenManager",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "quote",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "estimatedAmount",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "estimatedCost",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "estimatedFee",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "amountMsgValue",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "amountApproval",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "amountFunds",
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
    "name": "token",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "amount",
    "type": "uint256"
   }
  ],
  "name": "trySell",
  "outputs": [
   {
    "internalType": "address",
    "name": "tokenManager",
    "type": "address"
   },
   {
    "internalType": "address",
    "name": "quote",
    "type": "address"
   },
   {
    "internalType": "uint256",
    "name": "funds",
    "type": "uint256"
   },
   {
    "internalType": "uint256",
    "name": "fee",
    "type": "uint256"
   }
  ],
  "stateMutability": "view",
  "type": "function"
 }
] as const;
