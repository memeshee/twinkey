// The TwinKeyProbe contract that is deployed on the Portaldot V3 testnet at
// 0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725. Kept as a literal `as const` so viem can
// infer argument and return types without a codegen step.
export const TWINKEY_PROBE_ABI = [
  {
    type: "event",
    name: "ValueSet",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: true },
      { name: "callCount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ValueAdded",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "newValue", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "setValue",
    inputs: [{ name: "v", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "addValue",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "read",
    inputs: [],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
      { name: "", type: "uint256" },
    ],
    stateMutability: "view",
  },
  { type: "function", name: "value", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "lastCaller", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "callCount", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

/** Deployed instance used by the demo. Real, on PortaldotV3 Test. */
export const TWINKEY_PROBE_ADDRESS = "0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725" as const;

/** ValueSet(address indexed caller, uint256 indexed value, uint256 callCount) */
export const VALUE_SET_TOPIC0 =
  "0xc0e9036d619701c94569e1462d8120ef4a6d2b15a70d27cc942fd29ae2cc0e59" as const;
