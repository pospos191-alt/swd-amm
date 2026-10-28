//go:build ignore

// ethsign signs an Ethereum transaction for devnet tests (test-vote-keys.sh
// step 9) and wraps it as a Cosmos tx (MsgEthereumTx), ready for CometBFT's
// broadcast_tx_sync. Run it from the patched cosmos/evm checkout:
//
//	cd <cosmos/evm>/evmd && go run <repo>/zetaphy-chain/tools/ethsign/main.go <key hex> <evm chain id> <nonce> <to|-> <data hex> <denom>
//
// Prints the Cosmos tx (0x hex) and, for a contract creation, the new
// contract's address. Testnet keys only: a throw-away devnet test key.
package main

import (
	"fmt"
	"math/big"
	"os"
	"strconv"

	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/cosmos/evm/encoding"
	evmtypes "github.com/cosmos/evm/x/vm/types"
)

func main() {
	if len(os.Args) != 7 {
		fmt.Fprintln(os.Stderr, "ethsign <key hex> <evm chain id> <nonce> <to|-> <data hex> <denom>")
		os.Exit(2)
	}
	key, err := crypto.HexToECDSA(os.Args[1])
	must(err)
	cid, err := strconv.ParseUint(os.Args[2], 10, 64)
	must(err)
	chainID := new(big.Int).SetUint64(cid)
	nonce, err := strconv.ParseUint(os.Args[3], 10, 64)
	must(err)
	var to *common.Address
	if os.Args[4] != "-" {
		a := common.HexToAddress(os.Args[4])
		to = &a
	}
	signer := ethtypes.LatestSignerForChainID(chainID)
	tx, err := ethtypes.SignTx(ethtypes.NewTx(&ethtypes.DynamicFeeTx{ChainID: chainID, Nonce: nonce, To: to, Value: new(big.Int), Gas: 500000,
		GasFeeCap: big.NewInt(100_000_000_000), GasTipCap: big.NewInt(1_000_000_000), Data: common.FromHex(os.Args[5])}), signer, key)
	must(err)
	msg := &evmtypes.MsgEthereumTx{}
	must(msg.FromSignedEthereumTx(tx, signer))
	cfg := encoding.MakeConfig(cid)
	// 18 decimals: the denom is its own extended denom
	ctx, err := msg.BuildTxWithEvmParams(cfg.TxConfig.NewTxBuilder(), evmtypes.Params{EvmDenom: os.Args[6],
		ExtendedDenomOptions: &evmtypes.ExtendedDenomOptions{ExtendedDenom: os.Args[6]}})
	must(err)
	bz, err := cfg.TxConfig.TxEncoder()(ctx)
	must(err)
	fmt.Println("0x" + common.Bytes2Hex(bz))
	if to == nil { // the address the contract gets
		fmt.Println(crypto.CreateAddress(crypto.PubkeyToAddress(key.PublicKey), nonce).Hex())
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
