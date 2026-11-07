<?php
/**
 * Plugin Name:          SWD Pay for WooCommerce (Solana Pay: SWD, USDC)
 * Plugin URI:           https://github.com/pospos191-alt/zetaphy/tree/main/integrations/woocommerce-swd-pay
 * Description:          Accept SWD (SAWASDEE COIN) and USDC on Solana with Solana Pay. Payments go straight to your wallet and are verified on-chain.
 * Version:              0.1.0
 * Author:               SAWASDEE COIN (SWD)
 * Author URI:           https://swd-zetaphy.sawasdeecoin.com
 * License:              GPL-2.0-or-later
 * License URI:          https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:          swd-pay
 * Requires at least:    6.2
 * Requires PHP:         7.4
 * Requires Plugins:     woocommerce
 * WC requires at least: 8.0
 * WC tested up to:      10.3
 *
 * @package SWD_Pay
 */

defined( 'ABSPATH' ) || exit;

define( 'SWD_PAY_VERSION', '0.1.0' );
define( 'SWD_PAY_FILE', __FILE__ );
define( 'SWD_PAY_URL', plugin_dir_url( __FILE__ ) );
define( 'SWD_PAY_DIR', plugin_dir_path( __FILE__ ) );

require_once SWD_PAY_DIR . 'includes/class-swd-pay-math.php';
require_once SWD_PAY_DIR . 'includes/class-swd-pay-verifier.php';
require_once SWD_PAY_DIR . 'includes/class-swd-pay-solana.php';
require_once SWD_PAY_DIR . 'includes/class-swd-pay-price.php';

// Works with WooCommerce's order tables (HPOS) and the block checkout.
add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', SWD_PAY_FILE, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', SWD_PAY_FILE, true );
		}
	}
);

add_action(
	'plugins_loaded',
	function () {
		load_plugin_textdomain( 'swd-pay', false, dirname( plugin_basename( SWD_PAY_FILE ) ) . '/languages' ); // Optional .mo files in languages/.
		if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
			return;
		}
		require_once SWD_PAY_DIR . 'includes/class-swd-pay-gateway.php';

		add_filter(
			'woocommerce_payment_gateways',
			function ( $gateways ) {
				$gateways[] = 'SWD_Pay_Gateway';
				return $gateways;
			}
		);
		add_action( 'wp_ajax_swd_pay_status', array( 'SWD_Pay_Gateway', 'ajax_status' ) );
		add_action( 'wp_ajax_nopriv_swd_pay_status', array( 'SWD_Pay_Gateway', 'ajax_status' ) );
		add_action( 'swd_pay_cron', array( 'SWD_Pay_Gateway', 'cron_check' ) );
		add_filter( 'woocommerce_order_actions', array( 'SWD_Pay_Gateway', 'order_actions' ) );
		add_action( 'woocommerce_order_action_swd_pay_check', array( 'SWD_Pay_Gateway', 'order_action_check' ) );
		add_filter(
			'plugin_action_links_' . plugin_basename( SWD_PAY_FILE ),
			function ( $links ) {
				$url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=' . SWD_Pay_Gateway::ID );
				array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'swd-pay' ) . '</a>' );
				return $links;
			}
		);
	}
);

add_action(
	'woocommerce_blocks_loaded',
	function () {
		if ( ! class_exists( '\Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType' ) ) {
			return;
		}
		require_once SWD_PAY_DIR . 'includes/class-swd-pay-blocks.php';
		add_action(
			'woocommerce_blocks_payment_method_type_registration',
			function ( $registry ) {
				$registry->register( new SWD_Pay_Blocks() );
			}
		);
	}
);

// Every 5 minutes: look for payments of recent unpaid orders (in case the customer closed the page).
// A paid order should not wait 15 minutes, hence the short interval.
// phpcs:disable WordPress.WP.CronInterval.CronSchedulesInterval
add_filter(
	'cron_schedules',
	function ( $s ) {
		$s['swd_pay_5min'] = array(
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => 'SWD Pay: every 5 minutes',
		);
		return $s;
	}
);
// phpcs:enable WordPress.WP.CronInterval.CronSchedulesInterval
register_activation_hook(
	__FILE__,
	function () {
		if ( ! wp_next_scheduled( 'swd_pay_cron' ) ) {
			wp_schedule_event( time() + MINUTE_IN_SECONDS, 'swd_pay_5min', 'swd_pay_cron' );
		}
	}
);
register_deactivation_hook(
	__FILE__,
	function () {
		wp_clear_scheduled_hook( 'swd_pay_cron' );
	}
);
