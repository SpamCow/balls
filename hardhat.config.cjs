// Only used as a local EVM for tests (contracts are compiled by scripts/compile.mjs).
module.exports = { networks: { hardhat: { chainId: 31337, hardfork: "cancun" } } };
