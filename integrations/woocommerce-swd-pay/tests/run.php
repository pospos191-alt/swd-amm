<?php
/**
 * Offline tests for the parts with no WordPress dependency (math, Solana Pay URL, quotes, the transaction matcher,
 * the RPC flow with a fake transport). Run: php tests/run.php
 *
 * @package SWD_Pay
 */

// phpcs:disable

define( 'ABSPATH', __DIR__ . '/' );
function wp_json_encode( $v ) {
	return json_encode( $v );
}
$base = dirname( __DIR__ ) . '/includes/';
require $base . 'class-swd-pay-math.php';
require $base . 'class-swd-pay-verifier.php';
require $base . 'class-swd-pay-solana.php';
require $base . 'class-swd-pay-price.php';

$fails = 0;
$count = 0;
function eq( $got, $want, $name ) {
	global $fails, $count;
	++$count;
	if ( $got !== $want ) {
		++$fails;
		echo "FAIL $name\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
	}
}

// ---- base58 / references
eq( SWD_Pay_Math::base58_encode( 'Hello World!' ), '2NEpo7TZRRrLZSi2U', 'base58 vector' );
eq( SWD_Pay_Math::base58_encode( str_repeat( "\0", 32 ) ), '11111111111111111111111111111111', 'base58 zeros = system program' );
eq( SWD_Pay_Math::base58_encode( "\0\0\x01" ), '112', 'base58 leading zeros' );
$r1 = SWD_Pay_Math::new_reference();
eq( SWD_Pay_Math::is_address( $r1 ), true, 'reference is an address' );
eq( $r1 === SWD_Pay_Math::new_reference(), false, 'references are unique' );
eq( SWD_Pay_Math::is_address( 'not an address' ), false, 'bad address' );
eq( SWD_Pay_Math::is_address( '0OIl' . str_repeat( 'a', 40 ) ), false, 'base58 excludes 0 O I l' );

// ---- amounts (exact, rounded up)
eq( SWD_Pay_Math::token_raw_amount( '10.00', '0.05', 5 ), '20000000', '10 / 0.05 = 200 SWD' );
eq( SWD_Pay_Math::token_raw_amount( '1', '3', 6 ), '333334', 'ceil 1/3 USDC' );
eq( SWD_Pay_Math::token_raw_amount( '25.50', '1', 6 ), '25500000', 'USDC 1:1' );
eq( SWD_Pay_Math::token_raw_amount( '1000', '36.5', 6 ), '27397261', 'THB → USDC rounds up' );
eq( SWD_Pay_Math::token_raw_amount( '99999999.99', '0.000000000001', 5 ), '9999999999000000000000000', 'big numbers stay exact' );
eq( SWD_Pay_Math::token_raw_amount( '0', '1', 6 ), null, 'zero total' );
eq( SWD_Pay_Math::token_raw_amount( '10', '0', 6 ), null, 'zero price' );
eq( SWD_Pay_Math::token_raw_amount( '10', '-1', 6 ), null, 'negative price' );
eq( SWD_Pay_Math::token_raw_amount( '1e3', '1', 6 ), null, 'no exponent' );
eq( SWD_Pay_Math::format_raw( '20000000', 5 ), '200', 'format whole' );
eq( SWD_Pay_Math::format_raw( '333334', 6 ), '0.333334', 'format fraction' );
eq( SWD_Pay_Math::format_raw( '1234500', 5 ), '12.345', 'format trims zeros' );
eq( SWD_Pay_Math::format_raw( '0', 6 ), '0', 'format zero' );
eq( SWD_Pay_Math::cmp( '100', '99' ), 1, 'cmp longer' );
eq( SWD_Pay_Math::cmp( '0099', '99' ), 0, 'cmp leading zeros' );
eq( SWD_Pay_Math::cmp( '98', '99' ), -1, 'cmp less' );
eq( SWD_Pay_Math::add_one( '199' ), '200', 'add_one carry' );
eq( SWD_Pay_Math::float_to_decimal( 0.00001234 ), '0.00001234', 'float price' );
eq( SWD_Pay_Math::float_to_decimal( 1e-14 ), null, 'too small price' );

// ---- quotes and the Solana Pay URL
$settings = array( 'accept_swd' => 'yes', 'accept_usdc' => 'yes', 'pricing' => 'fixed', 'price_swd' => '0.05', 'price_usdc' => '1' );
$q        = SWD_Pay_Price::quotes( '10.00', $settings, 1000 );
eq( count( $q ), 2, 'two quotes' );
eq( $q[0]['symbol'] . ' ' . $q[0]['amount'] . ' ' . $q[0]['raw'], 'SWD 200 20000000', 'SWD quote' );
eq( $q[1]['symbol'] . ' ' . $q[1]['amount'], 'USDC 10', 'USDC quote' );
eq( $q[0]['until'], 0, 'fixed quotes never expire' );
$settings['accept_usdc'] = 'no';
eq( count( SWD_Pay_Price::quotes( '10.00', $settings, 1000 ) ), 1, 'only accepted tokens' );
$jup = array( 'accept_swd' => 'yes', 'pricing' => 'jupiter', 'usd_rate' => '36.5', 'quote_minutes' => '10' );
$q2  = SWD_Pay_Price::quotes( '100', $jup, 1000, function ( $mint ) { return 0.002; } );
eq( $q2[0]['price'], '0.073', 'jupiter price × THB rate' );
eq( $q2[0]['raw'], SWD_Pay_Math::token_raw_amount( '100', '0.073', 5 ), 'jupiter raw' );
eq( $q2[0]['until'], 1600, 'market quote expires' );
eq( SWD_Pay_Price::quotes( '100', $jup, 1000, function () { return null; } ), array(), 'no price, no quote' );
$url = SWD_Pay_Price::solana_pay_url( '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', $q[0], $r1, 'My Shop & Co', 'Order #12' );
eq( $url, 'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=200&spl-token=Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL&reference=' . $r1 . '&label=My%20Shop%20%26%20Co&message=Order%20%2312', 'Solana Pay URL' );

// ---- the transaction matcher
$merchant = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
$payer    = 'HUj3cyrb8eoZDJ6CWFSkQxjxDvK8Wn8PPcnYZbFEsWLx';
$ref      = $r1;
$swd      = 'Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL';
function bal( $owner, $mint, $amount, $dec, $idx ) {
	return array( 'accountIndex' => $idx, 'owner' => $owner, 'mint' => $mint, 'uiTokenAmount' => array( 'amount' => $amount, 'decimals' => $dec ) );
}
function tx( $ref, $pre, $post, $err = null, $time = 2000 ) {
	return array(
		'blockTime'   => $time,
		'meta'        => array( 'err' => $err, 'preTokenBalances' => $pre, 'postTokenBalances' => $post ),
		'transaction' => array( 'message' => array( 'accountKeys' => array( array( 'pubkey' => 'Payer1111' ), array( 'pubkey' => $ref ) ) ) ),
	);
}
$expect = array(
	'reference'  => $ref,
	'recipient'  => $merchant,
	'quotes'     => array( array( 'mint' => $swd, 'decimals' => 5, 'raw' => '20000000', 'until' => 0 ) ),
	'not_before' => 1500,
);
$paid = tx( $ref, array( bal( $merchant, $swd, '5', 5, 1 ), bal( $payer, $swd, '30000000', 5, 2 ) ), array( bal( $merchant, $swd, '20000005', 5, 1 ), bal( $payer, $swd, '10000000', 5, 2 ) ) );
$m    = SWD_Pay_Verifier::check( $paid, $expect );
eq( array( $m['ok'], $m['reason'], $m['received'] ), array( true, 'paid', '20000000' ), 'exact payment' );
$new_ata = tx( $ref, array(), array( bal( $merchant, $swd, '25000000', 5, 1 ) ) );
eq( SWD_Pay_Verifier::check( $new_ata, $expect )['ok'], true, 'payment that creates the merchant token account, overpaid' );
$under = tx( $ref, array( bal( $merchant, $swd, '0', 5, 1 ) ), array( bal( $merchant, $swd, '19999999', 5, 1 ) ) );
eq( SWD_Pay_Verifier::check( $under, $expect )['reason'], 'underpaid', 'underpaid by one unit' );
$other_mint = tx( $ref, array(), array( bal( $merchant, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '99000000', 6, 1 ) ) );
eq( SWD_Pay_Verifier::check( $other_mint, $expect )['ok'], false, 'a token the quote does not name' );
$fake_mint_dec = tx( $ref, array(), array( bal( $merchant, $swd, '20000000', 9, 1 ) ) );
eq( SWD_Pay_Verifier::check( $fake_mint_dec, $expect )['ok'], false, 'wrong decimals refused' );
$other_owner = tx( $ref, array(), array( bal( $payer, $swd, '20000000', 5, 1 ) ) );
eq( SWD_Pay_Verifier::check( $other_owner, $expect )['ok'], false, 'paid to someone else' );
eq( SWD_Pay_Verifier::check( tx( $ref, array(), array( bal( $merchant, $swd, '20000000', 5, 1 ) ), array( 'InstructionError' => array( 0, 'Custom' ) ) ), $expect )['reason'], 'failed', 'failed transaction' );
eq( SWD_Pay_Verifier::check( tx( 'OtherRef', array(), array( bal( $merchant, $swd, '20000000', 5, 1 ) ) ), $expect )['reason'], 'no_reference', 'reference missing' );
eq( SWD_Pay_Verifier::check( tx( $ref, array(), array( bal( $merchant, $swd, '20000000', 5, 1 ) ), null, 100 ), $expect )['reason'], 'too_old', 'older than the order' );
$exp2                       = $expect;
$exp2['quotes'][0]['until'] = 1900;
eq( SWD_Pay_Verifier::check( $paid, $exp2 )['ok'], false, 'expired quote not honoured' );
$exp2['quotes'][]           = array( 'mint' => $swd, 'decimals' => 5, 'raw' => '20000000', 'until' => 2100 );
eq( SWD_Pay_Verifier::check( $paid, $exp2 )['ok'], true, 'a newer valid quote is' );
eq( SWD_Pay_Verifier::check( null, $expect )['ok'], false, 'missing transaction' );

// ---- RPC flow with a fake transport
$calls     = array();
$transport = function ( $url, $body ) use ( &$calls, $paid, $under ) {
	$req     = json_decode( $body, true );
	$calls[] = $req['method'];
	if ( 'getSignaturesForAddress' === $req['method'] ) {
		return json_encode( array( 'result' => array( array( 'signature' => str_repeat( 'A', 88 ), 'err' => null ), array( 'signature' => str_repeat( 'B', 88 ), 'err' => null ), array( 'signature' => str_repeat( 'C', 88 ), 'err' => array( 'x' => 1 ) ) ) ) );
	}
	return json_encode( array( 'result' => $req['params'][0] === str_repeat( 'A', 88 ) ? $paid : $under ) );
};
$rpc    = new SWD_Pay_Solana( 'https://rpc.example', 'confirmed', $transport );
$found  = $rpc->find_payment( $expect + array( 'used' => function () { return false; } ) );
eq( array( $found['status'], $found['signature'] ), array( 'paid', str_repeat( 'A', 88 ) ), 'rpc: finds the paying transaction' );
eq( $calls, array( 'getSignaturesForAddress', 'getTransaction' ), 'rpc: stops at the first match, skips failed signatures' );
$calls = array();
$found = $rpc->find_payment( $expect + array( 'used' => function ( $s ) { return str_repeat( 'A', 88 ) === $s; } ) );
eq( $found['status'], 'underpaid', 'rpc: a signature already used by another order is skipped' );
$bad = new SWD_Pay_Solana( 'https://rpc.example', 'confirmed', function () { return '{"jsonrpc":"2.0","error":{"code":429,"message":"slow down"}}'; } );
$threw = false;
try {
	$bad->find_payment( $expect );
} catch ( RuntimeException $e ) {
	$threw = true;
}
eq( $threw, true, 'rpc error is raised, never read as "not paid"' );

echo $fails ? "\n$fails of $count checks FAILED\n" : "all $count checks passed\n";
exit( $fails ? 1 : 0 );
