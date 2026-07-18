// signatures.js — known 4-byte selector -> human signature, plus interface fingerprints.
// Curated, offline-first. No network needed for the common cases. The optional
// 4byte.directory lookup in inspect.js fills gaps for unknown selectors.

export const KNOWN = {
  // ERC-20
  "0x06fdde03": "name()",
  "0x95d89b41": "symbol()",
  "0x313ce567": "decimals()",
  "0x18160ddd": "totalSupply()",
  "0x70a08231": "balanceOf(address)",
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0xdd62ed3e": "allowance(address,address)",
  // ERC-20 extensions
  "0x40c10f19": "mint(address,uint256)",
  "0x42966c68": "burn(uint256)",
  "0x79cc6790": "burnFrom(address,uint256)",
  "0xd505accf": "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  // Ownable / access control
  "0x8da5cb5b": "owner()",
  "0xf2fde38b": "transferOwnership(address)",
  "0x715018a6": "renounceOwnership()",
  "0x91d14854": "hasRole(bytes32,address)",
  "0x2f2ff15d": "grantRole(bytes32,address)",
  "0xd547741f": "revokeRole(bytes32,address)",
  "0xa217fddf": "DEFAULT_ADMIN_ROLE()",
  // Pausable
  "0x8456cb59": "pause()",
  "0x3f4ba83a": "unpause()",
  "0x5c975abb": "paused()",
  // Proxy / upgradeable (EIP-1967 / UUPS / transparent)
  "0x5c60da1b": "implementation()",
  "0x3659cfe6": "upgradeTo(address)",
  "0x4f1ef286": "upgradeToAndCall(address,bytes)",
  "0xf851a440": "admin()",
  "0x8f283970": "changeAdmin(address)",
  "0x52d1902d": "proxiableUUID()",
  // ERC-165
  "0x01ffc9a7": "supportsInterface(bytes4)",
  // ERC-721
  "0x6352211e": "ownerOf(uint256)",
  "0x081812fc": "getApproved(uint256)",
  "0xa22cb465": "setApprovalForAll(address,bool)",
  "0xe985e9c5": "isApprovedForAll(address,address)",
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  "0xc87b56dd": "tokenURI(uint256)",
  // ERC-1155
  "0x00fdd58e": "balanceOf(address,uint256)",
  "0x4e1273f4": "balanceOfBatch(address[],uint256[])",
  "0xf242432a": "safeTransferFrom(address,address,uint256,uint256,bytes)",
  "0x2eb2c2d6": "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
  // Multicall
  "0xac9650d8": "multicall(bytes[])",
  "0x1f931c1c": "diamondCut((address,uint8,bytes4[])[],address,bytes)",
};

// ERC-165 interface IDs (XOR of selectors) for supportsInterface() probing.
export const INTERFACE_IDS = {
  "0x01ffc9a7": "ERC165",
  "0x80ac58cd": "ERC721",
  "0x5b5e139f": "ERC721Metadata",
  "0x780e9d63": "ERC721Enumerable",
  "0xd9b67a26": "ERC1155",
  "0x0e89341c": "ERC1155MetadataURI",
  "0x36372b07": "ERC20 (registry)",
};

// Selector sets that fingerprint a standard. Match = "this contract implements X".
export const FINGERPRINTS = [
  {
    name: "ERC-20",
    required: ["0x18160ddd", "0x70a08231", "0xa9059cbb", "0x23b872dd", "0x095ea7b3", "0xdd62ed3e"],
  },
  {
    name: "ERC-721",
    required: ["0x70a08231", "0x6352211e", "0x42842e0e", "0xa22cb465", "0xe985e9c5"],
  },
  {
    name: "ERC-1155",
    required: ["0x00fdd58e", "0x4e1273f4", "0xf242432a", "0x2eb2c2d6"],
  },
  {
    name: "Ownable",
    required: ["0x8da5cb5b", "0xf2fde38b"],
  },
  {
    name: "AccessControl",
    required: ["0x91d14854", "0x2f2ff15d", "0xd547741f"],
  },
  {
    name: "Pausable",
    required: ["0x5c975abb"],
  },
  {
    name: "UUPS/Upgradeable",
    required: ["0x52d1902d"],
    anyOf: ["0x3659cfe6", "0x4f1ef286"],
  },
  {
    name: "ERC-2612 Permit",
    required: ["0xd505accf"],
  },
];

// Functions that grant control or can move/destroy value/state. Flagged for review.
export const PRIVILEGED = {
  "0xf2fde38b": "ownership transfer",
  "0x715018a6": "ownership renounce",
  "0x2f2ff15d": "role grant",
  "0xd547741f": "role revoke",
  "0x40c10f19": "mint (supply inflation)",
  "0x8456cb59": "pause (can freeze transfers)",
  "0x3f4ba83a": "unpause",
  "0x3659cfe6": "upgradeTo (logic swap)",
  "0x4f1ef286": "upgradeToAndCall (logic swap)",
  "0x8f283970": "changeAdmin",
  "0xa22cb465": "setApprovalForAll",
};

// Admin/supply/upgrade/role selectors treated as privileged when found INSIDE an
// implementation contract (behind a proxy). Intentionally a subset of PRIVILEGED:
// excludes setApprovalForAll (normal ERC-721/1155 user op, not an admin power) and
// renounceOwnership (state change, but not an active control surface). Single source
// of truth so this set can't silently drift from risk scoring.
export const ADMIN_PRIVILEGED_SELECTORS = [
  "0x3659cfe6", // upgradeTo(address)
  "0x4f1ef286", // upgradeToAndCall(address,bytes)
  "0x40c10f19", // mint(address,uint256)
  "0x8456cb59", // pause()
  "0x3f4ba83a", // unpause()
  "0xf2fde38b", // transferOwnership(address)
  "0x8f283970", // changeAdmin(address)
  "0x2f2ff15d", // grantRole(bytes32,address)
  "0xd547741f", // revokeRole(bytes32,address)
];
