// Forrás: clanker-sdk 4.2.19 (npm, hivatalos clanker-devco), Clanker_v4_abi – TokenCreated esemény.
export const clankerV4TokenCreatedEvent = {
 "anonymous": false,
 "inputs": [
  {
   "indexed": false,
   "internalType": "address",
   "name": "msgSender",
   "type": "address"
  },
  {
   "indexed": true,
   "internalType": "address",
   "name": "tokenAddress",
   "type": "address"
  },
  {
   "indexed": true,
   "internalType": "address",
   "name": "tokenAdmin",
   "type": "address"
  },
  {
   "indexed": false,
   "internalType": "string",
   "name": "tokenImage",
   "type": "string"
  },
  {
   "indexed": false,
   "internalType": "string",
   "name": "tokenName",
   "type": "string"
  },
  {
   "indexed": false,
   "internalType": "string",
   "name": "tokenSymbol",
   "type": "string"
  },
  {
   "indexed": false,
   "internalType": "string",
   "name": "tokenMetadata",
   "type": "string"
  },
  {
   "indexed": false,
   "internalType": "string",
   "name": "tokenContext",
   "type": "string"
  },
  {
   "indexed": false,
   "internalType": "int24",
   "name": "startingTick",
   "type": "int24"
  },
  {
   "indexed": false,
   "internalType": "address",
   "name": "poolHook",
   "type": "address"
  },
  {
   "indexed": false,
   "internalType": "PoolId",
   "name": "poolId",
   "type": "bytes32"
  },
  {
   "indexed": false,
   "internalType": "address",
   "name": "pairedToken",
   "type": "address"
  },
  {
   "indexed": false,
   "internalType": "address",
   "name": "locker",
   "type": "address"
  },
  {
   "indexed": false,
   "internalType": "address",
   "name": "mevModule",
   "type": "address"
  },
  {
   "indexed": false,
   "internalType": "uint256",
   "name": "extensionsSupply",
   "type": "uint256"
  },
  {
   "indexed": false,
   "internalType": "address[]",
   "name": "extensions",
   "type": "address[]"
  }
 ],
 "name": "TokenCreated",
 "type": "event"
} as const;
