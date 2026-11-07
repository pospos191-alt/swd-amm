<?php
/**
 * Smoke test of the gateway glue with minimal WordPress / WooCommerce stand-ins (no WordPress install needed):
 * settings validation, checkout (reference + quotes), the payment box HTML, and check_order() with a fake RPC.
 * Run: php tests/gateway-smoke.php
 *
 * @package SWD_Pay
 */

// phpcs:disable

define( 'ABSPATH', __DIR__ . '/' );
define( 'DAY_IN_SECONDS', 86400 );
define( 'MINUTE_IN_SECONDS', 60 );

// ---- WordPress stand-ins
$GLOBALS['_opts'] = array();
$GLOBALS['_transients'] = array();
$GLOBALS['_http'] = null; // callable( url, args ) → array( code, body )
$GLOBALS['_notices'] = array();
$GLOBALS['_orders'] = array();
function __( $s ) { return $s; }
function esc_html__( $s ) { return htmlspecialchars( $s, ENT_QUOTES ); }
function esc_attr__( $s ) { return htmlspecialchars( $s, ENT_QUOTES ); }
function esc_html( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function esc_attr( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function esc_url( $u, $protocols = null ) {
	$p = $protocols ? $protocols : array( 'http', 'https' );
	$scheme = strtolower( (string) strtok( $u, ':' ) );
	return in_array( $scheme, $p, true ) ? htmlspecialchars( $u, ENT_QUOTES ) : '';
}
function esc_url_raw( $u, $protocols = null ) { return 0 === strpos( $u, 'https://' ) ? $u : ''; }
function sanitize_text_field( $s ) { return trim( strip_tags( (string) $s ) ); }
function wp_json_encode( $v ) { return json_encode( $v ); }
function get_bloginfo() { return 'Test Shop'; }
function get_option( $k, $d = false ) { return isset( $GLOBALS['_opts'][ $k ] ) ? $GLOBALS['_opts'][ $k ] : $d; }
function get_transient( $k ) { return isset( $GLOBALS['_transients'][ $k ] ) ? $GLOBALS['_transients'][ $k ] : false; }
function set_transient( $k, $v ) { $GLOBALS['_transients'][ $k ] = $v; return true; }
function add_action() {}
function admin_url( $p ) { return 'https://shop.test/wp-admin/' . $p; }
function wp_create_nonce() { return 'nonce123'; }
function wp_enqueue_style() {}
function wp_enqueue_script() {}
function wp_localize_script() {}
function wc_add_notice( $m ) { $GLOBALS['_notices'][] = $m; }
function wc_format_decimal( $v, $d ) { return number_format( (float) $v, $d, '.', '' ); }
function wc_get_price_decimals() { return 2; }
function get_woocommerce_currency() { return 'USD'; }
function wc_get_order( $id ) { return isset( $GLOBALS['_orders'][ $id ] ) ? $GLOBALS['_orders'][ $id ] : false; }
function wc_get_orders( $args ) { return array(); }
function is_wp_error( $x ) { return false; }
function wp_safe_remote_post( $url, $args ) { return call_user_func( $GLOBALS['_http'], $url, $args ); }
function wp_safe_remote_get( $url, $args ) { return call_user_func( $GLOBALS['_http'], $url, $args ); }
function wp_remote_retrieve_response_code( $r ) { return $r[0]; }
function wp_remote_retrieve_body( $r ) { return $r[1]; }
class WC_Admin_Settings { public static $errors = array(); public static function add_error( $m ) { self::$errors[] = $m; } }

class WC_Payment_Gateway {
	public $id, $settings = array(), $form_fields = array(), $enabled, $title, $description, $method_title, $method_description, $supports, $icon, $has_fields;
	public function init_settings() {
		$saved = get_option( 'woocommerce_' . $this->id . '_settings', array() );
		foreach ( $this->form_fields as $k => $f ) {
			$this->settings[ $k ] = isset( $saved[ $k ] ) ? $saved[ $k ] : ( isset( $f['default'] ) ? $f['default'] : '' );
		}
	}
	public function get_option( $k, $d = null ) { return isset( $this->settings[ $k ] ) && '' !== $this->settings[ $k ] ? $this->settings[ $k ] : $d; }
	public function is_available() { return 'yes' === $this->enabled; }
	public function get_return_url( $o ) { return 'https://shop.test/checkout/order-received/' . $o->get_id(); }
}
class Fake_Date { public function getTimestamp() { return time() - 60; } }
class WC_Order {
	private $id, $meta = array(), $status = 'pending', $paid = false;
	public $notes = array(), $tx = null;
	public function __construct( $id ) { $this->id = $id; }
	public function get_id() { return $this->id; }
	public function get_meta( $k ) { return isset( $this->meta[ $k ] ) ? $this->meta[ $k ] : ''; }
	public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; }
	public function save() {}
	public function get_total() { return '10.00'; }
	public function get_currency() { return 'USD'; }
	public function get_order_number() { return (string) $this->id; }
	public function get_order_key() { return 'wc_order_abc'; }
	public function get_payment_method() { return 'swd_pay'; }
	public function get_date_created() { return new Fake_Date(); }
	public function update_status( $s ) { $this->status = $s; }
	public function get_status() { return $this->status; }
	public function is_paid() { return $this->paid; }
	public function needs_payment() { return ! $this->paid; }
	public function add_order_note( $n ) { $this->notes[] = $n; }
	public function payment_complete( $tx ) { $this->paid = true; $this->tx = $tx; $this->status = 'processing'; }
}
function WC() { return (object) array( 'cart' => null ); }

define( 'SWD_PAY_URL', 'https://shop.test/wp-content/plugins/woocommerce-swd-pay/' );
define( 'SWD_PAY_VERSION', 'test' );
$inc = dirname( __DIR__ ) . '/includes/';
require $inc . 'class-swd-pay-math.php';
require $inc . 'class-swd-pay-verifier.php';
require $inc . 'class-swd-pay-solana.php';
require $inc . 'class-swd-pay-price.php';
require $inc . 'class-swd-pay-gateway.php';

$fails = 0;
function ok( $cond, $name ) {
	global $fails;
	echo ( $cond ? 'ok   ' : 'FAIL ' ) . $name . "\n";
	$fails += $cond ? 0 : 1;
}

$wallet = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
$GLOBALS['_opts']['woocommerce_swd_pay_settings'] = array( 'enabled' => 'yes', 'wallet' => $wallet, 'pricing' => 'fixed', 'price_swd' => '0.05', 'price_usdc' => '1', 'rpc_url' => 'https://rpc.test' );
$gw = new SWD_Pay_Gateway();

// settings validation
ok( $gw->validate_wallet_field( 'wallet', 'my seed phrase words' ) === $wallet && count( WC_Admin_Settings::$errors ) === 1, 'invalid wallet refused, old value kept' );
ok( $gw->validate_rpc_url_field( 'rpc_url', 'http://insecure.example' ) === 'https://rpc.test', 'http RPC refused' );
ok( $gw->validate_price_swd_field( 'price_swd', '0,07' ) === '0.07', 'comma decimal accepted' );
ok( $gw->validate_price_swd_field( 'price_swd', '-1' ) === '0.05', 'negative price refused' );
ok( $gw->is_available(), 'available with wallet + fixed prices' );

// checkout
$order = new WC_Order( 42 );
$GLOBALS['_orders'][42] = $order;
$res = $gw->process_payment( 42 );
ok( 'success' === $res['result'], 'process_payment succeeds' );
$ref = $order->get_meta( '_swd_pay_reference' );
ok( SWD_Pay_Math::is_address( $ref ), 'order has a reference key' );
$quotes = $gw->order_quotes( $order );
ok( 2 === count( $quotes ) && '20000000' === $quotes[0]['raw'] && '10000000' === $quotes[1]['raw'], 'quotes: 200 SWD, 10 USDC' );

// payment box
ob_start();
$gw->payment_box( 42 );
$html = ob_get_clean();
ok( false !== strpos( $html, 'href="solana:' . $wallet . '?amount=200&amp;spl-token=Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL&amp;reference=' . $ref ), 'payment box has the Solana Pay link' );
ok( false !== strpos( $html, 'data-url="solana:' ), 'payment box has the QR data' );
ok( false === strpos( $html, '<script' ), 'no inline script in the box' );

// check_order with a fake RPC: first nothing, then a paying transaction
$paid_tx = array(
	'blockTime'   => time(),
	'meta'        => array(
		'err'               => null,
		'preTokenBalances'  => array(),
		'postTokenBalances' => array( array( 'owner' => $wallet, 'mint' => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'uiTokenAmount' => array( 'amount' => '10000000', 'decimals' => 6 ) ) ),
	),
	'transaction' => array( 'message' => array( 'accountKeys' => array( array( 'pubkey' => $ref ) ) ) ),
);
$sigs = array();
$GLOBALS['_http'] = function ( $url, $args ) use ( &$sigs, $paid_tx ) {
	$req = json_decode( $args['body'], true );
	if ( 'getSignaturesForAddress' === $req['method'] ) {
		return array( 200, json_encode( array( 'result' => $sigs ) ) );
	}
	return array( 200, json_encode( array( 'result' => $paid_tx ) ) );
};
ok( 'pending' === $gw->check_order( $order ), 'no transaction yet → pending' );
$sigs = array( array( 'signature' => str_repeat( '5', 88 ), 'err' => null ) );
ok( 'paid' === $gw->check_order( $order ), 'paying transaction → paid' );
ok( $order->is_paid() && str_repeat( '5', 88 ) === $order->tx && 'processing' === $order->get_status(), 'order completed with the signature' );
ok( 1 === count( $order->notes ) && false !== strpos( $order->notes[0], '10 USDC' ), 'order note names the amount' );
$GLOBALS['_http'] = function () { return array( 500, '' ); };
$order2 = new WC_Order( 43 );
$GLOBALS['_orders'][43] = $order2;
$gw->process_payment( 43 );
ok( 'error' === $gw->check_order( $order2 ) && ! $order2->is_paid(), 'RPC down → error, not paid' );

echo $fails ? "$fails FAILED\n" : "gateway smoke test passed\n";
exit( $fails ? 1 : 0 );
